"""Post-traitement CMJN du PDF de Chrome (tâches 4.2 et 4.5, décisions P1 et P2).

Chrome n'écrit que du RVB. Ce script :
1. remplace chaque couleur vectorielle `r g b rg` / `RG` (et `sc`/`scn` dans un espace RVB) par les
   valeurs CMJN EXACTES de sa nuance (`c m y k k` / `K`), d'après la table du nuancier (RVB arrondi à
   l'unité) ; une couleur absente de la table est convertie par le profil et signalée ;
2. convertit chaque photo RVB en CMJN avec le profil (intention perceptive), à nombre de pixels égal,
   encrage limité ; masques de transparence gardés ;
3. passe les groupes de transparence en CMJN (les masques de luminosité en niveaux de gris) ;
4. rend le fichier conforme PDF/X-4 : version 1.6, OutputIntent GTS_PDFX avec le profil incorporé,
   XMP, /GTS_PDFXVersion, /Trapped /False ; en option, traits de coupe et repères de pli.

Usage : python pdf_cmyk.py <travail.json>
Le travail (écrit par server/export.ts) : {"input", "output", "profile", "presetFile"?, "imageIntent",
"vectorIntent", "blackPointCompensation", "maxInk", "colorTable": [{"rgb", "cmyk", "name"}], "pdfx":
{"standard", "title", "createdAt"}, "marks": null | {"margin", "bleed", "folds": [[mm…] par page]},
"downsample"?: {"ppi", "abovePpi"}, "cmykOriginals"?: [{"assetId", "name", "path"}], "smallText"?: {"pt",
"maxInks", "exceptions": [[c, m, j, n]…], "strict"}, "expectedFonts"?: [nom PostScript…]}.
Réponse JSON sur la sortie standard : couleurs inconnues, photos converties, résultat du contrôle.
"""
from __future__ import annotations

import json
import sys
import uuid
import zlib
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, Operator, Stream

from printcore import (
    PrintError,
    emit,
    fail,
    hex_to_rgb,
    image_max_ink,
    limit_ink_image,
    load_presets,
    resolve_profile,
    rgb_image_to_cmyk,
    rgb_list_to_cmyk,
    rgb_to_hex,
)
from pdfwalk import ContentVisit, color_space_info, decode_image, effective_ppi, image_usages, iter_contents, iter_images, iter_shadings

# Seule norme produite : PDF/X-1a exigerait d'aplatir la transparence et de passer en PDF 1.3 (audit A6).
SUPPORTED_STANDARDS = ("PDF/X-4",)

MM = 72 / 25.4
PRODUCER = "Fluidprint (Chrome/Skia, pikepdf)"
CREATOR = "Fluidprint"


def num(value: float) -> Decimal:
    """Nombre court et exact pour un flux de contenu (0.83, pas 0.8299999)."""
    d = Decimal(f"{value:.4f}").normalize()
    return Decimal(0) if d == 0 else d


# ---------------------------------------------------------------- table des couleurs


