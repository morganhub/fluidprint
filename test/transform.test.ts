// Poignées (tâche 2.5) : un objet glissé de 10 mm à l'écran l'est de 10,0 mm dans document.json, à
// 50, 100 et 200 % ; redimensionnement aux poignées (Maj : proportions) ; flèches 0,5 et 5 mm.
import { describe, expect, it } from 'vitest';
import type { GroupObject, LayoutDocument } from '../src/model/types';
import { PX_PER_MM } from '../src/model/units';
import { minimalDoc } from './fixtures/minimal-doc';
import {
  clickAt,
  copyExample,
  dragFrom,
  dragObject,
  openEditor,
  press,
  readSavedDocument,
  saveNow,
  selection,
  setZoom,
  withApp,
  withTempDocuments,
  writeDocument,
} from './helpers/editor';

describe('poignées : déplacer et redimensionner (2.5)', () => {
  it('un objet glissé de 10 mm à l’écran l’est de 10,0 mm dans document.json, à 50, 100 et 200 %', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      const original = await readSavedDocument(dir, id);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          // Magnétisme coupé : ce test vérifie le pas de la souris, pas l'aimantation (snapping.test.ts).
          await page.click('[data-snapping-toggle]');
          let expected = { x: original.objects['ext-g9'].x, y: original.objects['ext-g9'].y };
          for (const zoom of [0.5, 1, 2]) {
            await setZoom(page, zoom, 'ext-g9');
            const depth = await page.evaluate(() => window.__editor!.getState().history.depth);
            await dragObject(page, 'ext-g9', 10, 10, { steps: 8 });
            expect(await selection(page)).toEqual(['ext-g9']);
            expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(depth + 1);
            await saveNow(page);
            const saved = await readSavedDocument(dir, id);
            const g = saved.objects['ext-g9'] as GroupObject;
            expected = { x: expected.x + 10, y: expected.y + 10 };
            expect(g.x).toBeCloseTo(expected.x, 4);
            expect(g.y).toBeCloseTo(expected.y, 4);
            // Le groupe emmène ses enfants (coordonnées absolues).
            const src = original.objects['ext-g9'] as GroupObject;
            const moved = (expected.x - src.x) / 1;
            for (const c of g.children) expect(saved.objects[c].x - original.objects[c].x).toBeCloseTo(moved, 4);
          }
          // Les autres objets n'ont pas bougé d'un bit.
          const saved = await readSavedDocument(dir, id);
          const touched = new Set(['ext-g9', ...(original.objects['ext-g9'] as GroupObject).children]);
          for (const [objId, obj] of Object.entries(original.objects)) if (!touched.has(objId)) expect(saved.objects[objId]).toEqual(obj);
          // Ctrl+Z : retour au 0,01 mm près.
          await press(page, 'Control', 'z');
          await press(page, 'Control', 'z');
          await press(page, 'Control', 'z');
          const back = await page.evaluate(() => window.__editor!.getState().doc!.objects['ext-g9']);
          expect(Math.abs(back.x - original.objects['ext-g9'].x)).toBeLessThan(0.01);
          expect(Math.abs(back.y - original.objects['ext-g9'].y)).toBeLessThan(0.01);
        },
        { documentsDir: dir },
      );
    });
  });

  it('redimensionne aux poignées (Maj : proportions), déplace aux flèches de 0,5 et 5 mm', async () => {
    await withTempDocuments(async (dir) => {
      const doc: LayoutDocument = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          // Magnétisme coupé : ce test vérifie le pas de la souris, pas l'aimantation (snapping.test.ts).
          await page.click('[data-snapping-toggle]');
          await clickAt(page, 'p-ext', 25, 27);
          expect(await selection(page)).toEqual(['r1']);

          const handle = async (dir: string) => {
            const el = await page.waitForSelector(`.editor-moveable .moveable-control[data-direction="${dir}"]`, { visible: true });
            const b = (await el!.boundingBox())!;
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          };
          // Poignée droite tirée de 10 mm : 30 → 40 mm, le bord gauche ne bouge pas.
          await dragFrom(page, await handle('e'), 10, 0, { steps: 6 });
          let r1 = await page.evaluate(() => window.__editor!.getState().doc!.objects.r1);
          expect(r1.w).toBeCloseTo(40, 4);
          expect(r1.x).toBeCloseTo(10, 4);
          expect(r1.h).toBeCloseTo(15, 4);
          // Poignée gauche tirée de 5 mm vers la gauche : x 10 → 5, largeur 45.
          await dragFrom(page, await handle('w'), -5, 0, { steps: 6 });
          r1 = await page.evaluate(() => window.__editor!.getState().doc!.objects.r1);
          expect(r1.x).toBeCloseTo(5, 4);
          expect(r1.w).toBeCloseTo(45, 4);
          // Coin bas-droit avec Maj : proportions gardées (45 × 15 → 54 × 18).
          await dragFrom(page, await handle('se'), 9, 1, { steps: 6, hold: ['Shift'] });
          r1 = await page.evaluate(() => window.__editor!.getState().doc!.objects.r1);
          expect(r1.w).toBeCloseTo(54, 4);
          expect(r1.h).toBeCloseTo(18, 4);
          expect(r1.x).toBeCloseTo(5, 4);
          expect(r1.y).toBeCloseTo(20, 4);
          // Chaque geste = une étape d'annulation.
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(3);

          // Flèches : 0,5 mm ; Maj+flèches : 5 mm.
          await press(page, 'ArrowRight');
          await press(page, 'Shift', 'ArrowDown');
          r1 = await page.evaluate(() => window.__editor!.getState().doc!.objects.r1);
          expect(r1.x).toBeCloseTo(5.5, 6);
          expect(r1.y).toBeCloseTo(25, 6);

          // L'écran suit le document : le bord gauche du rectangle est à x mm de la face.
          const shown = await page.evaluate(() => {
            const face = document.querySelector('[data-page-id="p-ext"]')!.getBoundingClientRect();
            const el = document.querySelector('[data-obj-id="r1"]')!.getBoundingClientRect();
            return { left: el.left - face.left, width: el.width };
          });
          expect(shown.left / PX_PER_MM).toBeCloseTo(5.5, 1);
          expect(shown.width / PX_PER_MM).toBeCloseTo(54, 1);

          await saveNow(page);
          const saved = await readSavedDocument(dir, doc.id);
          expect(saved.objects.r1).toMatchObject({ x: 5.5, y: 25, w: 54, h: 18 });
        },
        { documentsDir: dir },
      );
    });
  });
});
