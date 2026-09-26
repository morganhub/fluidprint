// Texte en excès et hauteur automatique (tâche 2.26).
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { TextObject } from '../src/model/types';
import { copyExample, openEditor, press, readSavedDocument, saveNow, settle, withApp, withTempDocuments } from './helpers/editor';
import { openTextEditor } from './helpers/text';

const markers = (page: Page) => page.$$eval('[data-overset-marker]', (els) => els.map((e) => e.getAttribute('data-overset-marker')));
const objectOf = (page: Page, id: string) => page.evaluate((i) => window.__editor!.getState().doc!.objects[i] as TextObject, id);

async function editAtEnd(page: Page, id: string, keys: () => Promise<void>) {
  await openTextEditor(page, id);
  await press(page, 'Control', 'End');
  await keys();
  await press(page, 'Escape');
}

describe('texte en excès et hauteur auto (navigateur)', () => {
  it('ajouter une ligne à une carte pleine fait apparaître le « + » ; Hauteur auto suit le texte ; rien à l’impression', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 2, centerOn: 'int-t4' });
          // Le dépliant d'exemple importé ne déborde nulle part.
          expect(await markers(page)).toEqual([]);

          // Carte pleine : « Me protéger et protéger mes proches » (texte = hauteur du bloc).
          const card = 'int-t4';
          const before = await objectOf(page, card);
          await editAtEnd(page, card, async () => {
            await press(page, 'Shift', 'Enter');
            await page.keyboard.type('une ligne de plus');
          });
          await settle(page);
          expect(await markers(page)).toEqual([card]);
          // Le « + » est au coin bas-droit du bloc, à l'écran.
          const marker = await page.$eval(`[data-overset-marker="${card}"]`, (el) => el.getBoundingClientRect().toJSON());
          const box = await page.evaluate((i) => window.__editor!.objectClientBox(i), card);
          expect(Math.abs(marker.x + marker.width / 2 - (box.x + box.w))).toBeLessThan(2);
          expect(Math.abs(marker.y + marker.height / 2 - (box.y + box.h))).toBeLessThan(2);

          // Propriétés : alerte, puis « Ajuster la hauteur ».
          await page.evaluate((i) => window.__editor!.getState().select([i]), card);
          await settle(page);
          expect(await page.$('[data-testid="overset-warning"]')).not.toBeNull();
          await page.click('[data-action="fit-text-height"]');
          await settle(page);
          expect(await markers(page)).toEqual([]);
          const fitted = await objectOf(page, card);
          expect(fitted.h).toBeGreaterThan(before.h + 2);
          expect(fitted.y).toBe(before.y);

          // Hauteur auto : le bloc suit son texte, dans la même étape d'annulation que la frappe.
          await page.click('[data-section="text-frame"] input[name="autoHeight"]');
          await settle(page);
          expect((await objectOf(page, card)).autoHeight).toBe(true);
          const depth = await page.evaluate(() => window.__editor!.getState().history.depth);
          await editAtEnd(page, card, async () => {
            await press(page, 'Shift', 'Enter');
            await page.keyboard.type('et encore une');
          });
          await settle(page);
          const grown = await objectOf(page, card);
          expect(grown.h).toBeGreaterThan(fitted.h + 2);
          expect(await markers(page)).toEqual([]);
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(depth + 1);
          await press(page, 'Control', 'z');
          expect((await objectOf(page, card)).h).toBe(fitted.h);

          // Un changement de corps (hors éditeur de texte) est suivi aussi.
          await page.evaluate((i) => window.__editor!.getState().update([i], (o) => void ((o as TextObject).style.fontSize = 9), 'Corps'), card);
          await settle(page);
          await settle(page);
          expect((await objectOf(page, card)).h).toBeGreaterThan(fitted.h);
          expect(await markers(page)).toEqual([]);

          // Le nombre de lignes suivi par l'export suit le texte modifié.
          const lines = await page.$eval(`[data-page-id] [data-obj-id="${card}"]`, (el) => el.getClientRects().length);
          expect(lines).toBeGreaterThan(0);
          await saveNow(page);
          const saved = await readSavedDocument(dir, id);
          const t = saved.objects[card] as TextObject;
          expect(t.autoHeight).toBe(true);
          expect(t.lines).toBeGreaterThan(before.lines!);

          // Sans « Hauteur auto », un bloc trop petit reste signalé ; jamais dans la route d'impression.
          await page.evaluate(() => window.__editor!.getState().update(['int-t5'], (o) => void (o.h = 1), 'Hauteur'));
          await settle(page);
          expect(await markers(page)).toContain('int-t5');
          await saveNow(page);
          const print = await browser.newPage();
          await print.goto(`${url}/print/${id}`);
          await print.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, { timeout: 60_000 });
          expect(await print.$$('[data-overset-marker]')).toHaveLength(0);
        },
        { documentsDir: dir },
      );
    });
  });
});