class ColorMapper:
    """RVB (0-1, tel que Chrome l'écrit) → CMJN (0-1) d'après le nuancier, sinon par le profil."""

    def __init__(self, table: list[dict], profile: Path, intent: str, bpc: bool, max_ink: float | None):
        self.profile, self.intent, self.bpc, self.max_ink = profile, intent, bpc, max_ink
        self.table: dict[tuple[int, int, int], list[float]] = {}
        self.names: dict[tuple[int, int, int], str] = {}
        self.conflicts: list[str] = []
        for entry in table:
            key = hex_to_rgb(entry["rgb"])
            cmyk = [float(v) for v in entry["cmyk"]]
            if key in self.table and self.table[key] != cmyk:
                self.conflicts.append(
                    f"{entry['rgb']} : « {self.names[key]} » et « {entry.get('name', '?')} » ont le même RVB mais pas le même CMJN ; « {self.names[key]} » l'emporte"
                )
                continue
            self.table[key] = cmyk
            self.names[key] = entry.get("name", entry["rgb"])
        self.unknown: Counter = Counter()
        self.unknown_where: dict[tuple[int, int, int], set[str]] = defaultdict(set)
        self._converted: dict[tuple[int, int, int], list[float]] = {}
        self.used: Counter = Counter()

    def percent(self, rgb: tuple[int, int, int], where: str = "") -> list[float]:
        if rgb in self.table:
            self.used[rgb] += 1
            return self.table[rgb]
        # Papier et noir « pur » : jamais un mélange (le fond blanc de la face, un noir par défaut).
        if rgb == (255, 255, 255):
            return [0.0, 0.0, 0.0, 0.0]
        if rgb == (0, 0, 0):
            return [0.0, 0.0, 0.0, 100.0]
        if rgb not in self._converted:
            self._converted[rgb] = [float(v) for v in rgb_list_to_cmyk([rgb_to_hex(rgb)], self.profile, self.intent, self.bpc, self.max_ink)[0]]
        self.unknown[rgb] += 1
        if where:
            self.unknown_where[rgb].add(where)
        return self._converted[rgb]

    def fraction(self, components, where: str = "") -> list[float]:
        rgb = tuple(max(0, min(255, round(float(v) * 255))) for v in components[:3])
        return [v / 100 for v in self.percent(rgb, where)]  # type: ignore[arg-type]


def luminance(components) -> float:
    r, g, b = (float(v) for v in components[:3])
    return 0.3 * r + 0.59 * g + 0.11 * b


# ---------------------------------------------------------------- flux de contenu


class ContentRewriter:
    def __init__(self, pdf: pikepdf.Pdf, mapper: ColorMapper):
        self.pdf = pdf
        self.mapper = mapper
        self.errors: list[str] = []
        self.rewritten = 0

    def rewrite(self, visit: ContentVisit) -> None:
        instructions = pikepdf.parse_content_stream(visit.owner)
        out = []
        changed = False
        # Espace de remplissage et de trait courant : « rgb » si un `cs` a choisi un espace RVB.
        fill_rgb = stroke_rgb = False
        stack: list[tuple[bool, bool]] = []
        for item in instructions:
            if isinstance(item, pikepdf.ContentStreamInlineImage):
                try:
                    space = str(item.iimage.colorspace or "")
                except Exception:  # noqa: BLE001 — espace nommé introuvable : signalé comme inconnu
                    space = "?"
                if space in ("/DeviceRGB", "/RGB", "/CalRGB", "?") or item.iimage.indexed:
                    self.errors.append(f"{visit.where} : image en ligne ({space or 'indexée'}) non convertie")
                out.append(item)
                continue
            operands, operator = item.operands, str(item.operator)
            if operator == "q":
                stack.append((fill_rgb, stroke_rgb))
            elif operator == "Q" and stack:
                fill_rgb, stroke_rgb = stack.pop()
            if operator in ("rg", "RG") and len(operands) == 3:
                changed = True
                if visit.smask:
                    out.append(([num(luminance(operands))], Operator("g" if operator == "rg" else "G")))
                else:
                    cmyk = self.mapper.fraction(operands, visit.where)
                    out.append(([num(v) for v in cmyk], Operator("k" if operator == "rg" else "K")))
                continue
            if operator in ("cs", "CS") and operands:
                info = color_space_info(operands[0], visit.resources)
                is_rgb = info.kind == "rgb"
                if operator == "cs":
                    fill_rgb = is_rgb
                else:
                    stroke_rgb = is_rgb
                if is_rgb:
                    changed = True
                    target = Name.DeviceGray if visit.smask else Name.DeviceCMYK
                    out.append(([target], Operator(operator)))
                    continue
            if operator in ("sc", "scn", "SC", "SCN"):
                current_rgb = fill_rgb if operator in ("sc", "scn") else stroke_rgb
                numeric = [o for o in operands if not isinstance(o, Name)]
                if current_rgb and len(numeric) == 3 and len(operands) == 3:
                    changed = True
                    if visit.smask:
                        out.append(([num(luminance(numeric))], Operator(operator)))
                    else:
                        out.append(([num(v) for v in self.mapper.fraction(numeric, visit.where)], Operator(operator)))
                    continue
            out.append(item)
        if not changed:
            return
        data = pikepdf.unparse_content_stream(out)
        if isinstance(visit.owner, pikepdf.Page):
            visit.owner.obj.Contents = self.pdf.make_stream(data)
        else:
            visit.owner.write(data)
        self.rewritten += 1


