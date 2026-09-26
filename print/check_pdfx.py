"""Contrôle maison d'un PDF imprimeur (tâche 4.5) : les points de PDF/X-4 que l'export doit garantir.

Ce contrôle ne remplace pas Acrobat Pro (Contrôle en amont › PDF/X-4) ni le contrôle en ligne de
l'imprimeur : il vérifie ce que notre chaîne produit, pour qu'un export défectueux ne parte jamais.

- version 1.6, pas de chiffrement, ni JavaScript ni action automatique ;
- OutputIntent GTS_PDFX avec un profil ICC de sortie CMJN incorporé et un identifiant de condition ;
- Info : /GTS_PDFXVersion, /Trapped True|False, /Title, dates ; XMP cohérent (pdfxid, dc:title, dates,
  xmpMM:DocumentID, VersionID, RenditionClass, pdf:Trapped) ;
- chaque page : MediaBox, BleedBox, TrimBox emboîtées ; format fini attendu au 1/100 mm près ;
- polices incorporées ; aucune annotation hors PrinterMark/TrapNet ;
- AUCUN RVB : opérateurs rg/RG, espaces RVB (ressources, images, groupes, dégradés) ;
- encrage total maximal (vecteurs et photos) ;
- petits textes : sous `small_text_pt`, au plus `small_text_max_inks` encres, sauf couleurs d'exception
  (nuances d'accent, `Swatch.smallTextException`) ; en mode strict (export imprimeur), c'est une erreur ;
- polices : toute police Type 3 (dessin en contours : italique ou gras synthétiques, emoji, symbole absent)
  et toute police hors de la liste attendue (police de repli du système) sont signalées.

Usage : python check_pdfx.py <fichier.pdf> [--max-ink 300] [--trim 297x210] [--bleed 3]
        [--small-text-strict] [--small-text-exception 81,27,39,10 …] [--expected-font OpenSans-Regular …] [--json]
Code de sortie 0 si aucun défaut bloquant, 1 sinon.
"""
from __future__ import annotations

import argparse
import math
import re
import sys
from collections import Counter
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, Stream

from pdfwalk import IDENTITY, ColorSpaceInfo, color_space_info, decode_image, iter_contents, iter_fonts, iter_images, iter_shadings, matrix_of, multiply, page_resources
from printcore import emit, image_max_ink

MM = 72 / 25.4
BOX_TOLERANCE_PT = 0.02
REGISTRATION = "/All"


# ---------------------------------------------------------------- lecture des flux


class Paint:
    """Couleur courante : (espace, composantes) ; `inks` = encres CMJN non nulles (repérage exclu)."""

    def __init__(self, space: ColorSpaceInfo, values: tuple[float, ...]):
        self.space, self.values = space, values

    @property
    def kind(self) -> str:
        return self.space.kind

    def cmyk(self) -> tuple[float, ...] | None:
        if self.kind == "cmyk" and len(self.values) == 4:
            return self.values
        if self.kind == "gray" and len(self.values) == 1:
            return (0.0, 0.0, 0.0, 1 - self.values[0])
        return None

    def inks(self) -> int | None:
        cmyk = self.cmyk()
        if cmyk is not None:
            return sum(1 for v in cmyk if v > 0.005)
        if self.kind == "separation":
            return 4 if self.space.name == REGISTRATION else 1
        return None

    def describe(self) -> str:
        cmyk = self.cmyk()
        if cmyk is not None:
            return "C{} M{} J{} N{}".format(*(round(v * 100) for v in cmyk))
        return f"{self.kind} {' '.join(str(round(v, 4)) for v in self.values)}"


DEVICE_GRAY = ColorSpaceInfo("gray", 1, Name.DeviceGray)


