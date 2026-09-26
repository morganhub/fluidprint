// Versions nommées (tâche 2.17) : enregistrer une version (nom + date) dans documents/<id>/versions/,
// la lister, la comparer (vignettes) et la restaurer. Restaurer crée d'abord une copie de l'état courant.
import Fastify from 'fastify';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument } from '../src/model/types';
import { registerApiRoutes } from '../server/routes';
import { minimalDoc } from './fixtures/minimal-doc';
import { copyExample, openEditor, readSavedDocument, settle, withApp, withTempDocuments } from './helpers/editor';

// Scénario complet dans Chrome : large marge quand toute la suite tourne en parallèle.
const BROWSER_TIMEOUT_MS = 180_000;

interface VersionMeta {
  id: string;
  name: string;
  createdAt: string;
  kind: 'manual' | 'auto';
}

async function api(dir: string) {
  const app = Fastify();
  await registerApiRoutes(app, { documentsDir: dir });
  await app.ready();
  const call = async <T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object | undefined });
    return { status: res.statusCode, body: res.json() as T };
  };
  return { app, call };
}

async function seed(dir: string, doc: LayoutDocument) {
  await mkdir(path.join(dir, doc.id), { recursive: true });
  await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc, null, 2));
}

describe('versions nommées : API (2.17)', () => {
  it('enregistrer, lister, relire, restaurer (copie de l’état courant d’abord), supprimer', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      await seed(dir, doc);
      const { app, call } = await api(dir);
      try {
        // Version du fichier du disque.
        const v1 = await call<VersionMeta>('POST', '/api/doc/essai/versions', { name: '  Avant   retouche ' });
        expect(v1.status).toBe(201);
        expect(v1.body).toMatchObject({ name: 'Avant retouche', kind: 'manual' });
        expect(Date.parse(v1.body.createdAt)).not.toBeNaN();
        const files = await readdir(path.join(dir, 'essai', 'versions'));
        expect(files).toEqual([`${v1.body.id}.json`]);

        // Retouche enregistrée, puis version de l'état de l'éditeur (envoyé avec la requête).
        const edited = { ...doc, objects: { ...doc.objects, r1: { ...doc.objects.r1, x: 99 } } };
        expect((await call('PUT', '/api/doc/essai', edited)).status).toBe(200);
        const v2 = await call<VersionMeta>('POST', '/api/doc/essai/versions', { name: 'Après retouche', document: edited });
        expect(v2.status).toBe(201);

        const list = await call<VersionMeta[]>('GET', '/api/doc/essai/versions');
        expect(list.body.map((v) => v.name)).toEqual(['Après retouche', 'Avant retouche']);
        const read = await call<{ version: VersionMeta; document: LayoutDocument }>('GET', `/api/doc/essai/versions/${v1.body.id}`);
        expect(read.body.document.objects.r1.x).toBe(doc.objects.r1.x);

        // État courant de l'éditeur (non encore enregistré) : r1 à 123 mm.
        const current = { ...doc, objects: { ...doc.objects, r1: { ...doc.objects.r1, x: 123 } } };
        const restored = await call<{ document: LayoutDocument; backup: VersionMeta }>('POST', `/api/doc/essai/versions/${v1.body.id}/restore`, { current });
        expect(restored.status).toBe(200);
        expect(restored.body.document.objects.r1.x).toBe(doc.objects.r1.x);
        expect(restored.body.document.editedAt).toBeTruthy();
        // La copie de sécurité existe, porte l'état courant, et a été faite AVANT l'écriture du document.
        expect(restored.body.backup).toMatchObject({ kind: 'auto', name: 'Avant restauration de « Avant retouche »' });
        const backup = await call<{ document: LayoutDocument }>('GET', `/api/doc/essai/versions/${restored.body.backup.id}`);
        expect(backup.body.document.objects.r1.x).toBe(123);
        const onDisk = JSON.parse(await readFile(path.join(dir, 'essai', 'document.json'), 'utf8')) as LayoutDocument;
        expect(onDisk.objects.r1.x).toBe(doc.objects.r1.x);
        expect(Date.parse(restored.body.backup.createdAt)).toBeLessThanOrEqual(Date.parse(onDisk.editedAt!));
        expect((await call<VersionMeta[]>('GET', '/api/doc/essai/versions')).body[0].id).toBe(restored.body.backup.id);

        // Sans état courant fourni, c'est le fichier du disque qui est gardé.
        const again = await call<{ backup: VersionMeta }>('POST', `/api/doc/essai/versions/${v2.body.id}/restore`);
        const backup2 = await call<{ document: LayoutDocument }>('GET', `/api/doc/essai/versions/${again.body.backup.id}`);
        expect(backup2.body.document.objects.r1.x).toBe(doc.objects.r1.x);

        // Erreurs : nom vide, identifiant douteux, version absente, document invalide.
        expect((await call('POST', '/api/doc/essai/versions', { name: '   ' })).status).toBe(400);
        expect((await call('GET', '/api/doc/essai/versions/..%2F..%2Fdocument')).status).toBe(400);
        expect((await call('GET', '/api/doc/essai/versions/v-2020-01-01T00-00-00-000Z-abcdef')).status).toBe(404);
        expect((await call('POST', '/api/doc/essai/versions', { name: 'Cassée', document: { ...doc, layers: [] } })).status).toBe(422);
        expect((await call('POST', '/api/doc/absent/versions', { name: 'x' })).status).toBe(404);

        expect((await call('DELETE', `/api/doc/essai/versions/${v2.body.id}`)).status).toBe(200);
        expect((await call('GET', `/api/doc/essai/versions/${v2.body.id}`)).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
});

describe('versions nommées : éditeur (navigateur)', () => {
  it('bouton « Enregistrer une version », vignettes, comparer, restaurer (annulable), copie de l’état courant', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          const x0 = await page.evaluate(() => window.__editor!.getState().doc!.objects['ext-g9'].x);

          // Retouche, puis « Enregistrer une version » (barre du haut) : nom proposé avec la date.
          await page.evaluate(() => window.__editor!.getState().move(['ext-g9'], 10, 0));
          await page.click('[data-action="save-version"]');
          const input = await page.waitForSelector('[data-save-version-dialog] input[name="versionName"]', { visible: true });
          expect(await input!.evaluate((e) => (e as HTMLInputElement).value)).toMatch(/^Version du \d{1,2} [a-zé.]+ \d{4}/);
          // Le nom proposé est entièrement sélectionné : taper un nom le remplace (sans triple-clic).
          const selected = await input!.evaluate((e) => {
            const el = e as HTMLInputElement;
            return { focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, length: el.value.length };
          });
          expect(selected).toEqual({ focused: true, start: 0, end: selected.length, length: selected.length });
          await page.keyboard.type('Carte décalée');
          expect(await input!.evaluate((e) => (e as HTMLInputElement).value)).toBe('Carte décalée');
          await page.click('[data-action="confirm-save-version"]');
          await page.waitForSelector('[data-save-version-dialog]', { hidden: true });

          // Panneau Versions : la version, sa date et sa vignette (les deux faces rendues en miniature).
          await page.click('[data-panel-tab="versions"]');
          const row = await page.waitForSelector('[data-version-row]', { visible: true });
          expect(await row!.$eval('[data-version-name]', (e) => e.textContent)).toBe('Carte décalée');
          await page.waitForSelector('[data-version-row] [data-faces-preview] [data-page-id]');
          const thumb = await page.$eval('[data-version-row] [data-faces-preview]', (el) => ({
            faces: el.querySelectorAll('[data-page-id]').length,
            objects: el.querySelectorAll('[data-obj-id]').length,
            width: el.getBoundingClientRect().width,
          }));
          expect(thumb.faces).toBe(2);
          expect(thumb.objects).toBeGreaterThan(200);
          expect(thumb.width).toBeLessThan(270);
          // Enregistrée sur le disque, dans documents/<id>/versions/, avec la retouche.
          const [file] = await readdir(path.join(dir, id, 'versions'));
          const stored = JSON.parse(await readFile(path.join(dir, id, 'versions', file), 'utf8'));
          expect(stored.version.name).toBe('Carte décalée');
          expect(stored.document.objects['ext-g9'].x).toBeCloseTo(x0 + 10, 4);

          // Nouvelle retouche, puis comparer : version à gauche, état actuel à droite.
          await page.evaluate(() => window.__editor!.getState().move(['ext-g9'], 0, 20));
          await page.click('[data-action="compare-version"]');
          await page.waitForSelector('[data-compare-dialog] [data-faces-preview="current"] [data-page-id]', { visible: true });
          expect(await page.$$eval('[data-compare-dialog] [data-faces-preview]', (els) => els.length)).toBe(2);
          await page.keyboard.press('Escape');
          await page.waitForSelector('[data-compare-dialog]', { hidden: true });

          // Restaurer : l'état courant part d'abord en copie, puis le document revient à la version.
          const yEdited = await page.evaluate(() => window.__editor!.getState().doc!.objects['ext-g9'].y);
          await page.click('[data-action="restore-version"]');
          await page.click('[data-action="confirm-restore-version"]');
          await page.waitForSelector('[data-restore-dialog]', { hidden: true });
          await page.waitForSelector('[data-versions-notice]');
          await settle(page);
          const restored = await page.evaluate(() => window.__editor!.getState().doc!.objects['ext-g9']);
          expect(restored.x).toBeCloseTo(x0 + 10, 4);
          expect(restored.y).not.toBeCloseTo(yEdited, 2);
          const names = await page.$$eval('[data-version-row] [data-version-name]', (els) => els.map((e) => e.textContent));
          expect(names).toEqual(['Avant restauration de « Carte décalée »', 'Carte décalée']);
          const backupFile = (await readdir(path.join(dir, id, 'versions'))).find((f) => f !== file)!;
          const backup = JSON.parse(await readFile(path.join(dir, id, 'versions', backupFile), 'utf8'));
          expect(backup.version.kind).toBe('auto');
          expect(backup.document.objects['ext-g9'].y).toBeCloseTo(yEdited, 4);
          expect((await readSavedDocument(dir, id)).objects['ext-g9'].y).toBeCloseTo(restored.y, 4);

          // Ctrl+Z annule la restauration d'un coup.
          await page.evaluate(() => window.__editor!.getState().undo());
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects['ext-g9'].y)).toBeCloseTo(yEdited, 4);
          // Le serveur a réécrit le fichier à la restauration : l'éditeur connaît sa nouvelle révision et
          // enregistre par-dessus sans se croire en conflit.
          await page.evaluate(() => window.__editor!.saveNow());
          expect(await page.$eval('[data-save-status]', (el) => el.getAttribute('data-save-status'))).toBe('saved');
          expect((await readSavedDocument(dir, id)).objects['ext-g9'].y).toBeCloseTo(yEdited, 4);
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);
});
