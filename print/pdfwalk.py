"""Parcours d'un PDF : chaque flux de contenu (pages, formes, motifs, masques, glyphes Type 3, apparences
d'annotations) avec ses ressources, et chaque dictionnaire de ressources. Partagé par le post-traitement
(pdf_cmyk.py), le PDF léger (pdf_light.py) et le contrôle (check_pdfx.py).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator

import pikepdf
from pikepdf import Array, Dictionary, Name, Stream

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def multiply(a: Matrix, b: Matrix) -> Matrix:
    """a puis b (convention PDF : [x y 1] × a × b)."""
    return (
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    )


def matrix_of(value) -> Matrix:
    if value is None:
        return IDENTITY
    return tuple(float(v) for v in value)  # type: ignore[return-value]


def key_of(obj) -> tuple:
    """Identité d'un objet PDF : (numéro, génération) s'il est indirect, sinon son identité Python."""
    objgen = obj.objgen
    return objgen if objgen != (0, 0) else ("direct", id(obj))


class Seen:
    """Objets déjà parcourus.

    Un objet direct (dégradé rangé dans un motif, ressources d'une forme) n'a pas de numéro : on le
    reconnaît à son enveloppe Python, qu'il faut garder en vie. Sinon `id()` est réattribué à l'enveloppe
    d'un AUTRE objet, qui passait pour déjà vu : un dégradé RVB d'emoji restait ainsi non converti, au hasard
    de la mémoire."""

    def __init__(self) -> None:
        self._keys: set = set()
        self._alive: list = []

    def first_time(self, obj) -> bool:
        key = key_of(obj)
        if key in self._keys:
            return False
        self._keys.add(key)
        if key[0] == "direct":
            self._alive.append(obj)
        return True


# ---------------------------------------------------------------- espaces colorimétriques


@dataclass
class ColorSpaceInfo:
    kind: str  # rgb | cmyk | gray | lab | indexed | pattern | separation | devicen | other
    components: int
    obj: object = None
    # Profil incorporé (ICCBased), pour convertir une photo depuis son propre espace.
    icc: bytes | None = None
    base: "ColorSpaceInfo | None" = None
    name: str | None = None


def color_space_info(cs, resources: Dictionary | None = None) -> ColorSpaceInfo:
    """Nature d'un espace colorimétrique (nom de ressource, nom d'espace ou tableau)."""
    if isinstance(cs, Name):
        name = str(cs)
        if name in ("/DeviceRGB", "/RGB"):
            return ColorSpaceInfo("rgb", 3, cs)
        if name in ("/DeviceCMYK", "/CMYK"):
            return ColorSpaceInfo("cmyk", 4, cs)
        if name in ("/DeviceGray", "/G"):
            return ColorSpaceInfo("gray", 1, cs)
        if name == "/Pattern":
            return ColorSpaceInfo("pattern", 0, cs)
        spaces = resources.get("/ColorSpace") if resources is not None else None
        if spaces is not None and name in spaces:
            return color_space_info(spaces[name], resources)
        return ColorSpaceInfo("other", 0, cs)
    if isinstance(cs, Array) and len(cs) > 0:
        family = str(cs[0])
        if family == "/ICCBased":
            stream = cs[1]
            n = int(stream.get("/N", 3))
            kind = {1: "gray", 3: "rgb", 4: "cmyk"}.get(n, "other")
            icc = None
            try:
                icc = bytes(stream.read_bytes())
            except Exception:  # profil illisible : conversion depuis sRGB
                icc = None
            return ColorSpaceInfo(kind, n, cs, icc=icc)
        if family == "/CalRGB":
            return ColorSpaceInfo("rgb", 3, cs)
        if family == "/CalGray":
            return ColorSpaceInfo("gray", 1, cs)
        if family == "/Lab":
            return ColorSpaceInfo("lab", 3, cs)
        if family in ("/Indexed", "/I"):
            return ColorSpaceInfo("indexed", 1, cs, base=color_space_info(cs[1], resources))
        if family == "/Separation":
            return ColorSpaceInfo("separation", 1, cs, base=color_space_info(cs[2], resources), name=str(cs[1]))
        if family == "/DeviceN":
            return ColorSpaceInfo("devicen", len(cs[1]), cs, base=color_space_info(cs[2], resources))
        if family == "/Pattern":
            base = color_space_info(cs[1], resources) if len(cs) > 1 else None
            return ColorSpaceInfo("pattern", base.components if base else 0, cs, base=base)
    return ColorSpaceInfo("other", 0, cs)


# ---------------------------------------------------------------- parcours


@dataclass
class ContentVisit:
    """Un flux de contenu à lire ou réécrire."""

    kind: str  # page | form | pattern | charproc | smask | annotation
    owner: object  # pikepdf.Page ou Stream
    resources: Dictionary | None
    page_index: int
    smask: bool = False
    # Chemin lisible (« page 1 › X6 »), pour les messages.
    where: str = ""
    extra: dict = field(default_factory=dict)


def page_resources(page: pikepdf.Page) -> Dictionary | None:
    res = page.obj.get("/Resources")
    if res is None:
        # Ressources héritées de l'arbre des pages.
        node = page.obj.get("/Parent")
        while node is not None and res is None:
            res = node.get("/Resources")
            node = node.get("/Parent")
    return res


def iter_contents(pdf: pikepdf.Pdf, include_annotations: bool = True) -> Iterator[ContentVisit]:
    """Chaque flux de contenu une seule fois (une forme partagée par deux pages n'est vue qu'une fois)."""
    seen = Seen()

    def from_resources(resources: Dictionary | None, page_index: int, smask: bool, where: str) -> Iterator[ContentVisit]:
        if resources is None:
            return
        for name, xobj in (resources.get("/XObject") or {}).items():
            if not isinstance(xobj, Stream) or xobj.get("/Subtype") != "/Form":
                continue
            if not seen.first_time(xobj):
                continue
            here = f"{where} › {name[1:]}"
            yield ContentVisit("form", xobj, xobj.get("/Resources"), page_index, smask, here)
            yield from from_resources(xobj.get("/Resources"), page_index, smask, here)
        for name, pattern in (resources.get("/Pattern") or {}).items():
            if isinstance(pattern, Stream) and int(pattern.get("/PatternType", 0)) == 1:
                if not seen.first_time(pattern):
                    continue
                here = f"{where} › motif {name[1:]}"
                yield ContentVisit("pattern", pattern, pattern.get("/Resources"), page_index, smask, here)
                yield from from_resources(pattern.get("/Resources"), page_index, smask, here)
        for name, gs in (resources.get("/ExtGState") or {}).items():
            mask = gs.get("/SMask") if isinstance(gs, Dictionary) else None
            if isinstance(mask, Dictionary) and isinstance(mask.get("/G"), Stream):
                group = mask.G
                if not seen.first_time(group):
                    continue
                here = f"{where} › masque {name[1:]}"
                yield ContentVisit("smask", group, group.get("/Resources"), page_index, True, here, {"mask": mask})
                yield from from_resources(group.get("/Resources"), page_index, True, here)
        for name, font in (resources.get("/Font") or {}).items():
            if not isinstance(font, Dictionary) or font.get("/Subtype") != "/Type3":
                continue
            own = font.get("/Resources")
            font_res = own or resources
            here = f"{where} › police {name[1:]}"
            for glyph, proc in (font.get("/CharProcs") or {}).items():
                if not seen.first_time(proc):
                    continue
                yield ContentVisit("charproc", proc, font_res, page_index, smask, f"{here} {glyph[1:]}")
            # Un emoji en couleurs (Chrome : police Type 3) dessine chaque glyphe par « /Xg… Do » : formes,
            # images et états graphiques sont rangés dans les ressources de la police. Sans cette descente,
            # leur RVB restait dans le PDF imprimeur et le contrôle le refusait (audit C2).
            if isinstance(own, Dictionary):
                yield from from_resources(own, page_index, smask, here)

    for index, page in enumerate(pdf.pages):
        resources = page_resources(page)
        where = f"page {index + 1}"
        yield ContentVisit("page", page, resources, index, False, where)
        yield from from_resources(resources, index, False, where)
        if not include_annotations:
            continue
        for a, annot in enumerate(page.obj.get("/Annots") or []):
            ap = annot.get("/AP") if isinstance(annot, Dictionary) else None
            if not isinstance(ap, Dictionary):
                continue
            for state_key in ("/N", "/R", "/D"):
                entry = ap.get(state_key)
                streams = [entry] if isinstance(entry, Stream) else list(entry.values()) if isinstance(entry, Dictionary) else []
                for stream in streams:
                    if not isinstance(stream, Stream):
                        continue
                    if not seen.first_time(stream):
                        continue
                    here = f"{where} › annotation {a + 1}"
                    yield ContentVisit("annotation", stream, stream.get("/Resources"), index, False, here)
                    yield from from_resources(stream.get("/Resources"), index, False, here)


def iter_resources(pdf: pikepdf.Pdf) -> Iterator[tuple[Dictionary, int, bool, str]]:
    """Chaque dictionnaire de ressources : (ressources, page, dans un masque ?, chemin)."""
    seen = Seen()
    for visit in iter_contents(pdf):
        res = visit.resources
        if res is None:
            continue
        if not seen.first_time(res):
            continue
        yield res, visit.page_index, visit.smask, visit.where


def iter_images(pdf: pikepdf.Pdf) -> Iterator[tuple[Stream, str, int, bool, Dictionary]]:
    """Chaque image (XObject) une fois : (image, nom, page, dans un masque ?, ressources)."""
    seen = Seen()
    for res, page_index, smask, where in iter_resources(pdf):
        for name, xobj in (res.get("/XObject") or {}).items():
            if isinstance(xobj, Stream) and xobj.get("/Subtype") == "/Image":
                if not seen.first_time(xobj):
                    continue
                yield xobj, f"{where} › {name[1:]}", page_index, smask, res


def iter_shadings(pdf: pikepdf.Pdf) -> Iterator[tuple[object, str]]:
    """Chaque dégradé (ressource /Shading ou motif de type 2) une fois."""
    seen = Seen()
    for res, _page, _smask, where in iter_resources(pdf):
        found = [(name, sh) for name, sh in (res.get("/Shading") or {}).items()]
        for name, pattern in (res.get("/Pattern") or {}).items():
            if int(pattern.get("/PatternType", 0)) == 2 and pattern.get("/Shading") is not None:
                found.append((name, pattern.Shading))
        for name, shading in found:
            if not seen.first_time(shading):
                continue
            yield shading, f"{where} › dégradé {name[1:]}"


def iter_fonts(pdf: pikepdf.Pdf) -> Iterator[tuple[Dictionary, str]]:
    seen = Seen()
    for res, _page, _smask, where in iter_resources(pdf):
        for name, font in (res.get("/Font") or {}).items():
            if not seen.first_time(font):
                continue
            yield font, f"{where} › police {name[1:]}"


def image_usages(pdf: pikepdf.Pdf) -> dict:
    """Pour chaque image (clé : objgen) : la plus grande taille affichée, en points, toutes pages et formes
    confondues. Sert à la résolution effective (PDF léger, rééchantillonnage de l'export imprimeur)."""
    import math

    usages: dict = {}

    def run(owner, resources, ctm, depth=0):
        if depth > 12:
            return
        stack = []
        for item in pikepdf.parse_content_stream(owner, "q Q cm Do"):
            op, ops = str(item.operator), item.operands
            if op == "q":
                stack.append(ctm)
            elif op == "Q" and stack:
                ctm = stack.pop()
            elif op == "cm":
                ctm = multiply(matrix_of(ops), ctm)
            elif op == "Do" and resources is not None:
                xobj = (resources.get("/XObject") or {}).get(str(ops[0]))
                if not isinstance(xobj, Stream):
                    continue
                if xobj.get("/Subtype") == "/Form":
                    run(xobj, xobj.get("/Resources"), multiply(matrix_of(xobj.get("/Matrix")), ctm), depth + 1)
                elif xobj.get("/Subtype") == "/Image":
                    w_pt = math.hypot(ctm[0], ctm[1])
                    h_pt = math.hypot(ctm[2], ctm[3])
                    key = xobj.objgen
                    best = usages.get(key)
                    if best is None or w_pt * h_pt > best["w"] * best["h"]:
                        usages[key] = {"image": xobj, "name": str(ops[0])[1:], "w": w_pt, "h": h_pt}

    for page in pdf.pages:
        run(page, page_resources(page), IDENTITY)
    return usages


def effective_ppi(image: Stream, usage: dict | None) -> float | None:
    """Résolution effective d'une image à sa plus grande taille affichée (la plus faible des deux axes)."""
    if not usage or usage["w"] <= 0 or usage["h"] <= 0:
        return None
    return min(int(image.Width) / (usage["w"] / 72), int(image.Height) / (usage["h"] / 72))


def box_of(page: pikepdf.Page, name: str) -> list[float] | None:
    value = page.obj.get(name)
    if value is None:
        return None
    return [float(v) for v in value]


def decode_image(image: Stream):
    """Pixels d'une image XObject SANS son masque de transparence (Pillow), dans son propre espace.

    JPEG : décodé par Pillow depuis le flux brut ; Flate 8 bits : octets bruts ; sinon PdfImage de pikepdf
    (qui appliquerait le masque /SMask : on le retire le temps du décodage)."""
    import io

    from PIL import Image

    width, height = int(image.Width), int(image.Height)
    filters = image.get("/Filter")
    filters = [str(f) for f in filters] if isinstance(filters, Array) else [str(filters)] if filters is not None else []
    info = color_space_info(image.get("/ColorSpace"))
    mode = {"rgb": "RGB", "cmyk": "CMYK", "gray": "L"}.get(info.kind)
    bpc = int(image.get("/BitsPerComponent", 8))
    if filters == ["/DCTDecode"]:
        pil = Image.open(io.BytesIO(bytes(image.read_raw_bytes())))
        pil.load()
        return pil
    if mode and bpc == 8 and all(f in ("/FlateDecode", "/LZWDecode") for f in filters) and "/Decode" not in image:
        data = bytes(image.read_bytes())
        size = width * height * len(Image.new(mode, (1, 1)).getbands())
        if len(data) >= size:
            return Image.frombytes(mode, (width, height), data[:size])
    mask = image.get("/SMask")
    if mask is not None:
        del image["/SMask"]
    try:
        import pikepdf

        return pikepdf.PdfImage(image).as_pil_image()
    finally:
        if mask is not None:
            image.SMask = mask