class StreamAnalyzer:
    """Lit récursivement les flux d'une page (formes comprises, avec leurs matrices)."""

    def __init__(self, small_text_pt: float):
        self.small_text_pt = small_text_pt
        self.rgb_ops: Counter = Counter()
        self.rgb_where: set[str] = set()
        self.cmyk_values: Counter = Counter()
        self.texts: list[dict] = []

    def run(self, owner, resources: Dictionary | None, ctm, where: str, page: int, depth: int = 0) -> None:
        if depth > 12:
            return
        fill = Paint(DEVICE_GRAY, (0.0,))
        stroke = Paint(DEVICE_GRAY, (0.0,))
        stack = []
        tm = IDENTITY
        font_size = 0.0
        for item in pikepdf.parse_content_stream(owner):
            if isinstance(item, pikepdf.ContentStreamInlineImage):
                continue
            ops, op = item.operands, str(item.operator)
            nums = lambda: tuple(float(o) for o in ops if not isinstance(o, (Name, Array, pikepdf.String)))  # noqa: E731
            if op == "q":
                stack.append((ctm, fill, stroke))
            elif op == "Q" and stack:
                ctm, fill, stroke = stack.pop()
            elif op == "cm":
                ctm = multiply(matrix_of(ops), ctm)
            elif op in ("rg", "RG"):
                self.rgb_ops[op] += 1
                self.rgb_where.add(where)
                paint = Paint(ColorSpaceInfo("rgb", 3, Name.DeviceRGB), nums())
                fill, stroke = (paint, stroke) if op == "rg" else (fill, paint)
            elif op in ("k", "K"):
                paint = Paint(ColorSpaceInfo("cmyk", 4, Name.DeviceCMYK), nums())
                self.cmyk_values[paint.values] += 1
                fill, stroke = (paint, stroke) if op == "k" else (fill, paint)
            elif op in ("g", "G"):
                paint = Paint(DEVICE_GRAY, nums())
                fill, stroke = (paint, stroke) if op == "g" else (fill, paint)
            elif op in ("cs", "CS") and ops:
                info = color_space_info(ops[0], resources)
                if info.kind == "rgb":
                    self.rgb_ops[op] += 1
                    self.rgb_where.add(where)
                initial = tuple([0.0] * max(1, info.components)) if info.kind != "separation" else (1.0,)
                paint = Paint(info, initial)
                fill, stroke = (paint, stroke) if op == "cs" else (fill, paint)
            elif op in ("sc", "scn", "SC", "SCN"):
                current = fill if op in ("sc", "scn") else stroke
                paint = Paint(current.space, nums())
                if paint.kind == "cmyk":
                    self.cmyk_values[paint.values] += 1
                fill, stroke = (paint, stroke) if op in ("sc", "scn") else (fill, paint)
            elif op == "BT":
                tm = IDENTITY
            elif op == "Tf" and len(ops) >= 2:
                font_size = float(ops[1])
            elif op == "Tm" and len(ops) == 6:
                tm = matrix_of(ops)
            elif op in ("Td", "TD") and len(ops) == 2:
                tm = multiply((1, 0, 0, 1, float(ops[0]), float(ops[1])), tm)
            elif op in ("Tj", "TJ", "'", '"'):
                total = multiply(tm, ctm)
                size = abs(font_size) * math.sqrt(abs(total[0] * total[3] - total[1] * total[2]))
                self.texts.append({"page": page + 1, "size": round(size, 2), "paint": fill, "where": where})
            elif op == "Do" and ops:
                xobj = (resources.get("/XObject") or {}).get(str(ops[0])) if resources is not None else None
                if isinstance(xobj, Stream) and xobj.get("/Subtype") == "/Form":
                    self.run(xobj, xobj.get("/Resources"), multiply(matrix_of(xobj.get("/Matrix")), ctm), f"{where} › {str(ops[0])[1:]}", page, depth + 1)


# ---------------------------------------------------------------- contrôles


def _box(page: pikepdf.Page, name: str):
    value = page.obj.get(name)
    return [float(v) for v in value] if value is not None else None


def _inside(inner, outer) -> bool:
    return (
        inner[0] >= outer[0] - BOX_TOLERANCE_PT
        and inner[1] >= outer[1] - BOX_TOLERANCE_PT
        and inner[2] <= outer[2] + BOX_TOLERANCE_PT
        and inner[3] <= outer[3] + BOX_TOLERANCE_PT
    )


SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")


