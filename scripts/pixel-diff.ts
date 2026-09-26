// npm run diff:import -- --doc <id> [--design <fichier>] [--threshold <pourcentage>] [--documents <dossier>]
//
// Contrôle au pixel de l'import : chaque face du design d'origine et du document importé est rendue à
// 300 ppi dans le même Chrome, puis comparée avec pixelmatch. Le design d'origine est la copie gardée
// par l'import dans documents/<id>/design.dc.html, ou le fichier donné par --design.
// Les cadres et les QR codes sont retirés du pourcentage de la face, mais chacun a son propre contrôle :
//  - un cadre sans photo (la goutte, les vagues) a son propre taux d'écart, soumis au même seuil que la face ;
//  - un QR, régénéré depuis son adresse, n'a pas les mêmes pixels que le design : on décode les deux
//    rendus et on exige la même adresse ;
//  - seul un cadre qui porte une photo (absente du design) n'est pas comparable du tout.
// Dans l'image des écarts, tout écart qui compte est en rouge ; l'orange ne marque que les zones non comparables.
// Les bords des aplats du design sont calés sur le pixel CSS par Chrome, ceux de l'import sont exacts :
// un bord décalé de moins de 2 px (0,17 mm) n'est pas compté (voir EDGE_SHIFT_PX).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Browser, Page } from 'puppeteer-core';
import { startServer } from '../server/app';
import { launchBrowser } from '../server/chrome';
import { documentFile } from '../server/documents';
import { DEFAULT_DOCUMENTS_DIR, documentDir, PROJECT_ROOT } from '../server/paths';
import { faceSize } from '../src/model/format';
import { mmToPx } from '../src/model/units';
import type { DocObject, LayoutDocument, TextObject } from '../src/model/types';
import { openDesignPage } from './import/designPage';
import { DESIGN_COPY_NAME } from './import/importer';
import { decodeQrImage } from './import/qr';

const PPI = 300;
const DEVICE_SCALE = PPI / 96;
const PX_PER_MM = PPI / 25.4;
/**
 * Seuil de couleur de pixelmatch (0-1) : au-dessous, deux pixels sont jugés identiques. À 0,1, un écart
 * de luminance d'environ 26/255 passait inaperçu : des fonds pâles repeints en blanc donnaient 0 %.
 * À 0,02, l'import fidèle n'ajoute que quelques pixels.
 */
export const COLOR_THRESHOLD = 0.02;
/** Marge autour d'une zone exclue, en pixels : l'anticrénelage du bord déborde de la boîte. */
const EXCLUDE_MARGIN_PX = 2;
/**
 * Décalage de bord toléré, en pixels à 300 ppi. Chrome cale les aplats CSS du design (<div> à fond de
 * couleur) sur le pixel CSS entier, soit jusqu'à un demi-pixel CSS (1,56 px à 300 ppi) de leur position
 * exacte ; l'import dessine ses aplats et ses filets en SVG à leur position exacte (pour qu'ils le soient
 * dans le PDF). Un pixel n'est donc compté que si sa couleur ne se retrouve pas à 2 px près dans l'autre
 * rendu : un bord calé autrement ne compte pas, une couleur fausse ou un objet déplacé de plus de
 * 0,17 mm, si.
 */
const EDGE_SHIFT_PX = 2;
const READY_TIMEOUT_MS = 60_000;

const RED: [number, number, number] = [255, 0, 0];
const ORANGE: [number, number, number] = [255, 150, 0];
/** Bord décalé de moins de EDGE_SHIFT_PX : visible dans l'image des écarts, jamais compté. */
const SHIFTED: [number, number, number] = [255, 200, 220];
const EXCLUDED_TINT: [number, number, number] = [70, 130, 230];

