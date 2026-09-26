// Magnétisme (tâche 2.10) : calcul des cibles et de l'aimantation (unitaire), puis dans le vrai éditeur :
// un objet lâché à 0,6 mm d'un pli s'y colle ; avec Alt il reste à 0,6 mm ; seuil constant à l'écran.
import type { Page as BrowserPage } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { collectTargets, pageTargets, snapMove, snapResize, snapThreshold } from '../src/editor/snapping';
import type { LayoutDocument, RectObject } from '../src/model/types';
import { PX_PER_MM } from '../src/model/units';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, dragFrom, objectCenter, openEditor, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';

describe('magnétisme : calcul (unitaire)', () => {
  it('cibles de la face : format fini, plis, sécurité à 4 mm, milieux des volets, repères', () => {
    const doc = minimalDoc();
    doc.pages[0].guides = [{ id: 'g1', axis: 'y', at: 50 }];
    const t = pageTargets(doc, 'p-ext');
    const xs = (kind: string) => t.x.filter((v) => v.kind === kind).map((v) => v.at);
    expect(xs('trim')).toEqual([3, 300]);
    expect(xs('fold')).toEqual([100, 200]);
    expect(xs('safety')).toEqual([7, 96, 104, 196, 204, 296]);
    expect(xs('panel-center')).toEqual([51.5, 150, 250]);
    expect(t.y.filter((v) => v.kind === 'guide').map((v) => v.at)).toEqual([50]);
    expect(t.y.filter((v) => v.kind === 'safety').map((v) => v.at)).toEqual([7, 209]);
    // Face intérieure : plis à 103 et 203 mm.
    expect(pageTargets(doc, 'p-int').x.filter((v) => v.kind === 'fold').map((v) => v.at)).toEqual([103, 203]);
    // Aperçu (W) : ni plis, ni sécurité, ni repères.
    const hidden = pageTargets(doc, 'p-ext', false);
    expect(hidden.x.some((v) => v.kind === 'fold' || v.kind === 'safety')).toBe(false);
    expect(hidden.y.some((v) => v.kind === 'guide')).toBe(false);
  });

  it('aimante le bord le plus proche sous le seuil, garde les objets déplacés hors des cibles', () => {
    const doc = minimalDoc();
    const targets = collectTargets(doc, 'p-ext', ['r1']);
    // r1 exclu, t1 (12..92 × 60..80) présent.
    expect(targets.x.some((v) => v.objectId === 'r1')).toBe(false);
    expect(targets.x.filter((v) => v.objectId === 't1').map((v) => v.at)).toEqual([12, 52, 92]);
    const box = { x: 10.6, y: 20, w: 30, h: 15 };
    // 10,6 + 90 = 100,6 : à 0,6 mm du pli, seuil 1 mm → collé à 100.
    const snapped = snapMove(box, 90, 0, targets, snapThreshold(1));
    expect(snapped.dx).toBeCloseTo(89.4, 9);
    expect(snapped.dy).toBe(0);
    expect(snapped.lines.map((l) => l.kind)).toContain('fold');
    // Seuil de 0,5 mm à 200 % : 0,6 mm ne colle plus.
    expect(snapMove(box, 90, 0, targets, snapThreshold(2)).dx).toBe(90);
    // Alignement sur un objet : bord gauche de t1 (12) ; la distance verticale est donnée.
    const onText = snapMove({ x: 11.5, y: 20, w: 30, h: 15 }, 0, 0, targets, snapThreshold(1));
    expect(onText.dx).toBeCloseTo(0.5, 9);
    const line = onText.lines.find((l) => l.kind === 'object')!;
    expect(line.gap).toEqual({ from: 35, to: 60, at: 12 });
    // Redimensionnement : seul le bord tiré s'aimante.
    const resized = snapResize({ x: 60, y: 20, w: 39.6, h: 15 }, [1, 0], targets, snapThreshold(1));
    expect(resized.box.x).toBe(60);
    expect(resized.box.w).toBeCloseTo(40, 9);
    expect(resized.box.h).toBe(15);
  });
});