def font_name(font: Dictionary) -> str:
    """Nom PostScript d'une police, sans le préfixe de sous-ensemble (« ABCDEF+ ») ni l'encodage CID."""
    name = str(font.get("/BaseFont", ""))[1:]
    name = SUBSET_PREFIX.sub("", name)
    return re.sub(r"-(Identity-[HV])$", "", name)


def check_fonts(pdf, errors, warnings, stats, expected_fonts) -> None:
    """Polices incorporées ; Type 3 et polices hors liste signalées (une ligne par police)."""
    type3: dict[str, int] = {}
    unexpected: dict[str, int] = {}
    names: set[str] = set()
    for font, where in iter_fonts(pdf):
        if not _font_embedded(font):
            errors.append(f"{where} : police non incorporée ({font.get('/BaseFont')})")
        if font.get("/Subtype") == "/Type3":
            type3[where] = type3.get(where, 0) + len(font.get("/CharProcs") or {})
            continue
        name = font_name(font)
        names.add(name)
        if expected_fonts and name not in expected_fonts:
            unexpected[name] = unexpected.get(name, 0) + 1
    stats["fonts"] = sorted(names)
    stats["type3Fonts"] = len(type3)
    if type3:
        glyphs = sum(type3.values())
        warnings.append(
            f"{len(type3)} police{'s' if len(type3) > 1 else ''} Type 3 ({glyphs} glyphe{'s' if glyphs > 1 else ''} dessiné{'s' if glyphs > 1 else ''} en contours : "
            f"italique ou gras synthétique, emoji ou symbole absent des polices du document) : {', '.join(sorted(type3)[:3])}"
        )
    for name in sorted(unexpected):
        warnings.append(f"Police {name} hors des polices du document : police de repli du système, pour un caractère absent des polices fournies")


def _font_embedded(font: Dictionary) -> bool:
    subtype = font.get("/Subtype")
    if subtype == "/Type3":
        return True
    if subtype == "/Type0":
        descendants = font.get("/DescendantFonts") or []
        return all(_font_embedded(d) for d in descendants)
    descriptor = font.get("/FontDescriptor")
    if not isinstance(descriptor, Dictionary):
        return False
    return any(k in descriptor for k in ("/FontFile", "/FontFile2", "/FontFile3"))


def check_boxes(pdf, errors, stats, trim_mm, bleed_mm) -> None:
    pages = []
    for i, page in enumerate(pdf.pages):
        media, bleed, trim = _box(page, "/MediaBox"), _box(page, "/BleedBox"), _box(page, "/TrimBox")
        label = f"page {i + 1}"
        if trim is None:
            errors.append(f"{label} : TrimBox absente")
            continue
        if bleed is None:
            errors.append(f"{label} : BleedBox absente")
            bleed = media
        if not _inside(bleed, media):
            errors.append(f"{label} : BleedBox hors de la MediaBox")
        if not _inside(trim, bleed):
            errors.append(f"{label} : TrimBox hors de la BleedBox")
        size = ((trim[2] - trim[0]) / MM, (trim[3] - trim[1]) / MM)
        margins = [(trim[0] - bleed[0]) / MM, (trim[1] - bleed[1]) / MM, (bleed[2] - trim[2]) / MM, (bleed[3] - trim[3]) / MM]
        pages.append({"trimMm": [round(size[0], 3), round(size[1], 3)], "bleedMm": [round(m, 3) for m in margins], "mediaPt": media})
        if trim_mm and (abs(size[0] - trim_mm[0]) > 0.01 or abs(size[1] - trim_mm[1]) > 0.01):
            errors.append(f"{label} : format fini {size[0]:.3f} × {size[1]:.3f} mm au lieu de {trim_mm[0]} × {trim_mm[1]} mm")
        if bleed_mm is not None and any(abs(m - bleed_mm) > 0.01 for m in margins):
            errors.append(f"{label} : fond perdu {', '.join(f'{m:.2f}' for m in margins)} mm au lieu de {bleed_mm} mm")
    stats["pages"] = pages


