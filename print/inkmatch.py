"""Nuance d'impression à encres imposées la plus proche d'une couleur : variante « petit texte » d'une
nuance (scripts/print-swatches.ts), en noir seul pour un gris, en encres réduites pour une couleur.

Pourquoi un évaluateur à part : Pillow (ImageCms) ne rend le Lab qu'en 8 bits (pas de 0,4 en L, de 1 en a
et b), trop grossier pour départager deux valeurs d'encre voisines au ΔE00 près. On lit donc la table
A2B1 (colorimétrie relative) du profil de sortie et on l'interpole en flottant : même profil, même
intention que la conversion des nuances (server/color.ts, colorconv.py), sans quantification.

Usage : python inkmatch.py < {"profile": "FOGRA39", "targetCmyk": [80, 30, 75, 60], "targetRgb": "#1f3a30",
"inkSets": [["C", "M", "K"], ["C", "J", "K"]]}   (ou "inks": ["C", "K"] pour un seul jeu d'encres)
ou, pour plusieurs nuances d'un coup : {"profile": "FOGRA39", "jobs": [{"id": …, "targetCmyk": …, "inkSets": …}]}
Réponse : la meilleure combinaison (ΔE00 minimal face à la cible, au pour cent), ses écarts, les suivantes
et la meilleure de chaque jeu d'encres ; "exhaustive": true passe toute la grille au pour cent en revue.
"""
from __future__ import annotations

import heapq
import json
import math
import struct
import sys
from functools import lru_cache
from itertools import product
from pathlib import Path

from printcore import PrintError, emit, fail, hex_to_rgb, resolve_profile

INK_NAMES = ("C", "M", "J", "N")
INK_ALIASES = {"C": 0, "M": 1, "J": 2, "Y": 2, "N": 3, "K": 3}


# ---------------------------------------------------------------- lecture de la table A2B (lut16, « mft2 »)


class Lut16:
    """Table A2B d'un profil v2 (type mft2) : courbes d'entrée, grille CLUT, courbes de sortie."""

    def __init__(self, data: bytes, offset: int):
        if data[offset : offset + 4] != b"mft2":
            raise PrintError(f"Table A2B de type {data[offset:offset + 4]!r} non prise en charge (mft2 attendu)")
        self.inputs, self.outputs, self.grid = data[offset + 8], data[offset + 9], data[offset + 10]
        in_entries, out_entries = struct.unpack(">HH", data[offset + 48 : offset + 52])
        pos = offset + 52

        def read(count: int) -> list[int]:
            nonlocal pos
            values = list(struct.unpack(f">{count}H", data[pos : pos + 2 * count]))
            pos += 2 * count
            return values

        self.in_curves = [read(in_entries) for _ in range(self.inputs)]
        self.clut = read(self.grid**self.inputs * self.outputs)
        self.out_curves = [read(out_entries) for _ in range(self.outputs)]

    @staticmethod
    def _curve(table: list[int], x: float) -> float:
        """Courbe échantillonnée : x et résultat dans 0-1, interpolation linéaire."""
        pos = min(max(x, 0.0), 1.0) * (len(table) - 1)
        i = min(int(pos), len(table) - 2)
        f = pos - i
        return (table[i] * (1 - f) + table[i + 1] * f) / 65535

    def evaluate(self, values: list[float]) -> list[float]:
        """Entrées 0-1 → sorties 0-1 (interpolation multilinéaire dans la grille)."""
        g = self.grid
        coords = [self._curve(curve, v) * (g - 1) for curve, v in zip(self.in_curves, values)]
        base = [min(int(c), g - 2) for c in coords]
        frac = [c - b for c, b in zip(coords, base)]
        out = [0.0] * self.outputs
        # Première entrée = variation la plus lente (norme ICC) : index = ((i0·g + i1)·g + i2)·g + i3.
        for corner in product((0, 1), repeat=self.inputs):
            weight = 1.0
            index = 0
            for d, bit in enumerate(corner):
                weight *= frac[d] if bit else 1 - frac[d]
                index = index * g + base[d] + bit
            if weight == 0:
                continue
            at = index * self.outputs
            for o in range(self.outputs):
                out[o] += weight * self.clut[at + o] / 65535
        return [self._curve(curve, v) for curve, v in zip(self.out_curves, out)]


