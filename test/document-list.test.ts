// Page d'accueil (« Nouveau document », « Dupliquer ») et documents vierges de chaque gabarit dans le vrai
// éditeur : faces à la bonne taille, plis selon les volets, création d'un objet, export RVB. Dossiers de
// documents temporaires uniquement.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server/app';
import { launchBrowser } from '../server/chrome';
import { exportPdf } from '../server/export';
import { faceSize, foldPositions } from '../src/model/format';
import { TEMPLATES } from '../src/model/templates';
import type { TextObject } from '../src/model/types';
import { PX_PER_MM } from '../src/model/units';
import { validateDocument } from '../src/model/validate';
import { clickAt, openEditor, press, readSavedDocument, saveNow, selection, settle, withApp, withTempDocuments } from './helpers/editor';
import { readPdfPages } from './helpers/pdf';

const waitEditorReady = (page: Page) => page.waitForFunction(() => window.__editor?.ready === true, { timeout: 60_000 });

/** Textes du document ouvert dans l'éditeur, par face. */
const textsOf = (page: Page) =>
  page.evaluate(() => {
    const doc = window.__editor!.getState().doc!;
    return doc.pages.flatMap((p) =>
      p.children
        .map((id) => doc.objects[id])
        .filter((o) => o.type === 'text')
        .map((o) => ({ page: p.id, text: (o as TextObject).paragraphs.map((para) => para.runs.map((r) => r.text).join('')).join('\n') })),
    );
  });

