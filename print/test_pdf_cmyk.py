"""Tests du post-traitement CMJN (tâches 4.2, 4.3, 4.5 et 4.7) sur un PDF produit par Chrome."""
from __future__ import annotations

import pikepdf
import pytest
from PIL import Image, ImageChops, ImageStat

from check_pdfx import check_file
from conftest import MM
from pdf_cmyk import process
from pdfwalk import color_space_info, decode_image, iter_contents, iter_fonts, iter_images
from printcore import resolve_profile, rgb_image_to_cmyk


def operators(path) -> list[tuple[str, tuple[float, ...]]]:
    """Tous les opérateurs de couleur du fichier (pages, formes, masques, motifs)."""
    found = []
    with pikepdf.open(path) as pdf:
        for visit in iter_contents(pdf):
            for item in pikepdf.parse_content_stream(visit.owner):
                if isinstance(item, pikepdf.ContentStreamInlineImage):
                    continue
                op = str(item.operator)
                if op in ("rg", "RG", "k", "K", "g", "G", "sc", "scn", "SC", "SCN", "cs", "CS"):
                    found.append((op, tuple(float(o) if not isinstance(o, pikepdf.Name) else 0.0 for o in item.operands)))
    return found


@pytest.fixture
def converted(make_job):
    job = make_job()
    report = process(job)
    return job, report


def test_plus_aucun_rvb_ni_image_rvb(converted, chrome_sample):
    job, report = converted
    # Le PDF de départ en contient bien (sinon le test ne prouverait rien).
    assert any(op in ("rg", "RG") for op, _ in operators(chrome_sample["pdf"]))
    ops = operators(job["output"])
    assert not [op for op, _ in ops if op in ("rg", "RG")]
    with pikepdf.open(job["output"]) as pdf:
        kinds = [color_space_info(img.get("/ColorSpace")).kind for img, *_ in iter_images(pdf)]
    assert kinds and all(kind in ("cmyk", "gray") for kind in kinds)
    assert report["check"]["ok"], report["check"]["errors"]


def test_valeurs_exactes_des_nuances(converted):
    job, report = converted
    fills = {values for op, values in operators(job["output"]) if op == "k"}
    # Le bleu du nuancier (C86 M55 J0 N0) sort exactement avec ses valeurs, sans passer par le profil.
    assert (0.86, 0.55, 0.0, 0.0) in fills
    assert (0.97, 0.84, 0.39, 0.39) in fills
    assert (0.0, 0.0, 0.0, 0.8) in fills
    assert report["swatchesUsed"]["bleu"] >= 1


def test_couleur_hors_nuancier_convertie_et_signalee(converted, chrome_sample):
    _job, report = converted
    unknown = {u["rgb"]: u for u in report["unknownColors"]}
    assert chrome_sample["colors"]["horsNuancier"] in unknown
    assert len(unknown[chrome_sample["colors"]["horsNuancier"]]["cmyk"]) == 4


def test_photos_gardent_leurs_pixels_et_leur_masque(converted, chrome_sample):
    job, report = converted
    profile, _ = resolve_profile("FOGRA39")
    with pikepdf.open(chrome_sample["pdf"]) as before, pikepdf.open(job["output"]) as after:
        originals = {(int(i.Width), int(i.Height)): (decode_image(i), i.get("/ColorSpace")) for i, *_ in iter_images(before)}
        results = {(int(i.Width), int(i.Height)): i for i, *_ in iter_images(after)}
        assert set(results) == set(originals) == {(chrome_sample["photo"]["width"], chrome_sample["photo"]["height"]), (chrome_sample["alpha"]["width"], chrome_sample["alpha"]["height"])}
        for size, image in results.items():
            pil = decode_image(image)
            assert pil.mode == "CMYK" and pil.size == size
            # Même conversion que l'export, pixel pour pixel : aucun rééchantillonnage, aucune perte.
            source, cs = originals[size]
            expected = rgb_image_to_cmyk(source.convert("RGB"), profile, "perceptual", True, color_space_info(cs).icc, 300)
            assert ImageChops.difference(pil, expected).getbbox() is None
        alpha = results[(chrome_sample["alpha"]["width"], chrome_sample["alpha"]["height"])]
        assert "/SMask" in alpha
        assert (int(alpha.SMask.Width), int(alpha.SMask.Height)) == (chrome_sample["alpha"]["width"], chrome_sample["alpha"]["height"])
    assert all(img["maxInk"] <= 300 for img in report["images"])