def check_output_intent(pdf, errors, stats) -> None:
    intents = pdf.Root.get("/OutputIntents")
    pdfx = [i for i in (intents or []) if i.get("/S") == "/GTS_PDFX"]
    if not pdfx:
        errors.append("OutputIntent GTS_PDFX absent")
        return
    intent = pdfx[0]
    ident = str(intent.get("/OutputConditionIdentifier", ""))
    if not ident:
        errors.append("OutputIntent sans OutputConditionIdentifier")
    stats["outputCondition"] = ident
    profile = intent.get("/DestOutputProfile")
    if not isinstance(profile, Stream):
        # Sans profil incorporé, l'identifiant doit désigner une condition enregistrée : on l'exige ici.
        errors.append("OutputIntent sans profil ICC incorporé (DestOutputProfile)")
        return
    data = bytes(profile.read_bytes())
    if len(data) < 20 or data[16:20] != b"CMYK":
        errors.append("Profil de sortie incorporé : espace CMJN attendu")
    if len(data) >= 16 and data[12:16] != b"prtr":
        errors.append("Profil de sortie incorporé : profil d'imprimante (prtr) attendu")
    if int(profile.get("/N", 0)) != 4:
        errors.append("Profil de sortie incorporé : /N 4 attendu")
    stats["outputProfileBytes"] = len(data)


def _xmp_date_minutes(value: str) -> str:
    return value[:16] if value else ""


def _pdf_date_minutes(value: str) -> str:
    v = value[2:] if value.startswith("D:") else value
    if len(v) < 12:
        return ""
    return f"{v[0:4]}-{v[4:6]}-{v[6:8]}T{v[8:10]}:{v[10:12]}"


def check_metadata(pdf, errors, stats, standard: str) -> None:
    info = pdf.docinfo
    version = str(info.get("/GTS_PDFXVersion", ""))
    if version != standard:
        errors.append(f"Info /GTS_PDFXVersion = « {version} » au lieu de « {standard} »")
    trapped = info.get("/Trapped")
    if str(trapped) not in ("/True", "/False"):
        errors.append("Info /Trapped doit valoir /True ou /False")
    for key in ("/Title", "/CreationDate", "/ModDate"):
        if not str(info.get(key, "")):
            errors.append(f"Info {key} absent")
    meta = pdf.open_metadata()
    needed = {
        "pdfxid:GTS_PDFXVersion": standard,
        "dc:title": None,
        "xmp:CreateDate": None,
        "xmp:ModifyDate": None,
        "xmpMM:DocumentID": None,
        "xmpMM:VersionID": None,
        "xmpMM:RenditionClass": None,
        "pdf:Trapped": str(trapped)[1:] if trapped is not None else None,
    }
    for key, expected in needed.items():
        value = meta.get(key)
        if value in (None, "", {}):
            errors.append(f"XMP {key} absent")
        elif expected is not None and str(value) != expected:
            errors.append(f"XMP {key} = « {value} » au lieu de « {expected} »")
    if _xmp_date_minutes(str(meta.get("xmp:CreateDate", ""))) != _pdf_date_minutes(str(info.get("/CreationDate", ""))):
        errors.append("Dates de création différentes entre Info et XMP")
    stats["title"] = str(info.get("/Title", ""))


def check_color_spaces(pdf, errors) -> None:
    rgb_spaces = set()
    for visit in iter_contents(pdf):
        res = visit.resources
        if isinstance(visit.owner, Stream):
            group = visit.owner.get("/Group")
            if isinstance(group, Dictionary) and "/CS" in group and color_space_info(group.CS).kind == "rgb":
                rgb_spaces.add(f"{visit.where} : groupe de transparence RVB")
        elif visit.kind == "page":
            group = visit.owner.obj.get("/Group")
            if isinstance(group, Dictionary) and "/CS" in group and color_space_info(group.CS).kind == "rgb":
                rgb_spaces.add(f"{visit.where} : groupe de page RVB")
        if res is None:
            continue
        for name, cs in (res.get("/ColorSpace") or {}).items():
            info = color_space_info(cs, res)
            base = info.base.kind if info.base else None
            if info.kind == "rgb" or base == "rgb":
                rgb_spaces.add(f"{visit.where} : espace {name[1:]} RVB")
    for shading, where in iter_shadings(pdf):
        if color_space_info(shading.get("/ColorSpace")).kind == "rgb":
            rgb_spaces.add(f"{where} : dégradé RVB")
    errors.extend(sorted(rgb_spaces))


