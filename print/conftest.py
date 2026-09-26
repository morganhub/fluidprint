"""Données partagées des tests de la chaîne d'impression : un PDF d'essai produit par Chrome."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pikepdf
import pytest

PRINT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PRINT_DIR.parent
sys.path.insert(0, str(PRINT_DIR))

MM = 72 / 25.4
BLEED_MM = 3.0


def _make_chrome_pdf(out: Path, description: Path, *extra: str) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.fail("Node introuvable : le PDF d'essai est produit par Chrome via scripts/print-fixture.ts")
    tsx = PROJECT_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    result = subprocess.run(
        [node, str(tsx), "scripts/print-fixture.ts", "--out", str(out), "--json", str(description), *extra],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    if result.returncode != 0:
        pytest.fail(f"PDF d'essai impossible à produire : {result.stderr or result.stdout}")


def _boxed_sample(folder: Path, name: str, *extra: str) -> dict:
    """PDF de Chrome avec les boîtes que pose server/pdf.ts : MediaBox = BleedBox, TrimBox 3 mm à l'intérieur."""
    raw, description = folder / f"{name}.pdf", folder / f"{name}.json"
    _make_chrome_pdf(raw, description, *extra)
    boxed = folder / f"{name}-boxes.pdf"
    with pikepdf.open(raw) as pdf:
        for page in pdf.pages:
            media = [float(v) for v in page.obj.MediaBox]
            # Chrome arrondit la page au pixel CSS : 100 × 70 mm deviennent 99,82 × 69,85 mm.
            trim_mm = [round((media[2] - media[0]) / MM - 2 * BLEED_MM, 3), round((media[3] - media[1]) / MM - 2 * BLEED_MM, 3)]
            page.obj.BleedBox = pikepdf.Array(media)
            b = BLEED_MM * MM
            page.obj.TrimBox = pikepdf.Array([media[0] + b, media[1] + b, media[2] - b, media[3] - b])
        pdf.save(boxed)
    info = json.loads(description.read_text(encoding="utf-8"))
    return {"pdf": boxed, "raw": raw, "trimMm": trim_mm, **info}


@pytest.fixture(scope="session")
def chrome_sample(tmp_path_factory) -> dict:
    """PDF de Chrome (texte, aplats, découpe, photo JPEG, photo PNG à transparence, groupe transparent)."""
    return _boxed_sample(tmp_path_factory.mktemp("chrome"), "chrome")


@pytest.fixture(scope="session")
def chrome_emoji(tmp_path_factory) -> dict:
    """PDF de Chrome avec « Votre ✓ → 📱 » : l'emoji en police Type 3 (glyphes en formes RVB), les symboles
    absents d'Arial en police de repli."""
    return _boxed_sample(tmp_path_factory.mktemp("emoji"), "emoji", "--emoji")


@pytest.fixture(scope="session")
def make_photo_sample(tmp_path_factory):
    """Fabrique un PDF de Chrome qui montre une photo donnée (fichier) dans un cadre de 40 × 25 mm."""

    def build(photo: Path) -> dict:
        folder = tmp_path_factory.mktemp("photo")
        return _boxed_sample(folder, "photo", "--photo", str(photo))

    return build


def swatch_table(colors: dict, overrides: dict | None = None) -> list[dict]:
    """Nuancier des tests : RVB du PDF d'essai → CMJN exact (la couleur « horsNuancier » n'y est pas)."""
    cmyk = {
        "marine": [97, 84, 39, 39],
        "gris": [0, 0, 0, 80],
        "bleu": [86, 55, 0, 0],
        "violet": [76, 77, 0, 0],
        "blanc": [0, 0, 0, 0],
        "noirRiche": [60, 50, 40, 100],
        **(overrides or {}),
    }
    return [{"rgb": colors[key], "cmyk": value, "name": key} for key, value in cmyk.items()]


@pytest.fixture
def make_job(chrome_sample, tmp_path):
    def build(**extra) -> dict:
        job = {
            "input": str(chrome_sample["pdf"]),
            "output": str(tmp_path / "out.pdf"),
            "profile": "FOGRA39",
            "imageIntent": "perceptual",
            "vectorIntent": "relative",
            "blackPointCompensation": True,
            "maxInk": 300,
            "colorTable": swatch_table(chrome_sample["colors"]),
            "pdfx": {"standard": "PDF/X-4", "title": "Essai", "createdAt": "2026-09-25T21:00:00+02:00"},
            "trimMm": chrome_sample["trimMm"],
            "bleedMm": BLEED_MM,
            "marks": None,
        }
        job.update(extra)
        return job

    return build
