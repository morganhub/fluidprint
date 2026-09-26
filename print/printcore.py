"""Briques communes de la chaîne d'impression : préréglages, profils ICC, conversions de couleur.

Conventions :
- CMJN « document » : pourcentages 0-100 (C, M, J, N), comme dans le nuancier ;
- CMJN « pixel » (Pillow) : 0-255, 0 = pas d'encre ;
- RVB : `#rrggbb` ou triplets 0-255, en sRGB.
"""
from __future__ import annotations

import json
import os
import sys
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageCms, ImageMath

PRINT_DIR = Path(__file__).resolve().parent
PRESETS_FILE = PRINT_DIR / "presets.json"

# Emplacements des profils, dans l'ordre : ce dossier (profils téléchargés), une variable d'environnement,
# puis les dossiers système (Windows fournit CoatedFOGRA39.icc).
PROFILE_DIRS = [
    PRINT_DIR / "profiles",
    *(Path(p) for p in os.environ.get("FLUIDPRINT_ICC_DIRS", "").split(os.pathsep) if p),
    Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "spool" / "drivers" / "color",
    Path("/usr/share/color/icc"),
    Path("/Library/ColorSync/Profiles"),
]

INTENTS = {
    "perceptual": ImageCms.Intent.PERCEPTUAL,
    "relative": ImageCms.Intent.RELATIVE_COLORIMETRIC,
    "saturation": ImageCms.Intent.SATURATION,
    "absolute": ImageCms.Intent.ABSOLUTE_COLORIMETRIC,
}


class PrintError(Exception):
    """Erreur attendue (profil absent, PDF illisible…) : message d'une ligne pour l'utilisateur."""


# ---------------------------------------------------------------- préréglages et profils


def load_presets(path: str | Path | None = None) -> dict:
    with open(path or PRESETS_FILE, encoding="utf-8") as f:
        return json.load(f)


def find_profile_file(file_name: str) -> Path:
    """Chemin d'un profil ICC : nom exact, sinon un fichier du même début (les noms varient selon la publication)."""
    candidate = Path(file_name)
    if candidate.is_absolute():
        if candidate.is_file():
            return candidate
        raise PrintError(f"Profil ICC introuvable : {file_name}")
    stem = candidate.stem.lower()
    for folder in PROFILE_DIRS:
        exact = folder / file_name
        if exact.is_file():
            return exact
    for folder in PROFILE_DIRS:
        if not folder.is_dir():
            continue
        for entry in sorted(folder.iterdir()):
            if entry.suffix.lower() in (".icc", ".icm") and entry.stem.lower().startswith(stem[: max(6, len(stem) - 4)]):
                return entry
    raise PrintError(f"Profil ICC introuvable : {file_name} (voir print/profiles/README.md)")


def resolve_profile(profile_id: str, presets: dict | None = None) -> tuple[Path, dict]:
    """(chemin, description) d'un profil désigné par son identifiant (FOGRA39…) ou par un chemin de fichier."""
    presets = presets or load_presets()
    meta = presets["profiles"].get(profile_id)
    if meta is None:
        if profile_id.lower().endswith((".icc", ".icm")):
            path = find_profile_file(profile_id)
            return path, {"label": path.stem, "file": str(path), "outputConditionIdentifier": path.stem, "outputCondition": path.stem, "registryName": "http://www.color.org", "info": path.stem}
        raise PrintError(f"Profil inconnu : {profile_id} (connus : {', '.join(presets['profiles'])})")
    return find_profile_file(meta["file"]), meta


@lru_cache(maxsize=8)
def _open_profile(path: str) -> ImageCms.ImageCmsProfile:
    return ImageCms.getOpenProfile(path)


@lru_cache(maxsize=1)
def srgb_profile() -> ImageCms.ImageCmsProfile:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))


def profile_from_bytes(data: bytes) -> ImageCms.ImageCmsProfile:
    import io

    return ImageCms.ImageCmsProfile(io.BytesIO(data))


def _flags(bpc: bool) -> int:
    return int(ImageCms.Flags.BLACKPOINTCOMPENSATION) if bpc else 0


@lru_cache(maxsize=32)
def _transform(src: str, dst: str, in_mode: str, out_mode: str, intent: str, bpc: bool):
    source = srgb_profile() if src == "sRGB" else _open_profile(src)
    target = srgb_profile() if dst == "sRGB" else _open_profile(dst)
    return ImageCms.buildTransform(source, target, in_mode, out_mode, INTENTS[intent], flags=_flags(bpc))


def transform_to_cmyk(profile: Path | str, intent: str = "relative", bpc: bool = True, source: ImageCms.ImageCmsProfile | None = None):
    """Transformation RVB → CMJN (sRGB par défaut, ou le profil incorporé d'une photo)."""
    if source is not None:
        return ImageCms.buildTransform(source, _open_profile(str(profile)), "RGB", "CMYK", INTENTS[intent], flags=_flags(bpc))
    return _transform("sRGB", str(profile), "RGB", "CMYK", intent, bpc)


def transform_to_rgb(profile: Path | str, intent: str = "relative", bpc: bool = True):
    """Transformation CMJN → sRGB : simulation à l'écran de ce que le profil imprimera."""
    return _transform(str(profile), "sRGB", "CMYK", "RGB", intent, bpc)


