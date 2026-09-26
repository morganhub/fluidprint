// Repères déplaçables (tâche 2.25) : tirés depuis les règles, saisis au 0,1 mm, stockés dans la face,
// verrouillables, supprimés en les ramenant sur la règle ; un objet glissé près d'un repère s'y aimante ;
// les repères n'apparaissent pas dans l'export (PDF identique avec ou sans repères).
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { Page as BrowserPage } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../server/export';
import type { LayoutDocument } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, dragFrom, objectCenter, openEditor, pageToClient, press, readSavedDocument, saveNow, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';

const guidesOf = (page: BrowserPage, pageId: string) =>
  page.evaluate((id) => window.__editor!.getState().doc!.pages.find((p) => p.id === id)!.guides ?? [], pageId);

/** Glisser au pixel entier d'un point client à un autre. */
async function dragBetween(page: BrowserPage, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  await page.mouse.move(Math.round(from.x), Math.round(from.y));
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps));
  await page.mouse.up();
  await settle(page);
}

async function rulerBox(page: BrowserPage, which: 'top' | 'left') {
  const el = await page.waitForSelector(`[data-ruler="${which}"]`);
  return (await el!.boundingBox())!;
}

async function typeGuideAt(page: BrowserPage, value: string) {
  const input = await page.waitForSelector('[data-guide-editor] input[name="guide-at"]', { visible: true });
  await input!.click({ count: 3 });
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await settle(page);
}

/** Flux décompressés d'un PDF (contenu des pages, formes, polices…), triés. */
function inflatedStreams(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of text.matchAll(/<<((?:(?!endobj)[\s\S])*?)>>\s*stream\r?\n/g)) {
    if (!/\/FlateDecode/.test(m[1])) continue;
    const start = m.index! + m[0].length;
    const end = text.indexOf('endstream', start);
    try {
      out.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      // Longueur mal devinée (fin de ligne avant endstream) : on réessaie sans le dernier octet.
      out.push(inflateSync(pdf.subarray(start, end - 1)).toString('latin1'));
    }
  }
  return out.sort();
}

