// Pages types (tâche 4.11) : modèle rétrocompatible, rendu sous les objets de chaque face, édition à un
// seul endroit (mode page type) qui met à jour toutes les faces qui l'utilisent.
import { describe, expect, it } from 'vitest';
import { addMaster, applyMaster, masterObjects, moveToMaster, pagesUsingMaster, removeMaster } from '../src/model/masters';
import type { LayoutDocument, RectObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { stackedEntries } from '../src/render/PageView';
import { createEditorStore } from '../src/store/documentStore';
import { pageIdOf, pageOf } from '../src/store/tree';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, openEditor, press, readSavedDocument, saveNow, selection, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';

/** Document d'essai : une page type « A » (un bandeau et un filet) appliquée aux deux faces. */
function masterDoc(): LayoutDocument {
  const doc = minimalDoc();
  doc.id = 'pages-types';
  doc.layers = [
    { id: 'fonds', name: 'Fonds', visible: true, locked: false, printable: true, color: '#888888' },
    ...doc.layers,
  ];
  doc.masters = [{ id: 'pt-a', faceId: 'exterieur', name: 'A-Page type', children: ['m-band', 'm-rule'] }];
  doc.pages[0].masterId = 'pt-a';
  doc.pages[1].masterId = 'pt-a';
  doc.objects['m-band'] = { id: 'm-band', type: 'rect', layerId: 'fonds', x: 0, y: 180, w: 303, h: 36, fill: { swatch: 'bleu' } };
  doc.objects['m-rule'] = { id: 'm-rule', type: 'rect', layerId: 'contenu', x: 20, y: 150, w: 60, h: 10, fill: { swatch: 'gris' } };
  return doc;
}

describe('pages types : modèle', () => {
  it('un document sans page type reste valide ; références et appartenance vérifiées', () => {
    expect(validateDocument(minimalDoc()).ok).toBe(true);
    const doc = masterDoc();
    expect(validateDocument(doc)).toMatchObject({ ok: true });
    const bad = masterDoc();
    bad.pages[0].masterId = 'inconnue';
    expect(validateDocument(bad)).toMatchObject({ ok: false, errors: [{ path: 'pages.0.masterId' }] });
    const twice = masterDoc();
    twice.pages[0].children.push('m-rule');
    expect(validateDocument(twice).ok).toBe(false);
    const orphan = masterDoc();
    orphan.masters![0].children = ['m-band'];
    expect(validateDocument(orphan)).toMatchObject({ ok: false, errors: [{ path: 'objects.m-rule' }] });
  });

  it('arborescence, empilement par calque et commandes', () => {
    const doc = masterDoc();
    expect(pageIdOf(doc, 'm-rule')).toBe('pt-a');
    expect(pageOf(doc, 'm-rule')?.name).toBe('A-Page type');
    expect(pagesUsingMaster(doc, 'pt-a').map((p) => p.id)).toEqual(['p-ext', 'p-int']);
    expect(masterObjects(doc, doc.pages[1]).map((o) => o.id)).toEqual(['m-band', 'm-rule']);
    // Calque par calque, la page type passe SOUS les objets de la face.
    expect(stackedEntries(doc, doc.pages[0], 'print').map((e) => `${e.obj.id}${e.fromMaster ? '*' : ''}`)).toEqual(['m-band*', 'm-rule*', 'r1', 't1']);

    const id = addMaster(doc, { faceId: 'interieur' });
    expect(id).toBe('pt-b');
    expect(doc.masters!.at(-1)!.name).toBe('B-Page type');
    applyMaster(doc, 'p-int', id);
    expect(moveToMaster(doc, ['r1'], id)).toEqual(['r1']);
    expect(doc.pages[0].children).toEqual(['t1']);
    expect(validateDocument(doc).ok).toBe(true);
    removeMaster(doc, id);
    expect(doc.objects.r1).toBeUndefined();
    expect(doc.pages[1].masterId).toBeUndefined();
    expect(validateDocument(doc).ok).toBe(true);
  });

  it('les commandes du store s’appliquent aux objets de la page type', () => {
    const store = createEditorStore();
    store.getState().load(masterDoc());
    store.getState().move(['m-rule'], 5, 0);
    expect(store.getState().doc!.objects['m-rule'].x).toBe(25);
    store.getState().duplicate(['m-rule']);
    const copy = store.getState().selection[0];
    expect(store.getState().doc!.masters![0].children).toEqual(['m-band', 'm-rule', copy]);
    store.getState().remove([copy]);
    store.getState().undo();
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().doc!.objects['m-rule'].x).toBe(20);
    expect(store.getState().doc!.masters![0].children).toEqual(['m-band', 'm-rule']);
  });
});

