// Enregistrement automatique (tâche 2.2) : 2 s après la dernière modification, jamais pendant un geste,
// tout de suite sur Ctrl+S ; editedAt posé ; alerte à la fermeture ; erreur affichée.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, objectCenter, openEditor, press, readSavedDocument, saveNow, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { openTextEditor } from './helpers/text';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (doc: LayoutDocument, id: string) => (doc.objects[id] as TextObject).paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');

/** Horodatage de chaque requête d'enregistrement (PUT /api/doc/…). */
function trackSaves(page: Page): number[] {
  const puts: number[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().includes('/api/doc/')) puts.push(Date.now());
  });
  return puts;
}

const status = (page: Page) => page.$eval('[data-save-status]', (el) => ({ kind: el.getAttribute('data-save-status'), text: el.textContent }));

describe('enregistrement automatique (2.2)', () => {
  it('enregistre 2 s après la modification : fermer l’onglet 3 s après ne perd rien, editedAt est posé', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          // L'ouverture fait UNE copie d'historique, même si React monte l'éditeur deux fois.
          expect(await readdir(path.join(dir, doc.id, 'history'))).toHaveLength(1);
          const puts = trackSaves(page);
          let dialog = false;
          page.on('dialog', async (d) => {
            dialog = true;
            await d.accept();
          });
          expect(await status(page)).toEqual({ kind: 'saved', text: 'Enregistré' });

          await clickAt(page, 'p-ext', 25, 27);
          const t0 = Date.now();
          await press(page, 'ArrowRight');
          expect(await status(page)).toEqual({ kind: 'dirty', text: 'Modifications en cours' });
          await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });
          const elapsed = Date.now() - t0;
          expect(elapsed).toBeGreaterThanOrEqual(1900);
          expect(elapsed).toBeLessThan(3000);
          expect(puts).toHaveLength(1);

          await sleep(Math.max(0, 3000 - (Date.now() - t0)));
          await page.close({ runBeforeUnload: true });
          await sleep(200);
          expect(dialog).toBe(false);
          const saved = await readSavedDocument(dir, doc.id);
          expect(saved.objects.r1.x).toBeCloseTo(10.5, 6);
          expect(saved.editedAt).toBeDefined();
          expect(Date.parse(saved.editedAt!)).toBeGreaterThan(t0 - 1000);
        },
        { documentsDir: dir },
      );
    });
  });

  it('aucune requête d’enregistrement pendant un glisser, même quand le délai expire en plein geste', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          const puts = trackSaves(page);
          await clickAt(page, 'p-ext', 25, 27);
          // Une modification juste avant le geste : son délai de 2 s tombe pendant le glisser.
          await press(page, 'ArrowRight');
          const start = await objectCenter(page, 'r1');
          await page.mouse.move(Math.round(start.x), Math.round(start.y));
          await page.mouse.down();
          const dragStart = Date.now();
          for (let i = 1; i <= 16; i++) {
            await page.mouse.move(Math.round(start.x) + i * 4, Math.round(start.y) + i * 2);
            await sleep(200);
          }
          expect(Date.now() - dragStart).toBeGreaterThan(3000);
          const gesture = await page.evaluate(() => window.__editor!.getState().gesture);
          expect(gesture?.label).toBe('Déplacer');
          // Machine chargée (suite complète) : si le geste démarre plus de 2 s après la flèche, l'enregistrement
          // de la flèche part avant lui, à raison. Seul compte ce qui part pendant le geste : rien.
          expect(puts.filter((t) => t >= gesture!.startedAt)).toEqual([]);
          await page.mouse.up();
          const released = Date.now();
          const deadline = released + 6000;
          while (!puts.some((t) => t >= released) && Date.now() < deadline) await sleep(100);
          await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });
          const afterRelease = puts.filter((t) => t >= released);
          expect(afterRelease).toHaveLength(1);
          expect(afterRelease[0] - released).toBeGreaterThanOrEqual(1900);
          // Le glisser de plus de 3 s n'a fait qu'une étape (plus celle des flèches).
          expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(2);
          const saved = await readSavedDocument(dir, doc.id);
          expect(saved.objects.r1.x).toBeGreaterThan(20);
        },
        { documentsDir: dir },
      );
    });
  });

  it('Ctrl+S enregistre tout de suite ; fermer avec des changements en attente déclenche l’alerte', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          const puts = trackSaves(page);
          await clickAt(page, 'p-ext', 25, 27);
          await press(page, 'ArrowDown');
          const t0 = Date.now();
          await press(page, 'Control', 's');
          await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });
          expect(Date.now() - t0).toBeLessThan(1500);
          expect(puts).toHaveLength(1);
          expect((await readSavedDocument(dir, doc.id)).objects.r1.y).toBeCloseTo(20.5, 6);

          await press(page, 'ArrowDown');
          const dialogs: string[] = [];
          page.on('dialog', async (d) => {
            dialogs.push(d.type());
            await d.accept();
          });
          await page.close({ runBeforeUnload: true });
          await sleep(500);
          expect(dialogs).toEqual(['beforeunload']);
        },
        { documentsDir: dir },
      );
    });
  });

  it('affiche une erreur d’enregistrement et réessaie', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          await page.setRequestInterception(true);
          let fail = true;
          page.on('request', (req) => {
            if (fail && req.method() === 'PUT') void req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Disque plein' }) });
            else void req.continue();
          });
          await clickAt(page, 'p-ext', 25, 27);
          await press(page, 'ArrowRight');
          await press(page, 'Control', 's');
          await page.waitForSelector('[data-save-status="error"]', { timeout: 5000 });
          expect(await page.$eval('[data-save-status="error"]', (el) => el.textContent)).toContain('Disque plein');
          fail = false;
          await page.click('[data-save-status="error"]');
          await page.waitForSelector('[data-save-status="saved"]', { timeout: 5000 });
          expect((await readSavedDocument(dir, doc.id)).objects.r1.x).toBeCloseTo(10.5, 6);

          // Réseau coupé : le message est en français (et non « Failed to fetch »), l'éditeur réessaie.
          await page.setOfflineMode(true);
          await press(page, 'ArrowRight');
          await press(page, 'Control', 's');
          await page.waitForSelector('[data-save-status="error"]', { timeout: 5000 });
          const offline = await page.$eval('[data-save-status="error"]', (el) => el.textContent ?? '');
          expect(offline).toContain('Serveur injoignable');
          expect(offline).not.toMatch(/fetch/i);
          await page.setOfflineMode(false);
          await page.waitForSelector('[data-save-status="saved"]', { timeout: 8000 });
          expect((await readSavedDocument(dir, doc.id)).objects.r1.x).toBeCloseTo(11, 6);
        },
        { documentsDir: dir },
      );
    });
  });

  it('texte en édition, fermeture 3 s après : la frappe est sur le disque, l’historique garde une seule étape', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 't1' });
          const puts = trackSaves(page);
          const dialogs: string[] = [];
          page.on('dialog', async (d) => {
            dialogs.push(d.type());
            await d.accept();
          });
          const editing = () => page.evaluate(() => ({ mode: window.__editor!.getState().mode?.id ?? null, gesture: window.__editor!.getState().gesture?.label ?? null, depth: window.__editor!.getState().history.depth }));

          await openTextEditor(page, 't1');
          await page.keyboard.down('Control');
          await page.keyboard.press('End');
          await page.keyboard.up('Control');
          await page.keyboard.type(' AJOUT');
          const typed = Date.now();
          await sleep(3000);
          // Toujours en édition, rien de validé dans l'historique… mais le texte est sur le disque.
          expect(await editing()).toEqual({ mode: 'text-edit', gesture: 'Modifier le texte', depth: 0 });
          expect(puts.length).toBeGreaterThanOrEqual(1);
          expect(puts[0] - typed).toBeGreaterThanOrEqual(1500);
          expect(textOf(await readSavedDocument(dir, doc.id), 't1')).toBe('Votre atelier, pour vous. AJOUT');
          expect(await status(page)).toEqual({ kind: 'saved', text: 'Enregistré' });

          // Sortie : UNE étape « Modifier le texte » ; Ctrl+Z la défait et le disque suit.
          await page.keyboard.press('Escape');
          await settle(page);
          expect(await editing()).toEqual({ mode: null, gesture: null, depth: 1 });
          expect(await page.evaluate(() => window.__editor!.getState().history.undoLabel)).toBe('Modifier le texte');
          await press(page, 'Control', 'z');
          await saveNow(page);
          expect(textOf(await readSavedDocument(dir, doc.id), 't1')).toBe('Votre atelier, pour vous.');
          await press(page, 'Control', 'y');
          await saveNow(page);
          expect(textOf(await readSavedDocument(dir, doc.id), 't1')).toBe('Votre atelier, pour vous. AJOUT');

          // Nouvelle saisie, onglet fermé 3 s après sans quitter l'édition : rien n'est perdu, aucune alerte.
          await openTextEditor(page, 't1');
          await page.keyboard.down('Control');
          await page.keyboard.press('End');
          await page.keyboard.up('Control');
          await page.keyboard.type(' FIN');
          await sleep(3000);
          expect((await editing()).mode).toBe('text-edit');
          await page.close({ runBeforeUnload: true });
          await sleep(300);
          expect(dialogs).toEqual([]);
          expect(textOf(await readSavedDocument(dir, doc.id), 't1')).toBe('Votre atelier, pour vous. AJOUT FIN');
        },
        { documentsDir: dir },
      );
    });
  });

  it('deux onglets sur le même document : le second enregistrement est refusé (409), recharger ou écraser', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const a = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          const b = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'r1' });
          const conflictDialog = (page: Page) => page.$('[data-save-conflict-dialog]');
          // Un onglet caché ne reçoit plus d'images (requestAnimationFrame) : on passe au premier plan celui qu'on utilise.
          const use = async (page: Page) => {
            await page.bringToFront();
            await settle(page);
          };

          // B déplace r1 et enregistre.
          await use(b);
          await clickAt(b, 'p-ext', 25, 27);
          await press(b, 'ArrowRight');
          await saveNow(b);
          expect((await readSavedDocument(dir, doc.id)).objects.r1).toMatchObject({ x: 10.5, y: 20 });

          // A, ouvert avant, modifie autre chose : refusé, rien n'est écrit, A le dit et propose de choisir.
          await use(a);
          await clickAt(a, 'p-ext', 25, 27);
          await press(a, 'ArrowDown');
          await saveNow(a);
          await a.waitForSelector('[data-save-status="conflict"]');
          expect(await conflictDialog(a)).not.toBeNull();
          expect((await readSavedDocument(dir, doc.id)).objects.r1).toMatchObject({ x: 10.5, y: 20 });
          // Plus aucun essai automatique tant que l'utilisateur n'a pas choisi.
          await sleep(2500);
          expect((await readSavedDocument(dir, doc.id)).objects.r1).toMatchObject({ x: 10.5, y: 20 });

          // Écraser : la version de A gagne, celle de B reste dans l'historique.
          const historyBefore = (await readdir(path.join(dir, doc.id, 'history'))).length;
          await a.click('[data-action="conflict-overwrite"]');
          await a.waitForSelector('[data-save-status="saved"]');
          expect(await conflictDialog(a)).toBeNull();
          expect((await readSavedDocument(dir, doc.id)).objects.r1).toMatchObject({ x: 10, y: 20.5 });
          expect((await readdir(path.join(dir, doc.id, 'history'))).length).toBe(historyBefore + 1);

          // B ne sait rien : sa modification suivante est refusée à son tour. Recharger : B affiche le disque.
          await use(b);
          await press(b, 'ArrowRight');
          await saveNow(b);
          await b.waitForSelector('[data-save-status="conflict"]');
          await b.click('[data-action="conflict-reload"]');
          await b.waitForSelector('[data-save-status="saved"]');
          expect(await b.evaluate(() => ({ ...window.__editor!.getState().doc!.objects.r1 }))).toMatchObject({ x: 10, y: 20.5 });
          expect(await b.evaluate(() => window.__editor!.getState().history.depth)).toBe(0);
          // Après rechargement, B enregistre normalement.
          await clickAt(b, 'p-ext', 25, 28);
          await press(b, 'ArrowLeft');
          await saveNow(b);
          expect(await status(b)).toEqual({ kind: 'saved', text: 'Enregistré' });
          expect((await readSavedDocument(dir, doc.id)).objects.r1).toMatchObject({ x: 9.5, y: 20.5 });

          // Un script qui réécrit le fichier (derive-styles, print-swatches) est protégé de la même façon.
          const onDisk = await readSavedDocument(dir, doc.id);
          await writeDocument(dir, { ...onDisk, name: 'Renommé par un script' });
          await press(b, 'ArrowLeft');
          await saveNow(b);
          await b.waitForSelector('[data-save-status="conflict"]');
          expect((await readSavedDocument(dir, doc.id)).name).toBe('Renommé par un script');
        },
        { documentsDir: dir },
      );
    });
  });
});