@lru_cache(maxsize=4)
def load_a2b(path: str, tag: bytes = b"A2B1") -> Lut16:
    data = Path(path).read_bytes()
    if data[16:20] != b"CMYK" or data[20:24] != b"Lab ":
        raise PrintError(f"{path} : profil CMJN → Lab attendu")
    count = struct.unpack(">I", data[128:132])[0]
    for i in range(count):
        sig, offset, _size = struct.unpack(">4sII", data[132 + 12 * i : 144 + 12 * i])
        if sig == tag:
            return Lut16(data, offset)
    raise PrintError(f"{path} : table {tag.decode()} absente")


def cmyk_to_lab(profile: Path | str, cmyk: list[float]) -> tuple[float, float, float]:
    """CMJN en % → Lab (D50, relatif au papier) par la table A2B1 du profil, en flottant."""
    lut = load_a2b(str(profile))
    l16, a16, b16 = (v * 65535 for v in lut.evaluate([v / 100 for v in cmyk]))
    # Lab 16 bits « v2 » : L = 100 à 0xFF00, a et b = 0 à 0x8000.
    return l16 * 100 / 65280, a16 / 256 - 128, b16 / 256 - 128


# ---------------------------------------------------------------- couleurs de référence


def srgb_to_lab(hex_color: str) -> tuple[float, float, float]:
    """sRGB → Lab D50 (matrice sRGB adaptée à D50 par Bradford, comme le PCS ICC)."""

    def linear(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(c) for c in hex_to_rgb(hex_color))
    x = 0.4360747 * r + 0.3850649 * g + 0.1430804 * b
    y = 0.2225045 * r + 0.7168786 * g + 0.0606169 * b
    z = 0.0139322 * r + 0.0971045 * g + 0.7141733 * b
    white = (0.9642, 1.0, 0.8249)

    def f(t: float) -> float:
        return t ** (1 / 3) if t > (6 / 29) ** 3 else t / (3 * (6 / 29) ** 2) + 4 / 29

    fx, fy, fz = f(x / white[0]), f(y / white[1]), f(z / white[2])
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e_2000(lab1, lab2) -> float:
    """CIEDE2000 (kL = kC = kH = 1)."""
    l1, a1, b1 = lab1
    l2, a2, b2 = lab2
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)
    c_mean = (c1 + c2) / 2
    g = 0.5 * (1 - math.sqrt(c_mean**7 / (c_mean**7 + 25**7)))
    a1p, a2p = a1 * (1 + g), a2 * (1 + g)
    c1p, c2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360 if c1p else 0.0
    h2p = math.degrees(math.atan2(b2, a2p)) % 360 if c2p else 0.0
    dl = l2 - l1
    dc = c2p - c1p
    if c1p * c2p == 0:
        dh = 0.0
    elif abs(h2p - h1p) <= 180:
        dh = h2p - h1p
    else:
        dh = h2p - h1p - 360 if h2p > h1p else h2p - h1p + 360
    dH = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(dh / 2))
    l_mean = (l1 + l2) / 2
    cp_mean = (c1p + c2p) / 2
    if c1p * c2p == 0:
        h_mean = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        h_mean = (h1p + h2p) / 2
    else:
        h_mean = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    t = (
        1
        - 0.17 * math.cos(math.radians(h_mean - 30))
        + 0.24 * math.cos(math.radians(2 * h_mean))
        + 0.32 * math.cos(math.radians(3 * h_mean + 6))
        - 0.20 * math.cos(math.radians(4 * h_mean - 63))
    )
    d_theta = 30 * math.exp(-(((h_mean - 275) / 25) ** 2))
    rc = 2 * math.sqrt(cp_mean**7 / (cp_mean**7 + 25**7))
    sl = 1 + 0.015 * (l_mean - 50) ** 2 / math.sqrt(20 + (l_mean - 50) ** 2)
    sc = 1 + 0.045 * cp_mean
    sh = 1 + 0.015 * cp_mean * t
    rt = -math.sin(math.radians(2 * d_theta)) * rc
    return math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh))


