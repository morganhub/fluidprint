"""Photos provisoires tirées d'un PDF : les images d'un PDF deviennent les photos provisoires d'un document.

Extrait les images du PDF (pikepdf), masque de transparence compris, dans l'ordre où les pages les peignent ;
les range dans documents/<id>/assets/originals/provisoire-<n>.png et les ajoute à doc.assets avec
« placeholder: true ». Elles tiennent la place des originaux HD : filigrane « provisoire » à l'écran,
avertissement à l'export, refus de l'export imprimeur. Avec --fill, elles garnissent aussi les cadres vides
du document, dans l'ordre : première photo dans le premier cadre (pages dans l'ordre, puis ordre
d'empilement), et ainsi de suite, en Remplir.

Relançable : les photos provisoires sont réécrites et replacées ; un cadre qui porte une vraie photo (non
provisoire) n'est jamais touché ; une photo provisoire d'une extraction précédente qui ne sert plus quitte
la liste des images (son fichier reste sur le disque).

Usage : npm run extract-pdf-images -- --pdf <fichier> --doc <id> [--documents <dossier>] [--fill]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import pikepdf
from PIL import Image
from pikepdf import PdfImage

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DOCUMENTS = Path(os.environ.get("FLUIDPRINT_DOCUMENTS_DIR", PROJECT_ROOT / "documents"))

# Une photo, pas un décor : plus de 150 × 150 px en surface, et 100 px au moins de côté (les filets et
# bandeaux étirés d'un PDF de mise en page, 459 × 49 px par exemple, ne sont pas des photos).
MIN_AREA_PX = 150 * 150
MIN_SIDE_PX = 100

PREFIX = "provisoire-"
ASSET_PREFIX = "img-provisoire-"


def painted_images(pdf: pikepdf.Pdf):
    """Images du PDF dans l'ordre où elles sont peintes (opérateur Do), formulaires imbriqués compris ;
    une image peinte plusieurs fois n'est rendue qu'une fois."""
    seen: set = set()

    def walk(container, resources, depth=0):
        if depth > 12:
            return
        xobjects = resources.get("/XObject") if resources is not None else None
        for operands, operator in pikepdf.parse_content_stream(container):
            if str(operator) != "Do" or xobjects is None or not operands:
                continue
            xobj = xobjects.get(operands[0])
            if xobj is None or xobj.objgen in seen:
                continue
            seen.add(xobj.objgen)
            subtype = xobj.get("/Subtype")
            if subtype == "/Form":
                walk(xobj, xobj.get("/Resources", resources), depth + 1)
            elif subtype == "/Image":
                yield xobj

    for page in pdf.pages:
        yield from walk(page, page.get("/Resources"))


def to_pil(xobj) -> Image.Image:
    """Image PIL de l'XObject, masque /SMask compris (canal alpha), profil ICC gardé."""
    image = PdfImage(xobj).as_pil_image()
    icc = None
    colorspace = xobj.get("/ColorSpace")
    if isinstance(colorspace, pikepdf.Array) and len(colorspace) > 1 and colorspace[0] == "/ICCBased":
        icc = colorspace[1].read_bytes()
    if "/SMask" in xobj:
        mask = PdfImage(xobj.SMask).as_pil_image().convert("L")
        if mask.size != image.size:
            mask = mask.resize(image.size, Image.LANCZOS)
        image = image.convert("RGB")
        image.putalpha(mask)
    elif image.mode not in ("RGB", "RGBA", "L"):
        image = image.convert("RGB")
    if icc:
        image.info["icc_profile"] = icc
    return image


def extract(pdf_path: Path, out_dir: Path) -> list[dict]:
    """Écrit les photos du PDF (provisoire-1.png, provisoire-2.png…) ; renvoie leur liste, dans l'ordre."""
    photos: list[dict] = []
    ignored: list[str] = []
    with pikepdf.open(pdf_path) as pdf:
        for xobj in painted_images(pdf):
            w, h = int(xobj.Width), int(xobj.Height)
            if w * h <= MIN_AREA_PX or min(w, h) < MIN_SIDE_PX:
                ignored.append(f"{w} × {h} px")
                continue
            image = to_pil(xobj)
            out_dir.mkdir(parents=True, exist_ok=True)
            n = len(photos) + 1
            name = f"{PREFIX}{n}.png"
            tmp = out_dir / f".{name}.part"
            image.save(tmp, "PNG", icc_profile=image.info.get("icc_profile"))
            os.replace(tmp, out_dir / name)
            photos.append({"key": str(n), "file": name, "width": image.width, "height": image.height})
            print(f"  {name} : {image.width} × {image.height} px{' (masque)' if image.mode == 'RGBA' else ''}")
    if ignored:
        print(f"  ignorées (trop petites pour être des photos) : {', '.join(ignored)}")
    return photos


def r4(v: float):
    v = round(v * 1e4) / 1e4
    return int(v) if v == int(v) else v


def fill_placement(frame_w: float, frame_h: float, px_w: int, px_h: int) -> dict:
    """Comme computeImagePlacement('fill') (src/model/frame.ts) : la photo couvre le cadre, centrée."""
    s = max(frame_w / px_w, frame_h / px_h)
    w, h = px_w * s, px_h * s
    return {"x": r4((frame_w - w) / 2), "y": r4((frame_h - h) / 2), "w": r4(w), "h": r4(h)}