describe('page d’accueil : nouveau document et duplication', () => {
  it('crée un flyer A5 depuis la page d’accueil, y ajoute un texte, le retrouve après rechargement, le duplique et ouvre la copie', async () => {
    await withTempDocuments(async (dir) => {
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          await page.setViewport({ width: 1600, height: 1000 });
          page.on('pageerror', (error) => console.error(`[page] ${error}`));
          await page.goto(url);

          // 1. Aucun document : l'accueil invite à créer ou importer.
          await page.waitForSelector('[data-empty-documents]');
          expect(await page.$eval('[data-empty-documents]', (el) => el.textContent)).toMatch(/Aucun document.*Créez un document.*importez un design/s);

          // 2. Boîte « Nouveau document » : nom au clavier, gabarit en cartes, Créer désactivé tant que le nom manque.
          await page.click('[data-empty-documents] [data-action="new-document"]');
          await page.waitForSelector('[data-new-document-dialog] [data-template-id="flyer-a5"]');
          expect(await page.$$eval('[data-new-document-dialog] [data-template-id]', (els) => els.map((el) => el.getAttribute('data-template-id')))).toEqual(TEMPLATES.map((t) => t.id));
          expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('document-name');
          expect(await page.$eval('[data-action="create-document"]', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
          // Carte du dépliant pli roulé : deux faces schématisées, deux plis chacune.
          expect(await page.$$eval('[data-template-id="depliant-a4-pli-roule"] [data-template-fold]', (els) => els.length)).toBe(4);
          expect(await page.$eval('[data-template-id="flyer-a5"]', (el) => el.textContent)).toContain('148 × 210 mm');
          await page.keyboard.type('Flyer rentrée');
          await page.click('[data-template-id="flyer-a5"]');
          expect(await page.$eval('[data-template-id="flyer-a5"]', (el) => el.getAttribute('aria-pressed'))).toBe('true');
          expect(await page.$$eval('[data-template-list] [aria-pressed="true"]', (els) => els.length)).toBe(1);
          await Promise.all([page.waitForNavigation(), page.click('[data-action="create-document"]')]);
          expect(new URL(page.url()).pathname).toBe('/doc/flyer-rentree');
          await waitEditorReady(page);

          // 3. Deux faces A5 (154 × 216 mm fond perdu compris), sans pli.
          const faces = await page.evaluate(() => {
            const zoom = window.__editor!.getState().zoom;
            return [...document.querySelectorAll<HTMLElement>('[data-workspace-canvas] [data-face-id]')].map((el) => {
              const r = el.getBoundingClientRect();
              return { id: el.dataset.pageId, w: r.width, h: r.height, zoom };
            });
          });
          expect(faces.map((f) => f.id)).toEqual(['p-recto', 'p-verso']);
          for (const f of faces) {
            expect(f.w / (f.zoom * PX_PER_MM)).toBeCloseTo(154, 0);
            expect(f.h / (f.zoom * PX_PER_MM)).toBeCloseTo(216, 0);
          }
          expect(await page.$$('[data-page-guide="fold"]')).toHaveLength(0);
          // Pas de pli roulé : pas d'« Aperçu plié ».
          expect(await page.$('[data-topbar-action="fold-preview"]')).toBeNull();

          // 4. Un texte ajouté à l'outil Texte, puis enregistré.
          await press(page, 't');
          await clickAt(page, 'p-recto', 20, 40);
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-text-editor') === true);
          await page.keyboard.type('Portes ouvertes le 12 octobre');
          await press(page, 'Escape');
          const [textId] = await selection(page);
          expect(await textsOf(page)).toEqual([{ page: 'p-recto', text: 'Portes ouvertes le 12 octobre' }]);
          await saveNow(page);
          const saved = await readSavedDocument(dir, 'flyer-rentree');
          expect(validateDocument(saved).ok).toBe(true);
          expect(saved.objects[textId]).toMatchObject({ type: 'text', layerId: 'contenu', style: { color: { swatch: 'texte-courant' } } });
          expect(saved.editedAt).toBeDefined();

          // 5. Rechargement : rien de perdu.
          await page.reload();
          await waitEditorReady(page);
          expect(await textsOf(page)).toEqual([{ page: 'p-recto', text: 'Portes ouvertes le 12 octobre' }]);

          // 6. Retour à l'accueil, « Dupliquer » : nom proposé entièrement sélectionné, Entrée ouvre la copie.
          await page.goto(url);
          await page.waitForSelector('[data-doc-id="flyer-rentree"] [data-action="duplicate-document"]');
          expect(await page.$('[data-empty-documents]')).toBeNull();
          await page.click('[data-doc-id="flyer-rentree"] [data-action="duplicate-document"]');
          await page.waitForSelector('[data-duplicate-document-dialog] input[name="duplicate-name"]');
          await settle(page);
          const field = await page.evaluate(() => {
            const input = document.querySelector<HTMLInputElement>('input[name="duplicate-name"]')!;
            return { value: input.value, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd };
          });
          expect(field).toEqual({ value: 'Copie de Flyer rentrée', focused: true, start: 0, end: 'Copie de Flyer rentrée'.length });
          await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
          expect(new URL(page.url()).pathname).toBe('/doc/copie-de-flyer-rentree');
          await waitEditorReady(page);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.name)).toBe('Copie de Flyer rentrée');
          expect(await textsOf(page)).toEqual([{ page: 'p-recto', text: 'Portes ouvertes le 12 octobre' }]);
          const copy = await readSavedDocument(dir, 'copie-de-flyer-rentree');
          expect(copy).toMatchObject({ id: 'copie-de-flyer-rentree', format: { id: 'flyer-a5' } });
          expect(copy.editedAt).toBeUndefined();

          // 7. Une autre copie, renommée au clavier (la sélection est remplacée d'une frappe).
          await page.goto(url);
          await page.waitForSelector('[data-doc-id="flyer-rentree"] [data-action="duplicate-document"]');
          await page.click('[data-doc-id="flyer-rentree"] [data-action="duplicate-document"]');
          await page.waitForSelector('[data-duplicate-document-dialog] input[name="duplicate-name"]');
          await settle(page);
          await page.keyboard.type('Flyer Toussaint');
          await Promise.all([page.waitForNavigation(), page.click('[data-action="confirm-duplicate"]')]);
          expect(new URL(page.url()).pathname).toBe('/doc/flyer-toussaint');
          await waitEditorReady(page);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.name)).toBe('Flyer Toussaint');
        },
        { documentsDir: dir },
      );
    });
  });
});