def lch(lab) -> dict:
    return {"L": round(lab[0], 2), "C": round(math.hypot(lab[1], lab[2]), 2), "h": round(math.degrees(math.atan2(lab[2], lab[1])) % 360, 1)}


# ---------------------------------------------------------------- recherche


def _combo(inks: list[int], values) -> list[float]:
    cmyk = [0.0, 0.0, 0.0, 0.0]
    for ink, value in zip(inks, values):
        cmyk[ink] = value
    return cmyk


def _entry(profile, target_lab, cmyk: list[float]) -> dict:
    lab = cmyk_to_lab(profile, cmyk)
    return {"cmyk": [int(v) if float(v).is_integer() else v for v in cmyk], "lab": [round(v, 3) for v in lab], "deltaE": delta_e_2000(target_lab, lab)}


def _rank(entry: dict) -> tuple:
    # À ΔE00 égal (au millième), la combinaison la moins chargée : moins d'encres, puis moins d'encrage.
    inks = sum(1 for v in entry["cmyk"] if v > 0)
    return (round(entry["deltaE"], 3), inks, sum(entry["cmyk"]))


def best_inks(profile: Path | str, target_lab, inks: list[int], step: float = 1.0, max_ink: float | None = None, keep: int | None = None) -> list[dict]:
    """Toutes les combinaisons des encres permises (au pas `step`, en %), triées par ΔE00 croissant ;
    `keep` n'en garde que les meilleures (une recherche exhaustive à trois encres en compte un million)."""
    levels = [round(i * step, 4) for i in range(int(100 / step) + 1)]
    results = []
    for combo in product(levels, repeat=len(inks)):
        cmyk = _combo(inks, combo)
        if max_ink and sum(cmyk) > max_ink:
            continue
        entry = _entry(profile, target_lab, cmyk)
        if keep:
            key = _rank(entry)
            if len(results) < keep:
                heapq.heappush(results, (tuple(-k for k in key), id(entry), entry))
            elif key < tuple(-k for k in results[0][0]):
                heapq.heapreplace(results, (tuple(-k for k in key), id(entry), entry))
        else:
            results.append(entry)
    out = [r[2] for r in results] if keep else results
    out.sort(key=_rank)
    return out


# Recherche rapide à trois encres : grille à 5 %, puis affinage au pour cent autour des meilleurs points,
# puis descente pas à pas. Le ΔE00 varie doucement avec les encres : test_inkmatch.py vérifie qu'on
# retombe sur l'optimum de la recherche exhaustive au pour cent, en 50 fois moins d'évaluations.
COARSE_STEP = 5
SEEDS = 12
REFINE_RADIUS = 4


