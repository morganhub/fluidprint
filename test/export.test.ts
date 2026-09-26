import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { NO_HMR_CACHE_ROOT, startServer, viteServerConfig } from '../server/app';
import { launchBrowser } from '../server/chrome';
import { clientDependencies } from '../server/clientDeps';
import { countPdfPages, exportPdf, exportStamp, lineBreakWarnings, openPrintRoute, watchPage, type ExportResult } from '../server/export';
import { PROJECT_ROOT } from '../server/paths';
import { computeImagePlacement } from '../src/model/frame';
import type { Asset, LayoutDocument, TextObject } from '../src/model/types';
import { mmToPt } from '../src/model/units';
import { minimalDoc } from './fixtures/minimal-doc';
import { withTempDocuments } from './helpers/browser';
import { readPdfPages } from './helpers/pdf';

const PHOTO = { width: 3000, height: 2000 };

/**
 * Document de test à deux faces : un texte dont `lines` est volontairement faux (1 ligne rendue,
 * 3 annoncées), un texte gras juste, et une photo de 3 000 × 2 000 px montrée entière dans un cadre.
 */
async function writeExportDoc(dir: string, options: { id?: string; withPhotoFile?: boolean } = {}): Promise<LayoutDocument> {
  const doc = minimalDoc();
  doc.id = options.id ?? 'essai';
  const t1 = doc.objects.t1 as TextObject;
  t1.name = 'Accroche';
  t1.lines = 3;
  doc.objects.t2 = {
    ...t1,
    id: 't2',
    name: 'Titre intérieur',
    x: 20,
    y: 140,
    w: 120,
    h: 12,
    style: { ...t1.style, fontWeight: 700, fontSize: 12 },
    paragraphs: [{ runs: [{ text: 'Des formations pour tous' }] }],
    lines: 1,
  };
  doc.objects.photo = {
    id: 'photo',
    type: 'frame',
    layerId: 'contenu',
    x: 20,
    y: 20,
    w: 150,
    h: 100,
    shape: { kind: 'rect' },
    image: { assetId: 'photo3000', fit: 'fit', ...computeImagePlacement('fit', 150, 100, PHOTO.width, PHOTO.height) },
  };
  doc.pages[1].children.push('photo', 't2');
  doc.assets.push({ id: 'photo3000', kind: 'image', name: 'photo.jpg', original: 'assets/originals/photo.jpg', ...PHOTO });

  const docDir = path.join(dir, doc.id);
  await mkdir(path.join(docDir, 'assets', 'originals'), { recursive: true });
  if (options.withPhotoFile ?? true) {
    // Dégradé plutôt qu'aplat : une image unie pourrait être simplifiée par Chrome.
    const pixels = Buffer.alloc(PHOTO.width * PHOTO.height * 3);
    for (let y = 0; y < PHOTO.height; y++)
      for (let x = 0; x < PHOTO.width; x++)
        pixels.set([Math.round((x / PHOTO.width) * 255), Math.round((y / PHOTO.height) * 255), (x ^ y) & 0xff], (y * PHOTO.width + x) * 3);
    await sharp(pixels, { raw: { width: PHOTO.width, height: PHOTO.height, channels: 3 } })
      .jpeg({ quality: 90 })
      .toFile(path.join(docDir, 'assets', 'originals', 'photo.jpg'));
  }
  await writeFile(path.join(docDir, 'document.json'), JSON.stringify(doc, null, 2));
  return doc;
}

// ---------------------------------------------------------------- lecture du PDF

const latin1 = (pdf: Buffer) => pdf.toString('latin1');

/** Dictionnaires des objets suivis d'un flux (images, polices incorporées…), sans déborder sur l'objet suivant. */
function streamDicts(pdf: Buffer): string[] {
  return [...latin1(pdf).matchAll(/\d+ \d+ obj\s*<<((?:(?!endobj)[\s\S])*?)>>\s*stream/g)].map((m) => m[1]);
}

