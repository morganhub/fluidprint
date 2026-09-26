// Nuancier (tâches 2.9 et 2.18) : usages, modification qui recolore tout, suppression avec remplaçante,
// aucune couleur hors nuancier dans le document importé, pipette (et son repli hexadécimal), nouvelle
// nuance depuis un champ couleur de Propriétés.
import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  addSwatch,
  deleteSwatch,
  foreignColors,
  normalizeHex,
  objectsUsingSwatch,
  parseCssColor,
  PENDING_SWATCH_NAME,
  swatchUsages,
  updateSwatch,
} from '../src/model/swatches';
import type { LayoutDocument, RectObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { colorCss } from '../src/render/color';
import { createEditorStore } from '../src/store/documentStore';
import { minimalDoc } from './fixtures/minimal-doc';
import { EXAMPLE_FILE, copyExample, readSavedDocument, saveNow, settle, withApp, withTempDocuments } from './helpers/editor';

// Scénario complet dans Chrome : large marge quand toute la suite tourne en parallèle.
const BROWSER_TIMEOUT_MS = 180_000;

const example = (): LayoutDocument => JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));

describe('nuancier : modèle (2.9)', () => {
  it('aucun objet du dépliant d’exemple importé ne garde une couleur hors nuancier', () => {
    const doc = example();
    expect(foreignColors(doc)).toEqual([]);
    // Et chaque nuance référencée existe : la validation du document le confirme.
    expect(validateDocument(doc).ok).toBe(true);
    // Les usages couvrent les objets, les segments de texte et les filets.
    const usages = swatchUsages(doc);
    const total = [...usages.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBeGreaterThan(300);
    expect(usages.get('vert')!.length).toBeGreaterThan(5);
  });

  it('repère une couleur écrite en dur ou une nuance inconnue', () => {
    const doc = minimalDoc();
    (doc.objects.r1 as unknown as { fill: unknown }).fill = '#ff0000';
    (doc.objects.t1 as { style: { color: { swatch: string } } }).style.color = { swatch: 'inconnue' };
    expect(foreignColors(doc).map((f) => f.path).sort()).toEqual(['objects.r1.fill', 'objects.t1.style.color']);
  });

  it('modifier « Vert » recolore tous ses usages d’un coup, en une étape', () => {
    const store = createEditorStore();
    store.getState().load(example());
    const s = () => store.getState();
    const users = objectsUsingSwatch(s().doc!, 'vert');
    expect(users.length).toBeGreaterThan(5);
    const before = JSON.stringify(s().doc!.objects);
    s().apply('Modifier la nuance', (d) => updateSwatch(d, 'vert', { rgb: '#FF0000' }));
    expect(s().history.depth).toBe(1);
    // Les objets n'ont pas bougé d'un octet : ils référencent la nuance, qui seule a changé.
    expect(JSON.stringify(s().doc!.objects)).toBe(before);
    for (const u of swatchUsages(s().doc!).get('vert')!) {
      const ref = u.path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], s().doc);
      expect(colorCss(s().doc!, ref as { swatch: string })).toBe('#ff0000');
    }
    s().undo();
    expect(s().doc!.swatches.find((x) => x.id === 'vert')!.rgb).toBe(example().swatches.find((x) => x.id === 'vert')!.rgb);
  });

  it('supprimer une nuance utilisée exige une remplaçante et y reporte ses usages (teinte gardée)', () => {
    const doc = minimalDoc();
    (doc.objects.r1 as RectObject).fill = { swatch: 'bleu', tint: 0.4 };
    expect(() => deleteSwatch(doc, 'bleu')).toThrow(/remplacement/);
    deleteSwatch(doc, 'bleu', 'gris');
    expect(doc.swatches.map((s) => s.id)).toEqual(['gris']);
    expect((doc.objects.r1 as RectObject).fill).toEqual({ swatch: 'gris', tint: 0.4 });
    expect(foreignColors(doc)).toEqual([]);
    expect(validateDocument(doc).ok).toBe(true);
    // Une nuance inutilisée part sans remplaçante.
    const id = addSwatch(doc, { rgb: '#123456', name: 'Libre' });
    deleteSwatch(doc, id);
    expect(doc.swatches.some((s) => s.id === id)).toBe(false);
  });

  it('nouvelle nuance : nom « À nommer » unique, identifiant libre, couleur normalisée, champs futurs gardés', () => {
    const doc = minimalDoc();
    const a = addSwatch(doc, { rgb: 'ABC' });
    const b = addSwatch(doc, { rgb: '#3a7bd5' });
    expect(doc.swatches.find((s) => s.id === a)).toMatchObject({ name: PENDING_SWATCH_NAME, rgb: '#aabbcc' });
    expect(doc.swatches.find((s) => s.id === b)!.name).toBe(`${PENDING_SWATCH_NAME} 2`);
    expect(a).not.toBe(b);
    // Phase 4 : le CMJN (et tout champ ajouté plus tard) survit à une modification du nom.
    updateSwatch(doc, 'bleu', { cmyk: [86, 55, 0, 0] });
    updateSwatch(doc, 'bleu', { name: 'Bleu marque' });
    expect(doc.swatches.find((s) => s.id === 'bleu')).toMatchObject({ name: 'Bleu marque', cmyk: [86, 55, 0, 0] });
    expect(validateDocument(doc).ok).toBe(true);
    expect(normalizeHex('#12345')).toBeNull();
    expect(parseCssColor('rgb(58, 123, 213)')).toBe('#3a7bd5');
  });
});

