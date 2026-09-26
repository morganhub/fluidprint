// Import d'un design Claude Design depuis l'interface : route POST /api/import/claude-design et
// boîte de dialogue de la page d'accueil, sur un dossier de documents jetable.
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportResponse } from '../server/importDesign';
import { PROJECT_ROOT } from '../server/paths';
import { registerApiRoutes } from '../server/routes';
import type { LayoutDocument } from '../src/model/types';
import { withApp, withTempDocuments } from './helpers/browser';

const FLYER = path.join(PROJECT_ROOT, 'test', 'fixtures', 'designs', 'flyer-a5.dc.html');

async function multipart(fields: Record<string, string>, file?: { name: string; content: string | Buffer; type?: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', new Blob([typeof file.content === 'string' ? file.content : new Uint8Array(file.content)], { type: file.type ?? 'text/html' }), file.name);
  const encoded = new Response(form);
  return { headers: { 'content-type': encoded.headers.get('content-type')! }, payload: Buffer.from(await encoded.arrayBuffer()) };
}

async function withRoutes<T>(fn: (app: FastifyInstance, dir: string) => Promise<T>): Promise<T> {
  return withTempDocuments(async (dir) => {
    const app = Fastify();
    await registerApiRoutes(app, { documentsDir: dir });
    try {
      return await fn(app, dir);
    } finally {
      await app.close();
    }
  });
}

const post = async (app: FastifyInstance, body: { headers: Record<string, string>; payload: Buffer }) =>
  app.inject({ method: 'POST', url: '/api/import/claude-design', ...body });

describe('POST /api/import/claude-design', () => {
  it('importe un export valide : 201 { id, report }, document et copie du design dans le dossier documents', async () => {
    await withRoutes(async (app, dir) => {
      const flyer = await readFile(FLYER, 'utf8');
      const res = await post(app, await multipart({ name: 'Flyer atelier', template: 'auto' }, { name: 'Flyer A5.dc.html', content: flyer }));
      expect(res.statusCode, res.body).toBe(201);
      const { id, report } = res.json() as ImportResponse;
      expect(id).toBe('flyer-atelier');
      expect(report).toMatchObject({
        id: 'flyer-atelier',
        name: 'Flyer atelier',
        format: { id: 'flyer-a5', origin: 'detected', originLabel: 'gabarit reconnu' },
        pages: [
          { id: 'p-recto', name: 'Recto', sectionId: 'recto' },
          { id: 'p-verso', name: 'Verso', sectionId: 'verso' },
        ],
        objects: { total: 8, byType: { rect: 4, text: 3, icon: 1 } },
        unknownIcons: 0,
        qrCodes: [],
      });
      const doc = JSON.parse(await readFile(path.join(dir, id, 'document.json'), 'utf8')) as LayoutDocument;
      expect(doc.format.id).toBe('flyer-a5');
      // Le fichier envoyé était temporaire : sa copie reste la source du document.
      expect(await readFile(path.join(dir, id, 'design.dc.html'), 'utf8')).toBe(flyer);
      expect(doc.source?.path).toMatch(/flyer-atelier\/design\.dc\.html$/);
      expect(existsSync(path.join(dir, id, 'import-report.md'))).toBe(true);

      // Deux imports envoyés ensemble passent l'un après l'autre, chacun sous son propre identifiant.
      const [a, b] = await Promise.all([
        post(app, await multipart({}, { name: 'Flyer_A5.html', content: flyer })),
        post(app, await multipart({ template: 'flyer-a5' }, { name: 'Flyer_A5.html', content: flyer })),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      // Sans nom saisi : le <title> du design.
      expect([a.json().id, b.json().id].sort()).toEqual(['flyer-a5-d-essai', 'flyer-a5-d-essai-2']);
      expect(b.json().report.format.origin).toBe('template');
    });
  }, 180_000);

  it('refuse (400) un fichier qui n’est pas un export Claude Design lisible, sans rien écrire', async () => {
    await withRoutes(async (app, dir) => {
      const flyer = await readFile(FLYER, 'utf8');
      const cases: [Awaited<ReturnType<typeof multipart>>, RegExp][] = [
        [await multipart({}, { name: 'notes.txt', content: 'Bonjour', type: 'text/plain' }), /n'est pas un fichier \.html/],
        [await multipart({}, { name: 'page.html', content: '<html><body><h1>Bonjour</h1></body></html>' }), /page\.html : Ce fichier n'est pas un export Claude Design/],
        [await multipart({}, { name: 'photo.html', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) }), /pas un export Claude Design/],
        [await multipart({ name: 'Sans fichier' }), /Aucun fichier reçu/],
        [await multipart({ template: 'poster-geant' }, { name: 'flyer.html', content: flyer }), /Gabarit inconnu : « poster-geant »/],
        [await multipart({ template: 'affiche-a3' }, { name: 'flyer.html', content: flyer }), /Le gabarit « Affiche A3 » \(affiche-a3\) ne correspond pas au design/],
      ];
      for (const [body, message] of cases) {
        const res = await post(app, body);
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error).toMatch(message);
      }
      const json = await app.inject({ method: 'POST', url: '/api/import/claude-design', payload: { file: flyer } });
      expect(json.statusCode).toBe(415);
      expect(await readdir(dir)).toEqual([]);
    });
  }, 120_000);
});

describe('import depuis la page d’accueil', () => {
  it('importe le flyer par la boîte de dialogue, résume le rapport, puis ouvre le document dans l’éditeur', async () => {
    await withTempDocuments(async (dir) => {
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 900 });
          page.on('pageerror', (error) => console.error(`[page] ${error}`));
          await page.goto(`${url}/`);
          await page.waitForSelector('[data-import-design]', { timeout: 60_000 });
          await page.click('[data-import-design]');
          await page.waitForSelector('[data-import-dialog]');

          const input = await page.$('[data-import-dialog] input[type="file"]');
          await input!.uploadFile(FLYER);
          // Le nom proposé vient du <title> du design.
          await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[name="design-name"]')?.placeholder === "Flyer A5 d'essai");
          await page.type('input[name="design-name"]', 'Flyer depuis l’accueil');
          const options = await page.$$eval('select[name="design-template"] option', (els) => els.map((o) => (o as HTMLOptionElement).value));
          expect(options[0]).toBe('auto');
          expect(options).toContain('flyer-a5');
          await page.click('[data-import-submit]');
          await page.waitForSelector('[data-import-progress]');

          const result = await page.waitForSelector('[data-import-result]', { timeout: 90_000 });
          const id = await result!.evaluate((el) => el.getAttribute('data-import-result'));
          expect(id).toBe('flyer-depuis-l-accueil');
          expect(await page.$eval('[data-import-format]', (el) => el.getAttribute('data-import-format'))).toBe('flyer-a5');
          expect(await page.$eval('[data-import-objects]', (el) => el.textContent)).toContain('8 objets');
          expect(await page.$eval('[data-import-warnings]', (el) => el.getAttribute('data-import-warnings'))).toBe('0');
          expect(existsSync(path.join(dir, 'flyer-depuis-l-accueil', 'document.json'))).toBe(true);

          await Promise.all([page.waitForNavigation(), page.click('[data-import-open]')]);
          expect(new URL(page.url()).pathname).toBe('/doc/flyer-depuis-l-accueil');
          await page.waitForFunction(() => window.__editor?.ready === true, { timeout: 60_000 });
          const opened = await page.evaluate(() => {
            const doc = window.__editor!.getState().doc!;
            return { format: doc.format.id, pages: doc.pages.map((p) => p.id), name: doc.name };
          });
          expect(opened).toEqual({ format: 'flyer-a5', pages: ['p-recto', 'p-verso'], name: 'Flyer depuis l’accueil' });
          expect(await page.$$eval('[data-page-id]', (els) => [...new Set(els.map((e) => e.getAttribute('data-page-id')))])).toEqual(
            expect.arrayContaining(['p-recto', 'p-verso']),
          );
        },
        { documentsDir: dir },
      );
    });
  }, 180_000);
});
