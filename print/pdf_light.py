"""PDF léger pour l'e-mail (tâche 4.10) : RVB, photos réduites à la résolution voulue (150 ppi par défaut),
sans fond perdu (MediaBox = TrimBox).

Usage : python pdf_light.py <travail.json>
Travail : {"input", "output", "ppi": 150, "jpegQuality": 82, "trim": true}
Réponse JSON : {"output", "bytes", "images": [{"name", "from", "to", "ppi"}], "pages"}.
"""
from __future__ import annotations

import io
import json
import sys
import zlib
from pathlib import Path

import pikepdf
from pikepdf import Name, Stream
from PIL import Image

from pdfwalk import color_space_info, decode_image, effective_ppi, image_usages
from printcore import PrintError, emit, fail


def downsample(pdf: pikepdf.Pdf, ppi: float, quality: int) -> list[dict]:
    report = []
    for usage in image_usages(pdf).values():
        image: Stream = usage["image"]
        if image.get("/ImageMask"):
            continue
        width, height = int(image.Width), int(image.Height)
        effective = effective_ppi(image, usage)
        if effective is None:
            continue
        # 10 % de marge : une photo à 160 ppi ne mérite pas une recompression de plus.
        if effective <= ppi * 1.1:
            continue
        factor = ppi / effective
        size = (max(1, round(width * factor)), max(1, round(height * factor)))
        info = color_space_info(image.get("/ColorSpace"))
        pil = decode_image(image)
        if info.kind == "rgb":
            pil = pil.convert("RGB")
        elif info.kind == "gray":
            pil = pil.convert("L")
        else:
            continue
        small = pil.resize(size, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        small.save(buffer, format="JPEG", quality=quality, optimize=True)
        image.write(buffer.getvalue(), filter=Name.DCTDecode)
        image.Width, image.Height, image.BitsPerComponent = size[0], size[1], 8
        for key in ("/DecodeParms", "/Decode"):
            if key in image:
                del image[key]
        mask = image.get("/SMask")
        if isinstance(mask, Stream):
            alpha = decode_image(mask).convert("L").resize(size, Image.Resampling.LANCZOS)
            mask.write(zlib.compress(alpha.tobytes(), 9), filter=Name.FlateDecode)
            mask.Width, mask.Height, mask.BitsPerComponent = size[0], size[1], 8
            for key in ("/DecodeParms", "/Decode"):
                if key in mask:
                    del mask[key]
        report.append({"name": usage["name"], "from": [width, height], "to": list(size), "ppi": round(effective)})
    return report


def process(job: dict) -> dict:
    pdf = pikepdf.open(job["input"])
    images = downsample(pdf, float(job.get("ppi", 150)), int(job.get("jpegQuality", 82)))
    if job.get("trim", True):
        for page in pdf.pages:
            trim = page.obj.get("/TrimBox")
            if trim is None:
                continue
            page.obj.MediaBox = pikepdf.Array(list(trim))
            for key in ("/BleedBox", "/CropBox", "/ArtBox"):
                if key in page.obj:
                    del page.obj[key]
    output = Path(job["output"])
    pages = len(pdf.pages)
    pdf.save(output, object_stream_mode=pikepdf.ObjectStreamMode.disable, compress_streams=True, recompress_flate=True)
    pdf.close()
    return {"output": str(output), "bytes": output.stat().st_size, "images": images, "pages": pages}


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage : python pdf_light.py <travail.json>")
    try:
        emit(process(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))))
    except PrintError as error:
        fail(str(error))
    except pikepdf.PdfError as error:
        fail(f"PDF illisible : {error}")


if __name__ == "__main__":
    main()
