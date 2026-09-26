import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TimeoutError, type HTTPRequest, type Page as BrowserPage } from 'puppeteer-core';
import { FONT_POSTSCRIPT_NAMES } from '../src/model/fontCoverage';
import { faceSize, foldPositions } from '../src/model/format';
import { framePpi, placeholderFrames, PPI_ERROR, type PlaceholderFrame } from '../src/model/images';
import {
  hiddenPrintableLayers,
  pendingConfirmations,
  preflightRefusal,
  printedObjects,
  runPreflight,
  SMALL_TEXT_MAX_INKS,
  SMALL_TEXT_PT,
  type PreflightConfirmation,
  type PreflightConfirmations,
  type PreflightMeasures,
} from '../src/model/preflight';
import { printColorTable, type Cmyk, type PrintColor } from '../src/model/swatches';
import type { DocumentFormat, LayoutDocument, Page, TextObject } from '../src/model/types';
import { mmToPt, mmToPx } from '../src/model/units';
import { startServer, type RunningServer } from './app';
import { launchBrowser } from './chrome';
import { loadPresets, PRESETS_FILE, registerColorRoutes, rgbToCmyk, runPrintPython, type PrintPreset } from './color';
import { assetPath, HttpError, readDocument, writeFileAtomic } from './documents';
import { DEFAULT_DOCUMENTS_DIR, documentDir } from './paths';
import { setPageBoxes, type PdfBox } from './pdf';
import type { RouteContext } from './routes';

// Préréglages d'export (tâche 4.4, décision P2) : print/presets.json. « rvb » : le PDF tel que Chrome le
// produit ; « imprimeur » et « traits-de-coupe » : CMJN exact et PDF/X-4 par le post-traitement Python
// (print/pdf_cmyk.py) ; « email » : PDF RVB léger et aperçus PNG (print/pdf_light.py).
export const EXPORT_PRESETS: readonly string[] = Object.keys(loadPresets().presets);
export type ExportPreset = string;

export const DEFAULT_READY_TIMEOUT_MS = 60_000;
// Une face chargée de photos pleine résolution peut dépasser les 30 s par défaut de Puppeteer.
const PDF_TIMEOUT_MS = 120_000;

/** Étape en cours d'un export, pour la barre de progression de la boîte de dialogue. */
export interface ExportProgress {
  step: 'lecture' | 'rendu' | 'pdf' | 'couleurs' | 'allegement' | 'png' | 'ecriture';
  label: string;
  /** 0-1. */
  progress: number;
}

export interface ExportOptions {
  docId: string;
  preset: ExportPreset;
  documentsDir?: string;
  /** Serveur de l'éditeur déjà démarré ; sinon un serveur temporaire est lancé le temps de l'export. */
  baseUrl?: string;
  /** Attente maximale de `window.__ready` sur la route d'impression. */
  readyTimeoutMs?: number;
  /** Fichier de préréglages (tests) ; défaut print/presets.json. */
  presetsFile?: string;
  /** L'utilisateur a confirmé exporter malgré des photos sous 150 ppi (décision I2). */
  confirmLowResolution?: boolean;
  /** L'utilisateur a confirmé exporter sans les objets des calques imprimables masqués (audit B3). */
  confirmHiddenLayers?: boolean;
  onProgress?: (progress: ExportProgress) => void;
}

/** Bloc texte dont le nombre de lignes rendu diffère de celui de l'éditeur : une coupure a changé. */
export interface LineBreakWarning {
  kind: 'line-break';
  id: string;
  /** Nom de l'objet, ou à défaut le début de son texte. */
  name: string;
  /** Nom de la page qui porte le bloc. */
  page?: string;
  expected: number;
  rendered: number;
  message: string;
}

/** Le PDF n'a pas une page par face : une face a débordé sur la suivante, ou manque. */
export interface PageCountWarning {
  kind: 'page-count';
  expected: number;
  rendered: number;
  message: string;
}

/** Photos provisoires (tirées du PDF Canva) encore en place : l'export imprimeur les refuse. */
export interface PlaceholderImageWarning {
  kind: 'placeholder-image';
  frames: PlaceholderFrame[];
  message: string;
}

/** Couleurs de l'export imprimeur : couleur hors nuancier, nuance sans encres, deux nuances au même RVB. */
export interface ColorWarning {
  kind: 'unknown-color' | 'swatch-without-cmyk' | 'color-conflict';
  message: string;
}

/**
 * Remarque du contrôle PDF/X (police de repli…), poids du PDF, photos sous 150 ppi, erreur rouge du
 * contrôle en amont reprise par un préréglage qui ne bloque pas, calque imprimable masqué, photo CMJN.
 */
export interface PrintNoteWarning {
  kind: 'print-check' | 'file-size' | 'low-resolution' | 'preflight' | 'hidden-layers' | 'cmyk-original';
  message: string;
}

export type ExportWarning = LineBreakWarning | PageCountWarning | PlaceholderImageWarning | ColorWarning | PrintNoteWarning;