// ---------------------------------------------------------------- navigateur

/** Couleurs calculées (fond, texte, remplissage, trait) de tout ce qui est dessiné dans les faces. */
function countColor(page: Page, rgb: string): Promise<number> {
  return page.evaluate((target) => {
    let n = 0;
    for (const el of document.querySelectorAll('[data-workspace-viewport] [data-page-id] *')) {
      const cs = getComputedStyle(el);
      for (const v of [cs.color, cs.backgroundColor, cs.fill, cs.stroke]) if (v.replace(/\s/g, '') === target) n++;
    }
    return n;
  }, rgb);
}

const swatchRow = (page: Page, name: string) => page.waitForSelector(`[data-swatch-row][data-swatch-name="${name}"]`, { visible: true });

describe('nuancier : panneau, pipette et champs couleur (navigateur)', () => {
  it('modifier une nuance recolore l’écran ; pipette, repli hexadécimal, nouvelle nuance depuis un champ couleur', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const context = await browser.createBrowserContext();
          const page = await context.newPage();
          await page.evaluateOnNewDocument(() => {
            (window as unknown as { EyeDropper: unknown }).EyeDropper = class {
              async open() {
                return { sRGBHex: '#3a7bd5' };
              }
            };
          });
          await page.setViewport({ width: 1600, height: 1000 });
          await page.goto(`${url}/doc/${id}`);
          await page.waitForFunction(() => window.__editor?.ready === true, { timeout: 60_000 });

          // 1. Modifier « Vert » dans le panneau : tout ce qui est vert change, en une étape.
          // Nuancier CMJN (4.1) : l'écran montre la simulation des encres, lue dans le document.
          const swatchCss = () =>
            page.evaluate(() => {
              const hex = window.__editor!.getState().doc!.swatches.find((s) => s.id === 'vert')!.rgb;
              return `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')})`;
            });
          const greenCss = await swatchCss();
          const greenBefore = await countColor(page, greenCss);
          expect(greenBefore).toBeGreaterThan(10);
          await page.click('[data-panel-tab="swatches"]');
          await (await swatchRow(page, 'Vert'))!.click();
          // Ses usages : un objet par ligne, cliquer en sélectionne un.
          await page.waitForSelector('[data-swatch-usages] [data-usage-object]');
          const usageRows = await page.$$eval('[data-swatch-usages] [data-usage-object]', (els) => els.map((e) => (e as HTMLElement).dataset.usageObject));
          const users = await page.evaluate(() => {
            const d = window.__editor!.getState().doc!;
            const found = new Set<string>();
            const walk = (node: unknown, objId: string | null) => {
              if (Array.isArray(node)) return node.forEach((n) => walk(n, objId));
              if (!node || typeof node !== 'object') return;
              if ((node as { swatch?: string }).swatch === 'vert' && objId) found.add(objId);
              for (const v of Object.values(node)) walk(v, objId);
            };
            for (const [id, o] of Object.entries(d.objects)) walk(o, id);
            return [...found].sort();
          });
          expect([...usageRows].sort()).toEqual(users);
          await page.click(`[data-swatch-usages] [data-usage-object="${usageRows[0]}"]`);
          expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual([usageRows[0]]);
          // La nuance se modifie par ses encres (N 100 en plus) ; l'écran suit la simulation du profil.
          const black = await page.waitForSelector('[data-swatch-editor] input[name="swatchK"]', { visible: true });
          await black!.click({ count: 3 });
          await page.keyboard.type('100');
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => window.__editor!.getState().doc!.swatches.find((s) => s.id === 'vert')!.cmyk![3] === 100);
          await settle(page);
          expect(await countColor(page, greenCss)).toBe(0);
          expect(await countColor(page, await swatchCss())).toBeGreaterThanOrEqual(greenBefore);
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(1);
          await page.evaluate(() => window.__editor!.getState().undo());
          await settle(page);
          expect(await countColor(page, greenCss)).toBe(greenBefore);

          // 2. Pipette : la couleur prise entre au nuancier sous un nom à compléter.
          await page.click('[data-action="eyedropper"]');
          const pending = await swatchRow(page, PENDING_SWATCH_NAME);
          expect(await pending!.$('[data-swatch-pending]')).not.toBeNull();
          const picked = await page.evaluate((name) => window.__editor!.getState().doc!.swatches.find((s) => s.name === name), PENDING_SWATCH_NAME);
          expect(picked?.rgb).toBe('#3a7bd5');
          // Le nom est prêt à être complété (curseur dedans, texte sélectionné).
          const focused = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name);
          expect(focused).toBe('swatchName');
          await page.keyboard.type('Bleu pipette');
          await page.keyboard.press('Enter');
          await settle(page);
          expect(await page.evaluate((sid) => window.__editor!.getState().doc!.swatches.find((s) => s.id === sid)?.name, picked!.id)).toBe('Bleu pipette');

          // 3. Sans API EyeDropper : la pipette propose la saisie hexadécimale.
          await page.evaluate(() => delete (window as unknown as { EyeDropper?: unknown }).EyeDropper);
          await page.click('[data-action="eyedropper"]');
          const input = await page.waitForSelector('[data-add-swatch-form] input[name="newSwatchHex"]', { visible: true });
          await input!.click({ count: 3 });
          await page.keyboard.type('#123456');
          await page.click('[data-action="confirm-add-swatch"]');
          await swatchRow(page, PENDING_SWATCH_NAME);
          expect(await page.evaluate((name) => window.__editor!.getState().doc!.swatches.find((s) => s.name === name)?.rgb, PENDING_SWATCH_NAME)).toBe('#123456');

          // 4. Champ couleur de Propriétés : le nuancier d'abord, puis « Nouvelle nuance… » en pied de liste.
          const rectId = await page.evaluate(() => {
            const s = window.__editor!.getState();
            return Object.values(s.doc!.objects).find((o) => o.type === 'rect' && o.layerId === 'contenu' && !o.locked)?.id ?? null;
          });
          expect(rectId).not.toBeNull();
          await page.evaluate((rid) => window.__editor!.getState().select([rid!]), rectId);
          await page.click('[data-panel-tab="properties"]');
          await page.click('[data-side-panels] button[aria-label="Remplissage"]');
          const options = await page.$$eval('[data-swatch-list] [role="option"]', (els) => els.map((e) => e.textContent?.trim() ?? ''));
          const names = await page.evaluate(() => window.__editor!.getState().doc!.swatches.map((s) => s.name));
          expect(options.slice(1, 1 + names.length)).toEqual(names);
          await page.click('[data-swatch-list] [data-action="picker-new-swatch"]');
          await page.type('[data-swatch-list] input[name="pickerNewSwatchHex"]', '#00aa55');
          await page.keyboard.press('Enter');
          await settle(page);
          const result = await page.evaluate((rid) => {
            const d = window.__editor!.getState().doc!;
            const fill = (d.objects[rid!] as { fill?: { swatch: string } }).fill;
            return { fill, swatch: d.swatches.find((s) => s.id === fill?.swatch) };
          }, rectId);
          expect(result.swatch?.rgb).toBe('#00aa55');

          // 5. Supprimer une nuance utilisée : le panneau propose une remplaçante, les usages y passent.
          await page.keyboard.press('Escape');
          await page.click('[data-panel-tab="swatches"]');
          const newRow = `[data-swatch-row="${result.swatch!.id}"]`;
          // La nuance créée depuis Propriétés est déjà dépliée dans le panneau, prête à être nommée.
          await page.waitForSelector(`${newRow} button[aria-expanded="true"]`);
          await page.click(`${newRow} [data-action="ask-delete-swatch"]`);
          await page.waitForSelector(`${newRow} [data-swatch-delete] select[name="replacementSwatch"]`, { visible: true });
          await page.select(`${newRow} select[name="replacementSwatch"]`, 'orange');
          await page.click(`${newRow} [data-action="confirm-delete-swatch"]`);
          await settle(page);
          const afterDelete = await page.evaluate((rid, sid) => {
            const d = window.__editor!.getState().doc!;
            return { fill: (d.objects[rid!] as { fill?: { swatch: string } }).fill, exists: d.swatches.some((s) => s.id === sid) };
          }, rectId, result.swatch!.id);
          expect(afterDelete).toEqual({ fill: { swatch: 'orange' }, exists: false });

          await saveNow(page);
          const saved = await readSavedDocument(dir, id);
          expect(saved.swatches.some((s) => s.name === 'Bleu pipette' && s.rgb === '#3a7bd5')).toBe(true);
          expect(foreignColors(saved)).toEqual([]);
          await context.close();
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);
});
