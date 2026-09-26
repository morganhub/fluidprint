// Panneau Calques (tâche 2.4) : masquer un calque le retire de l'écran et de l'export ; glisser un objet
// vers un autre calque le fait passer dessus ou dessous ; un objet d'un calque verrouillé ne se
// sélectionne pas au clic ; renommer, rechercher, suivre la sélection. Plus les commandes sous-jacentes.
import { readFile } from 'node:fs/promises';
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { GroupObject, LayoutDocument } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { addLayer, moveObjectTo, removeLayer } from '../src/panels/layerCommands';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, openEditor, readSavedDocument, saveNow, selection, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { readPdfPages } from './helpers/pdf';

// Scénario complet dans Chrome : large marge quand toute la suite tourne en parallèle.
const BROWSER_TIMEOUT_MS = 180_000;

/** Deux calques qui se recouvrent : un grand aplat orange (Fonds) sous un rectangle bleu (Contenu). */
function layeredDoc(): LayoutDocument {
  const doc = minimalDoc();
  doc.layers = [
    { id: 'fonds', name: 'Fonds', visible: true, locked: false, printable: true, color: '#8a94a6' },
    { id: 'contenu', name: 'Contenu', visible: true, locked: false, printable: true, color: '#2563eb' },
    { id: 'reperes', name: 'Repères et notes', visible: true, locked: false, printable: false, color: '#e0245e' },
  ];
  doc.swatches.push({ id: 'orange', name: 'Orange', rgb: '#ff8800' });
  doc.objects.bg = { id: 'bg', type: 'rect', name: 'Aplat orange', layerId: 'fonds', x: 20, y: 15, w: 120, h: 90, fill: { swatch: 'orange' } };
  doc.objects.r1 = { id: 'r1', type: 'rect', name: 'Carré bleu', layerId: 'contenu', x: 40, y: 40, w: 30, h: 20, fill: { swatch: 'bleu' } };
  doc.objects.t1 = { ...(doc.objects.t1 as object), name: 'Titre accroche', y: 120 } as LayoutDocument['objects'][string];
  doc.pages[0].children = ['r1', 't1', 'bg'];
  return doc;
}

const R1_CENTER = { x: 55, y: 50 };

/** Objet dessiné au-dessus des autres en un point d'une face. */
async function topObjectAt(page: Page, pageId: string, x: number, y: number): Promise<string | null> {
  const p = await page.evaluate((pid, xx, yy) => window.__editor!.pageToClient(pid, xx, yy), pageId, x, y);
  return page.evaluate((cx, cy) => (document.elementFromPoint(cx, cy)?.closest('[data-page-id] [data-obj-id]') as HTMLElement | null)?.dataset.objId ?? null, p.x, p.y);
}

async function rowBox(page: Page, selector: string) {
  const el = await page.waitForSelector(selector, { visible: true });
  const box = await el!.boundingBox();
  return box!;
}

/** Glisse une ligne du panneau Calques sur une autre, en haut (0,15) ou en bas (0,85) de la cible. */
async function dragRow(page: Page, from: string, to: string, at: number) {
  const a = await rowBox(page, from);
  const b = await rowBox(page, to);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const tx = b.x + b.width / 2;
  const ty = b.y + b.height * at;
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + ((tx - a.x - a.width / 2) * i) / 8, a.y + a.height / 2 + ((ty - a.y - a.height / 2) * i) / 8);
  await page.mouse.up();
  await settle(page);
}