/** Résultat du contrôle PDF/X maison (print/check_pdfx.py). */
export interface PrintCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    version?: string;
    outputCondition?: string;
    maxInkVector?: number;
    maxInkImages?: number;
    /** Couleurs des textes de moins de 9 pt ; `exception` : encres d'une nuance d'accent admise. */
    smallText?: { color: string; inks: number | null; exception?: boolean; count: number }[];
    smallTextCount?: number;
    /** Noms PostScript des polices (hors Type 3) et nombre de polices Type 3. */
    fonts?: string[];
    type3Fonts?: number;
    pages?: { trimMm: [number, number]; bleedMm: number[]; mediaPt: number[] }[];
    images?: { name: string; width: number; height: number; colorSpace: string; maxInk?: number }[];
  };
}

export interface ExportResult {
  /** Le PDF. */
  file: string;
  pages: number;
  warnings: ExportWarning[];
  preset: string;
  /** Poids du PDF, en octets. */
  bytes: number;
  /** Aperçus PNG de chaque face (préréglage e-mail). */
  pngs: string[];
  /** Profil de sortie (identifiant) et norme, pour le résumé. */
  profile: string | null;
  standard: string | null;
  check?: PrintCheck;
  /** Compte rendu du post-traitement (photos converties, couleurs inconnues…). */
  report?: Record<string, unknown>;
}

export function isExportPreset(value: string, presetsFile = PRESETS_FILE): boolean {
  return Object.hasOwn(loadPresets(presetsFile).presets, value);
}

export function parsePreset(value: string | undefined, presetsFile = PRESETS_FILE): ExportPreset {
  const preset = value ?? 'rvb';
  if (!isExportPreset(preset, presetsFile)) {
    throw new HttpError(400, `Préréglage d'export inconnu : « ${preset} » (disponible : ${Object.keys(loadPresets(presetsFile).presets).join(', ')})`);
  }
  return preset;
}

// ---------------------------------------------------------------- avertissements de coupure

/** Page de chaque objet, enfants de groupes compris. */
function pagesByObject(doc: LayoutDocument): Map<string, Page> {
  const map = new Map<string, Page>();
  const visit = (id: string, page: Page) => {
    if (map.has(id)) return;
    map.set(id, page);
    const obj = doc.objects[id];
    if (obj?.type === 'group') obj.children.forEach((child) => visit(child, page));
  };
  for (const page of doc.pages) page.children.forEach((id) => visit(id, page));
  return map;
}

