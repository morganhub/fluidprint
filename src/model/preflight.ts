// Contrôle en amont (tâche 4.8), comme le panneau Contrôle en amont d'InDesign : des règles recalculées à
// chaque modification (panneau, pastille de la barre d'état) et relancées par l'export imprimeur, qui
// refuse de partir sur une erreur rouge.
//
// Fonctions pures, sans React ni navigateur : l'éditeur ET le serveur (server/export.ts) les appellent.
// Ce qui ne se sait qu'une fois le texte mis en page (étendue réelle des lignes, texte en excès) arrive
// par `measures` : mesuré à l'écran par l'éditeur, dans la route d'impression par l'export.
import { create as createQr } from 'qrcode';
import { FONT_COVERAGE } from './fontCoverage';
import { foldPositions, trimBox } from './format';
import { framePpi, frameLabel, PPI_ERROR, PPI_WARN } from './images';
import { foreignColors } from './swatches';
import type { ColorRef, DocObject, Id, LayoutDocument, MasterPage, Mm, Page, TextObject } from './types';
import { mmToPt } from './units';

export type PreflightSeverity = 'error' | 'warning';

export type PreflightRule =
  | 'safety'
  | 'overset'
  | 'ppi-error'
  | 'ppi-warn'
  | 'placeholder'
  | 'foreign-color'
  | 'ink-limit'
  | 'thin-stroke'
  | 'small-text-inks'
  | 'missing-glyph'
  | 'hidden-layer'
  | 'qr-small'
  | 'qr-quiet-zone'
  | 'qr-unreadable';

/**
 * Ce que l'utilisateur peut assumer pour lever le refus de l'export imprimeur : des photos sous 150 ppi
 * (décision I2), un calque imprimable masqué (ses objets ne partiront pas).
 */
export type PreflightConfirmation = 'low-resolution' | 'hidden-layers';

export interface PreflightIssue {
  /** Clé stable (règle + objet) : liste React, tests. */
  key: string;
  rule: PreflightRule;
  severity: PreflightSeverity;
  /** Objet en cause (un clic dans la liste le sélectionne). */
  objectId?: Id;
  /** Page (ou page type) qui porte l'objet. */
  pageId?: Id;
  message: string;
  /**
   * Problème qu'on peut assumer en connaissance de cause : l'export imprimeur demande confirmation au lieu
   * de refuser (photo sous 150 ppi, calque imprimable masqué).
   */
  confirmable?: boolean;
  /** La confirmation qui lève ce refus (présente si et seulement si `confirmable`). */
  confirm?: PreflightConfirmation;
}

export interface PreflightReport {
  issues: PreflightIssue[];
  errors: number;
  warnings: number;
  /** Erreurs rouges qui empêchent l'export imprimeur. */
  blocking: PreflightIssue[];
  /** Problèmes que l'export imprimeur n'accepte qu'après confirmation (erreurs ou alertes). */
  toConfirm: PreflightIssue[];
}

type Box = { x: Mm; y: Mm; w: Mm; h: Mm };

export interface PreflightTextMeasure {
  /** Hauteur occupée par le texte (mm). */
  contentH?: number;
  /** Étendue des lignes (mm, repère du bloc non tourné) ; null : bloc sans texte visible. */
  ink?: Box | null;
}

export interface PreflightMeasures {
  /** Mesures des blocs texte rendus, par identifiant. Sans mesure, la boîte du bloc sert de repli. */
  texts?: Record<Id, PreflightTextMeasure>;
}

export interface PreflightOptions {
  /** Encrage maximal du préréglage d'export (%), 300 par défaut (décision P1, préréglage imprimeur). */
  maxInk?: number;
  /**
   * Bloc texte sans mesure : 'box' (défaut) contrôle sa boîte ; 'skip' attend la mesure (l'export fait un
   * premier contrôle avant le rendu, puis le refait sur le texte imprimé : la boîte y serait plus sévère
   * que la pastille de l'éditeur, qui mesure les lignes).
   */
  unmeasuredText?: 'box' | 'skip';
}

