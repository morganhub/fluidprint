// Repères de page (tâches 2.23 et 2.27) : plis à 100 et 200 mm (extérieur), 103 et 203 mm (intérieur)
// depuis le bord du fond perdu ; zone de sécurité à 4 mm du trait de coupe et de chaque pli ; W les
// masque (aperçu) ; rien de tout cela dans la route d'impression.
import type { Page as BrowserPage } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { pageGuideGeometry } from '../src/editor/PageGuides';
import type { DocumentFormat } from '../src/model/types';
import template from '../src/model/templates/depliant-3-volets.json';
import { copyExample, openEditor, pageToClient, press, settle, withApp, withTempDocuments } from './helpers/editor';

const format = template as DocumentFormat;

describe('géométrie des repères de page (unitaire)', () => {
  it('gabarit : safety = 4 mm ; plis et zones de sécurité par volet', () => {
    expect(format.safety).toBe(4);
    const ext = pageGuideGeometry(format, 'exterieur');
    expect(ext.folds).toEqual([100, 200]);
    expect(ext.trim).toEqual({ x: 3, y: 3, w: 297, h: 210 });
    expect(ext.bleed).toEqual({ x: 0, y: 0, w: 303, h: 216 });
    expect(ext.safety.map((b) => [b.x, b.x + b.w])).toEqual([
      [7, 96],
      [104, 196],
      [204, 296],
    ]);
    for (const b of ext.safety) expect([b.y, b.y + b.h]).toEqual([7, 209]);
    const int = pageGuideGeometry(format, 'interieur');
    expect(int.folds).toEqual([103, 203]);
    expect(int.safety.map((b) => [b.x, b.x + b.w])).toEqual([
      [7, 99],
      [107, 199],
      [207, 296],
    ]);
  });
});

/** Position client (px) des traits d'une face : plis (x), zones de sécurité (bords), coupe. */
async function drawn(page: BrowserPage, pageId: string) {
  return page.evaluate((id) => {
    const root = document.querySelector(`[data-page-guides="${id}"]`);
    if (!root) return null;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    return {
      folds: [...root.querySelectorAll('[data-page-guide="fold"]')].map((el) => ({ at: Number(el.getAttribute('data-at')), ...rect(el) })),
      safety: [...root.querySelectorAll('[data-page-guide="safety"]')].map(rect),
      trim: rect(root.querySelector('[data-page-guide="trim"]')!),
    };
  }, pageId);
}

describe('repères de page dans l’éditeur (2.23, 2.27)', () => {
  it('plis, sécurité et coupe au bon endroit à plusieurs zooms ; W masque tout ; rien dans la route d’impression', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          const expected = {
            'p-exterieur': { folds: [100, 200], safety: [[7, 96], [104, 196], [204, 296]] },
            'p-interieur': { folds: [103, 203], safety: [[7, 99], [107, 199], [207, 296]] },
          } as const;
          for (const zoom of [0.5, 1, 2]) {
            for (const [pageId, exp] of Object.entries(expected)) {
              await page.evaluate(
                (z, p) => {
                  window.__editor!.getState().setZoom(z);
                  window.__editor!.getState().centerOn([p]);
                },
                zoom,
                pageId,
              );
              await settle(page);
              const d = (await drawn(page, pageId))!;
              expect(d.folds.map((f) => f.at)).toEqual([...exp.folds]);
              for (const f of d.folds) {
                const x = (await pageToClient(page, pageId, f.at, 0)).x;
                expect(Math.abs(f.left - x)).toBeLessThan(0.5);
              }
              expect(d.safety).toHaveLength(3);
              for (const [i, [x0, x1]] of exp.safety.entries()) {
                const a = await pageToClient(page, pageId, x0, 7);
                const b = await pageToClient(page, pageId, x1, 209);
                expect(Math.abs(d.safety[i].left - a.x)).toBeLessThan(0.5);
                expect(Math.abs(d.safety[i].right - b.x)).toBeLessThan(0.5);
                expect(Math.abs(d.safety[i].top - a.y)).toBeLessThan(0.5);
                expect(Math.abs(d.safety[i].bottom - b.y)).toBeLessThan(0.5);
              }
              const t0 = await pageToClient(page, pageId, 3, 3);
              const t1 = await pageToClient(page, pageId, 300, 213);
              expect(Math.abs(d.trim.left - t0.x)).toBeLessThan(0.5);
              expect(Math.abs(d.trim.bottom - t1.y)).toBeLessThan(0.5);
            }
          }

          // W : aperçu. Repères masqués, ainsi que les objets du calque non imprimable « Repères et notes ».
          const repVisible = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-page-id] > [data-obj-id="ext-rep2"]')!).display !== 'none');
          expect(await repVisible()).toBe(true);
          await press(page, 'w');
          expect(await page.evaluate(() => document.querySelectorAll('[data-page-guides]').length)).toBe(0);
          expect(await repVisible()).toBe(false);
          // Le document n'est pas touché : aucune étape d'annulation.
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(0);
          await press(page, 'w');
          expect(await page.evaluate(() => document.querySelectorAll('[data-page-guides]').length)).toBe(2);
          expect(await repVisible()).toBe(true);
          // W tapé dans un champ ne bascule rien.
          await page.evaluate(() => window.__editor!.getState().select(['ext-g9']));
          await settle(page);
          const input = await page.waitForSelector('[data-side-panels] input[name="x"]', { visible: true });
          await input!.click();
          await page.keyboard.press('w');
          await settle(page);
          expect(await page.evaluate(() => document.querySelectorAll('[data-page-guides]').length)).toBe(2);

          // Route d'impression : aucune surcouche de l'éditeur.
          const print = await browser.newPage();
          await print.goto(`${url}/print/${id}`);
          await print.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, { timeout: 60_000 });
          const leaks = await print.evaluate(
            () => document.querySelectorAll('[data-page-guides], [data-page-guide], [data-guide-id], [data-ruler], [data-snap-line], [data-page-overlays]').length,
          );
          expect(leaks).toBe(0);
          expect(await print.evaluate(() => document.querySelectorAll('[data-page-id]').length)).toBe(2);
        },
        { documentsDir: dir },
      );
    });
  });
});