describe('commandes du panneau Calques', () => {
  it('déplacer un objet hors d’un groupe, dans un groupe, vers un calque ; groupe vidé supprimé', () => {
    const doc = layeredDoc();
    doc.objects.g1 = { id: 'g1', type: 'group', layerId: 'contenu', x: 40, y: 40, w: 30, h: 20, children: ['r1'] } as GroupObject;
    doc.pages[0].children = ['g1', 't1', 'bg'];
    expect(validateDocument(doc).ok).toBe(true);

    // Un groupe ne se dépose pas en lui-même.
    expect(moveObjectTo(doc, 'g1', { type: 'group', groupId: 'g1' })).toBe(false);
    // r1 sort du groupe, au-dessus de l'aplat, sur le calque Fonds : le groupe vidé disparaît.
    expect(moveObjectTo(doc, 'r1', { type: 'object', targetId: 'bg', position: 'above' })).toBe(true);
    expect(doc.objects.g1).toBeUndefined();
    expect(doc.objects.r1.layerId).toBe('fonds');
    expect(doc.pages[0].children).toEqual(['t1', 'bg', 'r1']);
    expect(validateDocument(doc).ok).toBe(true);

    // En dessous de l'aplat.
    moveObjectTo(doc, 'r1', { type: 'object', targetId: 'bg', position: 'below' });
    expect(doc.pages[0].children).toEqual(['t1', 'r1', 'bg']);
    // En haut du calque Repères, sur l'autre face.
    moveObjectTo(doc, 'r1', { type: 'layer', layerId: 'reperes', pageId: 'p-int' });
    expect(doc.pages[1].children).toEqual(['r1']);
    expect(doc.objects.r1.layerId).toBe('reperes');
    expect(validateDocument(doc).ok).toBe(true);
  });

  it('nouveau calque au-dessus ; supprimer un calque déplace ses objets (ou les supprime)', () => {
    const doc = layeredDoc();
    const id = addLayer(doc, 'Photos');
    expect(doc.layers.at(-1)).toMatchObject({ id, name: 'Photos', visible: true, locked: false, printable: true });
    removeLayer(doc, 'contenu', 'fonds');
    expect(doc.layers.map((l) => l.id)).toEqual(['fonds', 'reperes', id]);
    expect(doc.objects.r1.layerId).toBe('fonds');
    expect(doc.objects.t1.layerId).toBe('fonds');
    removeLayer(doc, 'fonds');
    expect(Object.keys(doc.objects)).toEqual([]);
    expect(validateDocument(doc).ok).toBe(true);
  });
});