# ---------------------------------------------------------------- couleurs isolées


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    v = value.strip().lstrip("#")
    if len(v) != 6:
        raise PrintError(f"Couleur attendue au format #rrggbb : {value}")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def rgb_to_hex(rgb) -> str:
    return "#" + "".join(f"{int(c):02x}" for c in rgb[:3])


def percent_to_byte(p: float) -> int:
    return max(0, min(255, round(p * 255 / 100)))


def byte_to_percent(b: int) -> float:
    return round(b * 100 / 255, 1)


def ink_total(cmyk) -> float:
    return float(sum(cmyk))


def limit_ink_values(cmyk: list[float], max_ink: float | None) -> list[float]:
    """Encrage limité comme pour les photos : C, M, J réduits dans la même proportion, N gardé."""
    if not max_ink or sum(cmyk) <= max_ink:
        return list(cmyk)
    c, m, y, k = cmyk
    cmy = c + m + y
    if cmy <= 0:
        return list(cmyk)
    f = max(0.0, (max_ink - k) / cmy)
    return [c * f, m * f, y * f, k]


def pixels(img: Image.Image) -> list:
    """Pixels d'une image d'une ligne (Pillow 12 renomme getdata)."""
    getter = getattr(img, "get_flattened_data", None) or img.getdata
    return list(getter())


def rgb_list_to_cmyk(values: list[str], profile: Path | str, intent: str = "relative", bpc: bool = True, max_ink: float | None = None) -> list[list[float]]:
    """Couleurs `#rrggbb` → CMJN en % entiers (colorimétrie relative + compensation du point noir par défaut)."""
    if not values:
        return []
    img = Image.new("RGB", (len(values), 1))
    img.putdata([hex_to_rgb(v) for v in values])
    out = ImageCms.applyTransform(img, transform_to_cmyk(profile, intent, bpc))
    result = []
    for px in pixels(out):
        cmyk = limit_ink_values([b * 100 / 255 for b in px], max_ink)
        result.append([int(round(v)) for v in cmyk])
    return result


def cmyk_list_to_rgb(values: list[list[float]], profile: Path | str, intent: str = "relative", bpc: bool = True) -> list[str]:
    """CMJN en % → `#rrggbb` affiché (simulation du profil)."""
    if not values:
        return []
    img = Image.new("CMYK", (len(values), 1))
    img.putdata([tuple(percent_to_byte(v) for v in cmyk) for cmyk in values])
    out = ImageCms.applyTransform(img, transform_to_rgb(profile, intent, bpc))
    return [rgb_to_hex(px) for px in pixels(out)]


# ---------------------------------------------------------------- images


def limit_ink_image(img: Image.Image, max_ink: float | None) -> Image.Image:
    """Limite l'encrage total d'une image CMJN (les noirs d'une photo convertie montent à 330 % en FOGRA39).

    Pour chaque pixel au-delà du plafond, C, M et J sont réduits dans la même proportion et N est gardé :
    la teinte bouge peu, le noir reste dense."""
    if not max_ink or img.mode != "CMYK":
        return img
    limit = max_ink * 255 / 100
    c, m, y, k = img.split()
    total = ImageMath.lambda_eval(lambda a: a["c"] + a["m"] + a["y"] + a["k"], c=c, m=m, y=y, k=k)
    if total.getextrema()[1] <= limit:
        return img

    def scaled(channel):
        def expr(a):
            cmy = a["max"](a["float"](a["c"]) + a["float"](a["m"]) + a["float"](a["y"]), 1.0)
            factor = a["min"](a["max"]((limit - a["float"](a["k"])) / cmy, 0.0), 1.0)
            return a["convert"](a["float"](a["x"]) * factor, "L")

        return ImageMath.lambda_eval(expr, x=channel, c=c, m=m, y=y, k=k)

    return Image.merge("CMYK", (scaled(c), scaled(m), scaled(y), k))


def image_max_ink(img: Image.Image) -> float:
    """Encrage total maximal d'une image CMJN, en %."""
    if img.mode != "CMYK":
        return 0.0
    c, m, y, k = img.split()
    total = ImageMath.lambda_eval(lambda a: a["c"] + a["m"] + a["y"] + a["k"], c=c, m=m, y=y, k=k)
    return round(total.getextrema()[1] * 100 / 255, 1)


def rgb_image_to_cmyk(img: Image.Image, profile: Path | str, intent: str = "perceptual", bpc: bool = True, source_icc: bytes | None = None, max_ink: float | None = None) -> Image.Image:
    """Photo RVB → CMJN au profil de sortie, même taille, encrage limité."""
    if img.mode not in ("RGB",):
        img = img.convert("RGB")
    source = profile_from_bytes(source_icc) if source_icc else None
    converted = ImageCms.applyTransform(img, transform_to_cmyk(profile, intent, bpc, source))
    return limit_ink_image(converted, max_ink)


def emit(payload: dict) -> None:
    """Réponse JSON sur la sortie standard (lue par server/*.ts), en UTF-8 quelle que soit la console."""
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def fail(message: str, code: int = 2) -> None:
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stderr.write(message + "\n")
    sys.exit(code)
