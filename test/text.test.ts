// Édition du texte sur place (tâche 2.6) et correcteur orthographique (tâche 2.16).
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument, Paragraph, TextObject } from '../src/model/types';
import { docToParagraphs, normalizeRuns, paragraphsToDoc, sameParagraphs } from '../src/text/richText';
import { NNBSP } from '../src/text/typographyFr';
import { clickAt, copyExample, openEditor, press, readSavedDocument, saveNow, settle, withApp, withTempDocuments } from './helpers/editor';
import { openTextEditor } from './helpers/text';

describe('conversion modèle ↔ Tiptap', () => {
  it('aller-retour sans perte : segments, couleurs, retours à la ligne, fine insécable, surcharges de paragraphe', () => {
    const paragraphs: Paragraph[] = [
      { runs: [{ text: 'Créer de vos mains,\npas à pas, ' }, { text: 'avec nous.', color: { swatch: 'bleu' } }] },
      { runs: [{ text: 'Jeunes curieux :', fontWeight: 700, characterStyleId: 'cs-gras' }, { text: ` gratuit${NNBSP}!`, italic: true, fontSize: 6.8, letterSpacing: 0.02, transform: 'uppercase' }], fontSize: 9, align: 'center', lineHeight: 1.2, spaceBefore: 1.5 },
      { runs: [] },
    ];
    const json = paragraphsToDoc(paragraphs);
    expect(json.content![0].content!.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text', 'text']);
    expect(json.content![1].content!.some((n) => n.type === 'nnbsp')).toBe(true);
    const back = docToParagraphs(json);
    expect(back).toEqual(paragraphs);
    expect(sameParagraphs(back, paragraphs)).toBe(true);
    // Segments voisins de même mise en forme : fusionnés, vides retirés.
    expect(normalizeRuns([{ text: 'a' }, { text: '' }, { text: 'b' }, { text: 'c', color: { swatch: 'x' } }])).toEqual([{ text: 'ab' }, { text: 'c', color: { swatch: 'x' } }]);
  });
});

const editorText = (page: Page, id: string) =>
  page.evaluate((i) => {
    const t = window.__editor!.getState().doc!.objects[i] as TextObject;
    return t.paragraphs;
  }, id);

/** Lignes rendues d'un élément : texte de chaque ligne et position (px) de son premier caractère. */
function renderedLines(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const chars: { c: string; top: number; left: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.parentElement?.closest('style')) continue;
      for (let i = 0; i < node.data.length; i++) {
        const c = node.data[i];
        if (c === '⁠') continue;
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = [...range.getClientRects()].find((x) => x.width > 0 || x.height > 0);
        if (r) chars.push({ c, top: (r.top + r.bottom) / 2, left: r.left });
      }
    }
    const lines: { text: string; top: number; left: number }[] = [];
    for (const ch of chars) {
      const line = lines.at(-1);
      if (line && Math.abs(line.top - ch.top) < 2) line.text += ch.c;
      else lines.push({ text: ch.c, top: ch.top, left: ch.left });
    }
    return lines.map((l) => ({ text: l.text.trim(), top: Math.round(l.top * 10) / 10, left: Math.round(l.left * 10) / 10 }));
  }, selector);
}