export const DEFAULT_MAX_INK = 300;
/** Filet le plus fin qu'une presse offset reproduit proprement. */
export const MIN_STROKE_PT = 0.25;
/** Corps sous lequel un texte ne doit pas mêler plus de deux encres (repérage). */
export const SMALL_TEXT_PT = 9;
/**
 * Encres permises sous `SMALL_TEXT_PT`, hors nuances d'accent déclarées en exception
 * (`Swatch.smallTextException`). Le même plafond fait échouer le contrôle PDF/X de l'export imprimeur.
 */
export const SMALL_TEXT_MAX_INKS = 2;
/** Côté minimal d'un QR code imprimé, et marge blanche en modules (décision I4). */
export const MIN_QR_MM = 15;
export const QR_QUIET_ZONE = 4;
/** Dépassement de texte toléré (mm), le même que le « + » de l'éditeur. */
export const OVERSET_TOLERANCE_MM = 0.25;

const fmt = (v: number, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits).replace('.', ',');

// ---------------------------------------------------------------- objets imprimés

export interface Placed {
  obj: DocObject;
  /** Page qui porte l'objet (page type comprise) et face sur laquelle il s'imprime. */
  pageId: Id;
  faceId: Id;
}

/**
 * Objets qui partent à l'impression : visibles, sur un calque visible et imprimable, sans ancêtre masqué.
 * Les objets d'une page type ne comptent que si une face l'utilise, contrôlés sur chacune de ces faces.
 */
export function printedObjects(doc: LayoutDocument): Placed[] {
  const printable = new Set(doc.layers.filter((l) => l.visible && l.printable).map((l) => l.id));
  const out: Placed[] = [];
  const walk = (id: Id, pageId: Id, faceId: Id) => {
    const obj = doc.objects[id];
    if (!obj || obj.hidden || !printable.has(obj.layerId)) return;
    out.push({ obj, pageId, faceId });
    if (obj.type === 'group') obj.children.forEach((c) => walk(c, pageId, faceId));
  };
  for (const page of doc.pages) page.children.forEach((id) => walk(id, page.id, page.faceId));
  for (const master of doc.masters ?? []) {
    const faces = new Set(doc.pages.filter((p) => p.masterId === master.id).map((p) => p.faceId));
    for (const faceId of faces) master.children.forEach((id) => walk(id, master.id, faceId));
  }
  return out;
}

export interface HiddenLayer {
  id: Id;
  name: string;
  /** Objets de premier niveau (un groupe compte pour un) posés sur une face ou une page type utilisée. */
  objects: number;
}

/**
 * Calques imprimables masqués qui portent des objets : la route d'impression ne dessine que les calques
 * visibles, donc ces objets manquent au PDF sans que rien d'autre ne le signale (audit B3).
 */
export function hiddenPrintableLayers(doc: LayoutDocument): HiddenLayer[] {
  const hidden = doc.layers.filter((l) => l.printable && !l.visible);
  if (!hidden.length) return [];
  const usedMasters = new Set(doc.pages.map((p) => p.masterId).filter(Boolean));
  const roots = [...doc.pages.flatMap((p) => p.children), ...(doc.masters ?? []).filter((m) => usedMasters.has(m.id)).flatMap((m) => m.children)];
  return hidden
    .map((layer) => ({ id: layer.id, name: layer.name, objects: roots.filter((id) => doc.objects[id]?.layerId === layer.id && !doc.objects[id].hidden).length }))
    .filter((l) => l.objects > 0);
}

// ---------------------------------------------------------------- caractères absents des polices

const coverageCache = new Map<string, Set<number>>();

