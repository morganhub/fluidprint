// Styles de paragraphe et de caractère (tâche 2.21) et déduction des styles du dépliant d'exemple (tâche 2.22).
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyText, deriveStyles, MAX_PARAGRAPH_STYLES } from '../scripts/derive-styles';
import {
  applyCharacterStyleToRun,
  applyParagraphStyle,
  clearOverrides,
  createCharacterStyle,
  createParagraphStyle,
  deleteParagraphStyle,
  redefineParagraphStyle,
  textOverrides,
  updateCharacterStyle,
  updateParagraphStyle,
} from '../src/model/styles';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { minimalDoc } from './fixtures/minimal-doc';
import { EXAMPLE_FILE, copyExample, openEditor, readSavedDocument, saveNow, settle, typeInField, withApp, withTempDocuments } from './helpers/editor';

const example = (): LayoutDocument => JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));
const texts = (doc: LayoutDocument) => Object.values(doc.objects).filter((o): o is TextObject => o.type === 'text');

describe('déduction des styles du dépliant d’exemple (2.22)', () => {
  it('au plus 12 styles de paragraphe, tailles exactes conservées, document valide', () => {
    const doc = example();
    const before = structuredClone(doc);
    const report = deriveStyles(doc);
    expect(doc.styles.paragraph.length).toBeLessThanOrEqual(MAX_PARAGRAPH_STYLES);
    expect(report.paragraph.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Titre de couverture', 'Titre de volet', 'Sous-titre', 'Intertitre', 'Corps', 'Légende', 'Chiffre clé', 'Titre de carte']),
    );
    // Chaque bloc a un style ; rien de ce qui se dessine n'a changé (style effectif, segments).
    for (const t of texts(doc)) {
      expect(t.paragraphStyleId, t.id).toBeTruthy();
      const b = before.objects[t.id] as TextObject;
      expect(t.style).toEqual(b.style);
      const strip = (x: TextObject) => x.paragraphs.map((p) => p.runs.map(({ characterStyleId: _, ...r }) => r));
      expect(strip(t)).toEqual(strip(b));
    }
    const intertitre = doc.styles.paragraph.find((p) => p.name === 'Intertitre')!;
    expect(intertitre.style).toMatchObject({ fontSize: 6.5, fontWeight: 700, transform: 'uppercase', letterSpacing: 0.08 });
    expect(doc.styles.paragraph.find((p) => p.name === 'Titre de couverture')!.style.fontSize).toBe(24);
    expect(doc.styles.paragraph.find((p) => p.name === 'Corps')!.style.fontSize).toBe(7.5);
    expect(doc.styles.paragraph.find((p) => p.name === 'Chiffre clé')!.style.fontSize).toBe(14);
    // « Jeunes curieux : » (en gras) suit un style de caractère.
    const curious = doc.objects['int-t61'] as TextObject;
    expect(curious.paragraphs[0].runs[0].characterStyleId).toBeTruthy();
    expect(validateDocument(doc).ok).toBe(true);
    // Relançable sans doublon.
    deriveStyles(doc);
    expect(doc.styles.paragraph.length).toBe(report.paragraph.length);
    expect(doc.styles.character.length).toBe(report.character.length);
  });

  it('classe les rôles d’après le corps, la graisse, la casse et l’interlettrage', () => {
    const doc = example();
    expect(classifyText(doc.objects['ext-t61'] as TextObject)).toBe('Titre de couverture');
    expect(classifyText(doc.objects['int-t1'] as TextObject)).toBe('Titre de volet');
    expect(classifyText(doc.objects['ext-t13'] as TextObject)).toBe('Chiffre clé');
    expect(classifyText(doc.objects['ext-t3'] as TextObject)).toBe('Intertitre');
    expect(classifyText(doc.objects['ext-t2'] as TextObject)).toBe('Corps');
    expect(classifyText(doc.objects['int-t8'] as TextObject)).toBe('Titre de carte');
    expect(classifyText(doc.objects['int-t9'] as TextObject)).toBe('Légende');
  });
});