describe('édition du texte sur place (navigateur)', () => {
  it('même rendu en édition, « avec nous. » reste vert, Entrée / Maj+Entrée, collage nettoyé, une étape d’annulation, correcteur', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1.5, centerOn: 'ext-t1' });

          // 1. La ligne ne saute pas en entrant en édition (titre à deux segments, paragraphe « pretty »,
          //    segment gras, durée).
          for (const objId of ['ext-t1', 'ext-t2', 'int-t61', 'int-t9', 'ext-t61']) {
            await page.evaluate((i) => window.__editor!.getState().centerOn([i]), objId);
            await settle(page);
            const view = await renderedLines(page, `[data-page-id] [data-obj-id="${objId}"]`);
            await openTextEditor(page, objId);
            const edit = await renderedLines(page, `[data-text-editor="${objId}"]`);
            expect(edit.map((l) => l.text), objId).toEqual(view.map((l) => l.text));
            for (let i = 0; i < view.length; i++) {
              expect(Math.abs(edit[i].top - view[i].top), `${objId} ligne ${i + 1}`).toBeLessThanOrEqual(0.5);
              expect(Math.abs(edit[i].left - view[i].left), `${objId} ligne ${i + 1}`).toBeLessThanOrEqual(0.5);
            }
            // Le bloc rendu est masqué pendant l'édition ; sortie sans modification : aucune étape.
            expect(await page.$eval(`[data-page-id] [data-obj-id="${objId}"]`, (el) => getComputedStyle(el).visibility)).toBe('hidden');
            await press(page, 'Escape');
            expect(await page.$(`[data-text-editor="${objId}"]`)).toBeNull();
          }
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(0);

          // 2. Éditer le titre : « avec nous. » garde son vert ; toute la session = une étape.
          const original = await editorText(page, 'ext-t1');
          await openTextEditor(page, 'ext-t1');
          // Correcteur (2.16) : seulement sur le bloc en édition.
          expect(await page.$eval('[data-text-editor="ext-t1"]', (el) => [el.getAttribute('spellcheck'), el.getAttribute('lang'), (el as HTMLElement).isContentEditable])).toEqual(['true', 'fr', true]);
          expect(await page.$$eval('[data-page-id] [spellcheck], [data-page-id] [contenteditable]', (els) => els.length)).toBe(0);
          await press(page, 'Control', 'Home');
          await page.keyboard.type('Enfin : ');
          await press(page, 'Control', 'End');
          await page.keyboard.type(' Technophle');
          await press(page, 'Escape');
          const edited = await editorText(page, 'ext-t1');
          expect(edited[0].runs.map((r) => r.text).join('')).toBe(`Enfin : Créer de vos mains,\npas à pas, avec nous. Technophle`);
          const accent = edited[0].runs.find((r) => r.text.includes('avec nous.'))!;
          expect(accent.color).toEqual({ swatch: 'vert' });
          expect(edited[0].runs[0].color).toBeUndefined();
          const history = await page.evaluate(() => window.__editor!.getState().history);
          expect(history).toMatchObject({ depth: 1, undoLabel: 'Modifier le texte' });
          await press(page, 'Control', 'z');
          expect(await editorText(page, 'ext-t1')).toEqual(original);
          await press(page, 'Control', 'y');
          expect(await editorText(page, 'ext-t1')).toEqual(edited);

          // 3. Entrée = paragraphe, Maj+Entrée = retour à la ligne.
          await openTextEditor(page, 'ext-t30');
          await press(page, 'Control', 'End');
          await press(page, 'Enter');
          await page.keyboard.type('Deux');
          await press(page, 'Shift', 'Enter');
          await page.keyboard.type('Trois');
          await press(page, 'Escape');
          const paras = await editorText(page, 'ext-t30');
          expect(paras.length).toBe(2);
          expect(paras[1].runs.map((r) => r.text).join('')).toBe('Deux\nTrois');

          // 4. Collage depuis Word : ni police, ni couleur, ni corps étrangers ; gras et italique gardés.
          await openTextEditor(page, 'ext-t30');
          await press(page, 'Control', 'End');
          await page.$eval('[data-text-editor="ext-t30"]', (el) => {
            const html =
              '<html><head><style>p.MsoNormal{font-family:"Comic Sans MS";color:red}</style></head><body><!--StartFragment-->' +
              '<p class=MsoNormal style="font-family:Calibri;color:#ff0000;font-size:20pt;text-align:center">' +
              '<b><span style=\'font-family:"Comic Sans MS";color:red;font-size:20.0pt\'>Gras rouge</span></b> ' +
              '<i><span style="color:#00ff00;font-family:Arial">italique vert</span></i> ' +
              '<span style="font-family:Arial;color:blue;letter-spacing:3pt;text-transform:uppercase">bleu</span></p><!--EndFragment--></body></html>';
            const data = new DataTransfer();
            data.setData('text/html', html);
            data.setData('text/plain', 'Gras rouge italique vert bleu');
            el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
          });
          await settle(page);
          await press(page, 'Escape');
          const pasted = (await editorText(page, 'ext-t30')).flatMap((p) => p.runs);
          const runOf = (s: string) => pasted.find((r) => r.text.includes(s))!;
          expect(runOf('Gras rouge')).toEqual({ text: expect.stringContaining('Gras rouge'), fontWeight: 700 });
          expect(runOf('italique vert')).toEqual({ text: expect.stringContaining('italique vert'), italic: true });
          expect(runOf('bleu')).toEqual({ text: expect.stringContaining('bleu') });
          const saved0 = await editorText(page, 'ext-t30');
          expect(JSON.stringify(saved0)).not.toMatch(/Comic|Arial|Calibri|ff0000|color|fontSize|letterSpacing|uppercase|align/);

          // 5. Barre flottante : gras et nuance sur une sélection.
          await openTextEditor(page, 'ext-t30');
          await press(page, 'Control', 'Home');
          await press(page, 'Shift', 'End');
          await page.click('[data-action="text-bold"]');
          await page.click('[data-action="text-color"]');
          await page.click('[data-swatch-option="bleu"]');
          await page.click('[data-action="text-done"]');
          await settle(page);
          const styled = (await editorText(page, 'ext-t30'))[0].runs[0];
          expect(styled).toMatchObject({ fontWeight: 700, color: { swatch: 'bleu' } });

          // 6. Un clic hors du bloc termine l'édition ; l'export n'a ni spellcheck, ni contenteditable.
          await openTextEditor(page, 'ext-t2');
          await page.mouse.click(5, 300);
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().mode)).toBeNull();
          // 7. Un texte créé par l'outil Texte s'ouvre aussitôt en édition, tout sélectionné.
          await page.evaluate(() => window.__editor!.getState().centerOn(['p-exterieur']));
          await settle(page);
          await press(page, 't');
          await clickAt(page, 'p-exterieur', 150, 120);
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-text-editor') === true);
          await page.keyboard.type('Nouveau bloc');
          await press(page, 'Escape');
          const [created] = await page.evaluate(() => window.__editor!.getState().selection);
          expect((await editorText(page, created))[0].runs).toEqual([{ text: 'Nouveau bloc' }]);

          await saveNow(page);
          const saved: LayoutDocument = await readSavedDocument(dir, id);
          expect((saved.objects['ext-t1'] as TextObject).paragraphs).toEqual(edited);

          const print = await browser.newPage();
          await print.goto(`${url}/print/${id}`);
          await print.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, { timeout: 60_000 });
          expect(await print.$$eval('[spellcheck], [contenteditable], [data-text-editor], [lang]:not(html)', (els) => els.length)).toBe(0);
          expect(await print.$eval('[data-obj-id="ext-t1"]', (el) => el.textContent)).toContain('Technophle');
        },
        { documentsDir: dir },
      );
    });
  });
});