function coverageOf(family: string): Set<number> | null {
  const ranges = FONT_COVERAGE[family];
  if (ranges === undefined) return null;
  let set = coverageCache.get(family);
  if (!set) {
    set = new Set();
    for (const part of ranges.split(',')) {
      const [a, b] = part.split('-').map((v) => parseInt(v, 16));
      for (let c = a; c <= (b ?? a); c++) set.add(c);
    }
    coverageCache.set(family, set);
  }
  return set;
}

/**
 * Caractères sans glyphe visible à chercher : blancs et caractères de mise en forme (césure, jointures,
 * sélecteurs de variante) ne passent pas par une police. U+202F est dessinée par le rendu avec une espace
 * fine d'Open Sans (render/textCss, NNBSP_RENDER).
 */
const IGNORED_CHAR = /[\s­͏᠎​-‏‪- ⁠-⁤︀-️﻿]/u;

/** Caractères d'un bloc qu'aucune face de sa police ne contient ; null si la police n'est pas fournie. */
export function missingGlyphs(obj: TextObject): { family: string; chars: string[] } | null {
  const family = obj.style.fontFamily;
  const coverage = coverageOf(family);
  const missing = new Set<string>();
  for (const para of obj.paragraphs) {
    for (const run of para.runs) {
      for (const ch of run.text) {
        if (IGNORED_CHAR.test(ch)) continue;
        if (!coverage || !coverage.has(ch.codePointAt(0)!)) missing.add(ch);
      }
    }
  }
  if (coverage && !missing.size) return null;
  return { family, chars: [...missing] };
}

const charLabel = (ch: string) => `« ${ch} » (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`;

// ---------------------------------------------------------------- géométrie

/**
 * Zone de sécurité de chaque volet (même calcul que les repères de l'éditeur, editor/PageGuides.tsx ;
 * refait ici parce que ce module tourne aussi côté serveur, sans React).
 */
export function safetyBoxes(doc: Pick<LayoutDocument, 'format'>, faceId: Id): Box[] {
  const trim = trimBox(doc.format);
  const s = doc.format.safety;
  const edges = [trim.x, ...foldPositions(doc.format, faceId), trim.x + trim.w];
  const out: Box[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const x0 = edges[i] + s;
    const x1 = edges[i + 1] - s;
    out.push({ x: x0, y: trim.y + s, w: Math.max(0, x1 - x0), h: Math.max(0, trim.h - 2 * s) });
  }
  return out;
}

