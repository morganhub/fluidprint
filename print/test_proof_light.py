"""Épreuvage écran (4.9) et PDF léger pour l'e-mail (4.10)."""
from __future__ import annotations

import json
import subprocess
import sys

import pikepdf
from PIL import Image

from conftest import MM, PRINT_DIR
from pdf_light import process as make_light
from pdfwalk import iter_images
from printcore import resolve_profile
from proof import proof_image


def lab(rgb):
    def lin(u):
        s = u / 255
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(v) for v in rgb[:3])
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = r * 0.2126729 + g * 0.7151522 + b * 0.072175
    z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116  # noqa: E731
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e76(a, b) -> float:
    return sum((p - q) ** 2 for p, q in zip(lab(a), lab(b))) ** 0.5


def chroma(rgb) -> float:
    _, a, b = lab(rgb)
    return (a * a + b * b) ** 0.5


def test_epreuve_ternit_le_bleu_vif_et_garde_la_transparence(tmp_path):
    profile, _ = resolve_profile("FOGRA39")
    # Bleu vif hors du gamut FOGRA39 (celui de la couverture du dépliant d'exemple).
    vivid = (0x3B, 0x5B, 0xDB)
    img = Image.new("RGBA", (8, 8), vivid + (255,))
    img.putpixel((0, 0), (0, 0, 0, 0))
    proofed = proof_image(img, profile, "perceptual", True, 300)
    seen = proofed.getpixel((4, 4))
    assert proofed.mode == "RGBA" and proofed.getpixel((0, 0))[3] == 0
    assert delta_e76(vivid, seen) > 5
    assert chroma(seen) < chroma(vivid) - 5


def test_epreuve_en_ligne_de_commande_et_cache(tmp_path):
    source = tmp_path / "photo.png"
    Image.new("RGB", (32, 16), (0xEC, 0x65, 0x24)).save(source)
    target = tmp_path / "proof" / "photo.webp"
    command = [sys.executable, str(PRINT_DIR / "proof.py"), str(source), str(target), "--max-ink", "300"]
    first = json.loads(subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=True).stdout)
    second = json.loads(subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=True).stdout)
    assert first["cached"] is False and second["cached"] is True
    assert (first["width"], first["height"]) == (32, 16)


def test_pdf_email_leger_sans_fond_perdu(chrome_sample, tmp_path):
    out = tmp_path / "email.pdf"
    report = make_light({"input": str(chrome_sample["pdf"]), "output": str(out), "ppi": 150, "jpegQuality": 82})
    photo = chrome_sample["photo"]
    resized = {tuple(i["from"]): i for i in report["images"]}
    assert (photo["width"], photo["height"]) in resized
    entry = resized[(photo["width"], photo["height"])]
    # La photo est affichée sur 44 × 30 mm (étirée) : la plus faible résolution (en hauteur) passe à 150 ppi.
    assert entry["ppi"] > 600
    assert abs(entry["to"][1] - round(30 / 25.4 * 150)) <= 2
    with pikepdf.open(out) as pdf:
        page = pdf.pages[0].obj
        media, trim = [float(v) for v in page.MediaBox], [float(v) for v in page.TrimBox]
        assert media == trim
        assert abs((media[2] - media[0]) / MM - chrome_sample["trimMm"][0]) < 0.01
        assert "/BleedBox" not in page
        sizes = {(int(i.Width), int(i.Height)) for i, *_ in iter_images(pdf)}
        assert (photo["width"], photo["height"]) not in sizes
    assert report["bytes"] < chrome_sample["pdf"].stat().st_size