function mediaBoxes(pdf: Buffer): number[][] {
  return [...latin1(pdf).matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
}

const PT_TOLERANCE = 0.01;

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------- tests

describe('avertissements de coupure (unitaire)', () => {
  it('nomme le bloc (nom, ou début du texte), sa page, et ignore les blocs sans référence', () => {
    const doc = minimalDoc();
    const t1 = doc.objects.t1 as TextObject;
    t1.lines = 2;
    // Bloc sans nom, dans un groupe : la page vient du groupe, le nom du texte.
    doc.objects.t3 = { ...t1, id: 't3', paragraphs: [{ runs: [{ text: 'Un texte bien plus long que quarante caractères, coupé' }] }], lines: 1 };
    doc.objects.t4 = { ...t1, id: 't4', name: 'Sans référence', lines: undefined };
    doc.objects.g1 = { id: 'g1', type: 'group', layerId: 'contenu', x: 0, y: 0, w: 10, h: 10, children: ['t3'] };
    doc.pages[1].children.push('g1', 't4');
    t1.name = 'Accroche';

    const warnings = lineBreakWarnings(doc, { t1: 1, t3: 2, t4: 5, r1: 9 });
    expect(warnings.map((w) => [w.id, w.expected, w.rendered, w.page])).toEqual([
      ['t1', 2, 1, 'Extérieur'],
      ['t3', 1, 2, 'Intérieur'],
    ]);
    expect(warnings[0].message).toContain('« Accroche »');
    expect(warnings[1].name).toBe('Un texte bien plus long que quarante ca…');
  });

  it('horodatage local AAAA-MM-JJ-HHmm', () => {
    expect(exportStamp(new Date(2026, 8, 5, 7, 3))).toBe('2026-09-05-0703');
  });

  it("le diagnostic d'une route jamais prête montre l'exception de la page, pas le bruit du client Vite", () => {
    const page = new EventEmitter();
    const watcher = watchPage(page as never);
    const consoleError = (text: string) => ({ type: () => 'error', text: () => text });
    page.emit('console', consoleError("WebSocket connection to 'ws://127.0.0.1:24678/?token=x' failed"));
    page.emit('console', consoleError('[vite] failed to connect to websocket.'));
    page.emit('console', consoleError('Failed to send error to Vite server'));
    page.emit('console', consoleError('Failed to send error to Vite server'));
    page.emit('pageerror', new Error('WebSocket closed without opened.'));
    page.emit('console', consoleError('Warning: quelque chose'));
    page.emit('pageerror', new Error('Les arcs (commande A) ne sont pas pris en charge'));
    expect(watcher.cause()).toBe('erreur dans la page');
    const text = watcher.describe();
    expect(text).toMatch(/^ \(erreur dans la page : Les arcs \(commande A\)/);
    expect(text).toContain('console : Warning: quelque chose');
    expect(text).not.toMatch(/vite|ws:\/\/|WebSocket/i);
  });
});

describe('export PDF par Chrome (1.18)', () => {
  let result: ExportResult;
  let pdf: Buffer;
  let relativeFile: string;

  beforeAll(async () => {
    await withTempDocuments(async (dir) => {
      await writeExportDoc(dir);
      result = await exportPdf({ docId: 'essai', preset: 'rvb', documentsDir: dir });
      relativeFile = path.relative(dir, result.file);
      pdf = await readFile(result.file);
    });
  });

  it('écrit documents/<id>/exports/<AAAA-MM-JJ-HHmm>-rvb.pdf', () => {
    expect(relativeFile).toMatch(/^essai[\\/]exports[\\/]\d{4}-\d{2}-\d{2}-\d{4}-rvb\.pdf$/);
    expect(latin1(pdf.subarray(0, 5))).toBe('%PDF-');
  });

  it('a 2 pages de 303 × 216 mm exactement (858,898 × 612,283 pt à 0,01 pt près), TrimBox 297 × 210 mm à 3 mm du bord', () => {
    expect(result.pages).toBe(2);
    expect(countPdfPages(pdf)).toBe(2);
    expect(mediaBoxes(pdf)).toHaveLength(2);
    const bleed = mmToPt(3);
    for (const page of readPdfPages(pdf)) {
      const [x0, y0, x1, y1] = page.mediaBox!;
      expect(Math.abs(x1 - x0 - mmToPt(303))).toBeLessThanOrEqual(PT_TOLERANCE);
      expect(Math.abs(y1 - y0 - mmToPt(216))).toBeLessThanOrEqual(PT_TOLERANCE);
      expect(page.bleedBox).toEqual(page.mediaBox);
      const [t0, u0, t1, u1] = page.trimBox!;
      expect(Math.abs(t1 - t0 - mmToPt(297))).toBeLessThanOrEqual(PT_TOLERANCE);
      expect(Math.abs(u1 - u0 - mmToPt(210))).toBeLessThanOrEqual(PT_TOLERANCE);
      for (const inset of [t0 - x0, u0 - y0, x1 - t1, y1 - u1]) expect(Math.abs(inset - bleed)).toBeLessThanOrEqual(PT_TOLERANCE);
      // Rien n'est découpé à l'intérieur de la face : la découpe de la face couvre toute la MediaBox
      // (Chrome la calait sur 1145 × 816 px, laissant un liseré blanc de 0,05 mm à droite du fond perdu).
      const faceClip = page.clips.at(-1)!;
      expect(faceClip[0]).toBeLessThanOrEqual(x0 + PT_TOLERANCE);
      expect(faceClip[1]).toBeLessThanOrEqual(y0 + PT_TOLERANCE);
      expect(faceClip[2]).toBeGreaterThanOrEqual(x1 - PT_TOLERANCE);
      expect(faceClip[3]).toBeGreaterThanOrEqual(y1 - PT_TOLERANCE);
    }
  });

  it('incorpore les polices Open Sans (TrueType, /FontFile2) et aucune police Type3', () => {
    const text = latin1(pdf);
    const baseFonts = [...new Set([...text.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)].map((m) => m[1]))];
    // Regular (texte courant) et Bold (titre), sous-ensembles préfixés « ABCDEF+ ».
    expect(baseFonts.some((f) => /^[A-Z]{6}\+OpenSans-Regular$/.test(f))).toBe(true);
    expect(baseFonts.some((f) => /^[A-Z]{6}\+OpenSans-Bold$/.test(f))).toBe(true);
    // Aucune police de repli (Arial, Times…) : tout le texte est en Open Sans.
    expect(baseFonts.every((f) => f.includes('OpenSans'))).toBe(true);
    const descriptors = text.match(/\/Type\s*\/FontDescriptor/g)?.length ?? 0;
    expect(descriptors).toBeGreaterThanOrEqual(2);
    expect(text.match(/\/FontFile2/g)?.length).toBe(descriptors);
    expect(text).not.toMatch(/\/Subtype\s*\/Type3/);
    expect(text).not.toMatch(/\/FontFile3|\/FontFile\s/);
  });

  it('garde les 3 000 × 2 000 px de la photo, sans masque de transparence', () => {
    const images = streamDicts(pdf)
      .filter((d) => /\/Subtype\s*\/Image/.test(d))
      .map((d) => ({ w: Number(/\/Width\s+(\d+)/.exec(d)?.[1]), h: Number(/\/Height\s+(\d+)/.exec(d)?.[1]) }));
    expect(images).toContainEqual({ w: PHOTO.width, h: PHOTO.height });
    expect(latin1(pdf)).not.toContain('/SMask');
  });

  it('signale le bloc dont les lignes se coupent autrement, et lui seul', () => {
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings;
    expect(warning).toMatchObject({ kind: 'line-break', id: 't1', name: 'Accroche', page: 'Extérieur', expected: 3, rendered: 1 });
    expect(warning.message).toMatch(/Accroche.*3 lignes attendues, 1 rendue/);
  });
});

describe('polices du PDF (C3)', () => {
  it('gras et italique : les faces italiques d’Open Sans sont incorporées, sans police Type 3 ni police de repli', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      doc.id = 'italique';
      const t1 = doc.objects.t1 as TextObject;
      t1.style.fontSize = 12;
      // Sans ces faces, Chrome dessinait un faux italique en contours, incorporé en police Type 3.
      t1.paragraphs = [
        {
          runs: [
            { text: 'Semi ', fontWeight: 600, italic: true },
            { text: 'Gras ', fontWeight: 700, italic: true },
            { text: 'Extra ', fontWeight: 800, italic: true },
            { text: 'normal', italic: true },
          ],
        },
      ];
      await mkdir(path.join(dir, doc.id), { recursive: true });
      await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc));
      const { file } = await exportPdf({ docId: doc.id, preset: 'rvb', documentsDir: dir });
      const text = latin1(await readFile(file));
      const baseFonts = new Set([...text.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, '')));
      for (const face of ['OpenSans-SemiBoldItalic', 'OpenSans-BoldItalic', 'OpenSans-ExtraBoldItalic', 'OpenSans-Italic']) expect(baseFonts).toContain(face);
      expect([...baseFonts].every((f) => f.startsWith('OpenSans-'))).toBe(true);
      expect(text).not.toMatch(/\/Subtype\s*\/Type3/);
    });
  });
});