describe('styles de paragraphe (2.21)', () => {
  it('passer « Intertitre » de 6,5 à 7 pt met à jour tous les intertitres sans écart ; un bloc retouché garde sa retouche', () => {
    const doc = example();
    deriveStyles(doc);
    const id = doc.styles.paragraph.find((p) => p.name === 'Intertitre')!.id;
    const members = texts(doc).filter((t) => t.paragraphStyleId === id);
    // Une retouche locale : un intertitre passé à 6,8 pt.
    const retouched = members[0];
    retouched.style.fontSize = 6.8;
    const plain = members.filter((t) => t !== retouched && t.style.fontSize === 6.5);
    expect(plain.length).toBeGreaterThan(5);
    updateParagraphStyle(doc, id, { fontSize: 7 });
    for (const t of plain) expect(t.style.fontSize, t.id).toBe(7);
    expect(retouched.style.fontSize).toBe(6.8);
    // Les autres réglages (et les autres styles) n'ont pas bougé.
    for (const t of plain) expect(t.style.letterSpacing).toBe(0.08);
    expect(texts(doc).filter((t) => t.paragraphStyleId !== id && t.style.fontSize === 7).length).toBe(
      texts(example()).filter((t) => t.style.fontSize === 7).length,
    );
    expect(validateDocument(doc).ok).toBe(true);
  });

  it('écarts, « Effacer les écarts », « Redéfinir le style », suppression', () => {
    const doc = minimalDoc();
    const t1 = doc.objects.t1 as TextObject;
    const ps = createParagraphStyle(doc, 'Corps', { ...t1.style, fontSize: 8 });
    applyParagraphStyle(doc, ['t1'], ps.id);
    expect(t1.style.fontSize).toBe(8);
    // Seul écart : « pour vous. » en bleu, sans style de caractère.
    expect(textOverrides(doc, t1).map((o) => o.level)).toEqual(['segment']);
    t1.style.fontSize = 9;
    t1.paragraphs[0].fontSize = 10;
    expect(textOverrides(doc, t1).map((o) => `${o.level}:${o.key}`)).toEqual(['bloc:fontSize', 'paragraphe:fontSize', 'segment:color']);

    // Avec un style de caractère « Accent », le bleu n'est plus un écart et survit à l'effacement.
    const accent = createCharacterStyle(doc, 'Accent', { color: { swatch: 'bleu' } });
    applyCharacterStyleToRun(doc, t1.paragraphs[0].runs[1], accent.id);
    expect(textOverrides(doc, t1).some((o) => o.level === 'segment')).toBe(false);
    clearOverrides(doc, ['t1']);
    expect(t1.style.fontSize).toBe(8);
    expect(t1.paragraphs[0].fontSize).toBeUndefined();
    expect(t1.paragraphs[0].runs[1].color).toEqual({ swatch: 'bleu' });
    expect(textOverrides(doc, t1)).toEqual([]);

    // Redéfinir : le style prend la mise en forme du bloc.
    t1.style.lineHeight = 1.8;
    redefineParagraphStyle(doc, 't1');
    expect(ps.style.lineHeight).toBe(1.8);
    expect(textOverrides(doc, t1)).toEqual([]);

    // Le style de caractère mis à jour met à jour ses segments.
    updateCharacterStyle(doc, accent.id, { color: { swatch: 'gris' }, fontWeight: 700 });
    expect(t1.paragraphs[0].runs[1]).toMatchObject({ color: { swatch: 'gris' }, fontWeight: 700, characterStyleId: accent.id });
    expect(validateDocument(doc).ok).toBe(true);

    deleteParagraphStyle(doc, ps.id);
    expect(t1.paragraphStyleId).toBeUndefined();
    expect(t1.style.lineHeight).toBe(1.8);
  });

  it('validate.ts vérifie les références de styles et les nuances des styles', () => {
    const doc = minimalDoc();
    (doc.objects.t1 as TextObject).paragraphStyleId = 'ps-absent';
    (doc.objects.t1 as TextObject).paragraphs[0].runs[0].characterStyleId = 'cs-absent';
    doc.styles.paragraph.push({ id: 'ps-x', name: 'X', style: { ...(doc.objects.t1 as TextObject).style, color: { swatch: 'nulle-part' } } });
    doc.styles.character.push({ id: 'cs-x', name: 'Y', style: { color: { swatch: 'inconnue' } } }, { id: 'cs-x', name: 'Z', style: {} });
    const result = validateDocument(doc);
    expect(result.ok).toBe(false);
    const paths = result.ok ? [] : result.errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'objects.t1.paragraphStyleId',
        'objects.t1.paragraphs.0.runs.0.characterStyleId',
        'styles.paragraph.0.style.color.swatch',
        'styles.character.0.style.color.swatch',
        'styles.character.1.id',
      ]),
    );
    // Un document de la phase 1 (sans aucun des nouveaux champs) reste valide.
    expect(validateDocument(minimalDoc()).ok).toBe(true);
    expect(validateDocument(example()).ok).toBe(true);
  });
});

