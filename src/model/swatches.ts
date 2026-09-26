// Nuancier (tâche 2.9) : fonctions pures sur un document mutable (brouillon Immer ou copie).
//
// Une couleur du document est TOUJOURS une référence `{ swatch: id }` vers une nuance : modifier la
// nuance recolore d'un coup tous ses usages (objets, segments de texte, styles…). Les parcours ci-dessous
// lisent tout le document sauf le nuancier lui-même et les couleurs d'interface (calques) : un champ
// ajouté plus tard (pages types, styles…) est couvert sans rien changer ici.
//
// Phase 4 (nuancier CMJN) : une nuance portera `cmyk` et un `sourceRgb` ; `updateSwatch` fusionne le
// correctif sans rien perdre des champs qu'il ne connaît pas.
import { colorCss } from '../render/color';
import type { ColorRef, DocObject, Id, LayoutDocument, Swatch } from './types';

/** Nom donné à une nuance prise à la pipette ou créée à la volée, à compléter par l'utilisateur. */
export const PENDING_SWATCH_NAME = 'À nommer';

/** Clés qui portent une couleur d'interface (jamais imprimée) : ignorées par les parcours. */
const UI_COLOR_PATHS = new Set(['layers']);

/** `#abc`, `abc`, `#AABBCC`, `aabbcc` → `#aabbcc` ; null si la saisie n'est pas une couleur. */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${[...raw].map((c) => c + c).join('')}`;
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  return null;
}

/** `rgb(12, 34, 56)` (EyeDropper de certains navigateurs) ou hexadécimal → `#rrggbb`. */
export function parseCssColor(input: string): string | null {
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(input.trim());
  if (m) return `#${[m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`;
  return normalizeHex(input);
}

const isColorRef = (value: unknown): value is ColorRef =>
  !!value && typeof value === 'object' && typeof (value as ColorRef).swatch === 'string' && Object.keys(value).every((k) => k === 'swatch' || k === 'tint');

/** Un usage d'une nuance : où la référence se trouve dans le document. */
export interface SwatchUsage {
  /** Chemin de la référence, ex. `objects.t12.paragraphs.0.runs.1.color`. */
  path: string;
  /** Objet qui la porte (absent pour un style). */
  objectId?: Id;
  /** Nature de l'usage : fill, stroke, color, background, text… */
  role: string;
}

function roleOf(path: string[]): string {
  const last = path.at(-1)!;
  const prev = path.at(-2);
  if (path.includes('runs')) return 'texte (segment)';
  if (prev === 'style' && last === 'color') return 'texte';
  if (prev === 'stroke') return 'filet';
  if (last === 'fill') return 'remplissage';
  if (last === 'background') return 'fond';
  return 'couleur';
}

/** Visite chaque référence de couleur du document (objets, styles, champs futurs). */
export function forEachColorRef(doc: LayoutDocument, visit: (ref: ColorRef, path: string[]) => void): void {
  const walk = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, String(i)]));
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (isColorRef(node)) {
      visit(node, path);
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
  };
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'swatches' || UI_COLOR_PATHS.has(key)) continue;
    walk(value, [key]);
  }
}

/** Usages de chaque nuance (toutes les nuances du nuancier sont présentes, même inutilisées). */
export function swatchUsages(doc: LayoutDocument): Map<Id, SwatchUsage[]> {
  const out = new Map<Id, SwatchUsage[]>(doc.swatches.map((s) => [s.id, []]));
  forEachColorRef(doc, (ref, path) => {
    if (!out.has(ref.swatch)) out.set(ref.swatch, []);
    out.get(ref.swatch)!.push({ path: path.join('.'), objectId: path[0] === 'objects' ? path[1] : undefined, role: roleOf(path) });
  });
  return out;
}

/** Objets (identifiants distincts) qui utilisent une nuance. */
export function objectsUsingSwatch(doc: LayoutDocument, swatchId: Id): Id[] {
  const ids = new Set<Id>();
  for (const u of swatchUsages(doc).get(swatchId) ?? []) if (u.objectId) ids.add(u.objectId);
  return [...ids];
}

/** Une couleur « hors nuancier » : référence à une nuance inconnue, ou valeur écrite en dur. */
export interface ForeignColor {
  path: string;
  value: string;
}

const COLOR_KEYS = new Set(['fill', 'color', 'background']);

/**
 * Couleurs qui échappent au nuancier : références cassées, et chaînes de couleur (`#…`, `rgb(…)`)
 * laissées dans un champ de couleur. Un document sain n'en a aucune (décision P1).
 */