def check_images(pdf, errors, stats, max_ink) -> None:
    images = []
    worst = 0.0
    for image, where, _page, _smask, _res in iter_images(pdf):
        if image.get("/ImageMask"):
            continue
        info = color_space_info(image.get("/ColorSpace"))
        entry = {"name": where, "width": int(image.Width), "height": int(image.Height), "colorSpace": info.kind}
        if info.kind == "rgb" or (info.base is not None and info.base.kind == "rgb"):
            errors.append(f"{where} : image RVB")
        elif info.kind == "cmyk":
            try:
                pil = decode_image(image)
                entry["maxInk"] = image_max_ink(pil) if pil.mode == "CMYK" else None
            except Exception as error:  # noqa: BLE001
                errors.append(f"{where} : image illisible ({error})")
                continue
            if entry["maxInk"] is not None:
                worst = max(worst, entry["maxInk"])
                if max_ink and entry["maxInk"] > max_ink + 0.5:
                    errors.append(f"{where} : encrage {entry['maxInk']} % au-delà de {max_ink} %")
        images.append(entry)
    stats["images"] = images
    stats["maxInkImages"] = worst


def _same_cmyk(a, b) -> bool:
    # Les encres du PDF sont écrites au 1/10 000 près (pdf_cmyk.num) : une marge d'un demi-millième suffit.
    return len(a) == 4 and all(abs(x - y) < 0.0006 for x, y in zip(a, b))


def check_small_text(analyzer, errors, warnings, stats, small_text_pt, max_inks, exceptions, strict) -> None:
    """Petits textes : sous `small_text_pt`, au plus `max_inks` encres, hors couleurs d'exception (0-1)."""
    small = [t for t in analyzer.texts if t["size"] < small_text_pt]
    summary: Counter = Counter()
    for text in small:
        paint = text["paint"]
        cmyk = paint.cmyk()
        exception = cmyk is not None and any(_same_cmyk(cmyk, e) for e in exceptions)
        summary[(paint.describe(), paint.inks(), exception)] += 1
    stats["smallText"] = [{"color": color, "inks": inks, "exception": exception, "count": n} for (color, inks, exception), n in summary.most_common()]
    stats["smallTextCount"] = len(small)
    for (color, inks, exception), n in summary.items():
        if inks is None:
            warnings.append(f"Texte de moins de {small_text_pt} pt en {color} ({n} passages de texte) : encres inconnues")
        elif max_inks is not None and inks > max_inks and not exception:
            message = f"Texte de moins de {small_text_pt} pt en {inks} encres (au plus {max_inks} hors nuances d'accent) : {color} ({n} passages de texte)"
            (errors if strict else warnings).append(message)