# ---------------------------------------------------------------- groupes, masques, dégradés


def fix_groups(pdf: pikepdf.Pdf, visits: list[ContentVisit]) -> None:
    for visit in visits:
        if visit.kind == "page":
            page = visit.owner.obj
            group = page.get("/Group")
            if not isinstance(group, Dictionary):
                group = Dictionary(Type=Name.Group, S=Name.Transparency)
            group.CS = Name.DeviceCMYK
            page.Group = group
            continue
        if not isinstance(visit.owner, Stream):
            continue
        group = visit.owner.get("/Group")
        if isinstance(group, Dictionary) and group.get("/S") == "/Transparency":
            if visit.smask:
                group.CS = Name.DeviceGray
            elif "/CS" in group and color_space_info(group.CS).kind != "cmyk":
                group.CS = Name.DeviceCMYK
        if visit.kind == "smask":
            mask = visit.extra.get("mask")
            bc = mask.get("/BC") if mask is not None else None
            if isinstance(bc, Array) and len(bc) == 3:
                mask.BC = Array([num(luminance(bc))])


def convert_function(fn, mapper: ColorMapper, where: str):
    """Fonction d'un dégradé RVB → CMJN (types 2 et 3)."""
    ftype = int(fn.get("/FunctionType", -1))
    if ftype == 2:
        c0 = fn.get("/C0") or Array([0, 0, 0])
        c1 = fn.get("/C1") or Array([1, 1, 1])
        fn.C0 = Array([num(v) for v in mapper.fraction(list(c0), where)])
        fn.C1 = Array([num(v) for v in mapper.fraction(list(c1), where)])
        if "/Range" in fn:
            fn.Range = Array([0, 1] * 4)
        return fn
    if ftype == 3:
        fn.Functions = Array([convert_function(f, mapper, where) for f in fn.Functions])
        if "/Range" in fn:
            fn.Range = Array([0, 1] * 4)
        return fn
    raise PrintError(f"{where} : dégradé RVB à fonction de type {ftype} non pris en charge")


def convert_shadings(pdf: pikepdf.Pdf, mapper: ColorMapper, errors: list[str]) -> int:
    count = 0
    for shading, where in iter_shadings(pdf):
        info = color_space_info(shading.get("/ColorSpace"))
        if info.kind != "rgb":
            continue
        stype = int(shading.get("/ShadingType", 0))
        fn = shading.get("/Function")
        if stype not in (1, 2, 3) or fn is None or isinstance(fn, Array):
            errors.append(f"{where} : dégradé RVB de type {stype} non converti")
            continue
        try:
            shading.Function = convert_function(fn, mapper, where)
        except PrintError as error:
            errors.append(str(error))
            continue
        shading.ColorSpace = Name.DeviceCMYK
        if isinstance(shading.get("/Background"), Array):
            shading.Background = Array([num(v) for v in mapper.fraction(list(shading.Background), where)])
        count += 1
    return count


# ---------------------------------------------------------------- photos