describe('panneau Styles et Propriétés (2.21, navigateur)', () => {
  it('modifier un style met à jour les blocs en direct ; « + », Effacer les écarts, Redéfinir le style', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      // Styles déduits sur la copie (jamais sur documents/).
      const file = `${dir}/${id}/document.json`;
      const doc = JSON.parse(readFileSync(file, 'utf8')) as LayoutDocument;
      deriveStyles(doc);
      writeFileSync(file, JSON.stringify(doc));
      const intertitre = doc.styles.paragraph.find((p) => p.name === 'Intertitre')!;

      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 2, centerOn: 'ext-t3' });
          // Corps rendu, en pt (au centième).
          const fontSizeOf = (objId: string) =>
            page.$eval(`[data-page-id] [data-obj-id="${objId}"]`, (el) => Math.round(((parseFloat(getComputedStyle(el).fontSize) * 72) / 96) * 100) / 100);
          expect(await fontSizeOf('ext-t3')).toBe(6.5);

          // Panneau Styles : Intertitre 6,5 → 7 pt.
          await page.click('[data-panel-tab="styles"]');
          await page.click(`[data-paragraph-style="${intertitre.id}"] [data-action="edit-style"]`);
          await typeInField(page, 'styleFontSize', '7');
          expect(await fontSizeOf('ext-t3')).toBe(7);
          expect(await fontSizeOf('int-t3')).toBe(7);

          // Propriétés d'un intertitre retouché : « + », puis Effacer les écarts.
          await page.evaluate(() => window.__editor!.getState().update(['int-t25'], (o) => void ((o as TextObject).style.fontSize = 6.8), 'Corps'));
          await page.evaluate(() => window.__editor!.getState().select(['int-t25']));
          await page.click('[data-panel-tab="properties"]');
          await settle(page);
          expect(await page.$('[data-style-override]')).not.toBeNull();
          await page.click('[data-action="clear-overrides"]');
          await settle(page);
          expect(await page.evaluate(() => (window.__editor!.getState().doc!.objects['int-t25'] as TextObject).style.fontSize)).toBe(7);
          expect(await page.$('[data-style-override]')).toBeNull();

          // Redéfinir le style depuis un bloc passé à 7,5 pt : les autres intertitres suivent.
          await page.evaluate(() => window.__editor!.getState().update(['int-t25'], (o) => void ((o as TextObject).style.fontSize = 7.5), 'Corps'));
          await settle(page);
          await page.click('[data-action="redefine-style"]');
          await settle(page);
          expect(await fontSizeOf('ext-t3')).toBe(7.5);

          // Chaque modification est une étape : Ctrl+Z revient à 7 pt partout.
          await page.evaluate(() => window.__editor!.getState().undo());
          await settle(page);
          expect(await fontSizeOf('ext-t3')).toBe(7);

          await saveNow(page);
          const saved = await readSavedDocument(dir, id);
          expect(saved.styles.paragraph.find((p) => p.id === intertitre.id)!.style.fontSize).toBe(7);
          expect(validateDocument(saved).ok).toBe(true);
        },
        { documentsDir: dir },
      );
    });
  });
});