describe('Vite sans rechargement à chaud (C5)', () => {
  it('dépendances figées : tout paquet importé par src/ est pré-bundlé, sans découverte en cours de route', async () => {
    const config = viteServerConfig({ hmr: false });
    expect(config.optimizeDeps?.noDiscovery).toBe(true);
    const include = config.optimizeDeps?.include ?? [];
    for (const dep of ['react', 'react-dom/client', 'react/jsx-dev-runtime', '@tiptap/react', '@tiptap/pm/state', 'zustand/vanilla', 'qrcode', 'lucide-react']) expect(include).toContain(dep);
    // Chaque spécificateur de paquet écrit dans src/ y est (lecture indépendante, simple et large).
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(path.join(PROJECT_ROOT, 'src'), { recursive: true })).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    for (const f of files) {
      const code = await readFile(path.join(PROJECT_ROOT, 'src', f), 'utf8');
      for (const m of code.matchAll(/^import\s+(?!type\s)[^'"]*?from\s+'([^'.][^'?]*)'/gm)) expect(include, `${f} : ${m[1]}`).toContain(m[1]);
    }
    expect(clientDependencies()).toEqual(include);
    // Un cache par serveur : aucun autre processus (export en ligne de commande, autre test) n'y écrit.
    expect(path.dirname(config.cacheDir!)).toBe(NO_HMR_CACHE_ROOT);
    expect(viteServerConfig({ hmr: false }).cacheDir).not.toBe(config.cacheDir);
    // npm run dev garde la découverte : lui sait recharger la page, dans son propre cache.
    const dev = viteServerConfig({ hmr: true });
    expect(dev.optimizeDeps).toBeUndefined();
    expect(path.dirname(dev.cacheDir!)).not.toBe(NO_HMR_CACHE_ROOT);
    // Le dossier du serveur disparaît à son arrêt.
    const mine = async () => (await readdir(NO_HMR_CACHE_ROOT).catch(() => [] as string[])).filter((n) => n.startsWith(`${process.pid}-`));
    const before = await mine();
    const server = await startServer({ dev: true, hmr: false, port: 0 });
    await fetch(`${server.url}/print/inconnu`);
    expect((await mine()).length).toBe(before.length + 1);
    await server.close();
    expect(await mine()).toEqual(before);
  });

  it('un 504 « Outdated Optimize Dep » recharge la route d’impression une fois ; s’il persiste, l’erreur le dit', async () => {
    let served = 0;
    let persistent = false;
    const fake = http.createServer((req, res) => {
      if (req.url?.startsWith('/dep.js')) {
        served++;
        // Première demande (ou toutes, si persistent) : ce que répond Vite après une réoptimisation.
        if (persistent || served === 1) {
          res.writeHead(504, 'Outdated Optimize Dep');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('window.__ready = true;');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>x</title><script type="module" src="/dep.js?v=1"></script>');
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const { port } = fake.address() as AddressInfo;
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const started = Date.now();
      expect(await openPrintRoute(page, `http://127.0.0.1:${port}`, { id: 'essai' }, 20_000)).toEqual({ reloads: 1 });
      // Rechargé dès le 504, sans attendre le délai.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(served).toBe(2);

      persistent = true;
      const again = await browser.newPage();
      await expect(openPrintRoute(again, `http://127.0.0.1:${port}`, { id: 'essai' }, 20_000)).rejects.toThrow(/Outdated Optimize Dep.*même après un rechargement/);
    } finally {
      await browser.close();
      fake.closeAllConnections();
      await new Promise((resolve) => fake.close(resolve));
    }
  });
});

/** Filets horizontaux magenta de 0,25 pt et 1 pt, à des hauteurs qui tombent entre les pixels CSS. */
const LINE_WIDTHS_PT = [0.25, 1];
const LINE_YS_MM = Array.from({ length: 12 }, (_, i) => 23 + i * 3.1);

describe('filets et aplats au mm près dans le PDF', () => {
  it('chaque filet garde son épaisseur exacte quelle que soit sa hauteur (Chrome la calait sur le pixel CSS : 0,75 ou 1,5 pt)', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      doc.swatches.push({ id: 'magenta', name: 'Magenta', rgb: '#ff00ff' });
      LINE_YS_MM.forEach((y, i) =>
        LINE_WIDTHS_PT.forEach((width, k) => {
          const id = `filet-${i}-${k}`;
          doc.objects[id] = { id, type: 'line', layerId: 'contenu', x: 20 + 80 * k, y, w: 60, h: 0, stroke: { color: { swatch: 'magenta' }, width } };
          doc.pages[1].children.push(id);
        }),
      );
      doc.objects.aplat = { id: 'aplat', type: 'rect', layerId: 'contenu', x: 200.3, y: 30.17, w: 50.05, h: 20.33, fill: { swatch: 'magenta' } };
      doc.pages[1].children.push('aplat');
      await mkdir(path.join(dir, doc.id), { recursive: true });
      await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc, null, 2));

      const { file } = await exportPdf({ docId: doc.id, preset: 'rvb', documentsDir: dir });
      const page = readPdfPages(await readFile(file))[1];
      const top = page.mediaBox![3];
      const magenta = page.fills.filter((f) => f.color.join(' ') === '1 0 1');
      const fillAt = (x: number, y: number) =>
        magenta.find((f) => Math.abs(f.box[0] - mmToPt(x)) < 0.5 && Math.abs(top - (f.box[1] + f.box[3]) / 2 - mmToPt(y)) < 1);

      LINE_YS_MM.forEach((y, i) =>
        LINE_WIDTHS_PT.forEach((width, k) => {
          const fill = fillAt(20 + 80 * k, y);
          expect(fill, `filet ${width} pt à y = ${y} mm`).toBeDefined();
          const [x0, y0, x1, y1] = fill!.box;
          expect(Math.abs(y1 - y0 - width), `épaisseur du filet ${width} pt à y = ${y} mm`).toBeLessThanOrEqual(0.05);
          expect(Math.abs(x1 - x0 - mmToPt(60)), `longueur du filet ${i}`).toBeLessThanOrEqual(0.05);
          // Centré sur sa hauteur nominale, à 0,05 pt près.
          expect(Math.abs(top - (y0 + y1) / 2 - mmToPt(y))).toBeLessThanOrEqual(0.05);
        }),
      );
      const aplat = magenta.find((f) => f.box[3] - f.box[1] > 20)!;
      expect(aplat).toBeDefined();
      const [x0, y0, x1, y1] = aplat.box;
      for (const [got, want] of [
        [x0, mmToPt(200.3)],
        [x1 - x0, mmToPt(50.05)],
        [top - y1, mmToPt(30.17)],
        [y1 - y0, mmToPt(20.33)],
      ]) {
        expect(Math.abs(got - want)).toBeLessThanOrEqual(0.05);
      }
    });
  });
});