def check_file(
    path,
    max_ink=None,
    trim_mm=None,
    bleed_mm=None,
    standard: str = "PDF/X-4",
    small_text_pt: float = 9,
    pdfx: bool = True,
    small_text_max_inks: int | None = 2,
    small_text_exceptions: list | None = None,
    small_text_strict: bool = False,
    expected_fonts: list[str] | None = None,
) -> dict:
    """`small_text_exceptions` : encres des nuances d'accent, en % (0-100) ; `expected_fonts` : noms PostScript."""
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict = {}
    pdf = pikepdf.open(path)
    try:
        stats["version"] = pdf.pdf_version
        if pdfx and pdf.pdf_version != "1.6":
            errors.append(f"Version PDF {pdf.pdf_version} au lieu de 1.6")
        if pdf.is_encrypted:
            errors.append("PDF chiffré")
        names = pdf.Root.get("/Names")
        if pdf.Root.get("/OpenAction") is not None or pdf.Root.get("/AA") is not None or (isinstance(names, Dictionary) and "/JavaScript" in names):
            errors.append("Action automatique ou JavaScript présent")
        if pdfx:
            check_output_intent(pdf, errors, stats)
            check_metadata(pdf, errors, stats, standard)
        check_boxes(pdf, errors, stats, trim_mm, bleed_mm)

        for page_index, page in enumerate(pdf.pages):
            for annot in page.obj.get("/Annots") or []:
                if annot.get("/Subtype") not in ("/PrinterMark", "/TrapNet"):
                    errors.append(f"page {page_index + 1} : annotation {annot.get('/Subtype')} interdite en PDF/X")
        check_fonts(pdf, errors, warnings, stats, set(expected_fonts or []))

        analyzer = StreamAnalyzer(small_text_pt)
        for index, page in enumerate(pdf.pages):
            analyzer.run(page, page_resources(page), IDENTITY, f"page {index + 1}", index)
        # Les flux hors pages (masques, motifs, glyphes) peuvent aussi porter du RVB.
        for visit in iter_contents(pdf):
            if visit.kind in ("pattern", "smask", "charproc", "annotation"):
                analyzer.run(visit.owner, visit.resources, IDENTITY, visit.where, visit.page_index)
        if analyzer.rgb_ops:
            ops = ", ".join(f"{op} × {n}" for op, n in analyzer.rgb_ops.items())
            errors.append(f"Opérateurs RVB restants ({ops}) : {', '.join(sorted(analyzer.rgb_where)[:5])}")
        check_color_spaces(pdf, errors)
        check_images(pdf, errors, stats, max_ink)

        worst_vector = 0.0
        over = []
        for values, count in analyzer.cmyk_values.items():
            total = sum(values) * 100
            worst_vector = max(worst_vector, total)
            if max_ink and total > max_ink + 0.5:
                over.append(f"C{round(values[0] * 100)} M{round(values[1] * 100)} J{round(values[2] * 100)} N{round(values[3] * 100)} = {total:.0f} % ({count} fois)")
        if over:
            errors.append(f"Encrage au-delà de {max_ink} % : {'; '.join(over)}")
        stats["maxInkVector"] = round(worst_vector, 1)

        exceptions = [[float(v) / 100 for v in e] for e in (small_text_exceptions or [])]
        check_small_text(analyzer, errors, warnings, stats, small_text_pt, small_text_max_inks, exceptions, small_text_strict)
    finally:
        pdf.close()
    return {"ok": not errors, "errors": errors, "warnings": warnings, "stats": stats}


def main() -> None:
    parser = argparse.ArgumentParser(description="Contrôle PDF/X-4 maison")
    parser.add_argument("pdf")
    parser.add_argument("--max-ink", type=float, default=None)
    parser.add_argument("--trim", default=None, help="format fini attendu, ex. 297x210")
    parser.add_argument("--bleed", type=float, default=None)
    parser.add_argument("--standard", default="PDF/X-4")
    parser.add_argument("--small-text-strict", action="store_true", help="petit texte à trop d'encres = erreur (export imprimeur)")
    parser.add_argument("--small-text-exception", action="append", default=[], help="encres d'une nuance d'accent, ex. 81,27,39,10")
    parser.add_argument("--expected-font", action="append", default=[], help="nom PostScript attendu, ex. OpenSans-Regular")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    trim = tuple(float(v) for v in args.trim.lower().split("x")) if args.trim else None
    result = check_file(
        Path(args.pdf),
        args.max_ink,
        trim,
        args.bleed,
        args.standard,
        small_text_exceptions=[[float(v) for v in e.split(",")] for e in args.small_text_exception],
        small_text_strict=args.small_text_strict,
        expected_fonts=args.expected_font or None,
    )
    if args.json:
        emit(result)
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print("Conforme" if result["ok"] else "NON CONFORME")
        for e in result["errors"]:
            print(f"  erreur : {e}")
        for w in result["warnings"]:
            print(f"  avertissement : {w}")
        print(f"  encrage max : vecteurs {result['stats'].get('maxInkVector')} %, photos {result['stats'].get('maxInkImages')} %")
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
