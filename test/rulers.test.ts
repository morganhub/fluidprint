// Règles en millimètres (tâche 2.24) : origine au coin du format fini de chaque face ; à tout zoom (et
// après défilement), la graduation 97 de la face extérieure tombe sur son premier pli ; le pointeur est
// marqué sur les deux règles.
import type { Page as BrowserPage } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { rulerSteps } from '../src/editor/Rulers';
import { copyExample, dragFrom, openEditor, pageToClient, settle, withApp, withTempDocuments } from './helpers/editor';

describe('pas des graduations (unitaire)', () => {
  it('10 mm chiffrés et 1 mm gradué à 100 % ; des pas plus larges en zoom arrière', () => {
    expect(rulerSteps(1)).toEqual({ major: 10, medium: 5, minor: 1 });
    expect(rulerSteps(2)).toEqual({ major: 5, medium: 2.5, minor: 0.5 });
    expect(rulerSteps(0.5).major).toBe(20);
    expect(rulerSteps(0.25).major).toBe(50);
    for (const z of [0.1, 0.25, 0.5, 1, 2, 4, 8, 16]) {
      const s = rulerSteps(z);
      // Les graduations chiffrées tombent toujours sur une petite graduation.
      expect(Math.abs(s.major / s.minor - Math.round(s.major / s.minor))).toBeLessThan(1e-9);
    }
  });
});

/** Centre horizontal (px client) d'un élément de la règle du haut, ou null. */
function topMark(page: BrowserPage, selector: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(`[data-ruler="top"] ${sel}`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  }, selector);
}

describe('règles dans l’éditeur (2.24)', () => {
  it('la graduation 97 tombe sur le premier pli extérieur à tout zoom, suit le défilement ; pointeur marqué', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          const cases: { zoom: number; pan: number }[] = [
            { zoom: 0.25, pan: 0 },
            { zoom: 0.5, pan: 0 },
            { zoom: 1, pan: 0 },
            { zoom: 1, pan: -137 },
            { zoom: 2, pan: 0 },
            { zoom: 4, pan: 55 },
          ];
          for (const { zoom, pan } of cases) {
            await page.evaluate(
              (z, p) => {
                const s = window.__editor!.getState();
                s.setZoom(z);
                window.__editor!.getState().centerOn(['ext-rep2']);
                window.__editor!.getState().panBy(p, 0);
              },
              zoom,
              pan,
            );
            await settle(page);
            const fold = (await pageToClient(page, 'p-exterieur', 100, 0)).x;
            // Vue centrée sur le pli (ext-rep2 : le trait de pli du design). Le pli est marqué sur la règle, à 97 mm du format fini.
            const marker = await topMark(page, '[data-ruler-face="p-exterieur"] [data-ruler-fold="97"]');
            expect(marker, `zoom ${zoom}`).not.toBeNull();
            expect(Math.abs(marker! - fold), `zoom ${zoom}`).toBeLessThan(0.5);
            // Graduation 97 (présente dès que le pas est de 1 mm ou moins) : sur le pli, au pixel près.
            if (rulerSteps(zoom).minor <= 1) {
              const tick = await topMark(page, '[data-ruler-face="p-exterieur"] line[data-mm="97"]');
              expect(tick, `zoom ${zoom}`).not.toBeNull();
              expect(Math.abs(tick! - fold), `zoom ${zoom}`).toBeLessThanOrEqual(0.5);
            }
            // Le 0 est au coin du format fini (3 mm du bord du fond perdu).
            const zero = await topMark(page, '[data-ruler-face="p-exterieur"] line[data-mm="0"]');
            if (zero !== null) expect(Math.abs(zero - (await pageToClient(page, 'p-exterieur', 3, 0)).x)).toBeLessThanOrEqual(0.5);
          }

          // Chaque face a sa propre origine : sur l'intérieur, la graduation 100 tombe sur le pli à 103 mm.
          await page.evaluate(() => {
            window.__editor!.getState().setZoom(1);
            window.__editor!.getState().centerOn(['p-interieur']);
          });
          await settle(page);
          const intFold = (await pageToClient(page, 'p-interieur', 103, 0)).x;
          expect(Math.abs((await topMark(page, '[data-ruler-face="p-interieur"] line[data-mm="100"]'))! - intFold)).toBeLessThanOrEqual(0.5);
          expect(Math.abs((await topMark(page, '[data-ruler-face="p-interieur"] [data-ruler-fold="100"]'))! - intFold)).toBeLessThan(0.5);
          // Règle de gauche : 0 au bord haut du format fini.
          const zeroY = await page.evaluate(() => {
            const r = document.querySelector('[data-ruler="left"] line[data-mm="0"]')?.getBoundingClientRect();
            return r ? r.top + r.height / 2 : null;
          });
          expect(Math.abs(zeroY! - (await pageToClient(page, 'p-interieur', 0, 3)).y)).toBeLessThanOrEqual(0.5);

          // Pointeur : marqué sur les deux règles.
          const target = await pageToClient(page, 'p-interieur', 150, 100);
          await page.mouse.move(Math.round(target.x), Math.round(target.y));
          await settle(page);
          const marks = await page.evaluate(() => {
            const x = document.querySelector('[data-ruler-pointer="x"]')?.getBoundingClientRect();
            const y = document.querySelector('[data-ruler-pointer="y"]')?.getBoundingClientRect();
            return { x: x ? x.left + x.width / 2 : null, y: y ? y.top + y.height / 2 : null };
          });
          expect(Math.abs(marks.x! - Math.round(target.x))).toBeLessThanOrEqual(1);
          expect(Math.abs(marks.y! - Math.round(target.y))).toBeLessThanOrEqual(1);

          // Ni la souris ni un geste sur un objet (le document change à chaque image) ne recalculent les
          // graduations : seul le trait du pointeur bouge. Les recalculer coûtait jusqu'à 200 ms par image.
          const renders = () => page.evaluate(() => window.__editor!.rulerRenders());
          const renders0 = await renders();
          for (let i = 1; i <= 15; i++) {
            await page.mouse.move(Math.round(target.x) + i * 7, Math.round(target.y) + i * 3);
            await settle(page);
          }
          const moved = await page.$eval('[data-ruler-pointer="x"]', (el) => el.getBoundingClientRect().left);
          expect(Math.abs(moved - (Math.round(target.x) + 105))).toBeLessThanOrEqual(1);
          await page.evaluate(() => window.__editor!.getState().select(['int-g4']));
          await settle(page);
          const handle = await page.$eval('.editor-moveable .moveable-control[data-direction="e"]', (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await dragFrom(page, handle, 8, 0, { steps: 12 });
          expect(await page.evaluate(() => window.__editor!.getState().history.undoLabel)).toBe('Redimensionner');
          expect(await renders()).toBe(renders0);
          // Un changement de zoom, lui, les recalcule.
          await page.evaluate(() => window.__editor!.getState().setZoom(2));
          await settle(page);
          expect(await renders()).toBeGreaterThan(renders0);
        },
        { documentsDir: dir },
      );
    });
  });
});