export interface ExcludedZone {
  id: string;
  type: 'frame' | 'qr';
  name?: string;
  /** Boîte en pixels de l'image (300 ppi), marge comprise. */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Cadre portant une photo : absente du design, sa zone n'est pas comparable du tout. */
  hasPhoto?: boolean;
  /** Cadre sans photo : son rendu est déterministe, on donne son propre taux d'écart. */
  diffPercent?: number;
  /** QR : adresse lue dans chaque rendu (null : code illisible). */
  urls?: { design: string | null; imported: string | null };
  /** Contrôle propre de la zone (cadre sans photo, QR) ; absent pour un cadre photo. */
  passed?: boolean;
}

export interface FaceDiff {
  faceId: string;
  pageId: string;
  width: number;
  height: number;
  /** Pixels différents hors cadres et QR (ceux-ci ont leur propre contrôle, dans `excluded`). */
  diffPixels: number;
  comparedPixels: number;
  diffPercent: number;
  excluded: ExcludedZone[];
  passed: boolean;
}

export interface PixelDiffSummary {
  docId: string;
  ppi: number;
  colorThreshold: number;
  /** Décalage de bord toléré, en pixels (voir EDGE_SHIFT_PX). */
  edgeShiftPx: number;
  maxPercent: number;
  createdAt: string;
  faces: FaceDiff[];
  /** Blocs texte dont le nombre de lignes rendu diffère de celui mesuré à l'import. */
  lineMismatches: { id: string; expected: number; rendered: number }[];
  passed: boolean;
}

export interface PixelDiffOptions {
  docId: string;
  documentsDir?: string;
  /** Design à comparer ; défaut : la copie gardée à l'import (documents/<id>/design.dc.html), sinon `source.path`. */
  designFile?: string;
  /** Pourcentage maximal de pixels différents par face. */
  maxPercent?: number;
  /** Dossier des images et de summary.json ; défaut documents/<id>/import-report. */
  outDir?: string;
  log?: (message: string) => void;
}

function flatten(doc: LayoutDocument, ids: string[]): DocObject[] {
  return ids.flatMap((id) => {
    const obj = doc.objects[id];
    if (!obj) return [];
    return obj.type === 'group' ? [obj, ...flatten(doc, obj.children)] : [obj];
  });
}

/** Boîte englobante en pixels, rotation comprise. */
function pixelBox(obj: DocObject, width: number, height: number): ExcludedZone['box'] {
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const a = ((obj.rotation ?? 0) * Math.PI) / 180;
  const hw = (Math.abs(obj.w * Math.cos(a)) + Math.abs(obj.h * Math.sin(a))) / 2;
  const hh = (Math.abs(obj.w * Math.sin(a)) + Math.abs(obj.h * Math.cos(a))) / 2;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return {
    x0: clamp(Math.floor((cx - hw) * PX_PER_MM) - EXCLUDE_MARGIN_PX, width),
    y0: clamp(Math.floor((cy - hh) * PX_PER_MM) - EXCLUDE_MARGIN_PX, height),
    x1: clamp(Math.ceil((cx + hw) * PX_PER_MM) + EXCLUDE_MARGIN_PX, width),
    y1: clamp(Math.ceil((cy + hh) * PX_PER_MM) + EXCLUDE_MARGIN_PX, height),
  };
}

/**
 * Capture d'une face seule, collée au coin de la page : les autres faces sont masquées, ainsi les deux
 * rendus commencent sur le même pixel quel que soit l'empilement des faces dans chaque page.
 */
async function captureFace(page: Page, selector: string, faceId: string, clip: { width: number; height: number }): Promise<Uint8Array> {
  // Chrome ne peint plus un onglet d'arrière-plan : sans cela, la capture attend indéfiniment.
  await page.bringToFront();
  const styleHandle = await page.addStyleTag({
    content: `${selector}:not([data-face-id="${faceId}"]){display:none !important}`,
  });
  try {
    const found = await page.$(`${selector}[data-face-id="${faceId}"]`);
    if (!found) throw new Error(`Face « ${faceId} » introuvable (${selector})`);
    const rect = await found.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY };
    });
    if (Math.abs(rect.x) > 0.01 || Math.abs(rect.y) > 0.01) {
      throw new Error(`Face « ${faceId} » décalée de (${rect.x}, ${rect.y}) px dans ${selector} : capture non comparable`);
    }
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...clip }, captureBeyondViewport: false });
  } finally {
    await styleHandle.evaluate((el) => el.remove());
  }
}