class CmykOriginals:
    """Photos du document dont l'original est en CMJN (audit C4).

    Chrome ne sait afficher qu'en RVB : il décode l'original CMJN en sRGB, et reconvertir ce RVB en CMJN
    perdait la séparation du photographe (noir, encrage des ombres). On retrouve donc l'image du PDF par ses
    dimensions (orientation EXIF appliquée, comme Chrome) et l'on y remet les pixels CMJN de l'original :
    tels quels s'il est au profil de sortie (ou sans profil), sinon convertis de CMJN à CMJN."""

    def __init__(self, entries: list[dict], profile: Path, intent: str, bpc: bool):
        from PIL import Image, ImageOps

        self.profile, self.intent, self.bpc = profile, intent, bpc
        self.entries: list[dict] = []
        for entry in entries or []:
            try:
                with Image.open(entry["path"]) as img:
                    if img.mode != "CMYK":
                        continue
                    img.load()
                    oriented = ImageOps.exif_transpose(img)
                    self.entries.append({**entry, "image": oriented, "icc": img.info.get("icc_profile"), "matched": 0})
            except OSError as error:
                self.entries.append({**entry, "image": None, "error": str(error), "matched": 0})

    def _proxy(self, entry: dict):
        """Aperçu RVB de l'original, pour départager deux originaux de mêmes dimensions."""
        from PIL import ImageCms

        from printcore import profile_from_bytes, srgb_profile

        source = profile_from_bytes(entry["icc"]) if entry["icc"] else ImageCms.getOpenProfile(str(self.profile))
        small = entry["image"].copy()
        small.thumbnail((48, 48))
        return ImageCms.applyTransform(small, ImageCms.buildTransform(source, srgb_profile(), "CMYK", "RGB", ImageCms.Intent.RELATIVE_COLORIMETRIC))

    def find(self, rgb_image, width: int, height: int) -> dict | None:
        from PIL import ImageChops, ImageStat

        candidates = [e for e in self.entries if e.get("image") is not None and e["image"].size == (width, height)]
        if len(candidates) <= 1:
            return candidates[0] if candidates else None
        seen = rgb_image.convert("RGB")
        seen.thumbnail((48, 48))

        def distance(entry):
            proxy = self._proxy(entry).resize(seen.size)
            return sum(ImageStat.Stat(ImageChops.difference(proxy, seen)).mean)

        return min(candidates, key=distance)

    def pixels(self, entry: dict):
        """Pixels CMJN de l'original au profil de sortie, et comment ils y ont été amenés."""
        from PIL import ImageCms

        from printcore import INTENTS, profile_from_bytes

        image = entry["image"]
        target = self.profile.read_bytes()
        if not entry["icc"]:
            return image, "sans profil incorporé : tenu pour le profil de sortie"
        if entry["icc"] == target:
            return image, "au profil de sortie : pixels d'origine"
        source = profile_from_bytes(entry["icc"])
        description = ImageCms.getProfileDescription(source).strip()
        if description and description == ImageCms.getProfileDescription(ImageCms.getOpenProfile(str(self.profile))).strip():
            return image, "au profil de sortie : pixels d'origine"
        flags = int(ImageCms.Flags.BLACKPOINTCOMPENSATION) if self.bpc else 0
        transform = ImageCms.buildTransform(source, ImageCms.getOpenProfile(str(self.profile)), "CMYK", "CMYK", INTENTS[self.intent], flags=flags)
        return ImageCms.applyTransform(image, transform), f"converti de {description or 'son profil'} au profil de sortie"

    def report(self) -> list[dict]:
        return [{"name": e.get("name") or Path(e["path"]).name, "asset": e.get("assetId"), "matched": e["matched"], **({"error": e["error"]} if e.get("error") else {})} for e in self.entries]


def _write_pixels(image: Stream, pixels, color_space) -> None:
    # Flate, sans perte : un JPEG CMJN n'est pas lu de la même façon par tous les RIP (inversion Adobe).
    image.write(zlib.compress(pixels.tobytes(), 6), filter=Name.FlateDecode)
    image.ColorSpace = color_space
    image.BitsPerComponent = 8
    image.Width, image.Height = pixels.size
    for key in ("/DecodeParms", "/Decode"):
        if key in image:
            del image[key]