def frames_in_order(doc: dict) -> list[dict]:
    """Cadres imprimables du document : pages dans l'ordre, puis ordre d'empilement (groupes compris)."""
    printable = {layer["id"] for layer in doc.get("layers", []) if layer.get("printable", True)}
    objects = doc["objects"]
    out: list[dict] = []

    def walk(ids):
        for oid in ids:
            obj = objects.get(oid)
            if obj is None:
                continue
            if obj.get("type") == "group":
                walk(obj.get("children", []))
            elif obj.get("type") == "frame" and obj.get("layerId") in printable:
                out.append(obj)

    for page in [*doc.get("pages", []), *doc.get("masters", [])]:
        walk(page.get("children", []))
    return out


def update_document(doc_file: Path, photos: list[dict], fill: bool) -> tuple[list[str], list[str]]:
    """Ajoute les photos au document et, avec `fill`, garnit les cadres vides ; renvoie (garnis, restés vides)."""
    doc = json.loads(doc_file.read_text(encoding="utf-8"))
    assets = doc.setdefault("assets", [])
    previous = {a["id"]: (a.get("width"), a.get("height")) for a in assets}
    produced = set()
    for info in photos:
        asset = {
            "id": f"{ASSET_PREFIX}{info['key']}",
            "kind": "image",
            "name": info["file"],
            "original": f"assets/originals/{info['file']}",
            "width": info["width"],
            "height": info["height"],
            "placeholder": True,
        }
        produced.add(asset["id"])
        index = next((i for i, a in enumerate(assets) if a["id"] == asset["id"]), None)
        if index is None:
            assets.append(asset)
        else:
            assets[index] = asset
    by_id = {a["id"]: a for a in assets}

    placed: list[str] = []
    empty: list[str] = []
    fresh = {f"{ASSET_PREFIX}{info['key']}": info for info in photos}
    filled: set[str] = set()
    if fill:
        queue = list(photos)
        for frame in frames_in_order(doc):
            current = frame.get("image")
            if current and not by_id.get(current["assetId"], {}).get("placeholder"):
                print(f"  {frame['id']} garde sa vraie photo ({current['assetId']})")
                continue
            label = f"{frame['id']} ({frame.get('name', '')})"
            if not queue:
                empty.append(label)
                continue
            info = queue.pop(0)
            box = fill_placement(frame["w"], frame["h"], info["width"], info["height"])
            frame["image"] = {"assetId": f"{ASSET_PREFIX}{info['key']}", "fit": "fill", **box, "cover": True}
            filled.add(frame["id"])
            ppi = info["width"] * 25.4 / box["w"]
            placed.append(f"{label} ← {info['file']}, {ppi:.0f} ppi")
    # Une photo provisoire réécrite (mêmes nom et identifiant, autres dimensions) est replacée en Remplir dans
    # les autres cadres qui la montraient déjà : sans cela, son ancien cadrage la déformerait. À dimensions
    # égales, le cadrage choisi à la main est gardé.
    for frame in frames_in_order(doc):
        asset_id = (frame.get("image") or {}).get("assetId")
        info = fresh.get(asset_id)
        if info and frame["id"] not in filled and previous.get(asset_id) != (info["width"], info["height"]):
            frame["image"] = {"assetId": frame["image"]["assetId"], "fit": "fill", **fill_placement(frame["w"], frame["h"], info["width"], info["height"]), "cover": True}

    # Une photo provisoire d'une extraction précédente qui ne sert plus quitte la liste (son fichier reste).
    used = {o["image"]["assetId"] for o in doc["objects"].values() if o.get("type") == "frame" and o.get("image")}
    doc["assets"] = [a for a in assets if not (a.get("placeholder") and a["id"].startswith(ASSET_PREFIX) and a["id"] not in produced and a["id"] not in used)]

    tmp = doc_file.with_name(f".{doc_file.name}.part")
    # Octets écrits tels quels : sous Windows, write_text changerait les \n en \r\n (l'importeur écrit des \n).
    tmp.write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    os.replace(tmp, doc_file)
    return placed, empty


def main() -> int:
    parser = argparse.ArgumentParser(description="Photos provisoires tirées d'un PDF, ajoutées à un document (et placées dans ses cadres vides avec --fill).")
    parser.add_argument("--pdf", type=Path, required=True, help="PDF dont on extrait les images")
    parser.add_argument("--doc", required=True, help="document à compléter (dossier documents/<id>)")
    parser.add_argument("--documents", type=Path, default=DEFAULT_DOCUMENTS, help="dossier des documents")
    parser.add_argument("--fill", action="store_true", help="garnir les cadres vides du document, dans l'ordre")
    args = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", args.doc):
        print(f"Identifiant de document invalide : « {args.doc} »", file=sys.stderr)
        return 1
    doc_dir = args.documents / args.doc
    doc_file = doc_dir / "document.json"
    if not doc_file.is_file():
        print(f"Document introuvable : {doc_file}", file=sys.stderr)
        return 1
    if not args.pdf.is_file():
        print(f"PDF introuvable : {args.pdf}", file=sys.stderr)
        return 1

    print(f"Extraction des images de {args.pdf.name}…")
    photos = extract(args.pdf, doc_dir / "assets" / "originals")
    if not photos:
        print(f"Aucune photo dans {args.pdf.name} (images de plus de {MIN_SIDE_PX} px de côté).", file=sys.stderr)
        return 1
    placed, empty = update_document(doc_file, photos, args.fill)
    print(f"{len(photos)} photo(s) provisoire(s) ajoutée(s) au document.")
    if args.fill:
        print(f"{len(placed)} cadre(s) garni(s) de photos provisoires :")
        for line in placed:
            print(f"  {line}")
        if empty:
            print(f"{len(empty)} cadre(s) sans nouvelle photo, faute d'images dans le PDF : {', '.join(empty)}")
    print("Photos provisoires : filigrane à l'écran ; l'export les signale, l'export imprimeur les refuse.")
    print("Si l'éditeur a ce document ouvert, rechargez la page avant de le modifier.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
