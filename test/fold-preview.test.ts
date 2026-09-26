// Aperçu plié en 3D (tâche 2.20) : replié, on voit la couverture ; en ouvrant la couverture, le rabat
// « Créer de vos mains, pas à pas, avec nous » ; ouvert, l'intérieur ; retourné, le dos.
import type { Page as BrowserPage } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { foldModel } from '../src/editor/FoldPreview';
import type { LayoutDocument } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { EXAMPLE_FILE, copyExample, openEditor, settle, withApp, withTempDocuments } from './helpers/editor';
import { readFile } from 'node:fs/promises';

describe('modèle du pli roulé (unitaire)', () => {
  it('chaque volet intérieur a au dos le volet extérieur symétrique ; le rabat (97 mm) se replie d’abord', async () => {
    const doc = JSON.parse(await readFile(EXAMPLE_FILE, 'utf8')) as LayoutDocument;
    const model = foldModel(doc)!;
    expect(model.panels.map((p) => [p.frontName, p.backName, p.w])).toEqual([
      ['Intérieur gauche', 'Couverture', 100],
      ['Intérieur centre', 'Dos', 100],
      ['Intérieur droit', 'Rabat', 97],
    ]);
    expect(model.panels.map((p) => [p.x, p.backX])).toEqual([
      [0, 197],
      [100, 97],
      [200, 0],
    ]);
    expect(model.inner).toBe(2);
    expect(model.outer).toBe(0);
    const flyer = minimalDoc();
    flyer.format.faces[0].panels = [{ name: 'Recto', w: 297 }];
    expect(foldModel(flyer)).toBeNull();
  });
});

/** Face visible au centre du volet central de l'aperçu : nom du volet. */
async function visibleFace(page: BrowserPage): Promise<{ name: string | null }> {
  return page.evaluate(() => {
    const r = document.querySelector('[data-fold-panel="1"]')!.getBoundingClientRect();
    const hit = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height * 0.3).map((el) => el.closest('[data-fold-face]')).find(Boolean);
    return { name: hit?.getAttribute('data-fold-face-name') ?? null };
  });
}

/** Texte d'un objet dans une face de l'aperçu, et s'il tombe dans la partie visible (découpée) de la face. */
async function textInFace(page: BrowserPage, face: string, objId: string): Promise<{ text: string; inside: boolean }> {
  return page.evaluate(
    (f, id) => {
      const faceEl = document.querySelector(`[data-fold-face-name="${f}"]`)!;
      const el = faceEl.querySelector<HTMLElement>(`[data-obj-id="${id}"]`);
      if (!el) return { text: '', inside: false };
      const a = faceEl.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      return { text: el.innerText.replace(/\s+/g, ' '), inside: cx > a.left && cx < a.right && cy > a.top && cy < a.bottom };
    },
    face,
    objId,
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('aperçu plié dans l’éditeur (2.20)', () => {
  it('replié : la couverture ; couverture ouverte : le rabat ; ouvert : l’intérieur ; retourné : le dos', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          await page.click('[data-topbar-action="fold-preview"]');
          await page.waitForSelector('[data-fold-assembly][data-fold-state="closed"]', { visible: true });
          await wait(800);
          const closed = await visibleFace(page);
          expect(closed.name).toBe('Couverture');
          expect(await textInFace(page, 'Couverture', 'ext-t61')).toMatchObject({ inside: true });
          expect((await textInFace(page, 'Couverture', 'ext-t61')).text).toContain('en toute saison');

          await page.click('[data-fold-step="flap"]');
          await wait(800);
          const flap = await visibleFace(page);
          expect(flap.name).toBe('Rabat');
          const accroche = await textInFace(page, 'Rabat', 'ext-t1');
          expect(accroche.inside).toBe(true);
          expect(accroche.text).toMatch(/Créer de vos mains, pas à pas, avec nous/);

          await page.click('[data-fold-step="open"]');
          await wait(800);
          expect((await visibleFace(page)).name).toBe('Intérieur centre');

          await page.click('[data-fold-step="closed"]');
          await page.click('[data-fold-flip]');
          await wait(800);
          expect((await visibleFace(page)).name).toBe('Dos');

          // Les calques non imprimables (repères du design) ne sont pas dans l'aperçu.
          expect(await page.evaluate(() => document.querySelectorAll('[data-fold-preview] [data-obj-id="ext-rep2"]').length)).toBe(0);
          // Le document n'a pas bougé.
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(0);
          await page.keyboard.press('Escape');
          await settle(page);
          expect(await page.$('[data-fold-preview]')).toBeNull();
        },
        { documentsDir: dir },
      );
    });
  });
});