def _resize_mask(image: Stream, size: tuple[int, int]) -> None:
    from PIL import Image

    mask = image.get("/SMask")
    if not isinstance(mask, Stream) or (int(mask.Width), int(mask.Height)) == size:
        return
    alpha = decode_image(mask).convert("L").resize(size, Image.Resampling.LANCZOS)
    _write_pixels(mask, alpha, Name.DeviceGray)


def convert_images(
    pdf: pikepdf.Pdf,
    profile: Path,
    intent: str,
    bpc: bool,
    max_ink: float | None,
    mapper: ColorMapper,
    errors: list[str],
    downsample: dict | None = None,
    originals: CmykOriginals | None = None,
) -> list[dict]:
    """Photos RVB → CMJN. `downsample` ({"ppi", "abovePpi"}) : une photo affichée au-delà de `abovePpi` est
    réduite à `ppi` (audit B4 : 5 photos à 1 880 ppi faisaient un PDF de 110 Mo, sans gain à l'impression)."""
    from PIL import Image

    usages = image_usages(pdf) if downsample else {}
    report = []
    for image, where, _page, smask, _res in iter_images(pdf):
        if image.get("/ImageMask"):
            continue
        info = color_space_info(image.get("/ColorSpace"))
        if info.kind == "indexed" and info.base and info.base.kind == "rgb":
            lookup = image.ColorSpace[3]
            raw = bytes(lookup.read_bytes()) if isinstance(lookup, Stream) else bytes(lookup)
            entries = [rgb_to_hex(raw[i : i + 3]) for i in range(0, len(raw) - 2, 3)]
            cmyk = rgb_list_to_cmyk(entries, profile, intent, bpc, max_ink)
            table = bytes(round(v * 255 / 100) for c in cmyk for v in c)
            image.ColorSpace = Array([Name.Indexed, Name.DeviceCMYK, image.ColorSpace[2], pikepdf.String(table)])
            report.append({"name": where, "width": int(image.Width), "height": int(image.Height), "from": "indexed-rgb", "to": "indexed-cmyk"})
            continue
        if info.kind != "rgb":
            continue
        try:
            pil = decode_image(image)
        except Exception as error:  # noqa: BLE001 — une image illisible est signalée, pas ignorée
            errors.append(f"{where} : photo illisible ({error})")
            continue
        width, height = int(image.Width), int(image.Height)
        if pil.size != (width, height):
            errors.append(f"{where} : taille décodée {pil.size} différente de {width} × {height}")
            continue
        source_filter = str(image.get("/Filter", "")) if not isinstance(image.get("/Filter"), Array) else "+".join(str(f) for f in image.Filter)
        entry: dict = {"name": where, "width": width, "height": height}
        original = originals.find(pil, width, height) if originals and not smask else None
        if smask:
            converted = pil.convert("L")
            target_cs = Name.DeviceGray
            entry["from"] = f"rgb{' (ICC)' if info.icc else ''} {source_filter}".strip()
        elif original is not None:
            converted, how = originals.pixels(original)
            original["matched"] += 1
            target_cs = Name.DeviceCMYK
            entry["from"] = f"original CMJN « {original.get('name') or Path(original['path']).name} » ({how})"
        else:
            converted = None
            target_cs = Name.DeviceCMYK
            entry["from"] = f"rgb{' (ICC)' if info.icc else ''} {source_filter}".strip()
        # Réduction avant conversion : moins de pixels à convertir, et la même photo au final.
        ppi = effective_ppi(image, usages.get(image.objgen)) if downsample else None
        if ppi is not None and ppi > float(downsample["abovePpi"]) + 0.5:
            factor = float(downsample["ppi"]) / ppi
            size = (max(1, round(width * factor)), max(1, round(height * factor)))
            if converted is not None:
                converted = converted.resize(size, Image.Resampling.LANCZOS)
            else:
                pil = pil.convert("RGB").resize(size, Image.Resampling.LANCZOS)
            _resize_mask(image, size)
            entry.update({"resampledFrom": [width, height], "ppi": round(ppi), "width": size[0], "height": size[1]})
        if converted is None:
            converted = rgb_image_to_cmyk(pil, profile, intent, bpc, info.icc, max_ink)
        elif original is not None:
            # Après la réduction : le filtre de Lanczos peut dépasser un peu les valeurs d'origine.
            converted = limit_ink_image(converted, max_ink)
        _write_pixels(image, converted, target_cs)
        entry.update({"to": "gray" if smask else "cmyk", "maxInk": image_max_ink(converted), "hasSMask": "/SMask" in image})
        report.append(entry)
    return report