def search_inks(profile: Path | str, target_lab, inks: list[int], max_ink: float | None = None, exhaustive: bool = False, keep: int = 6) -> list[dict]:
    """Meilleures combinaisons au pour cent des encres permises, triées par ΔE00 croissant."""
    if exhaustive or len(inks) <= 2:
        return best_inks(profile, target_lab, inks, 1.0, max_ink, keep=keep)
    seen: dict[tuple, dict] = {}

    def visit(values) -> dict | None:
        values = tuple(min(100.0, max(0.0, float(v))) for v in values)
        if values in seen:
            return seen[values]
        cmyk = _combo(inks, values)
        if max_ink and sum(cmyk) > max_ink:
            seen[values] = None
            return None
        seen[values] = _entry(profile, target_lab, cmyk)
        return seen[values]

    levels = range(0, 101, COARSE_STEP)
    for combo in product(levels, repeat=len(inks)):
        visit(combo)
    seeds = sorted((v for v in seen.items() if v[1]), key=lambda kv: _rank(kv[1]))[:SEEDS]
    for values, _ in seeds:
        ranges = [range(max(0, int(v) - REFINE_RADIUS), min(100, int(v) + REFINE_RADIUS) + 1) for v in values]
        for combo in product(*ranges):
            visit(combo)
    # Descente : un pas de 1 % sur chaque encre tant qu'un voisin fait mieux (sortie de la boîte d'affinage).
    best_values = min((kv for kv in seen.items() if kv[1]), key=lambda kv: _rank(kv[1]))[0]
    improved = True
    while improved:
        improved = False
        current = seen[best_values]
        for delta in product((-1, 0, 1), repeat=len(inks)):
            candidate = tuple(v + d for v, d in zip(best_values, delta))
            entry = visit(candidate)
            if entry and _rank(entry) < _rank(current):
                best_values, current, improved = tuple(min(100.0, max(0.0, float(v))) for v in candidate), entry, True
    ranked = sorted((e for e in seen.values() if e), key=_rank)
    return ranked[:keep]


def match(job: dict) -> dict:
    """Meilleure combinaison, pour un ou plusieurs jeux d'encres permises (`inks` ou `inkSets`)."""
    profile, _meta = resolve_profile(job.get("profile", "FOGRA39"))
    ink_sets = job.get("inkSets") or [job.get("inks", ["C", "K"])]
    ink_sets = [[INK_ALIASES[name.upper()] for name in names] for names in ink_sets]
    references = {}
    if job.get("targetCmyk"):
        references["cmyk"] = cmyk_to_lab(profile, job["targetCmyk"])
    if job.get("targetRgb"):
        references["rgb"] = srgb_to_lab(job["targetRgb"])
    if not references:
        raise PrintError("targetCmyk ou targetRgb attendu")
    # La cible : les encres imprimées (ce que montrent les grands corps de la même nuance), sinon la couleur du design.
    target = references.get("cmyk") or references["rgb"]
    exhaustive = bool(job.get("exhaustive", False))

    def describe(entry: dict) -> dict:
        lab = cmyk_to_lab(profile, entry["cmyk"])
        return {
            "cmyk": entry["cmyk"],
            "inks": sum(1 for v in entry["cmyk"] if v > 0),
            "lab": [round(v, 2) for v in lab],
            "lch": lch(lab),
            "deltaE": {key: round(delta_e_2000(ref, lab), 2) for key, ref in references.items()},
        }

    by_set = []
    ranked: list[dict] = []
    for inks in ink_sets:
        found = search_inks(profile, target, inks, job.get("maxInk"), exhaustive)
        by_set.append({"inks": [INK_NAMES[i] for i in inks], "best": describe(found[0])})
        ranked.extend(found)
    ranked.sort(key=_rank)
    unique: list[dict] = []
    for entry in ranked:
        if all(entry["cmyk"] != u["cmyk"] for u in unique):
            unique.append(entry)
    return {
        "profile": str(profile),
        "inks": sorted({INK_NAMES[i] for inks in ink_sets for i in inks}, key=INK_NAMES.index),
        "targets": {key: {"lab": [round(v, 2) for v in ref], "lch": lch(ref)} for key, ref in references.items()},
        "targetsDeltaE": round(delta_e_2000(references["cmyk"], references["rgb"]), 2) if len(references) == 2 else None,
        "best": describe(unique[0]),
        "next": [describe(r) for r in unique[1:6]],
        "bySet": by_set,
    }


def main() -> None:
    try:
        job = json.loads(sys.stdin.read() or "{}")
        # Plusieurs nuances d'un coup (scripts/print-swatches.ts) : un seul lancement de Python.
        if "jobs" in job:
            emit({"results": [{"id": item.get("id"), **match({"profile": job.get("profile", "FOGRA39"), **item})} for item in job["jobs"]]})
        else:
            emit(match(job))
    except PrintError as error:
        fail(str(error))


if __name__ == "__main__":
    main()
