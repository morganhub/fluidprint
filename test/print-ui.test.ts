// Nuancier CMJN (4.1), aperçu impression (4.9) et boîte de dialogue Export (4.4) dans l'éditeur.
import type { Page } from 'puppeteer-core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { deltaE2000, parseColor } from '../scripts/import/colors';
import { cmykToRgb } from '../server/color';
import { minimalDoc } from './fixtures/minimal-doc';
import { copyExample, openEditor, settle, typeInField, withApp, withTempDocuments, writeDocument } from './helpers/editor';

const swatchOf = (page: Page, id: string) =>
  page.evaluate((sid) => window.__editor!.getState().doc!.swatches.find((s) => s.id === sid)!, id);

async function waitSwatch(page: Page, id: string, cmyk: number[]) {
  await page.waitForFunction(
    (sid, want) => JSON.stringify(window.__editor!.getState().doc!.swatches.find((s) => s.id === sid)?.cmyk) === JSON.stringify(want),
    { timeout: 20_000 },
    id,
    cmyk,
  );
  await settle(page);
}

async function setInks(page: Page, id: string, cmyk: number[]) {
  await page.click('[data-panel-tab="swatches"]');
  const row = `[data-swatch-row="${id}"]`;
  if (!(await page.$(`${row} [data-swatch-editor]`))) await page.click(`${row} > button`);
  await page.waitForSelector(`${row} [data-swatch-color]`, { visible: true });
  const names = ['swatchC', 'swatchM', 'swatchY', 'swatchK'];
  for (const [i, value] of cmyk.entries()) {
    const input = await page.waitForSelector(`${row} input[name="${names[i]}"]`, { visible: true });
    await input!.click({ count: 3 });
    await page.keyboard.type(String(value));
    await page.keyboard.press('Enter');
    await settle(page);
  }
  await waitSwatch(page, id, cmyk);
}

/** Couleurs calculées de tout ce qui est dessiné dans les faces. */
function countColor(page: Page, rgb: string): Promise<number> {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(rgb.slice(i, i + 2), 16));
  return page.evaluate((target) => {
    let n = 0;
    for (const el of document.querySelectorAll('[data-workspace-viewport] [data-page-id] *')) {
      const cs = getComputedStyle(el);
      for (const v of [cs.color, cs.backgroundColor, cs.fill, cs.stroke]) if (v.replace(/\s/g, '') === target) n++;
    }
    return n;
  }, `rgb(${r},${g},${b})`);
}

const chroma = (hex: string) => {
  const c = parseColor(hex)!;
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
};