/** Glisser en tenant Alt seulement APRÈS le départ (Alt au départ duplique l'objet). */
async function dragWithLateAlt(page: BrowserPage, from: { x: number; y: number }, dxMm: number) {
  const zoom = await page.evaluate(() => window.__editor!.getState().zoom);
  const dxPx = Math.round(dxMm * PX_PER_MM * zoom);
  const x0 = Math.round(from.x);
  const y0 = Math.round(from.y);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 10, y0);
  await page.keyboard.down('Alt');
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + Math.round((dxPx * i) / 8), y0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await settle(page);
}

function snapDoc(): LayoutDocument {
  const doc = minimalDoc();
  (doc.objects.r1 as RectObject).x = 10.6;
  return doc;
}

describe('magnétisme dans l’éditeur (2.10)', () => {
  it('lâché à 0,6 mm d’un pli : collé ; avec Alt : reste à 0,6 mm ; lignes d’aide pendant le geste', async () => {
    await withTempDocuments(async (dir) => {
      const doc = snapDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'p-ext' });
          const r1 = () => page.evaluate(() => window.__editor!.getState().doc!.objects.r1);
          await clickAt(page, 'p-ext', 25, 27);

          // Pendant le geste : une ligne d'aide « pli » est tracée.
          const start = await objectCenter(page, 'r1');
          const dxPx = Math.round(90 * PX_PER_MM);
          await page.mouse.move(Math.round(start.x), Math.round(start.y));
          await page.mouse.down();
          for (let i = 1; i <= 8; i++) await page.mouse.move(Math.round(start.x) + Math.round((dxPx * i) / 8), Math.round(start.y));
          await settle(page);
          const during = await page.evaluate(() => [...document.querySelectorAll('[data-snap-line]')].map((el) => el.getAttribute('data-snap-line')));
          expect(during).toContain('fold');
          await page.mouse.up();
          await settle(page);
          // 10,6 + 90 = 100,6 mm : à 0,6 mm du pli (100 mm) → collé.
          expect((await r1()).x).toBeCloseTo(100, 6);
          expect(await page.evaluate(() => document.querySelectorAll('[data-snap-line]').length)).toBe(0);

          // Même geste avec Alt : pas d'aimantation, et pas de copie (Alt pressé après le départ).
          await page.evaluate(() => window.__editor!.getState().undo());
          expect((await r1()).x).toBeCloseTo(10.6, 6);
          const count = await page.evaluate(() => Object.keys(window.__editor!.getState().doc!.objects).length);
          await dragWithLateAlt(page, await objectCenter(page, 'r1'), 90);
          expect((await r1()).x).toBeCloseTo(100.6, 6);
          expect(await page.evaluate(() => Object.keys(window.__editor!.getState().doc!.objects).length)).toBe(count);

          // Redimensionnement : la poignée droite tirée à 0,4 mm du pli s'y colle.
          await page.evaluate(() => window.__editor!.getState().setBox('r1', { x: 60.6, w: 30 }));
          await settle(page);
          const handle = await page.waitForSelector('.editor-moveable .moveable-control[data-direction="e"]', { visible: true });
          const b = (await handle!.boundingBox())!;
          await dragFrom(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, 9, 0, { steps: 6 });
          const resized = await r1();
          expect(resized.x).toBeCloseTo(60.6, 6);
          expect(resized.x + resized.w).toBeCloseTo(100, 6);

          // À 200 %, le seuil vaut 0,5 mm : 0,6 mm ne colle plus, 0,4 mm si.
          await page.evaluate(() => window.__editor!.getState().setBox('r1', { x: 10.6, w: 30 }));
          await page.evaluate(() => {
            const s = window.__editor!.getState();
            s.setZoom(2);
            window.__editor!.getState().centerOn(['r1']);
          });
          await settle(page);
          await dragFrom(page, await objectCenter(page, 'r1'), 45, 0, { steps: 8 });
          expect((await r1()).x).toBeCloseTo(55.6, 6);
          await page.evaluate(() => window.__editor!.getState().setBox('r1', { x: 55.4 }));
          await settle(page);
          await dragFrom(page, await objectCenter(page, 'r1'), 45, 0, { steps: 8 });
          expect((await r1()).x).toBeCloseTo(100, 6);
        },
        { documentsDir: dir },
      );
    });
  });
});