def test_groupes_de_transparence_en_cmjn(converted):
    job, _report = converted
    with pikepdf.open(job["output"]) as pdf:
        assert pdf.pages[0].obj.Group.CS == pikepdf.Name.DeviceCMYK
        groups = [v.owner.get("/Group") for v in iter_contents(pdf) if isinstance(v.owner, pikepdf.Stream) and v.owner.get("/Group") is not None]
        # L'opacité du « groupe transparent » donne une forme à groupe de transparence.
        assert groups
        for group in groups:
            assert "/CS" not in group or color_space_info(group.CS).kind in ("cmyk", "gray")


def test_aplat_a_330_pour_cent_fait_echouer_le_controle(make_job, chrome_sample, tmp_path):
    from conftest import swatch_table

    job = make_job(colorTable=swatch_table(chrome_sample["colors"], {"noirRiche": [90, 80, 70, 90]}))
    report = process(job)
    assert not report["check"]["ok"]
    assert any("Encrage au-delà de 300 %" in e and "330 %" in e for e in report["check"]["errors"])
    # Sans plafond, le même fichier passe : c'est bien l'encrage qui bloque.
    assert check_file(job["output"], max_ink=None, trim_mm=chrome_sample["trimMm"], bleed_mm=3)["ok"]


def test_conformite_pdfx4(converted, chrome_sample):
    job, _report = converted
    trim_mm = chrome_sample["trimMm"]
    result = check_file(job["output"], max_ink=300, trim_mm=trim_mm, bleed_mm=3)
    assert result["ok"], result["errors"]
    assert result["stats"]["version"] == "1.6"
    assert result["stats"]["outputCondition"] == "FOGRA39"
    with pikepdf.open(job["output"]) as pdf:
        intent = pdf.Root.OutputIntents[0]
        assert intent.S == pikepdf.Name.GTS_PDFX
        assert bytes(intent.DestOutputProfile.read_bytes())[16:20] == b"CMYK"
        assert str(pdf.docinfo.GTS_PDFXVersion) == "PDF/X-4"
        assert pdf.docinfo.Trapped == pikepdf.Name("/False")
        meta = pdf.open_metadata()
        assert meta["pdfxid:GTS_PDFXVersion"] == "PDF/X-4"
        assert meta["pdf:Trapped"] == "False"
        page = pdf.pages[0].obj
        media, bleed, trim = ([float(v) for v in page[k]] for k in ("/MediaBox", "/BleedBox", "/TrimBox"))
        assert bleed == media
        assert abs((trim[2] - trim[0]) / MM - trim_mm[0]) < 0.01 and abs((trim[0] - media[0]) / MM - 3) < 0.01


def test_le_controle_refuse_un_pdf_de_chrome_brut(chrome_sample):
    result = check_file(chrome_sample["raw"], max_ink=300)
    assert not result["ok"]
    text = " ".join(result["errors"])
    for expected in ("Version PDF", "OutputIntent GTS_PDFX absent", "GTS_PDFXVersion", "TrimBox absente", "Opérateurs RVB restants", "image RVB"):
        assert expected in text


def test_changer_de_profil_change_la_condition_de_sortie(make_job, tmp_path):
    fogra = process(make_job(output=str(tmp_path / "fogra.pdf")))
    gracol = process(make_job(output=str(tmp_path / "gracol.pdf"), profile="GRACoL2006"))
    assert fogra["check"]["stats"]["outputCondition"] == "FOGRA39"
    assert gracol["check"]["stats"]["outputCondition"] == "CGATS TR 006"
    with pikepdf.open(tmp_path / "fogra.pdf") as a, pikepdf.open(tmp_path / "gracol.pdf") as b:
        assert bytes(a.Root.OutputIntents[0].DestOutputProfile.read_bytes()) != bytes(b.Root.OutputIntents[0].DestOutputProfile.read_bytes())