describe('impression dans l’éditeur (navigateur)', () => {
  it('nuancier en CMJN, aperçu impression, boîte de dialogue Export', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);

          // 4.1 — Saisir C86 M55 J0 N0 sur le vert du dépliant affiche le bleu que FOGRA39 imprimera, partout où il sert.
          const [expected] = await cmykToRgb([[86, 55, 0, 0]]);
          await setInks(page, 'vert', [86, 55, 0, 0]);
          const blue = await swatchOf(page, 'vert');
          expect(blue.rgb).toBe(expected);
          expect(blue.sourceRgb).toBe('#2d7a55');
          expect(await countColor(page, expected)).toBeGreaterThan(10);
          expect(await page.$eval('[data-swatch-row="vert"] [data-swatch-ink]', (el) => el.textContent)).toMatch(/141\s*%/);

          // Deux nuances n'ont jamais le même RVB : les mêmes encres sur une autre nuance s'en écartent d'une unité.
          await setInks(page, 'rose-clair', [86, 55, 0, 0]);
          const twin = await swatchOf(page, 'rose-clair');
          expect(twin.rgb).not.toBe(blue.rgb);
          const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
          expect(channels(twin.rgb).reduce((sum, v, i) => sum + Math.abs(v - channels(blue.rgb)[i]), 0)).toBe(1);

          // Encrage total affiché, alerte au-delà des 300 % du préréglage imprimeur.
          expect(await page.$('[data-swatch-row="rose-clair"] [data-swatch-ink-warning]')).toBeNull();
          await setInks(page, 'rose-clair', [100, 100, 100, 30]);
          const warning = await page.waitForSelector('[data-swatch-row="rose-clair"] [data-swatch-ink-warning]', { visible: true });
          expect(await warning!.evaluate((el) => el.textContent)).toMatch(/330 %.*300 %/);
          await typeInField(page, 'swatchK', '0');
          await waitSwatch(page, 'rose-clair', [100, 100, 100, 0]);
          expect(await page.$('[data-swatch-row="rose-clair"] [data-swatch-ink-warning]')).toBeNull();

          // 4.9 — Aperçu impression : photos en épreuve, et le bleu vif (#3b5bdb dans le design) visiblement plus terne.
          await page.click('[data-topbar-action="print-preview"]');
          await page.waitForSelector('[data-print-preview-banner]', { visible: true });
          await page.waitForFunction(
            () => {
              const images = [...document.querySelectorAll('[data-workspace-viewport] image[data-asset-id]')];
              return images.length > 0 && images.every((img) => img.getAttribute('href')!.includes('/api/proof/'));
            },
            { timeout: 20_000 },
          );
          const [href, assetId] = await page.$eval('[data-workspace-viewport] image[data-asset-id]', (el) => [el.getAttribute('href')!, el.getAttribute('data-asset-id')!]);
          const proof = await fetch(`${url}${href}`);
          expect(proof.status).toBe(200);
          expect(proof.headers.get('content-type')).toBe('image/webp');
          const doc = await page.evaluate(() => window.__editor!.getState().doc!);
          const asset = doc.assets.find((a) => a.id === assetId)!;
          const preview = await fetch(`${url}/api/assets/${id}/${asset.preview ?? asset.original}`);
          const [proofStats, previewStats] = await Promise.all([
            sharp(Buffer.from(await proof.arrayBuffer())).stats(),
            sharp(Buffer.from(await preview.arrayBuffer())).stats(),
          ]);
          expect(proofStats.channels[0].mean).not.toBeCloseTo(previewStats.channels[0].mean, 0);

          const vivid = await page.$eval('[data-obj-id="ext-e6"]', (el) => {
            for (const node of [el, ...el.querySelectorAll('*')]) {
              const cs = getComputedStyle(node);
              for (const v of [cs.fill, cs.backgroundColor]) if (v && v !== 'none' && v !== 'rgba(0, 0, 0, 0)' && !v.startsWith('rgb(0, 0, 0)')) return v;
            }
            return null;
          });
          const shown = `#${vivid!.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
          expect(shown).toBe((await swatchOf(page, 'bleu')).rgb);
          expect(deltaE2000('#3b5bdb', shown)).toBeGreaterThan(5);
          expect(chroma(shown)).toBeLessThan(chroma('#3b5bdb') - 20);
          // Hors aperçu, les photos reviennent à leur aperçu normal.
          await page.click('[data-topbar-action="print-preview"]');
          await page.waitForFunction(() => [...document.querySelectorAll('[data-workspace-viewport] image[data-asset-id]')].every((img) => !img.getAttribute('href')!.includes('/api/proof/')));

          // 4.4 — Boîte de dialogue Export : préréglages, résumé, refus des photos provisoires, progression, téléchargement.
          await page.click('[data-topbar-action="export"]');
          await page.waitForSelector('[data-export-dialog] [data-export-summary="imprimeur"]', { visible: true });
          const summary = await page.$eval('[data-export-summary]', (el) => el.textContent);
          expect(summary).toContain('PDF/X-4');
          expect(summary).toContain('Coated FOGRA39');
          expect(summary).toContain('300 %');
          const blocked = await page.$eval('[data-export-blocked]', (el) => el.textContent);
          expect(blocked).toContain('Photo de couverture (HD)');
          expect(await page.$eval('[data-action="start-export"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true);
          await page.click('[data-export-preset="email"]');
          expect(await page.$eval('[data-export-summary]', (el) => el.textContent)).toMatch(/150 ppi.*moins de 5 Mo|moins de 5 Mo/);
          await page.click('[data-export-preset="rvb"]');
          const rvbSummary = await page.$eval('[data-export-summary]', (el) => el.textContent);
          expect(rvbSummary).toContain('PDF simple');
          expect(rvbSummary).not.toContain('FOGRA39');
          await page.click('[data-action="start-export"]');
          await page.waitForSelector('[data-export-progress]', { timeout: 20_000 });
          await page.waitForSelector('[data-export-result] [data-export-download]', { timeout: 180_000 });
          const download = await page.$eval('[data-export-download]', (el) => el.getAttribute('href')!);
          expect(download).toMatch(/\/exports\/\d{4}-\d{2}-\d{2}-\d{4}-rvb(-\d+)?\.pdf$/);
          const res = await fetch(`${url}${download}`);
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toBe('application/pdf');
          expect(res.headers.get('content-disposition')).toMatch(/attachment/);
          expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
        },
        { documentsDir: dir },
      );
    });
  }, 300_000);

  it('calque imprimable masqué : pastille orange, rappel dans la boîte d’export, confirmation avant l’export imprimeur (B3)', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      doc.id = 'calque';
      doc.layers[0].visible = false;
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id);
          // La pastille ne dit plus « aucun problème » : le calque est signalé.
          await page.waitForSelector('[data-preflight-status="warning"]');
          await page.click('[data-preflight-status]');
          const issue = await page.waitForSelector('[data-preflight-issue^="hidden-layer:"]');
          expect(await issue!.evaluate((el) => el.textContent)).toContain('Calque imprimable « Contenu » masqué : 2 objets ne seront pas imprimés');

          await page.click('[data-topbar-action="export"]');
          await page.waitForSelector('[data-export-dialog] [data-export-summary="imprimeur"]', { visible: true });
          const notice = await page.$eval('[data-export-hidden-layers]', (el) => el.textContent);
          expect(notice).toContain('« Contenu » : 2 objets');
          const disabled = () => page.$eval('[data-action="start-export"]', (el) => (el as HTMLButtonElement).disabled);
          // Imprimeur : pas d'export sans la case cochée.
          expect(await disabled()).toBe(true);
          await page.click('[data-export-hidden-layers] input[name="confirmHiddenLayers"]');
          expect(await disabled()).toBe(false);
          await page.click('[data-action="start-export"]');
          await page.waitForSelector('[data-export-result] [data-export-download]', { timeout: 180_000 });
          const warnings = await page.$eval('[data-export-warnings]', (el) => el.textContent);
          expect(warnings).toContain('Calque imprimable « Contenu » masqué : 2 objets absents du PDF');
          // RVB : le rappel reste, sans case à cocher.
          await page.click('[data-export-preset="rvb"]');
          expect(await page.$('[data-export-hidden-layers] input[name="confirmHiddenLayers"]')).toBeNull();
          expect(await page.$('[data-export-hidden-layers]')).not.toBeNull();
        },
        { documentsDir: dir },
      );
    });
  }, 300_000);
});
