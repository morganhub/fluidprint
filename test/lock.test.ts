// Verrouiller un objet (tâche 2.13) : Ctrl+L et cadenas du panneau Calques ; un objet verrouillé n'est
// sélectionnable ni au clic ni au lasso, et ne se déplace pas ; Ctrl+Alt+L déverrouille la face.
import { describe, expect, it } from 'vitest';
import type { LayoutDocument } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, copyExample, dragFrom, openEditor, pageToClient, press, readSavedDocument, saveNow, selection, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';

// Scénario complet dans Chrome : large marge quand toute la suite tourne en parallèle.
const BROWSER_TIMEOUT_MS = 180_000;

function lockDoc(): LayoutDocument {
  const doc = minimalDoc();
  doc.objects.r2 = { id: 'r2', type: 'rect', name: 'Voisin', layerId: 'contenu', x: 50, y: 22, w: 20, h: 10, fill: { swatch: 'gris' } };
  doc.pages[0].children.push('r2');
  return doc;
}

describe('verrouiller un objet (2.13)', () => {
  it('Ctrl+L verrouille : ni clic, ni lasso, ni déplacement ; le cadenas du panneau et Ctrl+Alt+L déverrouillent', async () => {
    await withTempDocuments(async (dir) => {
      const doc = lockDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          const x0 = doc.objects.r1.x;

          // Ctrl+L sur la sélection : verrouillé, et retiré de la sélection.
          await clickAt(page, 'p-ext', 25, 27);
          expect(await selection(page)).toEqual(['r1']);
          await press(page, 'Control', 'l');
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.locked)).toBe(true);
          expect(await selection(page)).toEqual([]);

          // Le clic passe au travers.
          await clickAt(page, 'p-ext', 25, 27);
          expect(await selection(page)).toEqual([]);

          // Un lasso qui englobe l'objet verrouillé et son voisin ne prend que le voisin.
          const start = await pageToClient(page, 'p-ext', 5, 15);
          await dragFrom(page, start, 75, 25);
          expect(await selection(page)).toEqual(['r2']);

          // Un glisser depuis l'objet verrouillé ne le déplace pas (c'est un lasso vide).
          await clickAt(page, 'p-ext', 150, 150);
          await dragFrom(page, await pageToClient(page, 'p-ext', 25, 27), 30, 0);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.x)).toBe(x0);
          // Les flèches non plus (rien n'est sélectionné).
          await press(page, 'ArrowRight');
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.x)).toBe(x0);

          // Cadenas du panneau Calques : déverrouiller, puis reverrouiller objet par objet.
          await page.click('[data-panel-tab="layers"]');
          const lockButton = '[data-object-row="r1"] [data-toggle="locked"]';
          await page.waitForSelector(lockButton);
          expect(await page.$eval(lockButton, (b) => b.getAttribute('aria-label'))).toBe('Déverrouiller');
          await page.click(lockButton);
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.locked)).toBeUndefined();
          await clickAt(page, 'p-ext', 25, 27);
          expect(await selection(page)).toEqual(['r1']);
          await page.click(lockButton);
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.locked)).toBe(true);
          expect(await selection(page)).toEqual([]);
          // Un objet verrouillé ne se sélectionne pas non plus depuis le panneau.
          await page.click('[data-object-row="r1"]');
          expect(await selection(page)).toEqual([]);

          await saveNow(page);
          expect((await readSavedDocument(dir, doc.id)).objects.r1.locked).toBe(true);

          // Ctrl+Alt+L : tout déverrouiller sur la face active.
          await press(page, 'Control', 'Alt', 'l');
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.locked)).toBeUndefined();
          expect(await selection(page)).toEqual(['r1']);
          // L'aide des raccourcis les liste.
          const ids = await page.evaluate(() => window.__editor!.registries().shortcuts);
          expect(ids).toEqual(expect.arrayContaining(['lock', 'unlock-all']));
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);

  it('Ctrl+Alt+L laisse verrouillés le trait de coupe et les plis ; un rectangle ou une ellipse sans fond ne s’attrape qu’à son contour', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'ext-g1' });
          const locks = () => page.evaluate(() => Object.fromEntries(['ext-g9', 'ext-rep1', 'ext-rep2', 'ext-rep3'].map((i) => [i, window.__editor!.getState().doc!.objects[i].locked ?? false])));
          const box = (objId: string) => page.evaluate((i) => ({ ...window.__editor!.getState().doc!.objects[i] }), objId);

          // Ctrl+L sur une carte, puis Ctrl+Alt+L : seule la carte est libérée (et sélectionnée).
          await page.evaluate(() => window.__editor!.getState().select(['ext-g9']));
          await press(page, 'Control', 'l');
          expect(await locks()).toEqual({ 'ext-g9': true, 'ext-rep1': true, 'ext-rep2': true, 'ext-rep3': true });
          await press(page, 'Control', 'Alt', 'l');
          expect(await locks()).toEqual({ 'ext-g9': false, 'ext-rep1': true, 'ext-rep2': true, 'ext-rep3': true });
          expect(await selection(page)).toEqual(['ext-g9']);

          // Trait de coupe déverrouillé à la main (297 × 210 mm, sans fond) : son intérieur laisse passer le clic.
          await page.evaluate(() => window.__editor!.getState().update(['ext-rep1'], { locked: undefined }, 'Déverrouiller'));
          await settle(page);
          await clickAt(page, 'p-exterieur', 7, 62.9);
          expect(await selection(page)).toEqual([]);
          const g9 = await box('ext-g9');
          await clickAt(page, 'p-exterieur', g9.x + g9.w / 2, g9.y + g9.h / 2);
          expect(await selection(page)).toEqual(['ext-g9']);
          // Sur son contour, il s'attrape.
          await clickAt(page, 'p-exterieur', 3, 100);
          expect(await selection(page)).toEqual(['ext-rep1']);

          // Un lasso commencé à l'intérieur du trait de coupe sélectionne la carte et ne déplace rien.
          await clickAt(page, 'p-exterieur', 7, 62.9);
          const g1 = await box('ext-g1');
          await dragFrom(page, await pageToClient(page, 'p-exterieur', 7, 62.9), g1.w + 4, g1.h + 4);
          const sel = await selection(page);
          expect(sel).toContain('ext-g1');
          expect(sel).not.toContain('ext-rep1');
          expect(await box('ext-rep1')).toMatchObject({ x: 3, y: 3 });

          // Même règle pour une ellipse sans fond.
          await page.evaluate(() => {
            const s = window.__editor!.getState();
            s.add([{ id: 'e-vide', type: 'ellipse', layerId: 'contenu', x: 10, y: 44, w: 60, h: 11, stroke: { color: { swatch: 'vert' }, width: 1 } }], ['e-vide'], { pageId: 'p-exterieur' });
            s.clearSelection();
          });
          await settle(page);
          await clickAt(page, 'p-exterieur', 40, 49.5);
          expect(await selection(page)).toEqual([]);
          await clickAt(page, 'p-exterieur', 10.1, 49.5);
          expect(await selection(page)).toEqual(['e-vide']);
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);
});