describe("route d'export et erreurs", () => {
  it('POST /api/doc/:id/export?preset=rvb renvoie le même résultat, sans écraser un export précédent', async () => {
    await withTempDocuments(async (dir) => {
      await writeExportDoc(dir);
      await writeExportDoc(dir, { id: 'manque', withPhotoFile: false });
      const server = await startServer({ dev: true, hmr: false, port: 0, documentsDir: dir });
      try {
        const post = (url: string) => fetch(`${server.url}${url}`, { method: 'POST' });

        const res = await post('/api/doc/essai/export?preset=rvb');
        const body = (await res.json()) as ExportResult;
        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(body.pages).toBe(2);
        expect(path.relative(dir, body.file)).toMatch(/^essai[\\/]exports[\\/]\d{4}-\d{2}-\d{2}-\d{4}-rvb(-\d+)?\.pdf$/);
        expect(await exists(body.file)).toBe(true);
        expect(body.warnings.map((w) => (w.kind === 'line-break' ? w.id : w.kind))).toEqual(['t1']);

        // Deux exports dans la même minute : le second reçoit un suffixe, le premier reste intact.
        const second = (await (await post('/api/doc/essai/export?preset=rvb')).json()) as ExportResult;
        expect(second.file).not.toBe(body.file);
        expect(await exists(body.file)).toBe(true);
        expect(await exists(second.file)).toBe(true);

        const unknownPreset = await post('/api/doc/essai/export?preset=cmjn');
        expect(unknownPreset.status).toBe(400);
        expect((await unknownPreset.json()).error).toMatch(/Préréglage d'export inconnu.*cmjn/);

        expect((await post('/api/doc/inconnu/export?preset=rvb')).status).toBe(404);
        expect((await post('/api/doc/..%2F..%2Fevil/export?preset=rvb')).status).toBe(400);

        // Photo référencée mais absente du disque : l'export refuse et la nomme.
        const missing = await post('/api/doc/manque/export?preset=rvb');
        expect(missing.status).toBe(422);
        expect((await missing.json()).error).toMatch(/Photo introuvable : photo3000/);
        expect(await exists(path.join(dir, 'manque', 'exports'))).toBe(false);
      } finally {
        await server.close();
      }
    });
  });

  it('exporte une photo envoyée en TIFF (copie PNG pleine résolution), et dit « illisible » plutôt que « introuvable » pour un fichier que Chrome ne décode pas', async () => {
    await withTempDocuments(async (dir) => {
      const doc = await writeExportDoc(dir, { withPhotoFile: false });
      const server = await startServer({ dev: true, hmr: false, port: 0, documentsDir: dir });
      try {
        const tiff = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 120, b: 200 } } }).tiff().toBuffer();
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(tiff)], { type: 'image/tiff' }), 'photo.tif');
        const uploaded = await fetch(`${server.url}/api/assets/essai`, { method: 'POST', body: form });
        expect(uploaded.status).toBe(201);
        const asset = (await uploaded.json()) as Asset;
        expect(asset.original).toBe('assets/originals/photo.tif');
        expect(asset.print).toBe('assets/print/photo.png');

        const putDoc = (body: LayoutDocument) =>
          fetch(`${server.url}/api/doc/essai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        doc.assets = [asset];
        const frame = doc.objects.photo as Extract<LayoutDocument['objects'][string], { type: 'frame' }>;
        frame.image = { assetId: asset.id, fit: 'fit', ...computeImagePlacement('fit', 150, 100, 1200, 800) };
        expect((await putDoc(doc)).status).toBe(200);

        const res = await fetch(`${server.url}/api/doc/essai/export?preset=rvb`, { method: 'POST' });
        const body = (await res.json()) as ExportResult & { error?: string };
        expect(res.status, body.error).toBe(200);
        const images = streamDicts(await readFile(body.file))
          .filter((d) => /\/Subtype\s*\/Image/.test(d))
          .map((d) => ({ w: Number(/\/Width\s+(\d+)/.exec(d)?.[1]), h: Number(/\/Height\s+(\d+)/.exec(d)?.[1]) }));
        expect(images).toContainEqual({ w: 1200, h: 800 });

        // Sans sa copie d'impression, le TIFF est présent mais indécodable : le message le dit.
        const { print: _print, ...withoutCopy } = asset;
        doc.assets = [withoutCopy];
        expect((await putDoc(doc)).status).toBe(200);
        const unreadable = await fetch(`${server.url}/api/doc/essai/export?preset=rvb`, { method: 'POST' });
        expect(unreadable.status).toBe(422);
        expect((await unreadable.json()).error).toMatch(/Photo illisible par le navigateur : img-\w+ \(assets\/originals\/photo\.tif\)/);
      } finally {
        await server.close();
      }
    });
  });

  it("échoue clairement si la route d'impression n'est pas prête dans le délai", async () => {
    await withTempDocuments(async (dir) => {
      await writeExportDoc(dir);
      // Faux serveur : la page ne pose jamais __ready et sa photo ne répond jamais.
      const fake = http.createServer((req, res) => {
        if (req.url?.includes('lente.jpg')) return;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>x</title><img src="/lente.jpg">');
      });
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
      const { port } = fake.address() as AddressInfo;
      try {
        await expect(exportPdf({ docId: 'essai', preset: 'rvb', documentsDir: dir, baseUrl: `http://127.0.0.1:${port}`, readyTimeoutMs: 2000 })).rejects.toThrow(
          /pas prête après 2 s.*lente\.jpg/,
        );
        expect(await exists(path.join(dir, 'essai', 'exports'))).toBe(false);
      } finally {
        fake.closeAllConnections();
        await new Promise((resolve) => fake.close(resolve));
      }
    });
  });

  it('échoue en une ligne si le serveur de la route d’impression est injoignable', async () => {
    await withTempDocuments(async (dir) => {
      await writeExportDoc(dir);
      // Port libéré juste avant : plus personne n'y écoute.
      const probe = http.createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const { port } = probe.address() as AddressInfo;
      await new Promise((resolve) => probe.close(resolve));
      await expect(exportPdf({ docId: 'essai', preset: 'rvb', documentsDir: dir, baseUrl: `http://127.0.0.1:${port}` })).rejects.toThrow(
        /Route d'impression injoignable \(http:\/\/127\.0\.0\.1:\d+\/print\/essai\)/,
      );
    });
  });
});

/** Lance la ligne de commande d'export dans un processus à part. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', path.join(PROJECT_ROOT, 'scripts', 'export.ts'), ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    proc.once('error', reject);
    proc.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('npm run export (ligne de commande)', () => {
  it('affiche le fichier, les pages et les avertissements, code 0 ; code 1 en cas d’erreur', async () => {
    await withTempDocuments(async (dir) => {
      await writeExportDoc(dir);

      const ok = await runCli(['--doc', 'essai', '--preset', 'rvb', '--documents', dir]);
      expect(ok.code, ok.stderr).toBe(0);
      const file = /PDF écrit : (.+\.pdf)/.exec(ok.stdout)?.[1];
      expect(file && (await exists(file.trim()))).toBe(true);
      expect(ok.stdout).toContain('Pages : 2');
      expect(ok.stderr).toMatch(/Coupure différente : « Accroche »/);

      const missing = await runCli(['--doc', 'inconnu', '--documents', dir]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('Document introuvable : inconnu');

      const usage = await runCli(['--preset', 'rvb']);
      expect(usage.code).toBe(1);
      expect(usage.stderr).toContain('--doc');
    });
  });
});