describe('repères déplaçables (2.25)', () => {
  it('tirés des règles, saisis au 0,1 mm, verrouillables, supprimés sur la règle ; un objet s’y aimante', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'p-ext' });

          // Règle du haut → repère horizontal, lâché à Y ≈ 50 mm du bord du fond perdu.
          const top = await rulerBox(page, 'top');
          const target = await pageToClient(page, 'p-ext', 150, 50);
          await dragBetween(page, { x: target.x, y: top.y + top.height / 2 }, target);
          let guides = await guidesOf(page, 'p-ext');
          expect(guides).toHaveLength(1);
          expect(guides[0].axis).toBe('y');
          expect(Math.abs(guides[0].at - 50)).toBeLessThanOrEqual(0.5);
          expect(await page.evaluate(() => window.__editor!.getState().history.undoLabel)).toBe('Ajouter un repère');

          // Position saisie au 0,1 mm (depuis le format fini, comme les règles) : 47,4 → 50,4 mm stockés.
          await typeGuideAt(page, '47,4');
          guides = await guidesOf(page, 'p-ext');
          expect(guides[0].at).toBe(50.4);
          await typeGuideAt(page, '47,43');
          expect((await guidesOf(page, 'p-ext'))[0].at).toBe(50.4);
          await typeGuideAt(page, '47,4');

          // Un objet glissé près du repère s'y aimante : r1 (y = 20) glissé de 30 mm → 50, à 0,4 mm du repère.
          await clickAt(page, 'p-ext', 25, 27);
          await dragFrom(page, await objectCenter(page, 'r1'), 0, 30, { steps: 8 });
          expect((await page.evaluate(() => window.__editor!.getState().doc!.objects.r1)).y).toBeCloseTo(50.4, 6);

          // Règle de gauche → repère vertical près de X = 120 mm ; puis déplacé à la souris vers 150 mm.
          const left = await rulerBox(page, 'left');
          const vTarget = await pageToClient(page, 'p-ext', 120, 150);
          await dragBetween(page, { x: left.x + left.width / 2, y: vTarget.y }, vTarget);
          guides = await guidesOf(page, 'p-ext');
          const vertical = guides.find((g) => g.axis === 'x')!;
          expect(Math.abs(vertical.at - 120)).toBeLessThanOrEqual(0.5);
          const from = await pageToClient(page, 'p-ext', vertical.at, 150);
          const to = await pageToClient(page, 'p-ext', 150.2, 150);
          await dragBetween(page, from, to);
          const moved = (await guidesOf(page, 'p-ext')).find((g) => g.id === vertical.id)!;
          // Aimanté au milieu du volet Dos (150 mm).
          expect(moved.at).toBe(150);

          // Clic sur le repère : il est sélectionné, son éditeur s'ouvre. Verrouillé, il ne bouge plus à la souris.
          await press(page, 'Escape');
          await dragBetween(page, await pageToClient(page, 'p-ext', 150, 150), await pageToClient(page, 'p-ext', 150, 150.01), 1);
          await page.click('[data-guide-editor] [data-guide-lock]');
          expect((await guidesOf(page, 'p-ext')).find((g) => g.id === vertical.id)!.locked).toBe(true);
          await dragBetween(page, await pageToClient(page, 'p-ext', 150, 150), await pageToClient(page, 'p-ext', 170, 150));
          expect((await guidesOf(page, 'p-ext')).find((g) => g.id === vertical.id)!.at).toBe(150);
          // Déverrouillé depuis la liste des repères (barre d'état).
          await page.click('[data-guides-status]');
          await page.waitForSelector('[data-guides-popover]', { visible: true });
          await page.click(`[data-guides-popover] [data-guide-row="${vertical.id}"] [data-guide-lock]`);
          expect((await guidesOf(page, 'p-ext')).find((g) => g.id === vertical.id)!.locked).toBeUndefined();
          await page.keyboard.press('Escape');
          await settle(page);

          // Ramené sur la règle de gauche : supprimé ; Ctrl+Z le rend.
          await dragBetween(page, await pageToClient(page, 'p-ext', 150, 150), { x: left.x + left.width / 2, y: vTarget.y });
          expect((await guidesOf(page, 'p-ext')).some((g) => g.id === vertical.id)).toBe(false);
          await press(page, 'Control', 'z');
          expect((await guidesOf(page, 'p-ext')).some((g) => g.id === vertical.id)).toBe(true);

          // Stockés dans la face du document enregistré.
          await saveNow(page);
          const saved = await readSavedDocument(dir, doc.id);
          expect(saved.pages[0].guides!.map((g) => [g.axis, g.at])).toEqual([
            ['y', 50.4],
            ['x', 150],
          ]);
          expect(saved.pages[1].guides).toBeUndefined();
        },
        { documentsDir: dir },
      );
    });
  });

  it('les repères n’apparaissent pas dans l’export : PDF identique avec ou sans repères', async () => {
    await withTempDocuments(async (dir) => {
      const plain: LayoutDocument = minimalDoc();
      const guided: LayoutDocument = { ...minimalDoc(), id: 'essai-reperes' };
      guided.pages[0].guides = [
        { id: 'g1', axis: 'x', at: 50 },
        { id: 'g2', axis: 'y', at: 100, locked: true },
      ];
      guided.pages[1].guides = [{ id: 'g3', axis: 'x', at: 150 }];
      await writeDocument(dir, plain);
      await writeDocument(dir, guided);
      const a = await exportPdf({ docId: plain.id, preset: 'rvb', documentsDir: dir });
      const b = await exportPdf({ docId: guided.id, preset: 'rvb', documentsDir: dir });
      const sa = inflatedStreams(await readFile(a.file));
      const sb = inflatedStreams(await readFile(b.file));
      expect(sa.length).toBeGreaterThan(0);
      expect(sb).toEqual(sa);
    });
  });
});