describe('pages types : dans l’éditeur', () => {
  it('modifier la page type met à jour toutes les faces qui l’utilisent, à l’écran et à l’impression', async () => {
    await withTempDocuments(async (dir) => {
      await writeDocument(dir, masterDoc());
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'pages-types');
          const onFace = (face: string, id: string) =>
            page.$eval(`[data-page-id="${face}"] [data-master-item="${id}"] [data-obj-id="${id}"]`, (el) => ({ left: (el as HTMLElement).style.left, top: (el as HTMLElement).style.top }));
          // Les objets de la page type sont dessinés sur les deux faces…
          expect(await onFace('p-ext', 'm-rule')).toEqual({ left: '20mm', top: '150mm' });
          expect(await onFace('p-int', 'm-rule')).toEqual({ left: '20mm', top: '150mm' });
          // … mais ne s'y sélectionnent pas : un clic passe au travers.
          await clickAt(page, 'p-ext', 50, 155);
          expect(await selection(page)).toEqual([]);

          // Mode d'édition de la page type : elle seule occupe le plan de travail.
          await page.click('[data-topbar-action="masters"]');
          await page.waitForSelector('[data-master-row="pt-a"]');
          await page.click('[data-master-row="pt-a"] [data-action="edit-master"]');
          await page.waitForSelector('[data-master-banner="pt-a"]');
          expect(await page.$$eval('[data-page-slot]', (els) => els.map((e) => e.getAttribute('data-page-slot')))).toEqual(['pt-a']);
          expect(await page.$eval('[data-master-banner]', (el) => el.textContent)).toContain('Extérieur, Intérieur');
          // Ici, l'objet se sélectionne et se déplace comme les autres (Maj+flèche : 5 mm).
          await clickAt(page, 'pt-a', 50, 155);
          expect(await selection(page)).toEqual(['m-rule']);
          await press(page, 'Shift', 'ArrowRight');
          await page.evaluate(() => window.__editor!.getState().update(['m-band'], (o) => void ((o as RectObject).fill = { swatch: 'gris' }), 'Couleur'));
          await page.click('[data-action="master-done"]');
          await settle(page);

          // Retour aux faces : les deux faces suivent la modification.
          expect(await page.$$eval('[data-page-slot]', (els) => els.map((e) => e.getAttribute('data-page-slot')))).toEqual(['p-ext', 'p-int']);
          expect(await onFace('p-ext', 'm-rule')).toEqual({ left: '25mm', top: '150mm' });
          expect(await onFace('p-int', 'm-rule')).toEqual({ left: '25mm', top: '150mm' });
          const fills = await page.$$eval('[data-master-item="m-band"] [fill]', (els) => els.map((e) => e.getAttribute('fill')));
          expect(fills).toEqual(['#4b4d55', '#4b4d55']);

          // Annuler depuis les faces : la page type revient, sans sélection fantôme.
          await press(page, 'Control', 'z');
          expect(await page.$$eval('[data-master-item="m-band"] [fill]', (els) => els.map((e) => e.getAttribute('fill')))).toEqual(['#2a5fa3', '#2a5fa3']);
          await press(page, 'Control', 'z');
          expect(await onFace('p-int', 'm-rule')).toEqual({ left: '20mm', top: '150mm' });
          expect(await selection(page)).toEqual([]);
          await press(page, 'Control', 'y');
          await press(page, 'Control', 'y');

          // Enregistré, puis imprimé : la page type est sur chaque page du PDF.
          await saveNow(page);
          const saved = await readSavedDocument(dir, 'pages-types');
          expect(saved.objects['m-rule'].x).toBe(25);
          expect(validateDocument(saved).ok).toBe(true);
          const print = await browser.newPage();
          await print.goto(`${url}/print/pages-types`);
          await print.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
          const printed = await print.$$eval('.print-face', (faces) => faces.map((f) => (f.querySelector('[data-obj-id="m-rule"]') as HTMLElement | null)?.style.left ?? null));
          expect(printed).toEqual(['25mm', '25mm']);
          await print.close();
        },
        { documentsDir: dir },
      );
    });
  });
});