# ---------------------------------------------------------------- PDF/X


def pdf_date(dt: datetime) -> str:
    offset = dt.strftime("%z") or "+0000"
    return f"D:{dt.strftime('%Y%m%d%H%M%S')}{offset[:3]}'{offset[3:]}'"


def xmp_date(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def remove_annotations(pdf: pikepdf.Pdf) -> int:
    removed = 0
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not annots:
            continue
        kept = Array([a for a in annots if a.get("/Subtype") in ("/PrinterMark", "/TrapNet")])
        removed += len(annots) - len(kept)
        if len(kept):
            page.obj.Annots = kept
        else:
            del page.obj["/Annots"]
    return removed


def apply_pdfx(pdf: pikepdf.Pdf, profile: Path, profile_meta: dict, job: dict) -> None:
    pdfx = job.get("pdfx") or {}
    standard = pdfx.get("standard") or "PDF/X-4"
    if standard not in SUPPORTED_STANDARDS:
        # Écrire « PDF/X-1a » sur un fichier PDF 1.6 à transparence vivante le rendrait faussement conforme.
        raise PrintError(f"Norme « {standard} » non prise en charge : seule PDF/X-4 est produite (PDF/X-1a exigerait d'aplatir la transparence)")
    title = pdfx.get("title") or "Sans titre"
    created = datetime.fromisoformat(pdfx["createdAt"]) if pdfx.get("createdAt") else datetime.now().astimezone()
    if created.tzinfo is None:
        created = created.astimezone()
    created = created.replace(microsecond=0)

    icc = pdf.make_stream(profile.read_bytes())
    icc.N = 4
    intent = Dictionary(
        Type=Name.OutputIntent,
        S=Name.GTS_PDFX,
        OutputConditionIdentifier=pikepdf.String(profile_meta["outputConditionIdentifier"]),
        OutputCondition=pikepdf.String(profile_meta.get("outputCondition", "")),
        RegistryName=pikepdf.String(profile_meta.get("registryName", "http://www.color.org")),
        Info=pikepdf.String(profile_meta.get("info", profile_meta.get("outputCondition", ""))),
        DestOutputProfile=icc,
    )
    pdf.Root.OutputIntents = Array([pdf.make_indirect(intent)])

    info = pdf.docinfo
    for key in list(info.keys()):
        del info[key]
    info.Title = pikepdf.String(title)
    info.Creator = pikepdf.String(CREATOR)
    info.Producer = pikepdf.String(PRODUCER)
    info.CreationDate = pikepdf.String(pdf_date(created))
    info.ModDate = pikepdf.String(pdf_date(created))
    info.Trapped = Name("/False")
    info.GTS_PDFXVersion = pikepdf.String(standard)

    doc_id = f"uuid:{uuid.uuid4()}"
    with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
        meta["dc:title"] = title
        meta["xmp:CreateDate"] = xmp_date(created)
        meta["xmp:ModifyDate"] = xmp_date(created)
        meta["xmp:MetadataDate"] = xmp_date(created)
        meta["xmp:CreatorTool"] = CREATOR
        meta["pdf:Producer"] = PRODUCER
        meta["pdf:Trapped"] = "False"
        meta["pdfxid:GTS_PDFXVersion"] = standard
        meta["xmpMM:DocumentID"] = doc_id
        meta["xmpMM:InstanceID"] = doc_id
        meta["xmpMM:VersionID"] = "1"
        meta["xmpMM:RenditionClass"] = "default"


# ---------------------------------------------------------------- traits de coupe et repères de pli


def add_marks(pdf: pikepdf.Pdf, marks: dict) -> None:
    """Agrandit chaque page de `margin` mm et dessine, hors du fond perdu, les traits de coupe et les
    repères de pli (couleur de repérage /All : visible sur toutes les plaques)."""
    margin = float(marks.get("margin", 10)) * MM
    folds_by_page = marks.get("folds") or []
    registration = Array(
        [
            Name.Separation,
            Name.All,
            Name.DeviceCMYK,
            Dictionary(FunctionType=2, Domain=Array([0, 1]), C0=Array([0, 0, 0, 0]), C1=Array([1, 1, 1, 1]), N=1),
        ]
    )
    for index, page in enumerate(pdf.pages):
        media = [float(v) for v in page.obj.MediaBox]
        trim = [float(v) for v in page.obj.get("/TrimBox", page.obj.MediaBox)]
        bleed = [float(v) for v in page.obj.get("/BleedBox", page.obj.MediaBox)]
        tx, ty = margin - media[0], margin - media[1]
        w, h = media[2] - media[0], media[3] - media[1]
        shift = lambda box: [box[0] + tx, box[1] + ty, box[2] + tx, box[3] + ty]  # noqa: E731
        trim, bleed = shift(trim), shift(bleed)
        page.obj.MediaBox = Array([0, 0, num(w + 2 * margin), num(h + 2 * margin)])
        page.obj.BleedBox = Array([num(v) for v in bleed])
        page.obj.TrimBox = Array([num(v) for v in trim])
        if "/CropBox" in page.obj:
            del page.obj["/CropBox"]

        resources = page.obj.get("/Resources")
        if resources is None:
            resources = page.obj.Resources = Dictionary()
        spaces = resources.get("/ColorSpace")
        if spaces is None:
            spaces = resources.ColorSpace = Dictionary()
        spaces.CSRepere = registration

        # Traits : de 1 mm au-delà du fond perdu jusqu'à 1 mm du bord de la page.
        gap = (trim[0] - bleed[0]) + 1 * MM
        length_end = margin + (trim[0] - bleed[0]) - 1 * MM
        lines = []
        x0, y0, x1, y1 = trim
        for x, sx in ((x0, -1), (x1, 1)):
            for y, sy in ((y0, -1), (y1, 1)):
                lines.append(((x + sx * gap, y), (x + sx * length_end, y)))
                lines.append(((x, y + sy * gap), (x, y + sy * length_end)))
        ops = ["q", "/CSRepere CS 1 SCN", f"{num(0.25)} w", "[] 0 d"]
        for (ax, ay), (bx, by) in lines:
            ops.append(f"{num(ax)} {num(ay)} m {num(bx)} {num(by)} l S")
        folds = folds_by_page[index] if index < len(folds_by_page) else []
        if folds:
            ops.append(f"[{num(1 * MM)} {num(0.8 * MM)}] 0 d")
            for fold in folds:
                fx = x0 + float(fold) * MM
                ops.append(f"{num(fx)} {num(y1 + gap)} m {num(fx)} {num(y1 + length_end)} l S")
                ops.append(f"{num(fx)} {num(y0 - gap)} m {num(fx)} {num(y0 - length_end)} l S")
        ops.append("Q")
        before = pdf.make_stream(f"q 1 0 0 1 {num(tx)} {num(ty)} cm\n".encode("latin-1"))
        after = pdf.make_stream(("\nQ\n" + "\n".join(ops) + "\n").encode("latin-1"))
        contents = page.obj.Contents
        parts = list(contents) if isinstance(contents, Array) else [contents]
        page.obj.Contents = Array([before, *parts, after])


# ---------------------------------------------------------------- programme


def process(job: dict) -> dict:
    presets = load_presets(job.get("presetFile"))
    profile, profile_meta = resolve_profile(job["profile"], presets)
    bpc = bool(job.get("blackPointCompensation", True))
    max_ink = job.get("maxInk")
    mapper = ColorMapper(job.get("colorTable") or [], profile, job.get("vectorIntent", "relative"), bpc, max_ink)
    standard = (job.get("pdfx") or {}).get("standard") or "PDF/X-4"
    if job.get("pdfx") and standard not in SUPPORTED_STANDARDS:
        raise PrintError(f"Norme « {standard} » non prise en charge : seule PDF/X-4 est produite (PDF/X-1a exigerait d'aplatir la transparence)")
    image_intent = job.get("imageIntent", "perceptual")
    originals = CmykOriginals(job.get("cmykOriginals") or [], profile, image_intent, bpc)

    pdf = pikepdf.open(job["input"])
    errors: list[str] = []
    visits = list(iter_contents(pdf))
    rewriter = ContentRewriter(pdf, mapper)
    for visit in visits:
        rewriter.rewrite(visit)
    errors.extend(rewriter.errors)
    shadings = convert_shadings(pdf, mapper, errors)
    images = convert_images(pdf, profile, image_intent, bpc, max_ink, mapper, errors, job.get("downsample"), originals)
    fix_groups(pdf, visits)

    removed = 0
    if job.get("pdfx"):
        removed = remove_annotations(pdf)
        apply_pdfx(pdf, profile, profile_meta, job)
    if job.get("marks"):
        add_marks(pdf, job["marks"])

    output = Path(job["output"])
    pdf.save(
        output,
        force_version="1.6" if job.get("pdfx") else None,
        object_stream_mode=pikepdf.ObjectStreamMode.disable,
        compress_streams=True,
        fix_metadata_version=True,
    )
    pdf.close()

    unknown = [
        {"rgb": rgb_to_hex(rgb), "cmyk": [round(v) for v in mapper._converted[rgb]], "count": n, "where": sorted(mapper.unknown_where[rgb])[:5]}
        for rgb, n in mapper.unknown.most_common()
    ]
    report = {
        "output": str(output),
        "profile": str(profile),
        "outputCondition": profile_meta.get("outputConditionIdentifier"),
        "unknownColors": unknown,
        "conflicts": mapper.conflicts,
        "swatchesUsed": {mapper.names[rgb]: n for rgb, n in mapper.used.items()},
        "images": images,
        "cmykOriginals": originals.report(),
        "shadings": shadings,
        "annotationsRemoved": removed,
        "errors": errors,
    }
    if job.get("check", True) and job.get("pdfx"):
        from check_pdfx import check_file

        small = job.get("smallText") or {}
        report["check"] = check_file(
            output,
            max_ink=max_ink,
            trim_mm=job.get("trimMm"),
            bleed_mm=job.get("bleedMm"),
            standard=standard,
            small_text_pt=small.get("pt", job.get("smallTextPt", 9)),
            small_text_max_inks=small.get("maxInks", 2),
            small_text_exceptions=small.get("exceptions"),
            small_text_strict=bool(small.get("strict", False)),
            expected_fonts=job.get("expectedFonts"),
        )
    return report


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage : python pdf_cmyk.py <travail.json>")
    try:
        job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        emit(process(job))
    except PrintError as error:
        fail(str(error))
    except pikepdf.PdfError as error:
        fail(f"PDF illisible : {error}")


if __name__ == "__main__":
    main()