/** Boîte englobante d'une boîte du bloc tournée avec lui (rotation autour du centre du bloc). */
function rotatedBounds(obj: DocObject, local: Box): Box {
  const rot = ((obj.rotation ?? 0) * Math.PI) / 180;
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const pts = [
    [local.x, local.y],
    [local.x + local.w, local.y],
    [local.x, local.y + local.h],
    [local.x + local.w, local.y + local.h],
  ].map(([x, y]) => {
    const dx = obj.x + x - cx;
    const dy = obj.y + y - cy;
    return [cx + dx * Math.cos(rot) - dy * Math.sin(rot), cy + dx * Math.sin(rot) + dy * Math.cos(rot)];
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

const EPS = 0.01;
const inside = (outer: Box, inner: Box) =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;

const hasText = (t: TextObject) => t.paragraphs.some((p) => p.runs.some((r) => r.text.trim() !== ''));

export function textLabel(obj: TextObject): string {
  if (obj.name) return obj.name;
  const text = obj.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? `« ${text.length > 32 ? `${text.slice(0, 31)}…` : text} »` : obj.id;
}

function objectLabel(obj: DocObject): string {
  if (obj.type === 'text') return textLabel(obj);
  if (obj.type === 'frame') return frameLabel(obj);
  return obj.name ?? obj.id;
}

// ---------------------------------------------------------------- encres

/** Encres d'une référence de couleur (CMJN × teinte), ou null si la nuance n'a pas de CMJN. */
function inksOf(doc: LayoutDocument, ref: ColorRef | undefined): number[] | null {
  if (!ref) return null;
  const sw = doc.swatches.find((s) => s.id === ref.swatch);
  if (!sw?.cmyk) return null;
  const tint = ref.tint ?? 1;
  return sw.cmyk.map((v) => v * tint);
}

const inkCount = (inks: number[]) => inks.filter((v) => v > 0.5).length;

/** Couleurs de texte d'un bloc, avec le corps de chaque segment. */
function textColors(obj: TextObject): { color: ColorRef; size: number }[] {
  const out: { color: ColorRef; size: number }[] = [];
  for (const para of obj.paragraphs) {
    for (const run of para.runs) {
      if (!run.text.trim()) continue;
      out.push({ color: run.color ?? obj.style.color, size: run.fontSize ?? para.fontSize ?? obj.style.fontSize });
    }
  }
  return out;
}

// ---------------------------------------------------------------- QR

// Le contrôle tourne à chaque modification du document (60 fois par seconde pendant un redimensionnement) :
// réencoder les QR codes à chaque fois coûtait 80 ms par image sur le dépliant (audit B5). Le résultat ne
// dépend que de l'adresse et du niveau de correction.
const qrProblems = new Map<string, string | null>();
const QR_CACHE_MAX = 500;

/** Problème qui rend un QR code illisible (adresse vide ou invalide, trop longue), sinon null. */
export function qrUrlProblem(url: string, ecc: 'L' | 'M' | 'Q' | 'H'): string | null {
  const key = `${ecc}\u0000${url}`;
  const cached = qrProblems.get(key);
  if (cached !== undefined) return cached;
  const problem = computeQrUrlProblem(url, ecc);
  if (qrProblems.size >= QR_CACHE_MAX) qrProblems.clear();
  qrProblems.set(key, problem);
  return problem;
}

function computeQrUrlProblem(url: string, ecc: 'L' | 'M' | 'Q' | 'H'): string | null {
  const text = url.trim();
  if (!text) return 'adresse vide';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return `adresse invalide (« ${text} »)`;
  }
  if (!['https:', 'http:', 'mailto:', 'tel:'].includes(parsed.protocol)) return `protocole refusé (${parsed.protocol})`;
  try {
    createQr(text, { errorCorrectionLevel: ecc });
  } catch {
    return `adresse trop longue pour le niveau ${ecc}`;
  }
  return null;
}

// ---------------------------------------------------------------- règles

/** Toutes les règles, dans l'ordre : erreurs rouges d'abord, puis avertissements. */
export function runPreflight(doc: LayoutDocument, measures: PreflightMeasures = {}, options: PreflightOptions = {}): PreflightReport {
  const maxInk = options.maxInk ?? DEFAULT_MAX_INK;
  const issues: PreflightIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: Omit<PreflightIssue, 'key'>) => {
    const key = `${issue.rule}:${issue.objectId ?? issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ ...issue, key });
  };
  const placed = printedObjects(doc);
  const safetyByFace = new Map<Id, Box[]>();
  const safety = (faceId: Id) => {
    if (!safetyByFace.has(faceId)) safetyByFace.set(faceId, safetyBoxes(doc, faceId));
    return safetyByFace.get(faceId)!;
  };
  const trim = trimBox(doc.format);
  const s = doc.format.safety;

  for (const { obj, pageId, faceId } of placed) {
    const at = { objectId: obj.id, pageId };
    switch (obj.type) {
      case 'text': {
        const m = measures.texts?.[obj.id];
        const label = textLabel(obj);
        // Zone de sécurité : l'étendue réelle des lignes quand elle est mesurée, sinon la boîte du bloc.
        if (m?.ink !== null && (m?.ink || (hasText(obj) && options.unmeasuredText !== 'skip'))) {
          const region = rotatedBounds(obj, m?.ink ?? { x: 0, y: 0, w: obj.w, h: obj.h });
          if (!safety(faceId).some((b) => inside(b, region))) {
            const toTrim = Math.min(region.x - trim.x, region.y - trim.y, trim.x + trim.w - region.x - region.w, trim.y + trim.h - region.y - region.h);
            const nearTrim = toTrim < s - EPS;
            add({
              ...at,
              rule: 'safety',
              severity: 'error',
              message: nearTrim
                ? `Texte ${label} à ${fmt(Math.max(0, toTrim))} mm de la coupe (${fmt(s, 0)} mm minimum)`
                : `Texte ${label} dans la zone de sécurité d'un pli (${fmt(s, 0)} mm de part et d'autre)`,
            });
          }
        }
        // Texte en excès : seul le dernier bloc d'une chaîne peut perdre du texte (les autres se déversent).
        if (m?.contentH !== undefined && !obj.autoHeight && !obj.nextId) {
          const excess = m.contentH - obj.h;
          if (excess > OVERSET_TOLERANCE_MM) add({ ...at, rule: 'overset', severity: 'error', message: `Texte en excès : ${label} dépasse de ${fmt(excess)} mm` });
        }
        // Petits textes : deux encres au plus (repérage), sauf nuance d'accent déclarée en exception. Erreur
        // rouge : le contrôle PDF/X de l'export imprimeur refuse le même fichier (npm run print-swatches crée
        // les variantes « petit texte » qui la respectent).
        for (const { color, size } of textColors(obj)) {
          if (size >= SMALL_TEXT_PT) continue;
          const swatch = doc.swatches.find((sw) => sw.id === color.swatch);
          if (swatch?.smallTextException) continue;
          const inks = inksOf(doc, color);
          if (inks && inkCount(inks) > SMALL_TEXT_MAX_INKS) {
            const name = swatch?.name ?? color.swatch;
            add({
              ...at,
              rule: 'small-text-inks',
              severity: 'error',
              message: `Texte ${label} en ${fmt(size)} pt avec ${inkCount(inks)} encres (${name}) : ${SMALL_TEXT_MAX_INKS} au plus sous ${SMALL_TEXT_PT} pt. Choisir une nuance à une ou deux encres, ou déclarer « ${name} » nuance d'accent (Nuancier)`,
            });
            break;
          }
        }
        // Caractère absent de la police : Chrome le prend dans une police du système, incorporée en police de
        // repli ou en Type 3 (emoji en couleurs RVB), et la mise en page change d'une machine à l'autre.
        if (hasText(obj)) {
          const missing = missingGlyphs(obj);
          if (missing && !FONT_COVERAGE[missing.family]) {
            add({ ...at, rule: 'missing-glyph', severity: 'warning', message: `Texte ${label} : police « ${missing.family} » non fournie par l'éditeur, remplacée par une police du système` });
          } else if (missing?.chars.length) {
            const list = missing.chars.slice(0, 5).map(charLabel).join(', ');
            const more = missing.chars.length > 5 ? ` et ${missing.chars.length - 5} autre(s)` : '';
            add({ ...at, rule: 'missing-glyph', severity: 'warning', message: `Texte ${label} : ${list}${more} absent${missing.chars.length > 1 ? 's' : ''} de ${missing.family}, dessiné${missing.chars.length > 1 ? 's' : ''} avec une police de repli` });
          }
        }
        break;
      }
      case 'frame': {
        const info = framePpi(doc, obj);
        if (info) {
          if (info.asset.placeholder) {
            add({ ...at, rule: 'placeholder', severity: 'error', message: `Photo provisoire dans « ${frameLabel(obj)} » : placer l'original` });
          }
          if (info.level === 'error') {
            add({
              ...at,
              rule: 'ppi-error',
              severity: 'error',
              confirmable: true,
              confirm: 'low-resolution',
              message: `Photo à ${Math.round(info.ppi)} ppi dans « ${frameLabel(obj)} » (moins de ${PPI_ERROR} ppi : floue à l'impression)`,
            });
          } else if (info.level === 'warn') {
            add({ ...at, rule: 'ppi-warn', severity: 'warning', message: `Photo à ${Math.round(info.ppi)} ppi dans « ${frameLabel(obj)} » (moins de ${PPI_WARN} ppi)` });
          }
        }
        break;
      }
      case 'qr': {
        const problem = qrUrlProblem(obj.url, obj.ecc);
        if (problem) add({ ...at, rule: 'qr-unreadable', severity: 'error', message: `QR code illisible : ${problem}` });
        const side = Math.min(obj.w, obj.h);
        if (side < MIN_QR_MM - EPS) add({ ...at, rule: 'qr-small', severity: 'warning', message: `QR code de ${fmt(side)} mm (${MIN_QR_MM} mm minimum)` });
        if (obj.margin < QR_QUIET_ZONE) add({ ...at, rule: 'qr-quiet-zone', severity: 'warning', message: `Marge blanche du QR code : ${obj.margin} module${obj.margin > 1 ? 's' : ''} (${QR_QUIET_ZONE} conseillés)` });
        break;
      }
      case 'svg': {
        // Un graphique importé peut garder des couleurs écrites en dur, hors nuancier.
        const hard = [...obj.content.matchAll(/(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi)].map((m) => m[1]);
        if (hard.length) add({ ...at, rule: 'foreign-color', severity: 'warning', message: `${objectLabel(obj)} : ${hard.length} couleur${hard.length > 1 ? 's' : ''} hors nuancier (${[...new Set(hard)].slice(0, 3).join(', ')})` });
        break;
      }
    }
    // Filets trop fins.
    const strokePt =
      obj.type === 'icon'
        ? mmToPt((obj.strokeWidth * Math.min(obj.w, obj.h)) / 24)
        : 'stroke' in obj && obj.stroke && obj.stroke.width > 0
          ? obj.stroke.width
          : null;
    if (strokePt !== null && strokePt > 0 && strokePt < MIN_STROKE_PT - 1e-6) {
      add({ ...at, rule: 'thin-stroke', severity: 'warning', message: `Filet de ${fmt(strokePt, 2)} pt sur ${objectLabel(obj)} (${fmt(MIN_STROKE_PT, 2)} pt minimum)` });
    }
  }

  // Encrage : une nuance employée au-delà du maximum du préréglage (teinte comprise).
  const placedIds = new Map(placed.map((p) => [p.obj.id, p]));
  const inkIssue = new Set<Id>();
  const checkInk = (ref: ColorRef | undefined, objectId: Id) => {
    const inks = inksOf(doc, ref);
    if (!inks || !ref) return;
    const total = inks.reduce((a, b) => a + b, 0);
    if (total <= maxInk + 1e-6 || inkIssue.has(objectId)) return;
    inkIssue.add(objectId);
    const p = placedIds.get(objectId)!;
    const name = doc.swatches.find((sw) => sw.id === ref.swatch)?.name ?? ref.swatch;
    add({ objectId, pageId: p.pageId, rule: 'ink-limit', severity: 'error', message: `${objectLabel(p.obj)} : ${name} à ${Math.round(total)} % d'encre (maximum ${maxInk} %)` });
  };
  for (const { obj } of placed) {
    const refs: (ColorRef | undefined)[] = [];
    if ('fill' in obj) refs.push(obj.fill);
    if ('stroke' in obj) refs.push(obj.stroke?.color);
    if (obj.type === 'text') refs.push(...textColors(obj).map((c) => c.color));
    if (obj.type === 'icon' || obj.type === 'qr' || obj.type === 'svg') refs.push(obj.color);
    if (obj.type === 'qr') refs.push(obj.background);
    refs.forEach((r) => checkInk(r, obj.id));
  }

  // Références à des nuances inconnues ou couleurs écrites en dur dans les champs de couleur.
  for (const f of foreignColors(doc)) {
    const [, objectId] = f.path.split('.');
    const p = f.path.startsWith('objects.') ? placedIds.get(objectId) : undefined;
    if (f.path.startsWith('objects.') && !p) continue;
    add({ objectId: p?.obj.id, pageId: p?.pageId, rule: 'foreign-color', severity: 'warning', message: `Couleur hors nuancier « ${f.value} » (${f.path})` });
  }

  // Calque imprimable masqué : ses objets manquent au PDF. Orange à l'écran (masquer un calque le temps
  // d'éditer est courant), mais l'export imprimeur demande confirmation.
  for (const layer of hiddenPrintableLayers(doc)) {
    add({
      rule: 'hidden-layer',
      severity: 'warning',
      confirmable: true,
      confirm: 'hidden-layers',
      message: `Calque imprimable « ${layer.name} » masqué : ${layer.objects} objet${layer.objects > 1 ? 's' : ''} ne ${layer.objects > 1 ? 'seront' : 'sera'} pas imprimé${layer.objects > 1 ? 's' : ''}`,
    });
  }

  const order = (i: PreflightIssue) => (i.severity === 'error' ? 0 : 1);
  issues.sort((a, b) => order(a) - order(b));
  const errors = issues.filter((i) => i.severity === 'error');
  return {
    issues,
    errors: errors.length,
    warnings: issues.length - errors.length,
    blocking: errors.filter((i) => !i.confirm),
    toConfirm: issues.filter((i) => i.confirm),
  };
}