// Les blocs importés n'ont pas de nom : le début du texte suffit à retrouver le bloc sur la page.
function textLabel(obj: TextObject): string {
  if (obj.name) return obj.name;
  const text = obj.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 40 ? `${text.slice(0, 39)}…` : text || obj.id;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Compare les lignes rendues par la route d'impression au nombre retenu par l'éditeur (`lines`). */
export function lineBreakWarnings(doc: LayoutDocument, lineCounts: Record<string, number>): LineBreakWarning[] {
  const pages = pagesByObject(doc);
  const warnings: LineBreakWarning[] = [];
  for (const [id, rendered] of Object.entries(lineCounts)) {
    const obj = doc.objects[id];
    // Sans nombre de référence (bloc jamais mesuré), il n'y a rien à comparer.
    if (obj?.type !== 'text' || typeof obj.lines !== 'number' || obj.lines === rendered) continue;
    const name = textLabel(obj);
    const page = pages.get(id)?.name;
    warnings.push({
      kind: 'line-break',
      id,
      name,
      page,
      expected: obj.lines,
      rendered,
      message: `Coupure différente : « ${name} » (${id}${page ? `, ${page}` : ''}) : ${plural(obj.lines, 'ligne')} attendue${obj.lines > 1 ? 's' : ''}, ${rendered} rendue${rendered > 1 ? 's' : ''}`,
    });
  }
  return warnings;
}

const placeholderList = (frames: PlaceholderFrame[]) => frames.map((f) => `« ${f.name} »${f.page ? ` (${f.page})` : ''}`).join(', ');

/** Un avertissement qui nomme chaque cadre portant une photo provisoire (décision I3). */
export function placeholderWarnings(doc: LayoutDocument): PlaceholderImageWarning[] {
  const frames = placeholderFrames(doc);
  if (!frames.length) return [];
  return [
    {
      kind: 'placeholder-image',
      frames,
      message: `${frames.length} ${frames.length > 1 ? 'photos provisoires' : 'photo provisoire'} à remplacer par l'original avant l'export imprimeur : ${placeholderList(frames)}`,
    },
  ];
}

/**
 * Refus de l'export imprimeur : photo provisoire (nommée), puis toute erreur rouge du contrôle en amont
 * (4.8) ; une photo sous 150 ppi ou un calque imprimable masqué ne bloquent plus une fois confirmés.
 * null si l'export peut partir. `details.confirm` : les confirmations qui lèveraient le refus (aucune
 * erreur rouge restante), que la boîte d'export propose d'un clic.
 */
export function printRefusal(doc: LayoutDocument, preset: PrintPreset, options: PreflightConfirmations = {}, measures: PreflightMeasures = {}): HttpError | null {
  if (!preset.refusePlaceholders) return null;
  const frames = placeholderFrames(doc);
  if (frames.length) {
    return new HttpError(
      422,
      `Export imprimeur refusé : ${frames.length} ${frames.length > 1 ? 'cadres portent une photo provisoire' : 'cadre porte une photo provisoire'} (tirée du PDF Canva), à remplacer par l'original : ${placeholderList(frames)}`,
      { reason: 'placeholder-image', frames },
    );
  }
  const report = runPreflight(doc, measures, { maxInk: preset.maxInk, unmeasuredText: measures.texts ? 'box' : 'skip' });
  const refusal = preflightRefusal(report, options);
  if (!refusal) return null;
  const pending: PreflightConfirmation[] = report.blocking.length ? [] : pendingConfirmations(report, options);
  return new HttpError(422, `Export imprimeur refusé. ${refusal}`, {
    // « low-resolution » gardé tel quel : c'est le cas historique (décision I2).
    reason: report.blocking.length ? 'preflight' : pending.length === 1 ? pending[0] : 'confirm',
    confirm: pending,
    issues: [...report.blocking, ...report.toConfirm].map((i) => ({ rule: i.rule, objectId: i.objectId, message: i.message, confirmable: !!i.confirmable, confirm: i.confirm })),
  });
}

/** Calques imprimables masqués : rappelés dans les avertissements de tout export (audit B3). */
function hiddenLayerWarnings(doc: LayoutDocument): PrintNoteWarning[] {
  return hiddenPrintableLayers(doc).map((l) => ({
    kind: 'hidden-layers',
    message: `Calque imprimable « ${l.name} » masqué : ${plural(l.objects, 'objet')} absent${l.objects > 1 ? 's' : ''} du PDF`,
  }));
}

/**
 * Préréglages qui ne bloquent pas (RVB, e-mail) : leurs PDF partaient sans dire qu'un texte débordait sur
 * son voisin (audit B9). Les erreurs rouges du contrôle en amont, mesurées sur le texte imprimé, y sont
 * reprises en avertissements (photos provisoires et sous 150 ppi : déjà signalées à part).
 */
export function preflightWarnings(doc: LayoutDocument, preset: PrintPreset, measures: PreflightMeasures): PrintNoteWarning[] {
  if (preset.refusePlaceholders) return [];
  const report = runPreflight(doc, measures, { maxInk: preset.maxInk, unmeasuredText: measures.texts ? 'box' : 'skip' });
  return report.issues
    .filter((i) => i.severity === 'error' && i.rule !== 'placeholder' && i.rule !== 'ppi-error')
    .map((i) => ({ kind: 'preflight', message: `Contrôle en amont : ${i.message}` }));
}

/** Photos sous 150 ppi (avertissement des préréglages qui ne refusent pas). */
function lowResolutionWarnings(doc: LayoutDocument): PrintNoteWarning[] {
  const low = Object.values(doc.objects)
    .map((o) => framePpi(doc, o))
    .filter((f): f is NonNullable<typeof f> => !!f && f.ppi < PPI_ERROR);
  if (!low.length) return [];
  const list = low.map((f) => `« ${f.frame.name ?? f.frame.id} » (${Math.round(f.ppi)} ppi)`).join(', ');
  return [{ kind: 'low-resolution', message: `${plural(low.length, 'photo')} sous ${PPI_ERROR} ppi, floue${low.length > 1 ? 's' : ''} à l'impression : ${list}` }];
}

// ---------------------------------------------------------------- fichier de sortie

/** Nombre de pages d'un PDF produit par Chrome (Skia n'utilise pas de flux d'objets : les dictionnaires sont lisibles). */
export function countPdfPages(pdf: Uint8Array): number {
  return Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

/** Horodatage local AAAA-MM-JJ-HHmm : c'est l'heure que l'on lit sur sa montre qui aide à retrouver un export. */
export function exportStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

const reservedFiles = new Set<string>();

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

// Un export antérieur n'est jamais écrasé : il a pu partir chez l'imprimeur, ou rester ouvert dans une
// visionneuse qui le verrouille sous Windows. Deux exports dans la même minute reçoivent un suffixe.
async function reserveExportFile(dir: string, stamp: string, preset: ExportPreset): Promise<string> {
  for (let seq = 1; ; seq++) {
    const file = path.join(dir, `${stamp}-${preset}${seq > 1 ? `-${seq}` : ''}.pdf`);
    if (reservedFiles.has(file) || (await exists(file))) continue;
    reservedFiles.add(file);
    return file;
  }
}

// ---------------------------------------------------------------- taille des pages

/**
 * Page demandée à Chrome, en px CSS entiers : un peu plus grande que la face. Chrome arrondit la taille
 * de page qu'on lui donne (303 × 216 mm devenaient 303,02 × 215,90 mm, 0,1 mm de fond perdu en moins
 * en bas) ; on lui laisse donc de la marge, puis `pageBoxes` ramène la page à la taille exacte.
 * Le pixel de plus couvre la découpe de la face, qui déborde d'un demi-pixel (PageView).
 */
export function chromePageSizePx(format: DocumentFormat): { w: number; h: number } {
  const size = faceSize(format);
  return { w: Math.ceil(mmToPx(size.w)) + 1, h: Math.ceil(mmToPx(size.h)) + 1 };
}

/**
 * Boîtes exactes d'une page, calculées depuis le gabarit et non depuis la page de Chrome : MediaBox et
 * BleedBox = la face fond perdu compris, TrimBox = le format fini, en retrait du fond perdu. Chrome
 * ancre le contenu en haut à gauche de sa page : la face occupe le haut de la MediaBox qu'il a écrite.
 */
export function pageBoxes(format: DocumentFormat, chromeMediaBox: PdfBox): { media: PdfBox; bleed: PdfBox; trim: PdfBox } {
  const size = faceSize(format);
  const [w, h, bleed] = [mmToPt(size.w), mmToPt(size.h), mmToPt(format.bleed)];
  const [x0, , x1, top] = chromeMediaBox;
  // 0,01 pt de tolérance : Chrome écrit ses dimensions arrondies à 5 chiffres.
  if (x1 - x0 < w - 0.01 || top - chromeMediaBox[1] < h - 0.01) {
    throw new Error(`Page de Chrome plus petite que la face : [${chromeMediaBox.join(' ')}] pour ${w.toFixed(3)} × ${h.toFixed(3)} pt`);
  }
  const media: PdfBox = [x0, top - h, x0 + w, top];
  return { media, bleed: media, trim: [media[0] + bleed, media[1] + bleed, media[2] - bleed, media[3] - bleed] };
}

// ---------------------------------------------------------------- suivi de la route d'impression

// Messages du client Vite injecté en mode dev : sans rechargement à chaud, il tente quand même sa
// WebSocket et le signale cinq fois. Ils prenaient toutes les places du diagnostic et cachaient la vraie erreur.
const VITE_CLIENT_NOISE = [/\[vite\]/, /\bws:\/\//, /Failed to send error to Vite server/, /WebSocket closed without opened/];
const isViteNoise = (text: string) => VITE_CLIENT_NOISE.some((re) => re.test(text));

/** Suivi de la page : en cas de délai dépassé, on sait ce qui n'est jamais arrivé ou ce qui a planté. */
export function watchPage(page: Pick<BrowserPage, 'on'>) {
  const pending = new Map<HTTPRequest, string>();
  const pageErrors: string[] = [];
  const otherProblems: string[] = [];
  page.on('request', (req) => pending.set(req, req.url()));
  page.on('requestfinished', (req) => pending.delete(req));
  page.on('requestfailed', (req) => {
    pending.delete(req);
    otherProblems.push(`requête échouée : ${req.url()} (${req.failure()?.errorText ?? 'raison inconnue'})`);
  });
  page.on('pageerror', (error) => {
    const message = (error as Error).message ?? String(error);
    if (!isViteNoise(message)) pageErrors.push(`erreur dans la page : ${message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isViteNoise(msg.text())) otherProblems.push(`console : ${msg.text()}`);
  });
  return {
    /** Cause probable d'une route jamais prête. */
    cause(): string {
      if (pending.size) return 'polices ou photos toujours en chargement';
      if (pageErrors.length) return 'erreur dans la page';
      return 'rendu jamais terminé';
    },
    describe(): string {
      const parts = [];
      // Les exceptions de la page d'abord : ce sont elles qui expliquent un rendu bloqué.
      if (pageErrors.length) parts.push(pageErrors.slice(0, 3).join(' ; '));
      if (pending.size) parts.push(`requêtes sans réponse : ${[...pending.values()].slice(0, 5).join(', ')}`);
      if (otherProblems.length) parts.push(otherProblems.slice(0, 5).join(' ; '));
      return parts.length ? ` (${parts.join(' ; ')})` : '';
    },
  };
}

// ---------------------------------------------------------------- couleurs d'impression

/**
 * Table RVB → CMJN pour print/pdf_cmyk.py : les nuances CMJN (et leurs teintes) ; une nuance sans encres
 * est convertie par le profil (colorimétrie relative, point noir compensé) et signalée.
 */
export async function buildColorTable(doc: LayoutDocument, preset: PrintPreset): Promise<{ table: PrintColor[]; warnings: ColorWarning[] }> {
  const { table, missing } = printColorTable(doc);
  const warnings: ColorWarning[] = [];
  if (missing.length) {
    const converted = await rgbToCmyk(
      missing.map((s) => s.rgb),
      preset.profile ?? 'FOGRA39',
      { intent: preset.vectorIntent ?? 'relative', bpc: preset.blackPointCompensation ?? true, maxInk: preset.maxInk },
    );
    missing.forEach((swatch, i) => table.push({ rgb: swatch.rgb, cmyk: converted[i] as Cmyk, name: swatch.name, swatch: swatch.id, tint: 1 }));
    warnings.push({
      kind: 'swatch-without-cmyk',
      message: `${plural(missing.length, 'nuance')} sans valeurs CMJN, convertie${missing.length > 1 ? 's' : ''} par le profil ${preset.profile} : ${missing.map((s, i) => `« ${s.name} » → C${converted[i][0]} M${converted[i][1]} J${converted[i][2]} N${converted[i][3]}`).join(', ')}`,
    });
  }
  return { table, warnings };
}

interface CmykReport {
  unknownColors: { rgb: string; cmyk: number[]; count: number; where: string[] }[];
  conflicts: string[];
  images: { name: string; width: number; height: number; from: string; to: string; maxInk?: number; resampledFrom?: [number, number]; ppi?: number }[];
  cmykOriginals?: { name: string; asset?: string; matched: number; error?: string }[];
  errors: string[];
  check?: PrintCheck;
  [key: string]: unknown;
}

function cmykWarnings(report: CmykReport): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  for (const u of report.unknownColors) {
    warnings.push({
      kind: 'unknown-color',
      message: `Couleur hors nuancier ${u.rgb} (${u.count} fois, ${u.where.join(', ')}) convertie par le profil : C${u.cmyk[0]} M${u.cmyk[1]} J${u.cmyk[2]} N${u.cmyk[3]}`,
    });
  }
  for (const c of report.conflicts) warnings.push({ kind: 'color-conflict', message: `Deux nuances au même RVB : ${c}` });
  for (const o of report.cmykOriginals ?? []) {
    // Faute de retrouver l'image dans le PDF, c'est le RVB de Chrome qui a été reconverti : on le dit.
    if (!o.matched) {
      warnings.push({
        kind: 'cmyk-original',
        message: `Photo CMJN « ${o.name} » non retrouvée dans le PDF${o.error ? ` (${o.error})` : ''} : reconvertie depuis le RVB affiché par Chrome, sa séparation d'origine est perdue`,
      });
    }
  }
  const resampled = report.images.filter((i) => i.resampledFrom);
  if (resampled.length) {
    warnings.push({
      kind: 'print-check',
      message: `${plural(resampled.length, 'photo')} réduite${resampled.length > 1 ? 's' : ''} à la résolution d'impression : ${resampled.map((i) => `${i.resampledFrom![0]} × ${i.resampledFrom![1]} px (${i.ppi} ppi) → ${i.width} × ${i.height} px`).join(', ')}`,
    });
  }
  for (const w of report.check?.warnings ?? []) warnings.push({ kind: 'print-check', message: w });
  return warnings;
}

/**
 * Encres des nuances d'accent (et de leurs teintes) : les seules couleurs admises en petit texte au-delà
 * de deux encres par le contrôle PDF/X, comme pour le contrôle en amont (`Swatch.smallTextException`).
 */
export function smallTextExceptions(doc: LayoutDocument, table: PrintColor[]): Cmyk[] {
  const accents = new Set(doc.swatches.filter((s) => s.smallTextException).map((s) => s.id));
  return table.filter((c) => accents.has(c.swatch)).map((c) => c.cmyk);
}

/** Originaux des photos imprimées : print/pdf_cmyk.py remet dans le PDF les pixels de ceux qui sont en CMJN. */
function printedOriginals(doc: LayoutDocument, documentsDir: string): { assetId: string; name: string; path: string }[] {
  const ids = new Set(printedObjects(doc).flatMap(({ obj }) => (obj.type === 'frame' && obj.image ? [obj.image.assetId] : [])));
  return doc.assets.filter((a) => ids.has(a.id)).map((a) => ({ assetId: a.id, name: a.name, path: assetPath(documentsDir, doc.id, a.original) }));
}

// ---------------------------------------------------------------- export

/** Réponse de Vite quand une dépendance pré-bundlée a été réoptimisée entre-temps. */
const OUTDATED_DEP = /Outdated Optimize Dep/i;

/**
 * Ouvre la route d'impression et attend `window.__ready`. Un serveur Vite sans rechargement à chaud ne peut
 * pas recharger la page quand il réoptimise ses dépendances : la page reçoit des 504 « Outdated Optimize
 * Dep » et reste bloquée jusqu'au délai (audit C5). Dans ce cas, et une seule fois, la page est rechargée.
 */
export async function openPrintRoute(page: BrowserPage, baseUrl: string, doc: Pick<LayoutDocument, 'id'>, readyTimeoutMs: number): Promise<{ reloads: number }> {
  const watcher = watchPage(page);
  const printUrl = `${baseUrl.replace(/\/$/, '')}/print/${encodeURIComponent(doc.id)}`;
  const deadline = Date.now() + readyTimeoutMs;
  let outdated = false;
  let signalOutdated: () => void = () => undefined;
  page.on('response', (res) => {
    if (res.status() === 504 && OUTDATED_DEP.test(res.statusText())) {
      outdated = true;
      signalOutdated();
    }
  });
  const notReady = () =>
    new HttpError(504, `Route d'impression pas prête après ${Math.round(readyTimeoutMs / 1000)} s : ${watcher.cause()}${watcher.describe()}`);
  const load = async (reload: boolean) => {
    try {
      if (reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
      else await page.goto(printUrl, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
    } catch (error) {
      if (error instanceof TimeoutError) throw notReady();
      // Serveur injoignable (baseUrl erronée, serveur arrêté) : une ligne claire plutôt qu'une pile Puppeteer.
      throw new HttpError(502, `Route d'impression injoignable (${printUrl}) : ${(error as Error).message}`);
    }
  };
  /** 'ready', ou 'outdated' dès qu'un 504 « Outdated Optimize Dep » arrive avant la fin du rendu. */
  const waitReady = async (): Promise<'ready' | 'outdated'> => {
    const outdatedSeen = new Promise<'outdated'>((resolve) => {
      signalOutdated = () => resolve('outdated');
      if (outdated) resolve('outdated');
    });
    const ready = page.waitForFunction(() => window.__ready === true, { timeout: Math.max(1, deadline - Date.now()) }).then(() => 'ready' as const);
    try {
      return await Promise.race([ready, outdatedSeen]);
    } catch (error) {
      throw error instanceof TimeoutError ? notReady() : error;
    } finally {
      ready.catch(() => undefined);
    }
  };

  await load(false);
  if ((await waitReady()) === 'ready') return { reloads: 0 };
  outdated = false;
  await load(true);
  if ((await waitReady()) === 'ready') return { reloads: 1 };
  throw new HttpError(504, `Route d'impression pas prête : dépendances de Vite réoptimisées pendant le rendu (504 « Outdated Optimize Dep »), même après un rechargement. Relancer l'export.`);
}

/** Aperçu PNG de chaque face, au format fini, à `ppi` (préréglage e-mail). */
async function screenshotFaces(page: BrowserPage, doc: LayoutDocument, ppi: number, dir: string, stamp: string, preset: string): Promise<string[]> {
  const size = faceSize(doc.format);
  await page.setViewport({ width: Math.ceil(mmToPx(size.w)) + 2, height: Math.ceil(mmToPx(size.h)) + 2, deviceScaleFactor: ppi / 96 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const faces = await page.$$('.print-face');
  const files: string[] = [];
  for (const [i, face] of faces.entries()) {
    const box = await face.boundingBox();
    if (!box) continue;
    const bleed = mmToPx(doc.format.bleed);
    const png = await page.screenshot({
      type: 'png',
      captureBeyondViewport: true,
      clip: { x: box.x + bleed, y: box.y + bleed, width: mmToPx(doc.format.trim.w), height: mmToPx(doc.format.trim.h) },
    });
    const faceId = doc.pages[i]?.faceId ?? `face-${i + 1}`;
    let file = path.join(dir, `${stamp}-${preset}-${faceId}.png`);
    for (let seq = 2; await exists(file); seq++) file = path.join(dir, `${stamp}-${preset}-${faceId}-${seq}.png`);
    await writeFileAtomic(file, png);
    files.push(file);
  }
  return files;
}

/**
 * Export PDF (tâches 1.18 et 4.2 à 4.10) : Chrome ouvre la route d'impression, attend `window.__ready`,
 * compare les lignes rendues à celles de l'éditeur, imprime une page par face à la taille du format ;
 * puis, selon le préréglage, post-traitement CMJN et PDF/X-4 (Python), ou PDF léger et aperçus PNG.
 * Écrit `documents/<id>/exports/<AAAA-MM-JJ-HHmm>-<préréglage>.pdf`.
 */
export async function exportPdf(options: ExportOptions): Promise<ExportResult> {
  const presetsFile = options.presetsFile ?? PRESETS_FILE;
  const presetId = parsePreset(options.preset, presetsFile);
  const preset = loadPresets(presetsFile).presets[presetId];
  const documentsDir = options.documentsDir ?? DEFAULT_DOCUMENTS_DIR;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const progress = (step: ExportProgress['step'], label: string, value: number) => options.onProgress?.({ step, label, progress: value });

  progress('lecture', 'Lecture du document', 0.02);
  // Lu avant de lancer quoi que ce soit : un document absent ou invalide échoue tout de suite.
  const doc = await readDocument(documentsDir, options.docId);
  const confirmations: PreflightConfirmations = { confirmLowResolution: options.confirmLowResolution, confirmHiddenLayers: options.confirmHiddenLayers };
  const refusal = printRefusal(doc, preset, confirmations);
  if (refusal) throw refusal;
  const colors = preset.colorMode === 'cmyk' ? await buildColorTable(doc, preset) : null;

  let server: RunningServer | undefined;
  let baseUrl = options.baseUrl;
  if (!baseUrl) {
    progress('lecture', 'Démarrage du serveur de rendu', 0.05);
    server = await startServer({ dev: true, hmr: false, port: 0, documentsDir });
    baseUrl = server.url;
  }
  const work = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-export-'));
  try {
    const browser = await launchBrowser();
    let chromePdf: Uint8Array;
    let state: { lineCounts: Record<string, number>; errors: string[]; faces: number; textMeasures: NonNullable<PreflightMeasures['texts']> };
    const stamp = exportStamp(new Date());
    const dir = path.join(documentDir(documentsDir, doc.id), 'exports');
    let pngs: string[] = [];
    try {
      const page = await browser.newPage();
      // Mesure des lignes et impression dans le même média que le PDF.
      await page.emulateMediaType('print');
      progress('rendu', 'Rendu des faces dans Chrome', 0.1);
      await openPrintRoute(page, baseUrl, doc, readyTimeoutMs);

      state = await page.evaluate(() => ({
        lineCounts: window.__lineCounts ?? {},
        errors: window.__printErrors ?? [],
        faces: document.querySelectorAll('.print-face').length,
        textMeasures: window.__textMeasures ?? {},
      }));
      if (state.errors.length) throw new HttpError(422, `Export impossible : ${state.errors.join(' ; ')}`);
      // Contrôle en amont relancé sur le texte tel qu'imprimé (4.8) : texte en excès, lignes réelles près de la coupe.
      const measured = printRefusal(doc, preset, confirmations, { texts: state.textMeasures });
      if (measured) throw measured;

      // Le titre de la page devient le /Title du PDF.
      await page.evaluate((title) => {
        document.title = title;
      }, doc.name);

      // La règle @page de la route d'impression (taille exacte de la face) est remplacée pour cet export
      // seulement : ajoutée en fin de <body>, elle passe après celle de la route.
      const pageSize = chromePageSizePx(doc.format);
      await page.evaluate(({ w, h }) => {
        const style = document.createElement('style');
        style.textContent = `@page { size: ${w}px ${h}px; margin: 0; }`;
        document.body.appendChild(style);
      }, pageSize);
      progress('pdf', 'Impression du PDF par Chrome', 0.35);
      chromePdf = await page.pdf({
        width: `${pageSize.w}px`,
        height: `${pageSize.h}px`,
        printBackground: true,
        preferCSSPageSize: true,
        timeout: PDF_TIMEOUT_MS,
      });
      if (preset.pngPpi) {
        progress('png', `Aperçus PNG à ${preset.pngPpi} ppi`, 0.5);
        await mkdir(dir, { recursive: true });
        pngs = await screenshotFaces(page, doc, preset.pngPpi, dir, stamp, presetId);
      }
    } finally {
      await browser.close();
    }

    const warnings: ExportWarning[] = [
      ...placeholderWarnings(doc),
      ...lowResolutionWarnings(doc),
      ...hiddenLayerWarnings(doc),
      ...preflightWarnings(doc, preset, { texts: state.textMeasures }),
      ...lineBreakWarnings(doc, state.lineCounts),
    ];
    let pdf: Uint8Array = setPageBoxes(chromePdf, (chromeMediaBox) => pageBoxes(doc.format, chromeMediaBox));
    const pages = countPdfPages(pdf);
    if (pages !== doc.pages.length) {
      warnings.push({
        kind: 'page-count',
        expected: doc.pages.length,
        rendered: pages,
        message: `Le PDF a ${plural(pages, 'page')} pour ${plural(doc.pages.length, 'face')} (${plural(state.faces, 'face')} rendue${state.faces > 1 ? 's' : ''})`,
      });
    }

    let check: PrintCheck | undefined;
    let report: CmykReport | Record<string, unknown> | undefined;
    const chromeFile = path.join(work, 'chrome.pdf');
    const outFile = path.join(work, 'final.pdf');
    if (colors) {
      progress('couleurs', 'Conversion CMJN et PDF/X-4', 0.6);
      warnings.push(...colors.warnings);
      await writeFile(chromeFile, pdf);
      const job = {
        input: chromeFile,
        output: outFile,
        presetFile: presetsFile,
        profile: preset.profile,
        imageIntent: preset.imageIntent ?? 'perceptual',
        vectorIntent: preset.vectorIntent ?? 'relative',
        blackPointCompensation: preset.blackPointCompensation ?? true,
        maxInk: preset.maxInk ?? null,
        colorTable: colors.table,
        pdfx: preset.standard ? { standard: preset.standard, title: doc.name, createdAt: new Date().toISOString() } : null,
        trimMm: [doc.format.trim.w, doc.format.trim.h],
        bleedMm: doc.format.bleed,
        marks: preset.cropMarks
          ? {
              margin: preset.marksMargin ?? 10,
              folds: doc.pages.map((p) => foldPositions(doc.format, p.faceId).map((x) => x - doc.format.bleed)),
            }
          : null,
        // Photos au-delà du seuil ramenées à la résolution d'impression (audit B4).
        downsample: preset.downsamplePpi && preset.downsampleAbovePpi ? { ppi: preset.downsamplePpi, abovePpi: preset.downsampleAbovePpi } : null,
        cmykOriginals: printedOriginals(doc, documentsDir),
        // Petits textes : sous 9 pt, deux encres au plus hors nuances d'accent ; le contrôle
        // refuse le fichier (strict) plutôt que de l'avertir.
        smallText: { pt: SMALL_TEXT_PT, maxInks: SMALL_TEXT_MAX_INKS, exceptions: smallTextExceptions(doc, colors.table), strict: true },
        expectedFonts: FONT_POSTSCRIPT_NAMES,
      };
      const jobFile = path.join(work, 'job.json');
      await writeFile(jobFile, JSON.stringify(job));
      const cmyk = await runPrintPython<CmykReport>('pdf_cmyk.py', [jobFile]);
      report = cmyk;
      check = cmyk.check;
      warnings.push(...cmykWarnings(cmyk));
      if (cmyk.errors.length) throw new HttpError(422, `Post-traitement CMJN incomplet : ${cmyk.errors.join(' ; ')}`);
      if (check && !check.ok) {
        throw new HttpError(422, `Le PDF imprimeur ne passe pas le contrôle PDF/X : ${check.errors.join(' ; ')}`, { check });
      }
      pdf = await readFile(outFile);
    } else if (preset.downsamplePpi || preset.bleed === 0) {
      progress('allegement', `Photos réduites à ${preset.downsamplePpi ?? 'leur'} ppi, sans fond perdu`, 0.6);
      await writeFile(chromeFile, pdf);
      const jobFile = path.join(work, 'job.json');
      await writeFile(jobFile, JSON.stringify({ input: chromeFile, output: outFile, ppi: preset.downsamplePpi ?? 100000, jpegQuality: preset.jpegQuality ?? 82, trim: preset.bleed === 0 }));
      report = await runPrintPython<Record<string, unknown>>('pdf_light.py', [jobFile]);
      pdf = await readFile(outFile);
    }
    if (preset.maxBytes && pdf.length > preset.maxBytes) {
      const limit = `${(preset.maxBytes / 1e6).toFixed(0)} Mo`;
      warnings.push({
        kind: 'file-size',
        message:
          preset.colorMode === 'cmyk'
            ? `PDF de ${(pdf.length / 1e6).toFixed(1)} Mo, au-delà des ${limit} qu'acceptent bien des imprimeurs : vérifier la limite du vôtre (envoi par lien, ou photos à réduire)`
            : `PDF de ${(pdf.length / 1e6).toFixed(1)} Mo, au-delà des ${limit} visés pour l'e-mail`,
      });
    }

    progress('ecriture', 'Écriture du fichier', 0.95);
    await mkdir(dir, { recursive: true });
    const file = await reserveExportFile(dir, stamp, presetId);
    try {
      await writeFileAtomic(file, pdf);
    } finally {
      reservedFiles.delete(file);
    }
    progress('ecriture', 'Terminé', 1);
    return { file, pages, warnings, preset: presetId, bytes: pdf.length, pngs, profile: preset.profile, standard: preset.standard, check, report };
  } finally {
    await rm(work, { recursive: true, force: true });
    await server?.close();
  }
}

// ---------------------------------------------------------------- travaux d'export (progression)

export interface ExportJob {
  id: string;
  docId: string;
  preset: string;
  state: 'running' | 'done' | 'error';
  progress: ExportProgress;
  result?: ExportResult;
  error?: string;
  /** Détails de l'erreur (cadres provisoires, erreurs du contrôle en amont…). */
  details?: Record<string, unknown>;
  startedAt: string;
}

const jobs = new Map<string, ExportJob>();
const JOBS_KEPT = 20;

export function startExportJob(options: ExportOptions): ExportJob {
  const job: ExportJob = {
    id: randomUUID(),
    docId: options.docId,
    preset: options.preset,
    state: 'running',
    progress: { step: 'lecture', label: 'Préparation', progress: 0 },
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  while (jobs.size > JOBS_KEPT) jobs.delete(jobs.keys().next().value!);
  exportPdf({ ...options, onProgress: (p) => (job.progress = p) }).then(
    (result) => {
      job.state = 'done';
      job.result = result;
    },
    (error: Error) => {
      job.state = 'error';
      job.error = error.message;
      if (error instanceof HttpError) job.details = error.details;
    },
  );
  return job;
}

// ---------------------------------------------------------------- routes

/** URL du serveur qui reçoit la requête ; absente s'il n'écoute pas (app.inject). */
function listeningUrl(app: FastifyInstance): string | undefined {
  const address = app.server.address();
  if (!address || typeof address === 'string') return undefined;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

const EXPORT_FILE = /^[A-Za-z0-9._-]+\.(pdf|png)$/;
const isFlag = (v: string | undefined) => v !== undefined && v !== '0' && v !== 'false';

export function registerExportRoutes(app: FastifyInstance, ctx: RouteContext): void {
  registerColorRoutes(app, ctx);

  app.post<{ Params: { id: string }; Querystring: { preset?: string; confirmLowResolution?: string; confirmHiddenLayers?: string } }>('/api/doc/:id/export', async (req) =>
    exportPdf({
      docId: req.params.id,
      preset: parsePreset(req.query.preset),
      documentsDir: ctx.documentsDir,
      baseUrl: listeningUrl(req.server),
      confirmLowResolution: isFlag(req.query.confirmLowResolution),
      confirmHiddenLayers: isFlag(req.query.confirmHiddenLayers),
    }),
  );

  // Export suivi (boîte de dialogue) : 202 tout de suite, puis GET /api/export-jobs/:job jusqu'à la fin.
  app.post<{ Params: { id: string }; Querystring: { preset?: string; confirmLowResolution?: string; confirmHiddenLayers?: string } }>('/api/doc/:id/export-jobs', async (req, reply) => {
    documentDir(ctx.documentsDir, req.params.id);
    const job = startExportJob({
      docId: req.params.id,
      preset: parsePreset(req.query.preset),
      documentsDir: ctx.documentsDir,
      baseUrl: listeningUrl(req.server),
      confirmLowResolution: isFlag(req.query.confirmLowResolution),
      confirmHiddenLayers: isFlag(req.query.confirmHiddenLayers),
    });
    return reply.code(202).send(job);
  });

  app.get<{ Params: { job: string } }>('/api/export-jobs/:job', async (req) => {
    const job = jobs.get(req.params.job);
    if (!job) throw new HttpError(404, `Export inconnu : ${req.params.job}`);
    return job;
  });

  app.get<{ Params: { id: string } }>('/api/doc/:id/exports', async (req) => {
    const dir = path.join(documentDir(ctx.documentsDir, req.params.id), 'exports');
    const names = await readdir(dir).catch(() => [] as string[]);
    const files = await Promise.all(
      names.filter((n) => EXPORT_FILE.test(n)).map(async (name) => ({ name, bytes: (await stat(path.join(dir, name))).size, url: `/api/doc/${req.params.id}/exports/${name}` })),
    );
    return files.sort((a, b) => b.name.localeCompare(a.name));
  });

  // Téléchargement d'un export : seuls les noms simples du dossier exports/ sont servis.
  app.get<{ Params: { id: string; file: string } }>('/api/doc/:id/exports/:file', async (req, reply) => {
    if (!EXPORT_FILE.test(req.params.file)) throw new HttpError(400, `Nom de fichier refusé : ${req.params.file}`);
    const file = path.join(documentDir(ctx.documentsDir, req.params.id), 'exports', req.params.file);
    if (!(await exists(file))) throw new HttpError(404, `Export introuvable : ${req.params.file}`);
    reply.type(file.endsWith('.pdf') ? 'application/pdf' : 'image/png');
    reply.header('Content-Disposition', `attachment; filename="${req.params.file}"`);
    return reply.send(createReadStream(file));
  });
}