describe('panneau Calques (navigateur)', () => {
  it('glisser d’un calque à l’autre, verrou, renommer, rechercher, suivre la sélection, masquer (écran et export)', async () => {
    await withTempDocuments(async (dir) => {
      const doc = layeredDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'bg' });
          await page.click('[data-panel-tab="layers"]');
          await page.waitForSelector('[data-layers-panel] [data-layer-row="contenu"]', { visible: true });
          // Arbre du dessus vers le dessous, comme à l'écran.
          const layerRows = await page.$$eval('[data-layer-row]', (els) => els.map((e) => (e as HTMLElement).dataset.layerRow));
          expect(layerRows).toEqual(['reperes', 'contenu', 'fonds']);

          // Suit la sélection faite sur la page.
          await clickAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y);
          expect(await selection(page)).toEqual(['r1']);
          expect(await page.$('[data-object-row="r1"][data-selected]')).not.toBeNull();
          expect(await topObjectAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y)).toBe('r1');

          // Glissé sous l'aplat (calque Fonds) : le carré bleu passe dessous à l'écran.
          await dragRow(page, '[data-object-row="r1"]', '[data-object-row="bg"]', 0.85);
          let r1 = await page.evaluate(() => window.__editor!.getState().doc!.objects.r1);
          expect(r1.layerId).toBe('fonds');
          expect(await topObjectAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y)).toBe('bg');
          // Une étape d'annulation.
          await page.evaluate(() => window.__editor!.getState().undo());
          await settle(page);
          expect(await topObjectAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y)).toBe('r1');
          await page.evaluate(() => window.__editor!.getState().redo());
          await settle(page);
          expect(await topObjectAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y)).toBe('bg');

          // Glissé sur le calque Contenu : il repasse dessus.
          await dragRow(page, '[data-object-row="r1"]', '[data-layer-row="contenu"]', 0.5);
          r1 = await page.evaluate(() => window.__editor!.getState().doc!.objects.r1);
          expect(r1.layerId).toBe('contenu');
          expect(await topObjectAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y)).toBe('r1');

          // Réordonner les calques : Fonds glissé au-dessus de Repères passe devant tout.
          await dragRow(page, '[data-layer-row="fonds"]', '[data-layer-row="reperes"]', 0.15);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.layers.map((l) => l.id))).toEqual(['contenu', 'reperes', 'fonds']);
          expect(await topObjectAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y)).toBe('bg');
          await page.evaluate(() => window.__editor!.getState().undo());
          await settle(page);
          expect(await topObjectAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y)).toBe('r1');

          // Calque Contenu verrouillé : un clic sur le carré ne le sélectionne pas (il atteint l'aplat dessous).
          await page.click('[data-layer-row="contenu"] [data-toggle="locked"]');
          await settle(page);
          await clickAt(page, 'p-ext', R1_CENTER.x, R1_CENTER.y);
          expect(await selection(page)).not.toContain('r1');
          expect(await selection(page)).toEqual(['bg']);
          await page.click('[data-layer-row="contenu"] [data-toggle="locked"]');
          await settle(page);

          // Couleur du cadre de sélection par calque.
          await page.evaluate(() => window.__editor!.getState().select(['r1']));
          await page.click('[data-layer-color="contenu"]');
          await page.click('button[aria-label="#16a34a"]');
          await page.keyboard.press('Escape');
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.layers.find((l) => l.id === 'contenu')!.color)).toBe('#16a34a');
          const outlines = await page.$$eval('[data-selection-layer] *', (els) => els.map((e) => getComputedStyle(e).outlineColor));
          expect(outlines).toContain('rgb(22, 163, 74)');

          // Renommer au double-clic.
          await page.click('[data-layer-row="reperes"] [data-layer-name]', { count: 2 });
          await page.waitForSelector('[data-layer-row="reperes"] input[name="layerRename"]', { visible: true });
          await page.keyboard.type('Notes');
          await page.keyboard.press('Enter');
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.layers.find((l) => l.id === 'reperes')!.name)).toBe('Notes');
          await page.click('[data-object-row="t1"]', { count: 2 });
          await page.waitForSelector('[data-object-row="t1"] input[name="layerRename"]', { visible: true });
          await page.keyboard.type('Accroche');
          await page.keyboard.press('Enter');
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.t1.name)).toBe('Accroche');

          // Recherche par nom (sans accents ni casse) ; un clic sélectionne.
          await page.type('input[name="layerSearch"]', 'carre');
          await settle(page);
          expect(await page.$$eval('[data-object-row]', (els) => els.map((e) => (e as HTMLElement).dataset.objectRow))).toEqual(['r1']);
          await page.click('[data-object-row="r1"]');
          expect(await selection(page)).toEqual(['r1']);
          await page.click('button[aria-label="Effacer la recherche"]');

          // Masquer le calque Contenu : retiré de l'écran…
          await page.click('[data-layer-row="contenu"] [data-toggle="visible"]');
          await settle(page);
          expect(await page.$('[data-workspace-viewport] [data-page-id] [data-obj-id="r1"]')).toBeNull();
          expect(await page.$('[data-workspace-viewport] [data-page-id] [data-obj-id="bg"]')).not.toBeNull();
          expect(await selection(page)).toEqual([]);
          await saveNow(page);
          const saved = await readSavedDocument(dir, doc.id);
          expect(saved.layers.find((l) => l.id === 'contenu')!.visible).toBe(false);

          // … et de l'export : ni sur la route d'impression, ni dans le PDF (l'aplat orange, lui, y est).
          const print = await browser.newPage();
          await print.goto(`${url}/print/${doc.id}`);
          await print.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
          expect(await print.$('[data-obj-id="r1"]')).toBeNull();
          expect(await print.$('[data-obj-id="bg"]')).not.toBeNull();
          const res = await fetch(`${url}/api/doc/${doc.id}/export?preset=rvb`, { method: 'POST' });
          expect(res.status).toBe(200);
          const { file } = (await res.json()) as { file: string };
          const fills = readPdfPages(await readFile(file)).flatMap((p) => p.fills.map((f) => f.color.map((c) => Math.round(c * 255)).join(',')));
          expect(fills).toContain('255,136,0');
          expect(fills).not.toContain('44,109,181');

          // Calque non imprimable : toujours à l'écran, plus sur la route d'impression.
          // (L'onglet de l'éditeur repasse devant : un onglet en arrière-plan ne dessine plus d'images.)
          await page.bringToFront();
          await page.click('[data-layer-row="fonds"] [data-toggle="printable"]');
          await settle(page);
          expect(await page.$('[data-workspace-viewport] [data-page-id] [data-obj-id="bg"]')).not.toBeNull();
          await saveNow(page);
          await print.bringToFront();
          await print.goto(`${url}/print/${doc.id}`);
          await print.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
          expect(await print.$('[data-obj-id="bg"]')).toBeNull();
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);
});
