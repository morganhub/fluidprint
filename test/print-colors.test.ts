// Nuancier CMJN (tâches 4.1 et 4.7) : modèle, conversions par le profil, règle des petits textes
// (scripts/print-swatches.ts : gris neutre en noir seul, couleur à plus de deux encres en encres réduites,
// QR codes en N 100) et nuancier du dépliant d'exemple.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { applyQrBlack, convertDocumentSwatches, isNeutralGray, smallTextRule, smallTextUses, variantInkSets } from '../scripts/print-swatches';
import { cmykToRgb, rgbToCmyk, runPrintPython } from '../server/color';
import { runPreflight, SMALL_TEXT_MAX_INKS, SMALL_TEXT_PT } from '../src/model/preflight';
import {
  addSwatch,
  distinctRgb,
  ensureDistinctRgb,
  inkCount,
  inkTotal,
  printColorTable,
  QR_BLACK_SWATCH,
  setSwatchCmyk,
  smallTextVariantId,
  updateSwatch,
  withSourceColors,
} from '../src/model/swatches';
import type { LayoutDocument, QrObject, Swatch, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { minimalDoc } from './fixtures/minimal-doc';
import { EXAMPLE_FILE } from './helpers/editor';

/** Couleur effective et corps de chaque segment non vide de moins de 9 pt. */
function smallRuns(doc: LayoutDocument): { swatch: string; size: number }[] {
  const out: { swatch: string; size: number }[] = [];
  for (const obj of Object.values(doc.objects)) {
    if (obj.type !== 'text') continue;
    for (const p of obj.paragraphs)
      for (const r of p.runs) {
        const size = r.fontSize ?? p.fontSize ?? obj.style.fontSize;
        if (size < SMALL_TEXT_PT && r.text.trim()) out.push({ swatch: (r.color ?? obj.style.color).swatch, size });
      }
  }
  return out;
}

const example = async (): Promise<LayoutDocument> => JSON.parse(await readFile(EXAMPLE_FILE, 'utf8'));

describe('nuancier CMJN : modèle', () => {
  it('deux nuances n’ont jamais le même RVB : décalage d’une unité (ajout, modification, encres)', () => {
    const doc = minimalDoc();
    expect(distinctRgb(doc, null, '#2a5fa3')).toBe('#2a5fa4');
    expect(distinctRgb(doc, 'bleu', '#2a5fa3')).toBe('#2a5fa3');
    const id = addSwatch(doc, { rgb: '#2a5fa3', name: 'Bleu bis' });
    expect(doc.swatches.find((s) => s.id === id)!.rgb).toBe('#2a5fa4');
    updateSwatch(doc, 'gris', { rgb: '#2a5fa3' });
    expect(new Set(doc.swatches.map((s) => s.rgb)).size).toBe(doc.swatches.length);
    setSwatchCmyk(doc, 'gris', [83, 53, 0, 0], '#2a5fa3');
    setSwatchCmyk(doc, 'bleu', [83, 53, 0, 0], '#2a5fa3');
    expect(new Set(doc.swatches.map((s) => s.rgb)).size).toBe(doc.swatches.length);
    // Un document où deux nuances partagent un RVB est corrigé d'un coup.
    doc.swatches[0].rgb = doc.swatches[1].rgb;
    expect(ensureDistinctRgb(doc)).toEqual([doc.swatches[1].id]);
    expect(new Set(doc.swatches.map((s) => s.rgb)).size).toBe(doc.swatches.length);
  });

  it('table RVB → CMJN de l’export : nuances, teintes, nuances encore en RVB ; couleurs d’origine du design', () => {
    const doc = minimalDoc();
    setSwatchCmyk(doc, 'bleu', [86, 55, 0, 0], '#2169b2', { sourceRgb: '#2a5fa3' });
    (doc.objects.r1 as { fill: { swatch: string; tint?: number } }).fill = { swatch: 'bleu', tint: 0.5 };
    const { table, missing } = printColorTable(doc);
    expect(table).toContainEqual(expect.objectContaining({ rgb: '#2169b2', cmyk: [86, 55, 0, 0], tint: 1 }));
    expect(table).toContainEqual(expect.objectContaining({ rgb: '#90b4d9', cmyk: [43, 27.5, 0, 0], tint: 0.5 }));
    expect(missing.map((s) => s.id)).toEqual(['gris']);
    expect(inkTotal([97, 84, 39, 39])).toBe(259);
    expect(withSourceColors(doc).swatches.find((s) => s.id === 'bleu')!.rgb).toBe('#2a5fa3');
    expect(validateDocument(doc).ok).toBe(true);
    // Un document de la phase 1 (sans encres ni couleur d'origine) reste valide.
    expect(validateDocument(minimalDoc()).ok).toBe(true);
  });

  it('QR codes en « Noir QR » (N 100)', () => {
    const doc = minimalDoc();
    doc.swatches.push({ id: QR_BLACK_SWATCH.id, name: QR_BLACK_SWATCH.name, rgb: '#1d1d1b', cmyk: QR_BLACK_SWATCH.cmyk });
    doc.objects.q1 = { id: 'q1', type: 'qr', layerId: 'contenu', x: 0, y: 0, w: 20, h: 20, url: 'https://example.org', ecc: 'M', color: { swatch: 'gris' }, margin: 4 };
    doc.pages[0].children.push('q1');
    expect(applyQrBlack(doc)).toBe(1);
    expect((doc.objects.q1 as QrObject).color.swatch).toBe(QR_BLACK_SWATCH.id);
    expect(QR_BLACK_SWATCH.cmyk).toEqual([0, 0, 0, 100]);
  });
});

describe('petits textes : règle générique', () => {
  const swatch = (id: string, rgb: string, cmyk: [number, number, number, number], extra: Partial<Swatch> = {}): Swatch => ({ id, name: id, rgb, sourceRgb: rgb, cmyk, ...extra });

  it('gris neutre → noir seul ; couleur à plus de deux encres → une encre de moins, trois au plus ; le reste n’a pas de variante', () => {
    // Gris neutre (ce que l'import nomme « Gris »), en quatre encres : noir seul.
    expect(isNeutralGray(swatch('g', '#46474c', [66, 57, 49, 48]))).toBe(true);
    const gray = smallTextRule(swatch('g', '#46474c', [66, 57, 49, 48]))!;
    expect(gray.rule).toBe('noir-seul');
    expect(gray.inkSets('toutes')).toEqual([['N']]);
    // Une teinte pâle n'est pas un gris : elle garde sa teinte (encres réduites).
    expect(isNeutralGray(swatch('p', '#f6ebf2', [3, 11, 2, 0]))).toBe(false);
    expect(isNeutralGray(swatch('c', '#bdb9b2', [28, 23, 28, 4]))).toBe(true);
    // Quatre encres → trois au plus, parmi toutes les encres ou sans le jaune.
    const green = smallTextRule(swatch('v', '#2d7a55', [81, 29, 75, 15]))!;
    expect(green.rule).toBe('encres-reduites');
    expect(green.inkSets('toutes')).toEqual([
      ['C', 'M', 'J'],
      ['C', 'M', 'N'],
      ['C', 'J', 'N'],
      ['M', 'J', 'N'],
    ]);
    expect(green.inkSets('sans-jaune')).toEqual([['C', 'M', 'N']]);
    // Trois encres → deux.
    const pale = smallTextRule(swatch('p', '#edf4ef', [8, 2, 8, 0]))!;
    expect(pale.inkSets('toutes')).toHaveLength(6);
    expect(pale.inkSets('sans-jaune')).toEqual([
      ['C', 'M'],
      ['C', 'N'],
      ['M', 'N'],
    ]);
    expect(variantInkSets(2).every((set) => set.length === 2)).toBe(true);
    // Deux encres, noir seul, exception déclarée, nuance sans encres : rien à faire.
    expect(smallTextRule(swatch('b', '#2a5fa3', [86, 55, 0, 0]))).toBeNull();
    expect(smallTextRule(swatch('n', '#575756', [0, 0, 0, 80]))).toBeNull();
    expect(smallTextRule(swatch('v', '#2d7a55', [81, 29, 75, 15], { smallTextException: true }))).toBeNull();
    expect(smallTextRule({ id: 'x', name: 'x', rgb: '#2d7a55' })).toBeNull();
  });

  /** Document minimal : un texte de 7,5 pt gris (segment bleu), un titre de 12 pt gris, un QR en gris. */
  function smallTextDoc(): LayoutDocument {
    const doc = minimalDoc();
    const big = structuredClone(doc.objects.t1) as TextObject;
    big.id = 'big';
    big.y = 100;
    big.style.fontSize = 12;
    big.paragraphs = [{ runs: [{ text: 'Nos ateliers' }] }];
    doc.objects.big = big;
    doc.objects.q1 = { id: 'q1', type: 'qr', layerId: 'contenu', x: 150, y: 20, w: 20, h: 20, url: 'https://example.org', ecc: 'M', color: { swatch: 'gris' }, margin: 4 };
    doc.pages[0].children.push('big', 'q1');
    doc.styles.paragraph.push({ id: 'ps-legende', name: 'Légende', style: structuredClone((doc.objects.t1 as TextObject).style) });
    (doc.objects.t1 as TextObject).paragraphStyleId = 'ps-legende';
    doc.styles.character.push({ id: 'cs-accent-bleu', name: 'Accent bleu', style: { color: { swatch: 'bleu' } } });
    (doc.objects.t1 as TextObject).paragraphs[0].runs[1].characterStyleId = 'cs-accent-bleu';
    return doc;
  }

  it('variantes calculées par inkmatch (ΔE00 minimal), petits textes déplacés, grands corps gardés, relançable', async () => {
    const doc = smallTextDoc();
    const report = await convertDocumentSwatches(doc);
    expect(validateDocument(doc).ok).toBe(true);
    // Le gris (#4b4d55, neutre) passe en noir seul ; le bleu du segment a plus de deux encres : encres réduites.
    const gris = doc.swatches.find((s) => s.id === 'gris')!;
    const bleu = doc.swatches.find((s) => s.id === 'bleu')!;
    expect(inkCount(gris.cmyk!)).toBeGreaterThan(1);
    expect(inkCount(bleu.cmyk!)).toBeGreaterThan(SMALL_TEXT_MAX_INKS);
    expect(report.variants.map((v) => [v.source.id, v.id, v.rule])).toEqual([
      ['bleu', smallTextVariantId('bleu'), 'encres-reduites'],
      ['gris', smallTextVariantId('gris'), 'noir-seul'],
    ]);
    const grisPetit = doc.swatches.find((s) => s.id === 'gris-petit-texte')!;
    const bleuPetit = doc.swatches.find((s) => s.id === 'bleu-petit-texte')!;
    expect(grisPetit).toMatchObject({ name: 'Gris texte petit texte', sourceRgb: gris.sourceRgb });
    expect(grisPetit.cmyk!.slice(0, 3)).toEqual([0, 0, 0]);
    expect(inkCount(bleuPetit.cmyk!)).toBeLessThan(inkCount(bleu.cmyk!));
    expect(inkCount(bleuPetit.cmyk!)).toBeLessThanOrEqual(3);
    // Exception seulement pour une variante restée à trois encres (réduction la plus fidèle possible).
    expect(!!bleuPetit.smallTextException).toBe(inkCount(bleuPetit.cmyk!) > SMALL_TEXT_MAX_INKS);
    expect(grisPetit.smallTextException).toBeUndefined();
    // Même calcul fait à part par inkmatch.py : la variante est bien la combinaison au ΔE00 minimal.
    type Match = { best: { cmyk: number[]; deltaE: { cmyk: number; rgb: number } } };
    const direct = await runPrintPython<Match>('inkmatch.py', [], {
      input: JSON.stringify({ profile: 'FOGRA39', targetCmyk: bleu.cmyk, targetRgb: bleu.sourceRgb, inkSets: variantInkSets(Math.min(3, inkCount(bleu.cmyk!) - 1)) }),
      timeoutMs: 120_000,
    });
    expect(bleuPetit.cmyk).toEqual(direct.best.cmyk);
    expect(report.variants[0].deltaE).toEqual(direct.best.deltaE);
    // Styles, blocs et segments : le petit texte suit la variante, le titre de 12 pt garde le gris.
    const t1 = doc.objects.t1 as TextObject;
    expect(t1.style.color.swatch).toBe('gris-petit-texte');
    expect(doc.styles.paragraph[0].style.color.swatch).toBe('gris-petit-texte');
    expect(t1.paragraphs[0].runs[1].color).toEqual({ swatch: 'bleu-petit-texte' });
    expect(doc.styles.character[0]).toMatchObject({ id: 'cs-accent-bleu-petit-texte', name: 'Accent bleu petit texte', style: { color: { swatch: 'bleu-petit-texte' } } });
    expect(t1.paragraphs[0].runs[1].characterStyleId).toBe('cs-accent-bleu-petit-texte');
    expect((doc.objects.big as TextObject).style.color.swatch).toBe('gris');
    expect(report.variants.find((v) => v.source.id === 'gris')!.moved).toMatchObject({ paragraphStyles: ['Légende'], runs: 1 });
    // QR codes en N 100 ; plus aucun petit texte au-delà de deux encres sans exception.
    expect((doc.objects.q1 as QrObject).color.swatch).toBe(QR_BLACK_SWATCH.id);
    expect(report.qr).toBe(1);
    expect(runPreflight(doc).issues.filter((i) => i.rule === 'small-text-inks')).toEqual([]);
    // Relancé : les variantes existantes sont reprises telles quelles, rien ne bouge.
    const before = JSON.stringify(doc);
    const again = await convertDocumentSwatches(doc);
    expect(again.variants.every((v) => v.reused && v.moved.runs === 0)).toBe(true);
    expect(JSON.stringify(doc)).toBe(before);
  }, 180_000);

  it('options : sans petits textes, nuance laissée en exception (--keep), --only, --inks sans-jaune', async () => {
    const off = smallTextDoc();
    expect((await convertDocumentSwatches(off, { smallText: false })).variants).toEqual([]);
    expect(off.swatches.some((s) => s.id.endsWith('-petit-texte'))).toBe(false);
    expect((off.objects.t1 as TextObject).style.color.swatch).toBe('gris');

    const kept = smallTextDoc();
    const keptReport = await convertDocumentSwatches(kept, { smallText: { keep: ['bleu'] } });
    expect(keptReport.kept).toEqual(['Bleu']);
    expect(kept.swatches.find((s) => s.id === 'bleu')!.smallTextException).toBe(true);
    expect(keptReport.variants.map((v) => v.source.id)).toEqual(['gris']);
    expect(runPreflight(kept).issues.filter((i) => i.rule === 'small-text-inks')).toEqual([]);

    const only = smallTextDoc();
    expect((await convertDocumentSwatches(only, { smallText: { only: ['bleu'], inks: 'sans-jaune' } })).variants.map((v) => v.source.id)).toEqual(['bleu']);
    const noYellow = only.swatches.find((s) => s.id === 'bleu-petit-texte')!;
    expect(noYellow.cmyk![2]).toBe(0);
    // Le gris n'était pas demandé : son petit texte, à plus de deux encres, reste signalé par le contrôle.
    expect(runPreflight(only).issues.filter((i) => i.rule === 'small-text-inks').map((i) => i.objectId)).toEqual(['t1']);
    await expect(convertDocumentSwatches(smallTextDoc(), { smallText: { keep: ['inconnue'] } })).rejects.toThrow(/Nuance inconnue/);
  }, 180_000);
});

describe('conversions par le profil FOGRA39 (Pillow ImageCms)', () => {
  it('C86 M55 J0 N0 s’affiche avec le bleu que FOGRA39 imprimera ; le design se convertit en colorimétrie relative', async () => {
    const [blue] = await cmykToRgb([[86, 55, 0, 0]]);
    // Même calcul que le serveur, fait à part par Python : la simulation vient bien du profil.
    const direct = await runPrintPython<{ values: string[] }>('colorconv.py', [], { input: JSON.stringify({ op: 'cmyk-to-rgb', profile: 'FOGRA39', values: [[86, 55, 0, 0]] }) });
    expect(blue).toBe(direct.values[0]);
    expect(blue).toMatch(/^#[0-9a-f]{6}$/);
    expect(blue).not.toBe('#2a5fa3');
    const [titles, noir] = await rgbToCmyk(['#1f3a30', '#000000'], 'FOGRA39', { maxInk: 300 });
    expect(titles).toEqual([82, 50, 70, 62]);
    // Le noir du profil monte à 326 % : plafonné à 300 % comme le préréglage imprimeur.
    expect(inkTotal(noir)).toBeLessThanOrEqual(300);
  });
});

describe('le dépliant d’exemple (nuancier posé par scripts/print-swatches.ts)', () => {
  it('chaque nuance porte ses encres, sa simulation écran et la couleur du design ; QR codes en N 100', async () => {
    const doc = await example();
    expect(validateDocument(doc).ok).toBe(true);
    expect(doc.swatches.every((s) => s.cmyk && s.sourceRgb)).toBe(true);
    expect(new Set(doc.swatches.map((s) => s.rgb)).size).toBe(doc.swatches.length);
    const displays = await cmykToRgb(doc.swatches.map((s) => s.cmyk!));
    doc.swatches.forEach((s, i) => expect(Math.max(...[1, 3, 5].map((k) => Math.abs(parseInt(s.rgb.slice(k, k + 2), 16) - parseInt(displays[i].slice(k, k + 2), 16))))).toBeLessThanOrEqual(1));
    expect(doc.swatches.find((s) => s.id === QR_BLACK_SWATCH.id)).toMatchObject({ cmyk: [0, 0, 0, 100], sourceRgb: '#1a1a1a' });
    const qrs = Object.values(doc.objects).filter((o): o is QrObject => o.type === 'qr');
    expect(qrs).toHaveLength(6);
    for (const q of qrs) expect(q.color.swatch).toBe(QR_BLACK_SWATCH.id);
  });

  it('petits textes : gris en noir seul, couleurs en encres réduites (trois encres = exception), accent laissé tel quel', async () => {
    const doc = await example();
    const byId = new Map(doc.swatches.map((s) => [s.id, s]));
    const runs = smallRuns(doc);
    const count = (id: string) => runs.filter((r) => r.swatch === id).length;
    // Les segments de moins de 9 pt relevés à la création du dépliant d'exemple, et plus aucun dans une nuance d'origine.
    expect(Object.fromEntries(smallTextUses(doc))).toEqual({
      'texte-principal-petit-texte': 36,
      'titres-petit-texte': 60,
      'vert-petit-texte': 8,
      'orange-petit-texte': 5,
      'brun-petit-texte': 4,
      'rose-tres-clair-petit-texte': 3,
      'gris-petit-texte': 3,
      'gris-tres-clair-petit-texte': 1,
      'vert-tres-clair-petit-texte': 1,
      'jaune-tres-clair-petit-texte': 1,
      'orange-tres-clair-petit-texte': 1,
      blanc: 13,
      rose: 1,
    });
    for (const id of ['texte-principal', 'titres', 'vert', 'orange', 'brun', 'gris']) expect(count(id), id).toBe(0);
    // Gris neutres : noir seul. Couleurs : une encre de moins que la nuance d'origine, trois au plus.
    for (const id of ['texte-principal', 'gris', 'gris-tres-clair']) expect(byId.get(smallTextVariantId(id))!.cmyk!.slice(0, 3), id).toEqual([0, 0, 0]);
    for (const id of ['titres', 'vert', 'orange', 'brun', 'vert-tres-clair', 'rose-tres-clair', 'jaune-tres-clair', 'orange-tres-clair']) {
      const source = byId.get(id)!;
      const variant = byId.get(smallTextVariantId(id))!;
      expect(inkCount(variant.cmyk!), id).toBeLessThan(inkCount(source.cmyk!));
      expect(inkCount(variant.cmyk!), id).toBeLessThanOrEqual(3);
      // La couleur du design reste celle de la nuance d'origine : diff:import rend ces textes comme avant.
      expect(variant.sourceRgb, id).toBe(source.sourceRgb);
      expect(variant.name).toBe(`${source.name} petit texte`);
    }
    // Les variantes à trois encres sont marquées d'exception, les autres non ; « Rose » a été laissée telle
    // quelle (nuance d'accent, --keep rose) : quatre encres, exception déclarée, sans variante.
    const exceptions = doc.swatches.filter((s) => s.smallTextException).map((s) => s.id).sort();
    expect(exceptions).toEqual(['brun-petit-texte', 'orange-petit-texte', 'rose', 'titres-petit-texte', 'vert-petit-texte']);
    expect(inkCount(byId.get('rose')!.cmyk!)).toBe(4);
    expect(byId.has('rose-petit-texte')).toBe(false);
    for (const { swatch } of runs) {
      const sw = byId.get(swatch)!;
      expect(inkCount(sw.cmyk!) <= SMALL_TEXT_MAX_INKS || sw.smallTextException, `${sw.name} (${sw.cmyk})`).toBe(true);
    }
    // Les grands corps gardent la nuance d'origine (titres de volet et chiffres clés en « Titres »).
    const bigTitles = Object.values(doc.objects).filter((o): o is TextObject => o.type === 'text' && o.style.fontSize >= SMALL_TEXT_PT && o.style.color.swatch === 'titres');
    expect(bigTitles.length).toBeGreaterThanOrEqual(8);
    // Le contrôle en amont n'a plus rien à redire aux petits textes du dépliant.
    expect(runPreflight(doc).issues.filter((i) => i.rule === 'small-text-inks')).toEqual([]);
    // Relancer le script ne change plus rien.
    const before = JSON.stringify(doc);
    const again = await convertDocumentSwatches(doc, { smallText: { keep: ['rose'] } });
    expect(again.variants.every((v) => v.reused && v.moved.runs === 0)).toBe(true);
    expect(JSON.stringify(doc)).toBe(before);
  }, 120_000);

  it('« Titres petit texte » est l’optimum exhaustif au pour cent de ses encres (ΔE00 minimal face aux titres imprimés)', async () => {
    const doc = await example();
    const titles = doc.swatches.find((s) => s.id === 'titres')!;
    const variant = doc.swatches.find((s) => s.id === 'titres-petit-texte')!;
    const inks = ['C', 'M', 'J', 'N'].filter((_, i) => variant.cmyk![i] > 0);
    expect(inks).toEqual(['C', 'J', 'N']);
    type Match = { best: { cmyk: number[]; deltaE: { cmyk: number; rgb: number } }; bySet: { inks: string[]; best: { deltaE: { cmyk: number } } }[] };
    const exhaustive = await runPrintPython<Match>('inkmatch.py', [], {
      input: JSON.stringify({ profile: 'FOGRA39', targetCmyk: titles.cmyk, targetRgb: titles.sourceRgb, inks, exhaustive: true }),
      timeoutMs: 300_000,
    });
    expect(exhaustive.best.cmyk).toEqual(variant.cmyk);
    // Invisible face aux titres imprimés ; sans le jaune, un vert sombre n'est plus le même vert.
    expect(exhaustive.best.deltaE.cmyk).toBeLessThan(0.5);
    const sets = await runPrintPython<Match>('inkmatch.py', [], {
      input: JSON.stringify({ profile: 'FOGRA39', targetCmyk: titles.cmyk, inkSets: variantInkSets(3) }),
      timeoutMs: 300_000,
    });
    expect(sets.best.cmyk).toEqual(variant.cmyk);
    expect(sets.bySet.find((s) => s.inks.join('') === 'CMN')!.best.deltaE.cmyk).toBeGreaterThan(5);
  }, 320_000);
});