export function foreignColors(doc: LayoutDocument): ForeignColor[] {
  const known = new Set(doc.swatches.map((s) => s.id));
  const out: ForeignColor[] = [];
  forEachColorRef(doc, (ref, path) => {
    if (!known.has(ref.swatch)) out.push({ path: path.join('.'), value: ref.swatch });
  });
  const walk = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, [...path, String(i)]));
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (COLOR_KEYS.has(key) && typeof value === 'string') out.push({ path: [...path, key].join('.'), value });
      else walk(value, [...path, key]);
    }
  };
  walk(doc.objects, ['objects']);
  walk(doc.styles, ['styles']);
  return out;
}

// ---------------------------------------------------------------- modifications

/** Identifiant lisible et libre dérivé d'un nom (« Bleu ciel » → `bleu-ciel`). */
export function newSwatchId(doc: Pick<LayoutDocument, 'swatches'>, name: string): Id {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'nuance';
  let id = base;
  for (let n = 2; doc.swatches.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** Nom libre : « À nommer », puis « À nommer 2 »… */
export function uniqueSwatchName(doc: Pick<LayoutDocument, 'swatches'>, name: string): string {
  const taken = new Set(doc.swatches.map((s) => s.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

export function isPendingName(name: string): boolean {
  return name.toLowerCase().startsWith(PENDING_SWATCH_NAME.toLowerCase());
}

/** Ajoute une nuance en fin de nuancier ; renvoie son identifiant. */
export function addSwatch(doc: LayoutDocument, input: { name?: string; rgb: string } & Partial<Omit<Swatch, 'id' | 'name' | 'rgb'>>): Id {
  const rgb = normalizeHex(input.rgb);
  if (!rgb) throw new Error(`Couleur invalide : ${input.rgb}`);
  const name = uniqueSwatchName(doc, input.name?.trim() || PENDING_SWATCH_NAME);
  const id = newSwatchId(doc, name);
  doc.swatches.push({ ...input, id, name, rgb: distinctRgb(doc, null, rgb) });
  return id;
}

/** Modifie une nuance (nom, couleur…) : ses usages suivent sans être touchés. */
export function updateSwatch(doc: LayoutDocument, id: Id, patch: Partial<Omit<Swatch, 'id'>>): void {
  const swatch = doc.swatches.find((s) => s.id === id);
  if (!swatch) return;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'rgb') {
      const rgb = normalizeHex(String(value));
      if (!rgb) throw new Error(`Couleur invalide : ${String(value)}`);
      swatch.rgb = distinctRgb(doc, id, rgb);
    } else if (key === 'name') {
      const name = String(value).trim();
      if (name) swatch.name = name;
    } else if (value === undefined) delete (swatch as unknown as Record<string, unknown>)[key];
    else (swatch as unknown as Record<string, unknown>)[key] = value;
  }
}

/** Fait pointer toutes les références de `from` vers `to` (la teinte de chaque usage est gardée). */
export function replaceSwatchRefs(doc: LayoutDocument, from: Id, to: Id): number {
  let count = 0;
  forEachColorRef(doc, (ref) => {
    if (ref.swatch === from) {
      ref.swatch = to;
      count++;
    }
  });
  return count;
}

/**
 * Supprime une nuance. Si elle est utilisée, `replacement` est obligatoire : ses usages passent sur la
 * nuance de remplacement (le document ne garde jamais de référence cassée).
 */
export function deleteSwatch(doc: LayoutDocument, id: Id, replacement?: Id): void {
  const index = doc.swatches.findIndex((s) => s.id === id);
  if (index < 0) return;
  const used = (swatchUsages(doc).get(id) ?? []).length > 0;
  if (used) {
    if (!replacement || replacement === id || !doc.swatches.some((s) => s.id === replacement)) {
      throw new Error('Nuance utilisée : choisir une nuance de remplacement');
    }
    replaceSwatchRefs(doc, id, replacement);
  }
  doc.swatches.splice(index, 1);
}

/** Déplace une nuance dans la liste (ordre d'affichage du nuancier). */
export function moveSwatch(doc: LayoutDocument, id: Id, toIndex: number): void {
  const from = doc.swatches.findIndex((s) => s.id === id);
  if (from < 0) return;
  const [swatch] = doc.swatches.splice(from, 1);
  doc.swatches.splice(Math.max(0, Math.min(doc.swatches.length, toIndex)), 0, swatch);
}

/** Nuance la plus proche d'une couleur (distance RVB), pour proposer un remplacement. */
export function closestSwatch(doc: Pick<LayoutDocument, 'swatches'>, rgb: string, exclude?: Id): Swatch | undefined {
  const c = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const target = c(rgb);
  let best: Swatch | undefined;
  let bestD = Infinity;
  for (const s of doc.swatches) {
    if (s.id === exclude) continue;
    const v = c(s.rgb);
    const d = (v[0] - target[0]) ** 2 + (v[1] - target[1]) ** 2 + (v[2] - target[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Libellé court d'un usage pour le panneau (« Remplissage · Rectangle »). */
export function usageObject(doc: LayoutDocument, usage: SwatchUsage): DocObject | undefined {
  return usage.objectId ? doc.objects[usage.objectId] : undefined;
}

// ---------------------------------------------------------------- nuancier CMJN (tâches 4.1 et 4.7, décision P1)
//
// Une nuance d'impression porte ses encres `cmyk` (la vérité pour l'imprimeur) ; son `rgb` n'est que la
// simulation à l'écran de ces encres par le profil de sortie (server/color.ts). À l'export imprimeur, le
// PDF de Chrome est relu et chaque RVB rencontré est remplacé par les encres de SA nuance : deux nuances ne
// doivent donc jamais partager le même `rgb` (sinon on ne saurait plus laquelle Chrome a peinte).
// `sourceRgb` garde la couleur d'origine du design : le contrôle au pixel de l'import (diff:import) rend le
// document avec elle (`/print/:id?colors=source`).

/** Encres C, M, J, N en % (0-100). */
export type Cmyk = [number, number, number, number];

/** Encrage total d'une couleur, en %. */
export function inkTotal(cmyk: readonly number[]): number {
  return Math.round(cmyk.reduce((a, b) => a + b, 0) * 10) / 10;
}

/** Nombre d'encres réellement posées (N seul = 1). */
export function inkCount(cmyk: readonly number[]): number {
  return cmyk.filter((v) => v > 0).length;
}

/** Valeurs bornées à 0-100, au dixième. */
export function normalizeCmyk(values: readonly number[]): Cmyk | null {
  if (values.length !== 4 || !values.every((v) => Number.isFinite(v))) return null;
  return values.map((v) => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10) as Cmyk;
}

export function formatCmyk(cmyk: readonly number[]): string {
  const f = (v: number) => String(v).replace('.', ',');
  return `C${f(cmyk[0])} M${f(cmyk[1])} J${f(cmyk[2])} N${f(cmyk[3])}`;
}

const hexChannels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const channelsHex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * `rgb` si aucune autre nuance ne l'a déjà, sinon la couleur la plus proche encore libre : une unité de
 * plus ou de moins sur un canal (le bleu d'abord, l'œil y est le moins sensible), puis deux…
 */
export function distinctRgb(doc: Pick<LayoutDocument, 'swatches'>, swatchId: Id | null, rgb: string): string {
  const taken = new Set(doc.swatches.filter((s) => s.id !== swatchId).map((s) => s.rgb));
  if (!taken.has(rgb)) return rgb;
  const base = hexChannels(rgb);
  for (let d = 1; d < 256; d++) {
    for (const channel of [2, 1, 0]) {
      for (const sign of [1, -1]) {
        const c = [...base];
        c[channel] += sign * d;
        if (c[channel] < 0 || c[channel] > 255) continue;
        const hex = channelsHex(c);
        if (!taken.has(hex)) return hex;
      }
    }
  }
  return rgb;
}

/** Corrige les nuances qui partagent un même RVB (la seconde est décalée) ; renvoie les ids modifiés. */
export function ensureDistinctRgb(doc: LayoutDocument): Id[] {
  const changed: Id[] = [];
  const seen = new Set<string>();
  for (const swatch of doc.swatches) {
    if (seen.has(swatch.rgb)) {
      swatch.rgb = distinctRgb({ swatches: doc.swatches.filter((s) => s !== swatch) }, null, swatch.rgb);
      changed.push(swatch.id);
    }
    seen.add(swatch.rgb);
  }
  return changed;
}

/**
 * Pose les encres d'une nuance et son RVB d'affichage (simulation du profil, calculée par le serveur).
 * La couleur d'origine du design (`sourceRgb`) est gardée : c'est la référence du contrôle au pixel.
 */
export function setSwatchCmyk(doc: LayoutDocument, id: Id, cmyk: readonly number[], displayRgb: string, options: { sourceRgb?: string } = {}): void {
  const swatch = doc.swatches.find((s) => s.id === id);
  const values = normalizeCmyk(cmyk);
  const rgb = normalizeHex(displayRgb);
  if (!swatch || !values || !rgb) throw new Error(`Nuance CMJN invalide : ${id}`);
  if (options.sourceRgb) swatch.sourceRgb = normalizeHex(options.sourceRgb) ?? undefined;
  swatch.cmyk = values;
  swatch.rgb = distinctRgb(doc, id, rgb);
}

/**
 * RVB affiché de tout le nuancier d'après ses encres : `displays[i]` = simulation par le profil des encres de
 * la i-ième nuance (server/color.ts, `cmykToRgb`). D'abord toutes les simulations, puis les écarts d'une
 * unité : l'ordre du nuancier décide qui bouge quand deux nuances tombent sur le même RVB.
 */
export function applySwatchDisplays(doc: LayoutDocument, displays: readonly string[]): void {
  if (displays.length !== doc.swatches.length || doc.swatches.some((s) => !s.cmyk)) throw new Error('Affichage du nuancier : une simulation par nuance CMJN attendue');
  doc.swatches.forEach((s) => (s.rgb = '#000000'));
  doc.swatches.forEach((s, i) => setSwatchCmyk(doc, s.id, s.cmyk!, displays[i]));
}

/** Une couleur telle que Chrome l'écrit dans le PDF (RVB) et les encres qui doivent la remplacer. */
export interface PrintColor {
  rgb: string;
  cmyk: Cmyk;
  name: string;
  swatch: Id;
  tint: number;
}

/**
 * Table RVB → CMJN de l'export imprimeur : chaque nuance CMJN, et chaque teinte utilisée (encres × teinte).
 * `missing` : nuances sans encres (créées en RVB, pipette…), que l'export convertit par le profil et signale.
 */
export function printColorTable(doc: LayoutDocument): { table: PrintColor[]; missing: Swatch[] } {
  const tints = new Map<Id, Set<number>>();
  forEachColorRef(doc, (ref) => {
    if (ref.tint !== undefined && ref.tint < 1) {
      if (!tints.has(ref.swatch)) tints.set(ref.swatch, new Set());
      tints.get(ref.swatch)!.add(ref.tint);
    }
  });
  const table: PrintColor[] = [];
  const missing: Swatch[] = [];
  for (const swatch of doc.swatches) {
    if (!swatch.cmyk) {
      missing.push(swatch);
      continue;
    }
    table.push({ rgb: swatch.rgb, cmyk: [...swatch.cmyk] as Cmyk, name: swatch.name, swatch: swatch.id, tint: 1 });
    for (const tint of tints.get(swatch.id) ?? []) {
      table.push({
        rgb: colorCss(doc, { swatch: swatch.id, tint })!,
        cmyk: swatch.cmyk.map((v) => Math.round(v * tint * 10) / 10) as Cmyk,
        name: `${swatch.name} ${Math.round(tint * 100)} %`,
        swatch: swatch.id,
        tint,
      });
    }
  }
  return { table, missing };
}

/** Le document avec les couleurs d'origine du design (contrôle au pixel de l'import). */
export function withSourceColors(doc: LayoutDocument): LayoutDocument {
  if (!doc.swatches.some((s) => s.sourceRgb)) return doc;
  return { ...doc, swatches: doc.swatches.map((s) => (s.sourceRgb ? { ...s, rgb: s.sourceRgb } : s)) };
}

/**
 * Noirs seuls : le texte courant du nuancier de départ (N 80, lisible et sans repérage en petit corps) et
 * les QR codes (N 100, le contraste le plus franc pour un lecteur).
 */
export const TEXT_BLACK_SWATCH = { id: 'texte-courant', name: 'Texte courant', cmyk: [0, 0, 0, 80] as Cmyk };
export const QR_BLACK_SWATCH = { id: 'noir-qr', name: 'Noir QR', cmyk: [0, 0, 0, 100] as Cmyk };

/**
 * Variante « petit texte » d'une nuance (scripts/print-swatches.ts) : mêmes couleurs à l'œil, moins d'encres,
 * pour les textes de moins de 9 pt. « Vert » (vert) → « Vert petit texte » (vert-petit-texte).
 */
export const SMALL_TEXT_VARIANT = { idSuffix: '-petit-texte', nameSuffix: ' petit texte' } as const;
export const smallTextVariantId = (id: Id): Id => `${id}${SMALL_TEXT_VARIANT.idSuffix}`;

/** Nuance autorisée en petit texte au-delà de deux encres (exception actée, voir `Swatch.smallTextException`). */
export function isSmallTextException(doc: Pick<LayoutDocument, 'swatches'>, swatchId: Id): boolean {
  return !!doc.swatches.find((s) => s.id === swatchId)?.smallTextException;
}