function decode(buffer: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(buffer));
}

// Écart de couleur perceptuel (YIQ) de pixelmatch, sur des captures opaques : même échelle que COLOR_THRESHOLD.
const MAX_YIQ_DELTA = 35215;

function colorDelta(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  const dr = a[i] - b[j];
  const dg = a[i + 1] - b[j + 1];
  const db = a[i + 2] - b[j + 2];
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const iq = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

/** La couleur du pixel (x, y) de `a` se retrouve-t-elle dans `b` à EDGE_SHIFT_PX près ? */
function foundNearby(a: PNG, b: PNG, x: number, y: number, maxDelta: number): boolean {
  const i = (y * a.width + x) * 4;
  for (let dy = -EDGE_SHIFT_PX; dy <= EDGE_SHIFT_PX; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= b.height) continue;
    for (let dx = -EDGE_SHIFT_PX; dx <= EDGE_SHIFT_PX; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= b.width) continue;
      if (colorDelta(a.data, i, b.data, (yy * b.width + xx) * 4) <= maxDelta) return true;
    }
  }
  return false;
}

/** Une zone dont les écarts de pixels comptent (cadre sans photo) ; sinon ils ne font que se voir. */
const isStrict = (z: ExcludedZone) => z.type === 'frame' && !z.hasPhoto;

/**
 * Compare deux captures ; la troisième image montre les écarts (rouge : comptés, orange : zone non
 * comparable, rose pâle : bord décalé de moins de EDGE_SHIFT_PX, non compté).
 */
function compare(design: PNG, imported: PNG, zones: ExcludedZone[]): { diff: PNG; diffPixels: number; comparedPixels: number } {
  if (design.width !== imported.width || design.height !== imported.height) {
    throw new Error(`Captures de tailles différentes : ${design.width}×${design.height} et ${imported.width}×${imported.height}`);
  }
  const { width, height } = design;
  const diff = new PNG({ width, height });
  pixelmatch(design.data, imported.data, diff.data, width, height, {
    threshold: COLOR_THRESHOLD,
    includeAA: false,
    alpha: 0.15,
    diffColor: RED,
    aaColor: [255, 235, 170],
  });

  // 0 : hors zone ; 1 : zone non comparable au pixel (photo, QR) ; 2 : zone au contrôle propre (cadre sans photo).
  const excluded = new Uint8Array(width * height);
  for (const z of zones) {
    const level = isStrict(z) ? 2 : 1;
    for (let y = z.box.y0; y < z.box.y1; y++) {
      for (let i = y * width + z.box.x0; i < y * width + z.box.x1; i++) excluded[i] = Math.max(excluded[i], level);
    }
  }

  let diffPixels = 0;
  let comparedPixels = 0;
  const zoneCounts = zones.map(() => 0);
  const d = diff.data;
  const maxDelta = MAX_YIQ_DELTA * COLOR_THRESHOLD * COLOR_THRESHOLD;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    let isDiff = d[o] === RED[0] && d[o + 1] === RED[1] && d[o + 2] === RED[2];
    if (isDiff) {
      const x = i % width;
      const y = (i - x) / width;
      // Dans les deux sens : un aplat disparu laisse une couleur que l'autre rendu n'a nulle part à côté.
      if (foundNearby(design, imported, x, y, maxDelta) && foundNearby(imported, design, x, y, maxDelta)) {
        [d[o], d[o + 1], d[o + 2]] = SHIFTED;
        isDiff = false;
      }
    }
    if (!excluded[i]) {
      comparedPixels++;
      if (isDiff) diffPixels++;
      continue;
    }
    if (isDiff) {
      if (excluded[i] === 1) [d[o], d[o + 1], d[o + 2]] = ORANGE;
      const x = i % width;
      const y = (i - x) / width;
      zones.forEach((z, k) => {
        if (x >= z.box.x0 && x < z.box.x1 && y >= z.box.y0 && y < z.box.y1) zoneCounts[k]++;
      });
    } else {
      for (let c = 0; c < 3; c++) d[o + c] = Math.round(d[o + c] * 0.75 + EXCLUDED_TINT[c] * 0.25);
    }
  }
  zones.forEach((z, k) => {
    const area = (z.box.x1 - z.box.x0) * (z.box.y1 - z.box.y0);
    if (z.type === 'frame' && !z.hasPhoto && area > 0) z.diffPercent = round((100 * zoneCounts[k]) / area);
  });
  return { diff, diffPixels, comparedPixels };
}