def test_traits_de_coupe_hors_du_fond_perdu(make_job, chrome_sample):
    job = make_job(marks={"margin": 10, "folds": [[40]]})
    report = process(job)
    assert report["check"]["ok"], report["check"]["errors"]
    with pikepdf.open(job["output"]) as pdf:
        page = pdf.pages[0].obj
        media, bleed, trim = ([float(v) for v in page[k]] for k in ("/MediaBox", "/BleedBox", "/TrimBox"))
        trim_mm = chrome_sample["trimMm"]
        assert abs((media[2] - media[0]) / MM - (trim_mm[0] + 6 + 20)) < 0.01
        assert abs((trim[2] - trim[0]) / MM - trim_mm[0]) < 0.01
        assert abs((trim[0] - bleed[0]) / MM - 3) < 0.01 and abs((bleed[0] - media[0]) / MM - 10) < 0.01
        marks = pikepdf.parse_content_stream(page.Contents[-1])
        points = []
        registration = False
        for item in marks:
            op = str(item.operator)
            if op == "CS" and str(item.operands[0]) == "/CSRepere":
                registration = True
            if op in ("m", "l"):
                points.append(tuple(float(v) for v in item.operands))
        assert registration and str(page.Resources.ColorSpace.CSRepere[1]) == "/All"
        assert len(points) == 8 * 2 + 2 * 2  # 8 traits de coupe et 2 repères de pli, de 2 points chacun
        for x, y in points:
            outside = x < bleed[0] or x > bleed[2] or y < bleed[1] or y > bleed[3]
            assert outside, (x, y)
            assert media[0] <= x <= media[2] and media[1] <= y <= media[3]
        fold_x = trim[0] + 40 * MM
        assert any(abs(x - fold_x) < 0.01 for x, _ in points)


def test_petits_textes_en_noir_seul(converted):
    _job, report = converted
    small = report["check"]["stats"]["smallText"]
    assert small, "le PDF d'essai contient un texte de 7 pt"
    assert all(entry["inks"] <= 1 for entry in small), small
    assert {entry["color"] for entry in small} == {"C0 M0 J0 N80"}


# ---------------------------------------------------------------- petits textes (C1 : deux encres au plus sous 9 pt)

SMALL_STRICT = {"pt": 9, "maxInks": 2, "exceptions": [], "strict": True}


def test_petit_texte_a_quatre_encres_fait_echouer_le_controle_imprimeur(make_job, chrome_sample, tmp_path):
    from conftest import swatch_table

    # Le petit texte gris du PDF d'essai (7 pt) dans le gris du design, à quatre encres.
    four = swatch_table(chrome_sample["colors"], {"gris": [71, 58, 41, 32]})
    strict = process(make_job(output=str(tmp_path / "strict.pdf"), colorTable=four, smallText=SMALL_STRICT))
    assert not strict["check"]["ok"]
    assert any("Texte de moins de 9 pt en 4 encres" in e and "C71 M58 J41 N32" in e for e in strict["check"]["errors"]), strict["check"]["errors"]
    # Hors mode strict (préréglages sans contrôle bloquant), la même règle n'est qu'un avertissement.
    loose = process(make_job(output=str(tmp_path / "loose.pdf"), colorTable=four, smallText={**SMALL_STRICT, "strict": False}))
    assert loose["check"]["ok"] and any("4 encres" in w for w in loose["check"]["warnings"])
    # Nuance d'accent déclarée en exception : acceptée, et marquée comme telle.
    accent = process(make_job(output=str(tmp_path / "accent.pdf"), colorTable=four, smallText={**SMALL_STRICT, "exceptions": [[71, 58, 41, 32]]}))
    assert accent["check"]["ok"], accent["check"]["errors"]
    assert {(e["color"], e["exception"]) for e in accent["check"]["stats"]["smallText"]} == {("C71 M58 J41 N32", True)}
    # Deux encres (cyan + noir) : acceptées sans exception.
    two = process(make_job(output=str(tmp_path / "two.pdf"), colorTable=swatch_table(chrome_sample["colors"], {"gris": [39, 0, 0, 91]}), smallText=SMALL_STRICT))
    assert two["check"]["ok"], two["check"]["errors"]
    assert {e["inks"] for e in two["check"]["stats"]["smallText"]} == {2}
    # Variante « petit texte » à trois encres (scripts/print-swatches.ts) : refusée seule, acceptée comme
    # exception déclarée, exactement comme le contrôle en amont de l'éditeur.
    three = swatch_table(chrome_sample["colors"], {"gris": [52, 0, 43, 85]})
    refused = process(make_job(output=str(tmp_path / "three.pdf"), colorTable=three, smallText=SMALL_STRICT))
    assert not refused["check"]["ok"]
    assert any("3 encres" in e and "C52 M0 J43 N85" in e for e in refused["check"]["errors"]), refused["check"]["errors"]
    variant = process(make_job(output=str(tmp_path / "variant.pdf"), colorTable=three, smallText={**SMALL_STRICT, "exceptions": [[52, 0, 43, 85]]}))
    assert variant["check"]["ok"], variant["check"]["errors"]
    assert {(e["color"], e["inks"], e["exception"]) for e in variant["check"]["stats"]["smallText"]} == {("C52 M0 J43 N85", 3, True)}