export interface PreflightConfirmations {
  /** Photos sous 150 ppi assumées (décision I2). */
  confirmLowResolution?: boolean;
  /** Export sans les objets des calques imprimables masqués. */
  confirmHiddenLayers?: boolean;
}

const CONFIRM_HINTS: Record<PreflightConfirmation, string> = {
  'low-resolution': 'photos sous 150 ppi',
  'hidden-layers': 'calque imprimable masqué',
};

/** Confirmations encore attendues avant l'export imprimeur. */
export function pendingConfirmations(report: PreflightReport, options: PreflightConfirmations = {}): PreflightConfirmation[] {
  const given: Record<PreflightConfirmation, boolean> = { 'low-resolution': !!options.confirmLowResolution, 'hidden-layers': !!options.confirmHiddenLayers };
  return [...new Set(report.toConfirm.map((i) => i.confirm!).filter((c) => !given[c]))];
}

/**
 * Message de refus de l'export imprimeur, ou null s'il peut partir. Une photo sous 150 ppi ou un calque
 * imprimable masqué ne bloquent que tant que l'utilisateur ne les a pas confirmés.
 */
export function preflightRefusal(report: PreflightReport, options: PreflightConfirmations = {}): string | null {
  const pending = pendingConfirmations(report, options);
  const stops = [...report.blocking, ...report.toConfirm.filter((i) => pending.includes(i.confirm!))];
  if (!stops.length) return null;
  const list = stops.slice(0, 8).map((i) => i.message).join(' ; ');
  const more = stops.length > 8 ? ` ; et ${stops.length - 8} autre(s)` : '';
  const hint = report.blocking.length ? '' : ` (${pending.map((c) => CONFIRM_HINTS[c]).join(', ')} : confirmer pour exporter quand même)`;
  const n = report.blocking.length;
  const toConfirm = stops.length - n;
  const what = [n && `${n} erreur${n > 1 ? 's' : ''} rouge${n > 1 ? 's' : ''} à corriger`, toConfirm && `${toConfirm} point${toConfirm > 1 ? 's' : ''} à confirmer`].filter(Boolean).join(' et ');
  return `Contrôle en amont : ${what} avant l'export imprimeur${hint} : ${list}${more}`;
}

/** Pages et pages types, pour nommer où se trouve un objet. */
export function preflightPageName(doc: LayoutDocument, pageId: Id | undefined): string | null {
  if (!pageId) return null;
  const page: Page | MasterPage | undefined = doc.pages.find((p) => p.id === pageId) ?? doc.masters?.find((m) => m.id === pageId);
  return page?.name ?? null;
}
