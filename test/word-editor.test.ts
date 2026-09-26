// Import Word dans le vrai éditeur (Vite + Chrome), sur des dossiers temporaires : « Placer… » dans le bloc
// sélectionné, curseur chargé sur une zone vide, remplissage automatique sur plusieurs volets (coulée mesurée,
// blocs chaînés, excès signalé), dépôt d'un .docx, une seule étape d'annulation, images dans le panneau
// Images ; puis « Nouveau document depuis Word » depuis l'accueil, jusqu'à l'export RVB.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../server/export';
import { safetyBoxes } from '../src/model/preflight';
import type { FrameObject, LayoutDocument, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { frameZone } from '../src/word/place';
import { makeDocx, longBody, p, pStyle, r, SAMPLE_BODY } from './helpers/docx';
import { clickAt, openEditor, press, readSavedDocument, saveNow, setZoom, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { dropFile } from './helpers/images';
import { renderedLines } from './helpers/lines';
import { minimalDoc } from './fixtures/minimal-doc';

const PNG = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#3a7a4a' } }).png().toBuffer();
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const state = (page: Page) => page.evaluate(() => window.__editor!.getState().doc!) as Promise<LayoutDocument>;

/** Document comparable d'un état à l'autre : sans les métadonnées tenues hors de l'historique (enregistrement, lignes mesurées). */
function comparable(doc: LayoutDocument): LayoutDocument {
  const copy = structuredClone(doc);
  delete copy.editedAt;
  for (const obj of Object.values(copy.objects)) if (obj.type === 'text') delete obj.lines;
  return copy;
}
const textOf = (t: TextObject) => t.paragraphs.map((para) => para.runs.map((r) => r.text).join(''));

/** Ouvre « Placer… », choisit le fichier et les options, valide. */
async function placeViaDialog(page: Page, file: string, options: { autoFill?: boolean } = {}) {
  await page.click('[data-topbar-action="place-word"]');
  const input = await page.waitForSelector('[data-place-word-dialog] input[name="word-file"]');
  await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(file);
  const checked = await page.$eval('[data-place-word-dialog] input[name="word-autofill"]', (el) => (el as HTMLInputElement).checked);
  if (checked !== !!options.autoFill) await page.click('[data-place-word-dialog] input[name="word-autofill"]');
  expect(await page.$eval('[data-place-word-dialog] input[name="word-typography"]', (el) => (el as HTMLInputElement).checked)).toBe(true);
  await page.click('[data-action="place-word-submit"]');
}

async function waitReport(page: Page) {
  await page.waitForSelector('[data-word-report]', { timeout: 30_000 });
  await settle(page);
  return page.$eval('[data-word-report]', (el) => ({
    file: el.getAttribute('data-word-report'),
    paragraphs: Number(el.getAttribute('data-word-paragraphs')),
    frames: Number(el.getAttribute('data-word-frames')),
    overflow: Number(el.getAttribute('data-word-overflow')),
    text: el.textContent ?? '',
  }));
}

async function closeReport(page: Page) {
  await page.click('[data-action="word-report-close"]');
  await page.waitForSelector('[data-word-report]', { hidden: true });
}

/** Position du premier caractère de chaque ligne d'un paragraphe de liste, par rapport au paragraphe (mm). */
function listGeometry(page: Page, objId: string, text: string) {
  return page.evaluate(
    (id, wanted) => {
      const el = document.querySelector(`[data-page-id] [data-obj-id="${id}"]`)!;
      const para = [...el.querySelectorAll<HTMLElement>('[data-list-marker]')].find((p) => p.textContent === wanted)!;
      const zoom = window.__editor!.getState().zoom;
      const k = zoom * (96 / 25.4);
      const pr = para.getBoundingClientRect();
      const range = document.createRange();
      const node = [...para.querySelectorAll('span')].map((s) => s.firstChild).find((n) => n?.nodeType === Node.TEXT_NODE)!;
      range.setStart(node, 0);
      range.setEnd(node, 1);
      const first = range.getBoundingClientRect();
      const before = getComputedStyle(para, '::before');
      return { marker: para.getAttribute('data-list-marker'), content: before.content, markerWidth: parseFloat(before.width) / k, textLeft: (first.left - pr.left) / k };
    },
    objId,
    text,
  );
}

describe('import Word dans l’éditeur', () => {
  it('placer dans le bloc sélectionné, sur une zone vide (curseur chargé), remplir automatiquement, déposer un .docx ; annuler d’un coup ; images non placées', async () => {
    const files = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-word-'));
    try {
      const guide = path.join(files, 'guide.docx');
      await writeFile(guide, makeDocx(SAMPLE_BODY, PNG));
      const long = path.join(files, 'long.docx');
      await writeFile(long, makeDocx(longBody(60)));

      await withTempDocuments(async (dir) => {
        const doc = minimalDoc();
        doc.objects.cadre = { id: 'cadre', type: 'frame', layerId: 'contenu', x: 110, y: 150, w: 60, h: 40, shape: { kind: 'rect' }, placeholder: 'Photo' } as FrameObject;
        doc.pages[1].children.push('cadre');
        await writeDocument(dir, doc);
        const zones = safetyBoxes(doc, 'exterieur').map(frameZone);

        await withApp(
          async ({ browser, url }) => {
            const page = await openEditor(browser, url, 'essai');
            const original = await state(page);

            // ---- 1. Dans le bloc sélectionné : son texte est remplacé.
            await clickAt(page, 'p-ext', 52, 70);
            expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual(['t1']);
            await page.click('[data-topbar-action="place-word"]');
            await page.waitForSelector('[data-place-word-target="t1"]');
            await page.keyboard.press('Escape');
            await placeViaDialog(page, guide);
            let report = await waitReport(page);
            expect(report).toMatchObject({ file: 'guide.docx', frames: 1 });
            expect(report.text).toMatch(/Styles créés.*Titre, Titre 1, Normal, Titre 2, Paragraphe de liste, Citation/);
            expect(report.text).toMatch(/image1\.png — après « Inscriptions sur notre site\. »/);
            expect(report.text).toMatch(/« notre site » : https:\/\/example\.com\/atelier\?a=1&b=2/);
            expect(report.text).toMatch(/Tableau 1 .*mis à plat/);
            expect(report.text).toMatch(/Polices du document Word ignorées \(Arial, Calibri\)/);
            let d = await state(page);
            const t1 = d.objects.t1 as TextObject;
            expect(textOf(t1).slice(0, 2)).toEqual(['Guide de l’atelier', 'Présentation']);
            expect(d.styles.paragraph.filter((s) => s.origin === 'word').map((s) => s.name)).toEqual(['Titre', 'Titre 1', 'Normal', 'Titre 2', 'Paragraphe de liste', 'Citation']);
            expect(d.assets).toHaveLength(1);
            expect(validateDocument(d).ok).toBe(true);
            // Puces et numéros dessinés dans un vrai retrait suspendu : le texte commence au retrait gauche.
            const scies = listGeometry(page, 't1', 'Scies');
            const para = t1.paragraphs.find((x) => x.runs.map((r) => r.text).join('') === 'Scies')!;
            expect(await scies).toMatchObject({ marker: '•', content: '"•"' });
            expect((await scies).textLeft).toBeCloseTo(para.leftIndent!, 0);
            expect((await listGeometry(page, 't1', 'Mesurer')).marker).toBe('a)');
            expect((await listGeometry(page, 't1', 'Nouvelle liste')).marker).toBe('1.');
            // Tabulations du tableau dessinées (pas réduites à une espace), souligné rendu.
            expect(await page.$$eval('[data-page-id] [data-obj-id="t1"] [data-tab]', (els) => els.length)).toBe(4);
            expect(await page.$$eval('[data-page-id] [data-obj-id="t1"] span', (els) => els.some((e) => getComputedStyle(e).textDecorationLine === 'underline' && e.textContent === 'souligné'))).toBe(true);
            // Une seule étape : tout revient (texte, styles, photo).
            expect(await page.evaluate(() => window.__editor!.getState().history.undoLabel)).toBe('Placer un fichier Word');
            await closeReport(page);
            await press(page, 'Control', 'z');
            expect(comparable(await state(page))).toEqual(comparable(original));
            await press(page, 'Control', 'y');
            expect(comparable(await state(page)).objects.t1).toEqual(comparable(d).objects.t1);

            // Image du Word dans le panneau Images, « non placée », puis glissée sur un cadre.
            await page.click('[data-panel-tab="images"]');
            const assetId = d.assets[0].id;
            expect(await page.$eval(`[data-asset-row="${assetId}"] [data-asset-unplaced]`, (el) => el.textContent?.trim())).toBe('Non placée');
            const frameBox = await page.evaluate(() => window.__editor!.objectClientBox('cadre'));
            await page.evaluate(
              (x, y, id) => {
                const dt = new DataTransfer();
                dt.setData('application/x-fluidprint-asset', id);
                const target = document.elementFromPoint(x, y)!;
                for (const kind of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
              },
              Math.round(frameBox.x + frameBox.w / 2),
              Math.round(frameBox.y + frameBox.h / 2),
              assetId,
            );
            await settle(page);
            expect(((await state(page)).objects.cadre as FrameObject).image?.assetId).toBe(assetId);
            await page.waitForSelector(`[data-asset-row="${assetId}"] [data-asset-usage="cadre"]`);

            // Édition du texte importé : l'éditeur dessine les mêmes puces ; un élément ajouté (Entrée) reste dans
            // la liste, avec son retrait, et prend le numéro suivant.
            await setZoom(page, 2, 't1');
            const t1Box = await page.evaluate(() => window.__editor!.objectClientBox('t1'));
            await page.mouse.click(Math.round(t1Box.x + t1Box.w / 2), Math.round(t1Box.y + 8), { count: 2 });
            await page.waitForFunction(() => document.activeElement?.hasAttribute('data-text-editor') === true);
            const editorMarkers = () => page.$$eval('[data-text-editor] [data-list-marker]', (els) => els.map((e) => e.getAttribute('data-list-marker')));
            expect(await editorMarkers()).toEqual(['•', '–', '•', '1.', 'a)', 'b)', '2.', '1.']);
            await page.evaluate(() => {
              const editor = (document.querySelector('[data-text-editor]') as unknown as { editor: { state: { doc: { descendants(f: (n: { type: { name: string }; textContent: string; nodeSize: number }, pos: number) => void): void } }; commands: { setTextSelection(pos: number): void } } }).editor;
              let end = 0;
              editor.state.doc.descendants((node, pos) => {
                if (node.type.name === 'paragraph' && node.textContent === 'Couper') end = pos + node.nodeSize - 1;
              });
              editor.commands.setTextSelection(end);
            });
            await page.keyboard.press('Enter');
            await page.keyboard.type('Poncer');
            await settle(page);
            expect(await editorMarkers()).toEqual(['•', '–', '•', '1.', 'a)', 'b)', '2.', '3.', '1.']);
            await press(page, 'Escape');
            const edited = (await state(page)).objects.t1 as TextObject;
            const couper = edited.paragraphs.find((x) => x.runs.map((r) => r.text).join('') === 'Couper')!;
            const poncer = edited.paragraphs.find((x) => x.runs.map((r) => r.text).join('') === 'Poncer')!;
            expect(poncer).toMatchObject({ list: couper.list, leftIndent: couper.leftIndent, firstLineIndent: couper.firstLineIndent, paragraphStyleId: couper.paragraphStyleId });
            expect(await page.$$eval('[data-page-id] [data-obj-id="t1"] [data-list-marker]', (els) => els.map((e) => e.getAttribute('data-list-marker')))).toContain('3.');
            expect(validateDocument(await state(page)).ok).toBe(true);
            await page.click('[data-zoom-fit]');
            await settle(page);

            // ---- 2. Curseur chargé sur une zone vide du volet central : bloc neuf à la largeur de sa zone de sécurité.
            await clickAt(page, 'p-ext', 150, 190);
            expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual([]);
            await page.click('[data-topbar-action="place-word"]');
            await page.waitForSelector('[data-place-word-target="cursor"]');
            await page.keyboard.press('Escape');
            const short = path.join(files, 'court.docx');
            await writeFile(short, makeDocx([p(r('Horaires'), pStyle('Titre2')), p(r('Ouvert le samedi de 9 h à 12 h.'))].join('')));
            await placeViaDialog(page, short);
            await page.waitForSelector('[data-word-loaded="court.docx"]');
            expect(await page.evaluate(() => window.__editor!.getState().mode)).toEqual({ id: 'place-word' });
            // Échap abandonne, un nouvel essai place.
            await press(page, 'Escape');
            expect(await page.$('[data-word-loaded]')).toBeNull();
            await placeViaDialog(page, short);
            await page.waitForSelector('[data-word-loaded]');
            await clickAt(page, 'p-ext', zones[1].x + 30, 50);
            report = await waitReport(page);
            expect(report).toMatchObject({ frames: 1, overflow: 0, paragraphs: 2 });
            d = await state(page);
            const createdId = d.pages[0].children.at(-1)!;
            const created = d.objects[createdId] as TextObject;
            expect(created).toMatchObject({ type: 'text', x: zones[1].x, w: zones[1].w });
            expect(created.y).toBeCloseTo(50, 0);
            expect(created.y + created.h).toBeCloseTo(zones[1].y + zones[1].h, 5);
            expect(textOf(created)).toEqual(['Horaires', 'Ouvert le samedi de 9 h à 12 h.']);
            expect(d.styles.paragraph.find((s) => s.id === created.paragraphs[0].paragraphStyleId)?.name).toBe('Titre 2');
            await closeReport(page);

            // ---- 3. Remplir automatiquement depuis le volet 1 de l'extérieur : volets suivants puis l'intérieur, excès signalé.
            await clickAt(page, 'p-ext', 150, 30);
            await placeViaDialog(page, long, { autoFill: true });
            await page.waitForSelector('[data-word-loaded="long.docx"]');
            const before = await state(page);
            await clickAt(page, 'p-ext', zones[0].x + 10, zones[0].y + 5);
            report = await waitReport(page);
            d = await state(page);
            const head = (Object.values(d.objects) as TextObject[]).find((o) => o.type === 'text' && o.name === 'Texte · long')!;
            const chain = [head.id];
            for (let next = head.nextId; next; next = (d.objects[next] as TextObject).nextId) chain.push(next);
            // Volets 1 à 3 de l'extérieur, puis 1 à 3 de l'intérieur : tout le document, et du texte en trop.
            expect(chain).toHaveLength(6);
            expect(report).toMatchObject({ frames: 6 });
            expect(report.overflow).toBeGreaterThan(0);
            expect(report.text).toMatch(/Texte en excès.*Le document est plein/s);
            expect(chain.map((id) => d.pages.find((pg) => pg.children.includes(id))!.id)).toEqual(['p-ext', 'p-ext', 'p-ext', 'p-int', 'p-int', 'p-int']);
            const intZones = safetyBoxes(d, 'interieur').map(frameZone);
            expect(d.objects[chain[1]]).toMatchObject({ x: zones[1].x, y: zones[1].y, w: zones[1].w, h: zones[1].h });
            expect(d.objects[chain[5]]).toMatchObject({ x: intZones[2].x, w: intZones[2].w });
            // La coulée à l'écran est celle mesurée au placement : chaque bloc a du texte, seul le dernier déborde.
            for (const id of chain) expect((await renderedLines(page, id)).length).toBeGreaterThan(10);
            await page.waitForSelector(`[data-overset-marker="${chain[5]}"]`);
            const markers = await page.$$eval('[data-overset-marker]', (els) => els.map((e) => e.getAttribute('data-overset-marker')));
            expect(markers.filter((id) => chain.includes(id!))).toEqual([chain[5]]);
            expect(validateDocument(d).ok).toBe(true);
            await closeReport(page);
            // Une seule étape d'annulation pour les six blocs.
            await press(page, 'Control', 'z');
            expect(comparable(await state(page))).toEqual(comparable(before));
            await press(page, 'Control', 'y');
            await settle(page);
            expect(Object.keys((await state(page)).objects)).toEqual(Object.keys(d.objects));
            // Les blocs du remplissage recouvrent celui de l'étape 2 : on les retire avant l'étape suivante.
            await press(page, 'Control', 'z');

            // ---- 4. Glisser-déposer d'un .docx sur le bloc créé à l'étape 2 : son texte est remplacé (dernières options).
            const target = await page.evaluate((id) => window.__editor!.objectClientBox(id), createdId);
            await dropFile(page, { x: target.x + target.w / 2, y: target.y + 20 }, { name: 'court.docx', type: DOCX_TYPE, data: await readFile(guide) });
            report = await waitReport(page);
            expect(report.frames).toBe(1);
            expect(textOf((await state(page)).objects[createdId] as TextObject)[0]).toBe('Guide de l’atelier');
            await closeReport(page);
            // Un .doc déposé : refus clair, rien ne change.
            const count = Object.keys((await state(page)).objects).length;
            await dropFile(page, { x: target.x + target.w / 2, y: target.y + 20 }, { name: 'ancien.doc', type: 'application/msword', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]) });
            await page.waitForSelector('[data-word-message="error"]');
            expect(await page.$eval('[data-word-message="error"]', (el) => el.textContent)).toMatch(/Word 97-2003 \(\.doc\)/);
            expect(await page.$('[data-drop-message="error"]')).toBeNull();
            expect(Object.keys((await state(page)).objects)).toHaveLength(count);

            await saveNow(page);
            const saved = await readSavedDocument(dir, 'essai');
            expect(validateDocument(saved).ok).toBe(true);
            await page.close();
          },
          { documentsDir: dir },
        );
      });
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  });

  it('« Nouveau document depuis Word » depuis l’accueil : gabarit, toutes les faces remplies, rapport, enregistré, export RVB', async () => {
    const files = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-word-'));
    try {
      const file = path.join(files, 'Guide_atelier.docx');
      await writeFile(file, makeDocx(`${SAMPLE_BODY}\n${longBody(40)}`, PNG));
      await withTempDocuments(async (dir) => {
        await withApp(
          async ({ browser, url }) => {
            const page = await browser.newPage();
            await page.setViewport({ width: 1600, height: 1000 });
            page.on('pageerror', (error) => console.error(`[page] ${error}`));
            await page.goto(url);
            await page.waitForSelector('[data-empty-documents] [data-action="new-from-word"]');
            await page.click('[data-empty-documents] [data-action="new-from-word"]');
            const input = await page.waitForSelector('[data-new-from-word-dialog] input[name="word-file"]');
            await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(file);
            await page.waitForSelector('[data-new-from-word-dialog] [data-template-id="depliant-a4-accordeon"]');
            await page.click('[data-new-from-word-dialog] [data-template-id="depliant-a4-accordeon"]');
            expect(await page.$eval('[data-new-from-word-dialog] input[name="document-name"]', (el) => (el as HTMLInputElement).placeholder)).toBe('Guide atelier');
            await Promise.all([page.waitForNavigation(), page.click('[data-action="create-from-word"]')]);
            expect(new URL(page.url()).pathname).toBe('/doc/guide-atelier');
            await page.waitForFunction(() => window.__editor?.ready === true, { timeout: 60_000 });
            const report = await waitReport(page);
            expect(report.file).toBe('Guide_atelier.docx');
            expect(report.frames).toBeGreaterThan(2);

            const d = await state(page);
            expect(d.format.id).toBe('depliant-a4-accordeon');
            const texts = Object.values(d.objects).filter((o): o is TextObject => o.type === 'text');
            const head = texts.find((t) => !texts.some((o) => o.nextId === t.id))!;
            // Le texte commence dans la zone de sécurité du premier volet de la première face.
            expect(d.objects[head.id]).toMatchObject(frameZone(safetyBoxes(d, 'exterieur')[0]));
            expect(d.pages[0].children[0]).toBe(head.id);
            expect(textOf(head)[0]).toBe('Guide de l’atelier');
            expect(texts).toHaveLength(report.frames);
            expect(d.assets).toHaveLength(1);
            expect(d.styles.paragraph.every((s) => s.origin === 'word')).toBe(true);
            expect(await page.evaluate(() => window.__editor!.getState().history.depth)).toBe(1);
            await closeReport(page);

            // `lines` de chaque bloc suit la mesure : attendre qu'ils soient tous connus avant d'enregistrer.
            await page.waitForFunction(() => {
              const doc = window.__editor!.getState().doc!;
              return Object.values(doc.objects).every((o) => o.type !== 'text' || typeof (o as { lines?: number }).lines === 'number');
            });
            await saveNow(page);
            const saved = await readSavedDocument(dir, 'guide-atelier');
            expect(validateDocument(saved).ok).toBe(true);
            expect(Object.keys(saved.objects)).toHaveLength(report.frames);
            await page.close();

            // Export RVB : une page par face, et les mêmes lignes à l'impression qu'à l'écran (puces, tabulations, retraits).
            const result = await exportPdf({ docId: 'guide-atelier', preset: 'rvb', documentsDir: dir, baseUrl: url });
            expect(result.pages).toBe(2);
            expect(result.warnings.filter((w) => w.kind === 'line-break')).toEqual([]);
          },
          { documentsDir: dir },
        );
      });
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  });
});