# ---------------------------------------------------------------- emoji et polices (C2, C3)


def test_chaque_objet_direct_est_vu_une_fois(chrome_emoji):
    """Chrome range dégradés et ressources en objets directs : chacun doit être vu (et converti), même quand
    l'enveloppe Python du précédent a été libérée et son `id()` réattribué. L'ancien repérage par `id()` ne
    voyait que 2 de ces 200 dictionnaires, et 55 des 95 dégradés du PDF à emoji."""
    from pdfwalk import Seen, iter_shadings

    items = pikepdf.Array([pikepdf.Dictionary(A=i) for i in range(200)])
    seen = Seen()
    assert sum(1 for item in items if seen.first_time(item)) == 200
    # Le PDF à emoji de Chrome en contient bien : c'est là que le défaut se voyait.
    with pikepdf.open(chrome_emoji["pdf"]) as pdf:
        assert [sh for sh, _ in iter_shadings(pdf) if sh.objgen == (0, 0)]


def test_emoji_en_police_type3_converti_sans_rvb_restant(chrome_emoji, make_job):
    # Chrome dessine l'emoji par une forme rangée dans les ressources de sa police Type 3 : c'est elle qui
    # gardait son RVB (« Opérateurs RVB restants : … police F7 g84D › Xg84D ») et bloquait l'export.
    with pikepdf.open(chrome_emoji["pdf"]) as pdf:
        type3 = [font for font, _ in iter_fonts(pdf) if font.get("/Subtype") == "/Type3"]
        assert type3 and any(isinstance(f.get("/Resources"), pikepdf.Dictionary) and f.Resources.get("/XObject") for f in type3)
    job = make_job(input=str(chrome_emoji["pdf"]), trimMm=chrome_emoji["trimMm"])
    report = process(job)
    assert report["errors"] == []
    assert report["check"]["ok"], report["check"]["errors"]
    assert not [op for op, _ in operators(job["output"]) if op in ("rg", "RG")]
    with pikepdf.open(job["output"]) as pdf:
        visits = [v for v in iter_contents(pdf) if "police" in v.where and v.kind != "charproc"]
        assert visits, "les formes des glyphes sont parcourues"


def test_polices_type3_et_de_repli_signalees(chrome_emoji, chrome_sample, make_job, tmp_path):
    job = make_job(input=str(chrome_emoji["pdf"]), trimMm=chrome_emoji["trimMm"], expectedFonts=["ArialMT"])
    warnings = " ".join(process(job)["check"]["warnings"])
    assert "police Type 3" in warnings or "polices Type 3" in warnings
    assert "Police SegoeUISymbol hors des polices du document" in warnings
    assert "ArialMT" not in warnings
    # Le PDF d'essai n'a que de l'Arial, attendue : rien à signaler.
    plain = process(make_job(output=str(tmp_path / "plain.pdf"), expectedFonts=["ArialMT", "Arial-BoldMT"]))
    assert not [w for w in plain["check"]["warnings"] if "olice" in w], plain["check"]["warnings"]
    assert plain["check"]["stats"]["type3Fonts"] == 0


# ---------------------------------------------------------------- photos : rééchantillonnage (B4), original CMJN (C4)