const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

function crop(png: PNG, box: ExcludedZone['box']): { data: Uint8Array; width: number; height: number } {
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((box.y0 + y) * png.width + box.x0) * 4;
    data.set(png.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { data, width, height };
}

/** Un QR faux compte comme un écart : ses pixels orange passent au rouge. */
function markZoneRed(diff: PNG, box: ExcludedZone['box']): void {
  const d = diff.data;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const o = (y * diff.width + x) * 4;
      if (d[o] === ORANGE[0] && d[o + 1] === ORANGE[1] && d[o + 2] === ORANGE[2]) [d[o], d[o + 1], d[o + 2]] = RED;
    }
  }
}

/** Fenêtre de capture : une face entière (303 × 216 mm → 1146 × 817 px CSS pour un dépliant A4). */
function faceViewport(doc: LayoutDocument): { width: number; height: number; deviceScaleFactor: number } {
  const size = faceSize(doc.format);
  return { width: Math.ceil(mmToPx(size.w)), height: Math.ceil(mmToPx(size.h)), deviceScaleFactor: DEVICE_SCALE };
}

/**
 * Design d'origine du document : celui qu'on impose, sinon la copie gardée à l'import dans le dossier du
 * document (elle suit le document si on le copie ailleurs), sinon `source.path` (relatif au projet ou absolu).
 */
export function designFileOf(doc: LayoutDocument, docDir: string, override?: string): string {
  if (override) {
    const file = path.resolve(override);
    if (!existsSync(file)) throw new Error(`Design introuvable : ${file}`);
    return file;
  }
  const copy = path.join(docDir, DESIGN_COPY_NAME);
  if (existsSync(copy)) return copy;
  const source = doc.source?.path;
  if (source) {
    const file = path.isAbsolute(source) ? source : path.join(PROJECT_ROOT, source);
    if (existsSync(file)) return file;
  }
  throw new Error(`Design d'origine introuvable pour « ${doc.id} » : ni ${copy}, ni source.path (${source ?? 'absent'}). Indiquez-le avec --design.`);
}

async function openPrintRoute(browser: Browser, url: string, docId: string, doc: LayoutDocument): Promise<{ page: Page; lineCounts: Record<string, number> }> {
  const page = await browser.newPage();
  await page.setViewport(faceViewport(doc));
  // Couleurs d'origine du design (sourceRgb) : le nuancier CMJN simule l'impression, le design est en RVB.
  await page.goto(`${url}/print/${encodeURIComponent(docId)}?colors=source`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: READY_TIMEOUT_MS });
  const { errors, lineCounts } = await page.evaluate(() => ({ errors: window.__printErrors ?? [], lineCounts: window.__lineCounts ?? {} }));
  if (errors.length) throw new Error(`Route d'impression en erreur : ${errors.join(' ; ')}`);
  return { page, lineCounts };
}

