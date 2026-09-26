// Panneau Propriétés, socle (tâche 2.7) : L = 52 mm, « — » en sélection multiple, filet sous 0,25 pt
// signalé, X et Y depuis le format fini, texte de base.
import { describe, expect, it } from 'vitest';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, openEditor, readSavedDocument, saveNow, selection, settle, typeInField, withApp, withTempDocuments, writeDocument } from './helpers/editor';

function propertiesDoc(): LayoutDocument {
  const doc = minimalDoc();
  doc.objects.r2 = { id: 'r2', type: 'rect', layerId: 'contenu', x: 50, y: 20, w: 20, h: 10, fill: { swatch: 'gris' } };
  doc.objects.l1 = { id: 'l1', type: 'line', layerId: 'contenu', x: 10, y: 45, w: 60, h: 0, stroke: { color: { swatch: 'gris' }, width: 0.5 } };
  doc.pages[0].children.push('r2', 'l1');
  return doc;
}

const fieldValue = (page: import('puppeteer-core').Page, name: string) =>
  page.$eval(`[data-side-panels] input[name="${name}"]`, (el) => ({ value: (el as HTMLInputElement).value, placeholder: (el as HTMLInputElement).placeholder }));

describe('panneau Propriétés (2.7)', () => {
  it('saisir L = 52 mm redimensionne l’objet à 52,0 mm ; X se lit depuis le format fini', async () => {
    await withTempDocuments(async (dir) => {
      const doc = propertiesDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          await clickAt(page, 'p-ext', 25, 27);
          expect(await selection(page)).toEqual(['r1']);
          expect(await fieldValue(page, 'w')).toMatchObject({ value: '30' });
          // X affiché = 10 mm − 3 mm de fond perdu.
          expect(await fieldValue(page, 'x')).toMatchObject({ value: '7' });

          await typeInField(page, 'w', '52');
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.w)).toBe(52);
          expect(await fieldValue(page, 'w')).toMatchObject({ value: '52' });
          await typeInField(page, 'x', '17,25');
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.r1.x)).toBe(20.25);
          await saveNow(page);
          const saved = await readSavedDocument(dir, doc.id);
          expect(saved.objects.r1.w).toBe(52);
          expect(saved.objects.r1.x).toBe(20.25);
          // Chaque saisie = une étape d'annulation.
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(2);
        },
        { documentsDir: dir },
      );
    });
  });

  it('affiche « — » quand les valeurs diffèrent, et une saisie s’applique à toute la sélection', async () => {
    await withTempDocuments(async (dir) => {
      const doc = propertiesDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          await clickAt(page, 'p-ext', 25, 27);
          await clickAt(page, 'p-ext', 60, 25, { shift: true });
          expect(await selection(page)).toEqual(['r1', 'r2']);
          expect(await fieldValue(page, 'w')).toEqual({ value: '', placeholder: '—' });
          // Même Y pour les deux : la valeur commune s'affiche.
          expect(await fieldValue(page, 'y')).toMatchObject({ value: '17' });
          expect(await page.$eval('[data-selection-name]', (el) => el.textContent)).toBe('2 objets');
          await typeInField(page, 'w', '25');
          const objs = await page.evaluate(() => window.__editor!.getState().doc!.objects);
          expect(objs.r1.w).toBe(25);
          expect(objs.r2.w).toBe(25);
        },
        { documentsDir: dir },
      );
    });
  });

  it('signale un filet de moins de 0,25 pt', async () => {
    await withTempDocuments(async (dir) => {
      const doc = propertiesDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 2, centerOn: 'l1' });
          await clickAt(page, 'p-ext', 40, 45);
          expect(await selection(page)).toEqual(['l1']);
          expect(await page.$('[data-testid="stroke-warning"]')).toBeNull();
          await typeInField(page, 'strokeWidth', '0,2');
          expect(await page.evaluate(() => (window.__editor!.getState().doc!.objects.l1 as { stroke: { width: number } }).stroke.width)).toBe(0.2);
          const warning = await page.waitForSelector('[data-testid="stroke-warning"]', { visible: true });
          expect(await warning!.evaluate((el) => el.textContent)).toContain('0,25 pt');
          await typeInField(page, 'strokeWidth', '0,3');
          await settle(page);
          expect(await page.$('[data-testid="stroke-warning"]')).toBeNull();
        },
        { documentsDir: dir },
      );
    });
  });

  it('règle le texte de base : corps, interlignage en pt, interlettrage, alignement, casse', async () => {
    await withTempDocuments(async (dir) => {
      const doc = propertiesDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 't1' });
          await clickAt(page, 'p-ext', 20, 62);
          expect(await selection(page)).toEqual(['t1']);
          expect(await fieldValue(page, 'leading')).toMatchObject({ value: '11,25' });
          await typeInField(page, 'fontSize', '10');
          await typeInField(page, 'leading', '14');
          await typeInField(page, 'tracking', '80');
          await page.click('[data-side-panels] button[aria-label="Centrer"]');
          await page.click('[data-side-panels] button[aria-label="Capitales"]');
          await settle(page);
          const t1 = (await page.evaluate(() => window.__editor!.getState().doc!.objects.t1)) as TextObject;
          expect(t1.style.fontSize).toBe(10);
          expect(t1.style.lineHeight).toBeCloseTo(1.4, 6);
          expect(t1.style.letterSpacing).toBeCloseTo(0.08, 6);
          expect(t1.style.align).toBe('center');
          expect(t1.style.transform).toBe('uppercase');
          // La couleur locale de « pour vous. » survit aux retouches du bloc.
          expect(t1.paragraphs[0].runs[1].color).toEqual({ swatch: 'bleu' });
        },
        { documentsDir: dir },
      );
    });
  });
});