def test_photos_au_dela_de_450_ppi_reduites_a_300(make_job, chrome_sample):
    job = make_job(downsample={"ppi": 300, "abovePpi": 450})
    report = process(job)
    assert report["check"]["ok"], report["check"]["errors"]
    by_source = {tuple(i.get("resampledFrom") or (i["width"], i["height"])): i for i in report["images"]}
    photo = by_source[(chrome_sample["photo"]["width"], chrome_sample["photo"]["height"])]
    # 1 200 × 800 px dans 44 × 30 mm : environ 680 ppi, ramenés à 300.
    assert photo["ppi"] > 450
    assert abs(photo["width"] - round(chrome_sample["photo"]["width"] * 300 / photo["ppi"])) <= 1
    # 400 px sur 24 mm : 423 ppi, sous le seuil : intacte.
    alpha = by_source[(chrome_sample["alpha"]["width"], chrome_sample["alpha"]["height"])]
    assert "resampledFrom" not in alpha
    with pikepdf.open(job["output"]) as pdf:
        sizes = {(int(i.Width), int(i.Height)) for i, *_ in iter_images(pdf) if not i.get("/ImageMask")}
    assert (photo["width"], photo["height"]) in sizes and (chrome_sample["photo"]["width"], chrome_sample["photo"]["height"]) not in sizes


def _cmyk_photo(path, icc: bytes | None) -> Image.Image:
    """Photo CMJN de 400 × 250 : dégradés par encre et, en bas, des ombres à 345 % (noir riche d'une vraie photo)."""
    img = Image.new("CMYK", (400, 250))
    px = img.load()
    for y in range(250):
        for x in range(400):
            px[x, y] = (230, 204, 204, 242) if y > 220 else (x * 255 // 399, y * 255 // 249, (x + y) % 256, (x * y) % 97)
    img.save(path, quality=95, **({"icc_profile": icc} if icc else {}))
    return Image.open(path)


def test_original_cmjn_garde_ses_pixels_au_lieu_d_etre_reconverti(make_photo_sample, make_job, tmp_path):
    from printcore import limit_ink_image

    profile, _ = resolve_profile("FOGRA39")
    original = _cmyk_photo(tmp_path / "cmjn.jpg", profile.read_bytes())
    sample = make_photo_sample(tmp_path / "cmjn.jpg")
    expected = limit_ink_image(original.convert("CMYK"), 300)

    def photo_of(path):
        with pikepdf.open(path) as pdf:
            return next(decode_image(i) for i, *_ in iter_images(pdf) if (int(i.Width), int(i.Height)) == (400, 250))

    # Sans l'original : Chrome l'a décodé en sRGB, la reconversion change les encres (le défaut C4).
    plain = make_job(input=str(sample["pdf"]), trimMm=sample["trimMm"], output=str(tmp_path / "plain.pdf"))
    process(plain)
    drift = sum(ImageStat.Stat(ImageChops.difference(photo_of(plain["output"]), expected)).mean)
    assert drift > 8, drift

    job = make_job(input=str(sample["pdf"]), trimMm=sample["trimMm"], output=str(tmp_path / "original.pdf"), cmykOriginals=[{"assetId": "a1", "name": "cmjn.jpg", "path": str(tmp_path / "cmjn.jpg")}])
    report = process(job)
    assert report["check"]["ok"], report["check"]["errors"]
    assert report["cmykOriginals"] == [{"name": "cmjn.jpg", "asset": "a1", "matched": 1}]
    entry = next(i for i in report["images"] if i["width"] == 400)
    assert "original CMJN" in entry["from"] and "pixels d'origine" in entry["from"]
    # Pixels de l'original, au bit près, seulement plafonnés à 300 % dans les ombres.
    assert ImageChops.difference(photo_of(job["output"]), expected).getbbox() is None
    assert entry["maxInk"] <= 300


def test_original_cmjn_introuvable_signale(make_job, chrome_sample, tmp_path):
    _cmyk_photo(tmp_path / "autre.jpg", None)
    report = process(make_job(output=str(tmp_path / "o.pdf"), cmykOriginals=[{"assetId": "a2", "name": "autre.jpg", "path": str(tmp_path / "autre.jpg")}]))
    assert report["cmykOriginals"] == [{"name": "autre.jpg", "asset": "a2", "matched": 0}]


# ---------------------------------------------------------------- norme (A6)


def test_norme_autre_que_pdfx4_refusee(make_job):
    from printcore import PrintError

    with pytest.raises(PrintError, match=r"PDF/X-1a:2001.*non prise en charge"):
        process(make_job(pdfx={"standard": "PDF/X-1a:2001", "title": "Essai", "createdAt": "2026-09-25T21:00:00+02:00"}))
