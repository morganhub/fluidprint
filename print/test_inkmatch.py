"""Variantes « petit texte » (scripts/print-swatches.ts) : l'évaluateur de la table A2B1 de FOGRA39, le ΔE00
qui départage les combinaisons d'encres, et la recherche rapide qui doit retrouver l'optimum exhaustif."""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys

import pytest
from PIL import Image, ImageCms

from conftest import PRINT_DIR
from inkmatch import best_inks, cmyk_to_lab, delta_e_2000, match, search_inks
from printcore import resolve_profile

# Nuances du dépliant d'exemple, converties par FOGRA39 : « Titres » (vert très foncé), « Vert », « Texte principal » (gris).
TITLES = [82, 50, 70, 62]
GREEN = [81, 29, 75, 15]
GRAY = [66, 57, 49, 48]


@pytest.fixture(scope="module")
def fogra39():
    profile, _ = resolve_profile("FOGRA39")
    return profile


def test_l_evaluateur_flottant_suit_littlecms(fogra39):
    # Même profil, même intention que Pillow : les écarts ne viennent que du Lab 8 bits de Pillow
    # (pas de 0,39 en L, arrondi à l'unité en a et b).
    to_lab = ImageCms.buildTransform(ImageCms.getOpenProfile(str(fogra39)), ImageCms.createProfile("LAB"), "CMYK", "LAB", ImageCms.Intent.RELATIVE_COLORIMETRIC)
    rng = random.Random(3)
    for _ in range(200):
        byte = tuple(rng.randint(0, 255) for _ in range(4))
        L8, a8, b8 = ImageCms.applyTransform(Image.new("CMYK", (1, 1), byte), to_lab).getpixel((0, 0))
        lab = cmyk_to_lab(fogra39, [v * 100 / 255 for v in byte])
        assert abs(lab[0] - L8 * 100 / 255) < 0.45
        assert abs(lab[1] - (a8 - 128)) < 0.75 and abs(lab[2] - (b8 - 128)) < 0.75


def test_ciede2000_sur_les_donnees_de_sharma():
    # Sharma, Wu, Dalal (2005), paires 1, 7 et 17 de la table de référence.
    assert delta_e_2000((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485)) == pytest.approx(2.0425, abs=1e-4)
    assert delta_e_2000((50.0, 0.0, 0.0), (50.0, -1.0, 2.0)) == pytest.approx(2.3669, abs=1e-4)
    assert delta_e_2000((50.0, 2.5, 0.0), (73.0, 25.0, -18.0)) == pytest.approx(27.1492, abs=1e-4)


def test_recherche_rapide_retrouve_l_optimum_exhaustif_a_trois_encres(fogra39):
    # Toute la grille au pour cent (un million de combinaisons) contre la grille à 5 % affinée : même optimum.
    target = cmyk_to_lab(fogra39, TITLES)
    inks = [0, 2, 3]  # cyan, jaune, noir
    fast = search_inks(fogra39, target, inks)
    exhaustive = best_inks(fogra39, target, inks, keep=3)
    assert fast[0]["cmyk"] == exhaustive[0]["cmyk"]
    assert fast[0]["deltaE"] == pytest.approx(exhaustive[0]["deltaE"], abs=1e-9)
    # Invisible face aux titres imprimés, avec une encre de moins.
    assert fast[0]["deltaE"] < 0.5
    assert fast[0]["cmyk"][1] == 0


def test_gris_neutre_en_noir_seul(fogra39):
    result = match({"profile": "FOGRA39", "targetCmyk": GRAY, "targetRgb": "#46474c", "inks": ["N"]})
    c, m, y, k = result["best"]["cmyk"]
    assert (c, m, y) == (0, 0, 0) and 70 < k < 100
    # Même clarté que le gris imprimé, à une unité près : c'est le noir seul « équivalent ».
    assert abs(result["best"]["lab"][0] - result["targets"]["cmyk"]["lab"][0]) < 1
    # Aucune autre valeur de noir ne fait mieux (recherche exhaustive à une encre).
    assert all(n["deltaE"]["cmyk"] >= result["best"]["deltaE"]["cmyk"] for n in result["next"])


def test_jeux_d_encres_meilleure_combinaison_et_sans_jaune(fogra39):
    sets = [["C", "M", "J"], ["C", "M", "N"], ["C", "J", "N"], ["M", "J", "N"]]
    result = match({"profile": "FOGRA39", "targetCmyk": GREEN, "targetRgb": "#2d7a55", "inkSets": sets})
    by_set = {"".join(s["inks"]): s["best"] for s in result["bySet"]}
    assert set(by_set) == {"CMJ", "CMN", "CJN", "MJN"}
    # La meilleure de toutes est la meilleure de son jeu, et trois encres au plus.
    assert result["best"]["deltaE"]["cmyk"] == min(s["deltaE"]["cmyk"] for s in by_set.values())
    assert result["best"]["inks"] <= 3
    # Un vert sans jaune n'est plus un vert : l'option « sans jaune » a un prix, que le rapport montre.
    assert by_set["CMN"]["deltaE"]["cmyk"] > 5 > by_set["CJN"]["deltaE"]["cmyk"]


def test_plusieurs_nuances_en_un_seul_lancement():
    job = {"profile": "FOGRA39", "jobs": [{"id": "gris", "targetCmyk": GRAY, "inks": ["N"]}, {"id": "vert", "targetCmyk": GREEN, "inkSets": [["C", "J", "N"]]}]}
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    out = subprocess.run([sys.executable, str(PRINT_DIR / "inkmatch.py")], input=json.dumps(job), capture_output=True, text=True, encoding="utf-8", env=env, timeout=300)
    assert out.returncode == 0, out.stderr
    results = json.loads(out.stdout)["results"]
    assert [r["id"] for r in results] == ["gris", "vert"]
    assert results[0]["best"]["cmyk"][:3] == [0, 0, 0]
    assert results[1]["best"]["cmyk"][1] == 0 and results[1]["best"]["inks"] <= 3
