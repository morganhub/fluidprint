// Rechercher et remplacer (tâche 2.19).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { findInDocument, replaceAll, replaceMatch } from '../src/text/findReplace';
import { minimalDoc } from './fixtures/minimal-doc';
import { EXAMPLE_FILE, copyExample, openEditor, press, readSavedDocument, saveNow, settle, withApp, withTempDocuments } from './helpers/editor';

const example = (): LayoutDocument => JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));
const nonText = (doc: LayoutDocument) => Object.values(doc.objects).filter((o) => o.type !== 'text');

describe('recherche et remplacement (modèle)', () => {
  it('remplacer « example » ne touche ni au logo ni aux QR codes, et garde les styles des segments', () => {
    const doc = example();
    const found = findInDocument(doc, 'example');
    // Le texte de présentation, l'adresse des missions, le site et le courriel ; les QR codes mènent aussi à example.com.
    expect(new Set(found.map((m) => m.objId))).toEqual(new Set(['ext-t2', 'ext-t51', 'ext-t54', 'ext-t56']));
    expect(findInDocument(doc, 'example', { caseSensitive: true }).length).toBe(found.length);
    expect(findInDocument(doc, 'Example', { caseSensitive: true })).toEqual([]);
    const count = replaceAll(doc, 'example', 'Exemple');
    expect(count).toBe(found.length);
    expect(findInDocument(doc, 'example')).toEqual([]);
    expect((doc.objects['ext-t54'] as TextObject).paragraphs[0].runs[0].text).toBe('Exemple.com');
    // Logos (svg) et QR codes : identiques au bit près.
    expect(nonText(doc)).toEqual(nonText(example()));
    expect(nonText(doc).filter((o) => o.type === 'qr').every((q) => q.type === 'qr' && q.url.includes('example.com'))).toBe(true);
    expect(validateDocument(doc).ok).toBe(true);
  });

  it('insécables et apostrophes confondues ; mot entier ; un remplacement garde la couleur du segment', () => {
    const doc = minimalDoc();
    const t1 = doc.objects.t1 as TextObject;
    t1.paragraphs.push({ runs: [{ text: 'l’atelier en 1 h 30 ; vous et vousmême' }] });
    expect(findInDocument(doc, "l'atelier en 1 h 30")).toHaveLength(1);
    expect(findInDocument(doc, 'vous')).toHaveLength(3);
    expect(findInDocument(doc, 'vous', { wholeWord: true })).toHaveLength(2);
    // « pour vous. » est bleu : le remplacement reste bleu.
    const [first] = findInDocument(doc, 'vous');
    expect(replaceMatch(doc, first, 'vous', 'toi')).toBe(true);
    expect(t1.paragraphs[0].runs).toEqual([{ text: 'Votre atelier, ' }, { text: 'pour toi.', color: { swatch: 'bleu' } }]);
    // Une occurrence périmée n'est pas remplacée.
    expect(replaceMatch(doc, first, 'vous', 'toi')).toBe(false);
  });
});

describe('Ctrl+F dans l’éditeur (navigateur)', () => {
  it('recherche, navigation, remplacement un par un puis partout (une étape), le logo reste intact', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          await press(page, 'Control', 'f');
          await page.waitForSelector('[data-find-replace] input[name="findQuery"]');
          expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('findQuery');
          await page.keyboard.type('example');
          await settle(page);
          expect(await page.$eval('[data-find-status]', (el) => el.textContent)).toBe('1 sur 4');
          await press(page, 'Enter');
          expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual(['ext-t2']);
          await press(page, 'Enter');
          expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual(['ext-t51']);
          expect(await page.$eval('[data-find-status]', (el) => el.textContent)).toBe('2 sur 4');

          await page.click('[data-find-replace] input[name="findReplacement"]');
          await page.keyboard.type('Exemple');
          await page.click('[data-action="replace-one"]');
          await settle(page);
          const t51 = await page.evaluate(() => (window.__editor!.getState().doc!.objects['ext-t51'] as TextObject).paragraphs[0].runs[0].text);
          expect(t51).toBe('Exemple.com/benevoles');
          expect(await page.$eval('[data-find-status]', (el) => el.textContent)).toBe('2 sur 3');

          const depth = await page.evaluate(() => window.__editor!.getState().history.depth);
          await page.click('[data-action="replace-all"]');
          await settle(page);
          expect(await page.$eval('[data-find-message]', (el) => el.textContent)).toBe('3 remplacements.');
          expect(await page.evaluate(() => window.__editor!.getState().history)).toMatchObject({ depth: depth + 1, undoLabel: 'Tout remplacer' });
          expect(await page.$eval('[data-find-status]', (el) => el.textContent)).toBe('Aucun résultat');

          await press(page, 'Escape');
          expect(await page.$('[data-find-replace]')).toBeNull();

          await saveNow(page);
          const saved = await readSavedDocument(dir, id);
          expect(findInDocument(saved, 'example')).toEqual([]);
          expect(nonText(saved)).toEqual(nonText(example()));
        },
        { documentsDir: dir },
      );
    });
  });
});