export async function runPixelDiff(options: PixelDiffOptions): Promise<PixelDiffSummary> {
  const docId = options.docId;
  if (!docId) throw new Error('Document à contrôler manquant (--doc)');
  const documentsDir = path.resolve(options.documentsDir ?? DEFAULT_DOCUMENTS_DIR);
  const maxPercent = options.maxPercent ?? 0.5;
  const log = options.log ?? (() => {});
  const outDir = options.outDir ?? path.join(documentDir(documentsDir, docId), 'import-report');
  const doc = JSON.parse(await readFile(documentFile(documentsDir, docId), 'utf8')) as LayoutDocument;
  // Résolu avant de lancer quoi que ce soit : un design introuvable doit l'être tout de suite.
  const designFile = designFileOf(doc, documentDir(documentsDir, docId), options.designFile);
  const size = faceSize(doc.format);
  // Même rectangle de capture pour les deux rendus, calé sur un nombre entier de pixels.
  const clip = {
    width: Math.ceil(size.w * PX_PER_MM) / DEVICE_SCALE,
    height: Math.ceil(size.h * PX_PER_MM) / DEVICE_SCALE,
  };

  await mkdir(outDir, { recursive: true });
  const server = await startServer({ dev: true, hmr: false, port: 0, documentsDir });
  const faces: FaceDiff[] = [];
  let lineMismatches: PixelDiffSummary['lineMismatches'] = [];
  // Chrome est lancé dans le try : s'il ne démarre pas, le serveur est quand même fermé et le processus se termine.
  try {
    const browser = await launchBrowser();
    try {
      // Sections rangées sur les faces du document comme à l'import (par identifiant, sinon dans l'ordre).
      const { page: designPage } = await openDesignPage(browser, { designFile, format: doc.format, deviceScaleFactor: DEVICE_SCALE });
      await designPage.setViewport(faceViewport(doc));
      const { page: printPage, lineCounts } = await openPrintRoute(browser, server.url, docId, doc);

      lineMismatches = Object.values(doc.objects)
        .filter((o): o is TextObject => o.type === 'text' && o.lines !== undefined && lineCounts[o.id] !== undefined)
        .filter((o) => lineCounts[o.id] !== o.lines)
        .map((o) => ({ id: o.id, expected: o.lines!, rendered: lineCounts[o.id] }));

      for (const docPage of doc.pages) {
        const faceId = docPage.faceId;
        log(`Face ${faceId} : capture à ${PPI} ppi…`);
        const designPng = decode(await captureFace(designPage, '.design-face', faceId, clip));
        const importPng = decode(await captureFace(printPage, 'div.print-face', faceId, clip));
        const { width, height } = designPng;

        const zones: ExcludedZone[] = flatten(doc, docPage.children)
          .filter((o) => o.type === 'frame' || o.type === 'qr')
          .filter((o) => !o.hidden && doc.layers.find((l) => l.id === o.layerId)?.printable !== false)
          .map((o) => ({
            id: o.id,
            type: o.type as 'frame' | 'qr',
            ...(o.name ? { name: o.name } : {}),
            box: pixelBox(o, width, height),
            ...(o.type === 'frame' && o.image ? { hasPhoto: true } : {}),
          }));

        const { diff, diffPixels, comparedPixels } = compare(designPng, importPng, zones);
        const diffPercent = round((100 * diffPixels) / Math.max(1, comparedPixels));
        for (const z of zones) {
          if (z.type === 'frame' && !z.hasPhoto) z.passed = (z.diffPercent ?? 0) <= maxPercent;
          if (z.type === 'qr') {
            // Le QR est régénéré : ses modules peuvent différer du design pour la même adresse. On juge donc
            // l'adresse, lue dans chaque rendu ; un code illisible échoue.
            z.urls = { design: decodeQrImage(crop(designPng, z.box)), imported: decodeQrImage(crop(importPng, z.box)) };
            z.passed = z.urls.design !== null && z.urls.design === z.urls.imported;
            if (!z.passed) markZoneRed(diff, z.box);
          }
        }
        const passed = diffPercent <= maxPercent && zones.every((z) => z.passed !== false);

        await writeFile(path.join(outDir, `${faceId}-design.png`), PNG.sync.write(designPng));
        await writeFile(path.join(outDir, `${faceId}-import.png`), PNG.sync.write(importPng));
        await writeFile(path.join(outDir, `${faceId}-diff.png`), PNG.sync.write(diff));
        faces.push({ faceId, pageId: docPage.id, width, height, diffPixels, comparedPixels, diffPercent, excluded: zones, passed });
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }

  const summary: PixelDiffSummary = {
    docId,
    ppi: PPI,
    colorThreshold: COLOR_THRESHOLD,
    edgeShiftPx: EDGE_SHIFT_PX,
    maxPercent,
    createdAt: new Date().toISOString(),
    faces,
    lineMismatches,
    passed: faces.every((f) => f.passed),
  };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

const USAGE = `Usage : npm run diff:import -- --doc <id> [--design <fichier>] [--threshold <pourcentage>] [--documents <dossier>]
  --doc        document à comparer à son design (obligatoire)
  --design     design d'origine, défaut : la copie gardée à l'import (documents/<id>/${DESIGN_COPY_NAME})
  --threshold  pourcentage maximal de pixels différents par face, défaut 0.5
  --documents  dossier des documents, défaut <projet>/documents`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        doc: { type: 'string' },
        design: { type: 'string' },
        threshold: { type: 'string', default: '0.5' },
        documents: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.doc) {
    console.error(`Option --doc manquante.\n\n${USAGE}`);
    return 2;
  }
  const maxPercent = Number(values.threshold);
  if (!Number.isFinite(maxPercent) || maxPercent < 0) {
    console.error(`Seuil invalide : « ${values.threshold} » (pourcentage attendu, par exemple 0.5)\n\n${USAGE}`);
    return 2;
  }
  try {
    const summary = await runPixelDiff({
      docId: values.doc,
      documentsDir: values.documents ? path.resolve(values.documents) : undefined,
      designFile: values.design,
      maxPercent,
      log: (m) => console.log(m),
    });
    for (const face of summary.faces) {
      const faceOk = face.diffPercent <= maxPercent;
      console.log(
        `${face.faceId} : ${face.diffPercent.toFixed(3)} % de pixels différents hors cadres et QR (${face.diffPixels} sur ${face.comparedPixels}) ${faceOk ? 'OK' : `AU-DESSUS DE ${maxPercent} %`}`,
      );
      for (const z of face.excluded) {
        if (z.diffPercent !== undefined) {
          console.log(`  cadre vide ${z.name ?? z.id} : ${z.diffPercent.toFixed(3)} % de sa boîte ${z.passed ? 'OK' : `AU-DESSUS DE ${maxPercent} %`}`);
        }
        if (z.urls) {
          const { design, imported } = z.urls;
          const verdict = z.passed ? 'même adresse, OK' : design === null ? 'ILLISIBLE dans le design' : imported === null ? "ILLISIBLE dans l'import" : 'ADRESSE DIFFÉRENTE';
          console.log(`  QR ${z.name ?? z.id} : ${verdict}${z.passed ? '' : ` (design « ${design ?? '-'} », import « ${imported ?? '-'} »)`}`);
        }
      }
    }
    for (const m of summary.lineMismatches) console.warn(`Texte ${m.id} : ${m.rendered} ligne(s) rendue(s) au lieu de ${m.expected}`);
    console.log(`Rapport : ${path.join(documentDir(path.resolve(values.documents ?? DEFAULT_DOCUMENTS_DIR), values.doc), 'import-report')}`);
    return summary.passed ? 0 : 1;
  } catch (error) {
    console.error(`Échec du contrôle au pixel : ${(error as Error).stack ?? error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