describe('document vierge de chaque gabarit dans l’éditeur', () => {
  let dir: string;
  let server: RunningServer;
  let browser: Browser;

  // Un serveur et un Chrome pour les six gabarits : chacun reste un test à part, avec son propre délai.
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-docs-'));
    server = await startServer({ dev: true, hmr: false, port: 0, documentsDir: dir });
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s : faces, plis, un rectangle ajouté et enregistré, export RVB', async (_name, template) => {
    const res = await fetch(`${server.url}/api/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Essai ${template.name}`, templateId: template.id }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const size = faceSize(template);

    const page = await openEditor(browser, server.url, id);
    try {
      // Faces : une par face du gabarit, à la taille du format fini + fond perdu.
      const faces = await page.evaluate(() => {
        const zoom = window.__editor!.getState().zoom;
        return [...document.querySelectorAll<HTMLElement>('[data-workspace-canvas] [data-face-id]')].map((el) => {
          const r = el.getBoundingClientRect();
          return { faceId: el.dataset.faceId!, pageId: el.dataset.pageId!, w: r.width / (zoom * 96 / 25.4), h: r.height / (zoom * 96 / 25.4) };
        });
      });
      expect(faces.map((f) => f.faceId)).toEqual(template.faces.map((f) => f.id));
      for (const f of faces) {
        expect(Math.abs(f.w - size.w)).toBeLessThan(0.5);
        expect(Math.abs(f.h - size.h)).toBeLessThan(0.5);
      }
      // Repères de plis : entre les volets de chaque face, aux positions du gabarit.
      for (const f of faces) {
        const folds = await page.$$eval(`[data-page-guides="${f.pageId}"] [data-page-guide="fold"]`, (els) => els.map((el) => Number(el.getAttribute('data-at'))));
        expect(folds).toEqual(foldPositions(template, f.faceId));
        expect(await page.$$eval(`[data-page-guides="${f.pageId}"] [data-page-guide="safety"]`, (els) => els.length)).toBe(template.faces.find((x) => x.id === f.faceId)!.panels.length);
      }
      // « Aperçu plié » : pour le seul pli roulé.
      expect(!!(await page.$('[data-topbar-action="fold-preview"]'))).toBe(template.id === 'depliant-a4-pli-roule');

      // Édition : un rectangle posé au milieu de la première face, sur le calque Contenu, dans le bleu de départ.
      await page.click('[data-toolbar] [data-tool="rect"]');
      await clickAt(page, faces[0].pageId, size.w / 2, size.h / 2);
      const [rectId] = await selection(page);
      expect(rectId).toBeDefined();
      await saveNow(page);
      const saved = await readSavedDocument(dir, id);
      expect(validateDocument(saved).ok).toBe(true);
      expect(saved.objects[rectId]).toMatchObject({ type: 'rect', layerId: 'contenu', fill: { swatch: 'bleu' } });
      expect(saved.pages[0].children).toEqual([rectId]);
    } finally {
      await page.close();
    }

    // Export RVB : une page par face, boîtes à la taille du gabarit.
    const result = await exportPdf({ docId: id, preset: 'rvb', documentsDir: dir, baseUrl: server.url });
    expect(result.pages).toBe(template.faces.length);
    const pages = readPdfPages(await readFile(result.file));
    expect(pages).toHaveLength(template.faces.length);
    const pt = (mm: number) => (mm * 72) / 25.4;
    for (const p of pages) {
      const [mx0, my0, mx1, my1] = p.mediaBox!;
      const [tx0, ty0, tx1, ty1] = p.trimBox!;
      expect(mx1 - mx0).toBeCloseTo(pt(size.w), 1);
      expect(my1 - my0).toBeCloseTo(pt(size.h), 1);
      expect(tx1 - tx0).toBeCloseTo(pt(template.trim.w), 1);
      expect(ty1 - ty0).toBeCloseTo(pt(template.trim.h), 1);
    }
  });
});
