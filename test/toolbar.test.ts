// Barre d'outils et raccourcis (tâche 2.8) : dupliquer une carte, annuler la suppression d'un groupe,
// créer des objets, copier-coller d'une face à l'autre, grouper / dissocier, ordre, Alt+glisser.
import { describe, expect, it } from 'vitest';
import type { GroupObject, LayoutDocument } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { minimalDoc } from './fixtures/minimal-doc';
import {
  clickAt,
  copyExample,
  dragFrom,
  objectCenter,
  openEditor,
  pageToClient,
  press,
  readSavedDocument,
  saveNow,
  selection,
  settle,
  withApp,
  withTempDocuments,
  writeDocument,
} from './helpers/editor';

const docOf = (page: import('puppeteer-core').Page): Promise<LayoutDocument> => page.evaluate(() => window.__editor!.getState().doc!);

describe('ajouter, dupliquer, supprimer, grouper (2.8)', () => {
  it('Ctrl+D sur une carte de session crée un groupe identique décalé de 5 mm ; Ctrl+Z annule la suppression d’un groupe entier', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      const original = await readSavedDocument(dir, id);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'int-g4' });
          await clickAt(page, 'p-interieur', 20, 127.5);
          expect(await selection(page)).toEqual(['int-g4']);
          await press(page, 'Control', 'd');
          const [copyId] = await selection(page);
          expect(copyId).not.toBe('int-g4');
          const doc = await docOf(page);
          const copy = doc.objects[copyId] as GroupObject;
          const src = original.objects['int-g4'] as GroupObject;
          expect(copy.type).toBe('group');
          expect(copy.name).toBe(src.name);
          expect(copy.x - src.x).toBeCloseTo(5, 6);
          expect(copy.y - src.y).toBeCloseTo(5, 6);
          expect(copy.children).toHaveLength(src.children.length);
          copy.children.forEach((c, i) => {
            const a = doc.objects[c];
            const b = original.objects[src.children[i]];
            expect(a.x - b.x).toBeCloseTo(5, 6);
            expect(a.y - b.y).toBeCloseTo(5, 6);
            // Même objet au décalage et à l'identifiant près.
            expect({ ...a, id: '', x: 0, y: 0 }).toEqual({ ...b, id: '', x: 0, y: 0 });
          });
          // La copie est juste au-dessus de l'original, sur la même face.
          const int = doc.pages.find((p) => p.id === 'p-interieur')!;
          expect(int.children.indexOf(copyId)).toBe(int.children.indexOf('int-g4') + 1);
          await press(page, 'Control', 'z');
          expect(await docOf(page)).toEqual(original);

          // Supprimer le groupe entier, puis Ctrl+Z : tout revient, enfants compris.
          await clickAt(page, 'p-interieur', 20, 127.5);
          await press(page, 'Delete');
          const gone = await docOf(page);
          for (const c of [src.id, ...src.children]) expect(gone.objects[c]).toBeUndefined();
          await press(page, 'Control', 'z');
          expect(await docOf(page)).toEqual(original);
          expect(await selection(page)).toEqual(['int-g4']);
          await saveNow(page);
          expect(validateDocument(await readSavedDocument(dir, id)).ok).toBe(true);
        },
        { documentsDir: dir },
      );
    });
  });

  it('crée des objets au clic-glisser ou d’un clic, avec leur outil', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'p-ext' });
          // Rectangle tracé de (100, 100) sur 30 × 20 mm.
          await press(page, 'r');
          expect(await page.evaluate(() => window.__editor!.getState().tool)).toBe('rect');
          await dragFrom(page, await pageToClient(page, 'p-ext', 100, 100), 30, 20, { steps: 6 });
          let d = await docOf(page);
          const [rectId] = await selection(page);
          expect(d.objects[rectId]).toMatchObject({ type: 'rect', w: 30, h: 20 });
          expect(d.objects[rectId].x).toBeCloseTo(100, 0);
          expect(await page.evaluate(() => window.__editor!.getState().tool)).toBe('select');

          // Texte, ellipse, cadre, forme, icône, QR : un clic pose la taille par défaut.
          const created: Record<string, string> = {};
          for (const [tool, x] of [
            ['text', 20],
            ['ellipse', 90],
            ['frame', 130],
            ['shape', 180],
            ['icon', 230],
            ['qr', 250],
            ['line', 20],
          ] as const) {
            await page.click(`[data-toolbar] [data-tool="${tool}"]`);
            await clickAt(page, 'p-ext', x, tool === 'line' ? 190 : 150);
            created[tool] = (await selection(page))[0];
          }
          d = await docOf(page);
          expect(d.objects[created.text]).toMatchObject({ type: 'text', w: 60 });
          expect(d.objects[created.ellipse]).toMatchObject({ type: 'ellipse', w: 30, h: 30 });
          expect(d.objects[created.frame]).toMatchObject({ type: 'frame', shape: { kind: 'rect' } });
          expect(d.objects[created.shape]).toMatchObject({ type: 'frame', shape: { kind: 'path', preset: 'goutte' } });
          expect(d.objects[created.icon]).toMatchObject({ type: 'icon', iconName: 'star' });
          expect(d.objects[created.qr]).toMatchObject({ type: 'qr', w: 20, h: 20, margin: 4 });
          expect(d.objects[created.line]).toMatchObject({ type: 'line', w: 40, h: 0 });
          expect(validateDocument(d).ok).toBe(true);
          // Chaque création : une étape d'annulation.
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(8);
        },
        { documentsDir: dir },
      );
    });
  });

  it('copie-colle d’une face à l’autre, groupe et dissocie, change l’ordre, duplique à Alt+glisser', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      doc.objects.r2 = { id: 'r2', type: 'rect', layerId: 'contenu', x: 25, y: 25, w: 20, h: 10, fill: { swatch: 'gris' } };
      doc.pages[0].children.push('r2');
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id);
          await clickAt(page, 'p-ext', 12, 22);
          expect(await selection(page)).toEqual(['r1']);
          await press(page, 'Control', 'c');
          // Survoler la face intérieure en fait la face active : le collage y tombe, même position.
          const over = await pageToClient(page, 'p-int', 150, 100);
          await page.mouse.move(Math.round(over.x), Math.round(over.y));
          await new Promise((r) => setTimeout(r, 100));
          await press(page, 'Control', 'v');
          let d = await docOf(page);
          const [pasted] = await selection(page);
          expect(d.pages.find((p) => p.id === 'p-int')!.children).toEqual([pasted]);
          expect(d.objects[pasted]).toMatchObject({ type: 'rect', x: 10, y: 20, w: 30, h: 15 });

          // Grouper r1 et r2 (Maj+clic), puis dissocier.
          await clickAt(page, 'p-ext', 12, 22);
          await clickAt(page, 'p-ext', 32, 30, { shift: true });
          expect(await selection(page)).toEqual(['r1', 'r2']);
          await press(page, 'Control', 'g');
          const [group] = await selection(page);
          d = await docOf(page);
          expect(d.objects[group]).toMatchObject({ type: 'group', children: ['r1', 'r2'], x: 10, y: 20, w: 35, h: 15 });
          expect(d.pages[0].children).toEqual(['t1', group]);
          await press(page, 'Control', 'Shift', 'g');
          expect(await selection(page)).toEqual(['r1', 'r2']);
          expect((await docOf(page)).pages[0].children).toEqual(['t1', 'r1', 'r2']);

          // Arrière-plan / premier plan (boutons de la barre d'outils).
          await clickAt(page, 'p-ext', 32, 30);
          await page.click('[data-toolbar] [data-action="back"]');
          expect((await docOf(page)).pages[0].children).toEqual(['r2', 't1', 'r1']);
          await page.click('[data-toolbar] [data-action="front"]');
          expect((await docOf(page)).pages[0].children).toEqual(['t1', 'r1', 'r2']);

          // Alt+glisser : une copie part, l'original reste.
          await dragFrom(page, await objectCenter(page, 'r2'), 0, 20, { steps: 6, hold: ['Alt'] });
          d = await docOf(page);
          const [dup] = await selection(page);
          expect(dup).not.toBe('r2');
          expect(d.objects.r2).toMatchObject({ x: 25, y: 25 });
          expect(d.objects[dup]).toMatchObject({ type: 'rect', x: 25, y: 45, w: 20, h: 10 });
          await press(page, 'Control', 'z');
          expect((await docOf(page)).objects[dup]).toBeUndefined();
        },
        { documentsDir: dir },
      );
    });
  });

  it('les options de l’outil Icône ne couvrent pas le plan de travail ; Échap, Fermer ou un clic sur la page les ferment', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          // Zoom « Ajuster », 1600 × 1000 : la face extérieure commence juste à droite de la barre d'outils.
          const page = await openEditor(browser, url, doc.id);
          const rect = (selector: string) =>
            page.$eval(selector, (el) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            });
          const tool = () => page.evaluate(() => window.__editor!.getState().tool);
          const options = () => page.$('[data-tool-options]');

          await press(page, 'k');
          await page.waitForSelector('[data-tool-options="icon"] [data-icon-picker]', { visible: true });
          await settle(page);
          const panel = await rect('[data-tool-options="icon"]');
          const viewport = await rect('[data-workspace-viewport]');
          // Aucun recouvrement : la colonne d'options finit là où le plan de travail commence.
          expect(panel.right).toBeLessThanOrEqual(viewport.left + 0.5);
          // Rien ne s'interpose au point de pose : c'est bien la face qui reçoit le clic.
          const target = await pageToClient(page, 'p-ext', 70, 45);
          expect(await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest('[data-workspace-viewport]'), target.x, target.y)).toBe(true);

          // Clic sur la page : l'icône est posée là, l'outil revient à la sélection, les options se ferment.
          await clickAt(page, 'p-ext', 70, 45);
          const created = await page.evaluate(() => {
            const s = window.__editor!.getState();
            return s.selection.map((i) => s.doc!.objects[i]);
          });
          expect(created).toHaveLength(1);
          expect(created[0].type).toBe('icon');
          expect(Math.abs(created[0].x - 70)).toBeLessThan(0.5);
          expect(Math.abs(created[0].y - 45)).toBeLessThan(0.5);
          expect(await tool()).toBe('select');
          expect(await options()).toBeNull();

          // Échap, même avec le curseur dans le champ de recherche, ferme les options.
          await press(page, 'k');
          await page.waitForSelector('[data-tool-options="icon"] input[name="iconSearch"]', { visible: true });
          await page.click('[data-tool-options="icon"] input[name="iconSearch"]');
          await page.keyboard.type('q');
          await page.keyboard.press('Escape');
          await settle(page);
          expect(await tool()).toBe('select');
          expect(await options()).toBeNull();

          // Bouton « Fermer ».
          await press(page, 'k');
          await page.waitForSelector('[data-action="close-tool-options"]', { visible: true });
          await page.click('[data-action="close-tool-options"]');
          await settle(page);
          expect(await tool()).toBe('select');
          expect(await options()).toBeNull();
        },
        { documentsDir: dir },
      );
    });
  });
});
