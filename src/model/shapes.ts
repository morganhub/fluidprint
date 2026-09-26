// Formes des cadres et des tracés. Un tracé est stocké NORMALISÉ dans la boîte 0..1 : il s'étire à
// la boîte de l'objet (clipPath `objectBoundingBox` pour un cadre, viewBox 0 0 1 1 pour un tracé).

import type { ShapeRef } from './types';

type Point = [number, number];

/** Commande absolue, H/V déjà convertis en L, S/T en C/Q explicites. */
export type PathCommand =
  | { c: 'M' | 'L'; p: Point }
  | { c: 'C'; p1: Point; p2: Point; p: Point }
  | { c: 'Q'; p1: Point; p: Point }
  | { c: 'Z' };

const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0, A: 7 };

export interface ParsePathOptions {
  /** Convertit les arcs (commande A) en courbes de Bézier au lieu de les refuser (import SVG). */
  convertArcs?: boolean;
}

/** Lit un attribut `d` SVG (commandes absolues et relatives ; les arcs seulement avec `convertArcs`). */
export function parsePath(d: string, options: ParsePathOptions = {}): PathCommand[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: PathCommand[] = [];
  let i = 0;
  let cmd = '';
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  let lastCtrl: Point | null = null;
  let lastQuad: Point | null = null;
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || /[a-zA-Z]/.test(t)) throw new Error(`Tracé SVG incomplet : « ${d.slice(0, 60)} »`);
    return Number(t);
  };
  // Drapeau d'arc : un seul caractère, souvent collé au suivant dans un SVG compressé (« a5 5 0 011 1 »).
  const flag = () => {
    const t = tokens[i];
    if (t === undefined || !/^[01]/.test(t)) throw new Error(`Drapeau d'arc invalide : « ${d.slice(0, 60)} »`);
    if (t.length > 1) tokens[i] = t.slice(1);
    else i++;
    return t[0] === '1';
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error(`Tracé SVG sans commande initiale : « ${d.slice(0, 60)} »`);
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    if (!(upper in ARG_COUNT)) throw new Error(`Commande de tracé inconnue : ${cmd}`);
    if (upper === 'A' && !options.convertArcs) throw new Error('Les arcs (commande A) ne sont pas pris en charge : convertir le SVG en courbes');
    const abs = (x: number, y: number): Point => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    switch (upper) {
      case 'M': {
        cur = abs(num(), num());
        start = cur;
        out.push({ c: 'M', p: cur });
        cmd = rel ? 'l' : 'L'; // les paires suivantes d'un M sont des L implicites
        lastCtrl = lastQuad = null;
        break;
      }
      case 'L':
        cur = abs(num(), num());
        out.push({ c: 'L', p: cur });
        lastCtrl = lastQuad = null;
        break;
      case 'H': {
        const x = num();
        cur = [rel ? cur[0] + x : x, cur[1]];
        out.push({ c: 'L', p: cur });
        lastCtrl = lastQuad = null;
        break;
      }
      case 'V': {
        const y = num();
        cur = [cur[0], rel ? cur[1] + y : y];
        out.push({ c: 'L', p: cur });
        lastCtrl = lastQuad = null;
        break;
      }
      case 'C': {
        const p1 = abs(num(), num());
        const p2 = abs(num(), num());
        const p = abs(num(), num());
        out.push({ c: 'C', p1, p2, p });
        cur = p;
        lastCtrl = p2;
        lastQuad = null;
        break;
      }
      case 'S': {
        const p1: Point = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const p2 = abs(num(), num());
        const p = abs(num(), num());
        out.push({ c: 'C', p1, p2, p });
        cur = p;
        lastCtrl = p2;
        lastQuad = null;
        break;
      }
      case 'Q': {
        const p1 = abs(num(), num());
        const p = abs(num(), num());
        out.push({ c: 'Q', p1, p });
        cur = p;
        lastQuad = p1;
        lastCtrl = null;
        break;
      }
      case 'T': {
        const p1: Point = lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : cur;
        const p = abs(num(), num());
        out.push({ c: 'Q', p1, p });
        cur = p;
        lastQuad = p1;
        lastCtrl = null;
        break;
      }
      case 'Z':
        out.push({ c: 'Z' });
        cur = start;
        lastCtrl = lastQuad = null;
        break;
      case 'A': {
        const rx = num();
        const ry = num();
        const rotation = num();
        const large = flag();
        const sweep = flag();
        const p = abs(num(), num());
        out.push(...arcToCubics(cur, rx, ry, rotation, large, sweep, p));
        cur = p;
        lastCtrl = lastQuad = null;
        break;
      }
    }
  }
  return out;
}

/**
 * Arc elliptique SVG → courbes de Bézier cubiques (au plus 90° chacune), d'après l'annexe F.6 de SVG :
 * passage aux paramètres du centre, rayons agrandis s'ils ne suffisent pas à joindre les deux points.
 */
export function arcToCubics(from: Point, rx: number, ry: number, rotationDeg: number, large: boolean, sweep: boolean, to: Point): PathCommand[] {
  const [x1, y1] = from;
  const [x2, y2] = to;
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [{ c: 'L', p: to }];
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let delta = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (a: number): Point => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const deriv = (a: number): Point => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  const out: PathCommand[] = [];
  for (let s = 0; s < segments; s++) {
    const a1 = theta1 + s * step;
    const a2 = a1 + step;
    const p1 = point(a1);
    const p2 = point(a2);
    const d1 = deriv(a1);
    const d2 = deriv(a2);
    out.push({
      c: 'C',
      p1: [p1[0] + k * d1[0], p1[1] + k * d1[1]],
      p2: [p2[0] - k * d2[0], p2[1] - k * d2[1]],
      // Le dernier point est exactement celui demandé : pas de dérive d'arrondi en bout d'arc.
      p: s === segments - 1 ? to : p2,
    });
  }
  return out;
}

const fmt = (n: number) => String(Math.round(n * 100000) / 100000);

export function serializePath(cmds: PathCommand[]): string {
  return cmds
    .map((cmd) => {
      switch (cmd.c) {
        case 'M':
        case 'L':
          return `${cmd.c}${fmt(cmd.p[0])} ${fmt(cmd.p[1])}`;
        case 'C':
          return `C${fmt(cmd.p1[0])} ${fmt(cmd.p1[1])} ${fmt(cmd.p2[0])} ${fmt(cmd.p2[1])} ${fmt(cmd.p[0])} ${fmt(cmd.p[1])}`;
        case 'Q':
          return `Q${fmt(cmd.p1[0])} ${fmt(cmd.p1[1])} ${fmt(cmd.p[0])} ${fmt(cmd.p[1])}`;
        case 'Z':
          return 'Z';
      }
    })
    .join('');
}

export function mapPath(d: string, fn: (p: Point) => Point): string {
  return serializePath(
    parsePath(d).map((cmd) => {
      switch (cmd.c) {
        case 'M':
        case 'L':
          return { c: cmd.c, p: fn(cmd.p) };
        case 'C':
          return { c: 'C', p1: fn(cmd.p1), p2: fn(cmd.p2), p: fn(cmd.p) };
        case 'Q':
          return { c: 'Q', p1: fn(cmd.p1), p: fn(cmd.p) };
        case 'Z':
          return cmd;
      }
    }),
  );
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ramène un tracé écrit dans `viewBox` à la boîte 0..1 (comme `preserveAspectRatio="none"`). */
export function normalizePath(d: string, viewBox: Box): string {
  return mapPath(d, ([x, y]) => [(x - viewBox.x) / viewBox.w, (y - viewBox.y) / viewBox.h]);
}

/** Boîte des points et points de contrôle : les courbes restent à l'intérieur (propriété des Bézier). */
export function controlBounds(d: string): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const cmd of parsePath(d)) {
    if (cmd.c === 'Z') continue;
    const pts = cmd.c === 'C' ? [cmd.p1, cmd.p2, cmd.p] : cmd.c === 'Q' ? [cmd.p1, cmd.p] : [cmd.p];
    for (const [x, y] of pts) {
      xs.push(x);
      ys.push(y);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ---------------------------------------------------------------- formes prêtes

/** Goutte, dessinée dans une boîte de 100 × 130 : forme prête à l'emploi, reconnue aussi dans les masques d'un design. */
export const DROP_PATH = 'M50 2C61 30 96 56 96 86C96 111 76 128 50 128C24 128 4 111 4 86C4 56 39 30 50 2Z';
export const DROP_VIEWBOX: Box = { x: 0, y: 0, w: 100, h: 130 };

export interface ShapePreset {
  id: string;
  name: string;
  /** Tracé normalisé 0..1. */
  d: string;
  /** Rapport largeur / hauteur d'origine, pour créer la forme sans la déformer. */
  aspect: number;
  /** Forme paramétrique (polygone, étoile) : ses réglages restent modifiables après création. */
  polygon?: { sides: number; inset: number; rounding: number };
}

export const SHAPE_PRESETS: Record<string, ShapePreset> = {
  goutte: { id: 'goutte', name: 'Goutte', d: normalizePath(DROP_PATH, DROP_VIEWBOX), aspect: DROP_VIEWBOX.w / DROP_VIEWBOX.h },
};

// ---------------------------------------------------------------- rectangles arrondis

/** Rayons [haut-gauche, haut-droit, bas-droit, bas-gauche], ramenés à ce que la boîte peut contenir
 *  (même règle que CSS border-radius : si deux rayons voisins dépassent un côté, tous sont réduits). */
export function cornerRadii(radius: number | [number, number, number, number] | undefined, w: number, h: number): [number, number, number, number] {
  const r: [number, number, number, number] = Array.isArray(radius) ? [...radius] : [radius ?? 0, radius ?? 0, radius ?? 0, radius ?? 0];
  const clamp = (a: number) => Math.max(0, a);
  for (let i = 0; i < 4; i++) r[i] = clamp(r[i]);
  const f = Math.min(1, w / (r[0] + r[1] || Infinity), w / (r[3] + r[2] || Infinity), h / (r[0] + r[3] || Infinity), h / (r[1] + r[2] || Infinity));
  return f < 1 ? (r.map((v) => v * f) as [number, number, number, number]) : r;
}

// Constante du quart de cercle en Bézier cubique : les arcs (commande A) sont exclus des tracés.
const KAPPA = 0.5522847498;

/** Tracé d'un rectangle aux coins arrondis, en coordonnées de la boîte (x, y, w, h). */
export function roundedRectPath(x: number, y: number, w: number, h: number, radius?: number | [number, number, number, number]): string {
  const [tl, tr, br, bl] = cornerRadii(radius, w, h);
  const k = KAPPA;
  const x1 = x + w;
  const y1 = y + h;
  const cmds: PathCommand[] = [{ c: 'M', p: [x + tl, y] }, { c: 'L', p: [x1 - tr, y] }];
  if (tr) cmds.push({ c: 'C', p1: [x1 - tr + tr * k, y], p2: [x1, y + tr - tr * k], p: [x1, y + tr] });
  cmds.push({ c: 'L', p: [x1, y1 - br] });
  if (br) cmds.push({ c: 'C', p1: [x1, y1 - br + br * k], p2: [x1 - br + br * k, y1], p: [x1 - br, y1] });
  cmds.push({ c: 'L', p: [x + bl, y1] });
  if (bl) cmds.push({ c: 'C', p1: [x + bl - bl * k, y1], p2: [x, y1 - bl + bl * k], p: [x, y1 - bl] });
  cmds.push({ c: 'L', p: [x, y + tl] });
  if (tl) cmds.push({ c: 'C', p1: [x, y + tl - tl * k], p2: [x + tl - tl * k, y], p: [x + tl, y] });
  cmds.push({ c: 'Z' });
  return serializePath(cmds);
}

/** Tracé normalisé 0..1 étiré à une boîte w × h (mm) : pour dessiner un contour d'épaisseur uniforme. */
export function scalePath(d: string, w: number, h: number): string {
  return mapPath(d, ([x, y]) => [x * w, y * h]);
}

// ---------------------------------------------------------------- transformations et boîtes exactes

/** Matrice affine SVG [a, b, c, d, e, f] : x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const applyMatrix = (m: Matrix, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const NUMBER_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** Lit un attribut `transform` SVG (matrix, translate, scale, rotate, skewX, skewY). */
export function parseTransform(value: string | undefined): Matrix {
  let m = IDENTITY;
  if (!value) return m;
  for (const [, name, args] of value.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const v = (args.match(NUMBER_RE) ?? []).map(Number);
    let t: Matrix;
    switch (name) {
      case 'matrix':
        t = [v[0], v[1], v[2], v[3], v[4], v[5]];
        break;
      case 'translate':
        t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case 'scale':
        t = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
        break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
        t = multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        throw new Error(`Transformation SVG inconnue : ${name}`);
    }
    m = multiply(m, t);
  }
  return m;
}

/** Applique une fonction de point à chaque commande (une transformation affine garde les Bézier exactes). */
export function mapCommands(cmds: PathCommand[], fn: (p: Point) => Point): PathCommand[] {
  return cmds.map((cmd) => {
    switch (cmd.c) {
      case 'M':
      case 'L':
        return { c: cmd.c, p: fn(cmd.p) };
      case 'C':
        return { c: 'C', p1: fn(cmd.p1), p2: fn(cmd.p2), p: fn(cmd.p) };
      case 'Q':
        return { c: 'Q', p1: fn(cmd.p1), p: fn(cmd.p) };
      case 'Z':
        return cmd;
    }
  });
}

/** Valeurs de t dans ]0, 1[ où une Bézier (cubique ou quadratique) atteint un extremum sur un axe. */
function extremaT(values: number[]): number[] {
  const out: number[] = [];
  const push = (t: number) => {
    if (t > 1e-9 && t < 1 - 1e-9) out.push(t);
  };
  if (values.length === 3) {
    const [a, b, c] = values;
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-12) push((a - b) / den);
    return out;
  }
  const [p0, p1, p2, p3] = values;
  // Dérivée (à un facteur 3 près) : A t² + B t + C.
  const A = -p0 + 3 * p1 - 3 * p2 + p3;
  const B = 2 * (p0 - 2 * p1 + p2);
  const C = p1 - p0;
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) push(-C / B);
    return out;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  push((-B + sq) / (2 * A));
  push((-B - sq) / (2 * A));
  return out;
}

const bezierAt = (v: number[], t: number) =>
  v.length === 3
    ? (1 - t) ** 2 * v[0] + 2 * (1 - t) * t * v[1] + t * t * v[2]
    : (1 - t) ** 3 * v[0] + 3 * (1 - t) ** 2 * t * v[1] + 3 * (1 - t) * t * t * v[2] + t ** 3 * v[3];

/** Boîte EXACTE d'un tracé (extrema des courbes), plus serrée que `controlBounds`. */
export function commandsBounds(cmds: PathCommand[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = ([x, y]: Point) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  for (const cmd of cmds) {
    if (cmd.c === 'Z') {
      cur = start;
      continue;
    }
    if (cmd.c === 'M') start = cmd.p;
    add(cmd.p);
    if (cmd.c === 'C' || cmd.c === 'Q') {
      const xs = cmd.c === 'C' ? [cur[0], cmd.p1[0], cmd.p2[0], cmd.p[0]] : [cur[0], cmd.p1[0], cmd.p[0]];
      const ys = cmd.c === 'C' ? [cur[1], cmd.p1[1], cmd.p2[1], cmd.p[1]] : [cur[1], cmd.p1[1], cmd.p[1]];
      for (const t of [...extremaT(xs), ...extremaT(ys)]) add([bezierAt(xs, t), bezierAt(ys, t)]);
    }
    cur = cmd.p;
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const pathBounds = (d: string): Box => commandsBounds(parsePath(d, { convertArcs: true }));

/** Ramène un tracé à sa boîte exacte, étirée en 0..1 ; renvoie aussi la boîte d'origine. */
export function normalizeCommands(cmds: PathCommand[]): { d: string; box: Box } {
  const box = commandsBounds(cmds);
  if (!(box.w > 0 && box.h > 0)) throw new Error('Forme sans surface : largeur ou hauteur nulle');
  return { d: serializePath(mapCommands(cmds, ([x, y]) => [(x - box.x) / box.w, (y - box.y) / box.h])), box };
}

// ---------------------------------------------------------------- import d'une forme SVG (3.3)

export interface ImportedShape {
  /** Tracé normalisé 0..1, tous les tracés du fichier réunis. */
  d: string;
  /** Rapport largeur / hauteur d'origine. */
  aspect: number;
  /** Nombre d'éléments lus (path, rect, circle…). */
  elements: number;
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3] ?? '';
  return out;
}

/** Valeur d'une propriété de présentation, dans `style` (prioritaire) ou en attribut. */
function styleValue(attrs: Record<string, string>, name: string): string | undefined {
  const inStyle = attrs.style?.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  return inStyle ?? attrs[name];
}

function numAttr(attrs: Record<string, string>, name: string, fallback = 0): number {
  const v = parseFloat(attrs[name] ?? '');
  return Number.isFinite(v) ? v : fallback;
}

/** Ellipse en quatre quarts de Bézier (les arcs sont exclus des tracés stockés). */
function ellipseCommands(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { c: 'M', p: [cx + rx, cy] },
    { c: 'C', p1: [cx + rx, cy + ky], p2: [cx + kx, cy + ry], p: [cx, cy + ry] },
    { c: 'C', p1: [cx - kx, cy + ry], p2: [cx - rx, cy + ky], p: [cx - rx, cy] },
    { c: 'C', p1: [cx - rx, cy - ky], p2: [cx - kx, cy - ry], p: [cx, cy - ry] },
    { c: 'C', p1: [cx + kx, cy - ry], p2: [cx + rx, cy - ky], p: [cx + rx, cy] },
    { c: 'Z' },
  ];
}

/** Tracé d'un élément de forme SVG, dans son propre repère ; null s'il n'a pas de surface. */
function elementCommands(name: string, a: Record<string, string>): PathCommand[] | null {
  switch (name) {
    case 'path':
      return a.d ? parsePath(a.d, { convertArcs: true }) : null;
    case 'rect': {
      const w = numAttr(a, 'width');
      const h = numAttr(a, 'height');
      if (!(w > 0 && h > 0)) return null;
      const r = Math.min(numAttr(a, 'rx', numAttr(a, 'ry')), w / 2, h / 2);
      return parsePath(roundedRectPath(numAttr(a, 'x'), numAttr(a, 'y'), w, h, r));
    }
    case 'circle': {
      const r = numAttr(a, 'r');
      return r > 0 ? ellipseCommands(numAttr(a, 'cx'), numAttr(a, 'cy'), r, r) : null;
    }
    case 'ellipse': {
      const rx = numAttr(a, 'rx');
      const ry = numAttr(a, 'ry');
      return rx > 0 && ry > 0 ? ellipseCommands(numAttr(a, 'cx'), numAttr(a, 'cy'), rx, ry) : null;
    }
    case 'polygon': {
      const v = (a.points?.match(NUMBER_RE) ?? []).map(Number);
      if (v.length < 6) return null;
      const cmds: PathCommand[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) cmds.push({ c: i ? 'L' : 'M', p: [v[i], v[i + 1]] });
      cmds.push({ c: 'Z' });
      return cmds;
    }
    default:
      return null;
  }
}

// Contenu jamais dessiné tel quel : définitions, masques, métadonnées…
const SKIPPED_CONTAINERS = new Set([
  'defs',
  'clipPath',
  'mask',
  'metadata',
  'symbol',
  'pattern',
  'marker',
  'title',
  'desc',
  'style',
  'linearGradient',
  'radialGradient',
  'filter',
]);

/**
 * « Forme depuis un SVG » : lit les tracés du fichier (path, rect, circle, ellipse, polygon), applique
 * les transformations des groupes, convertit les arcs en courbes, les réunit en un seul tracé et le
 * normalise dans la boîte 0..1. Les éléments sans remplissage (`fill="none"`) et masqués sont ignorés.
 */
export function shapeFromSvg(svg: string): ImportedShape {
  const text = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  const stack: { matrix: Matrix; hidden: boolean; fill: string | undefined }[] = [];
  let skipDepth = 0;
  const all: PathCommand[] = [];
  let elements = 0;
  for (const m of text.matchAll(/<(\/?)([a-zA-Z][-a-zA-Z0-9_:]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, closing, rawName, rest, selfClosing] = m;
    const name = rawName.replace(/^svg:/, '');
    if (closing) {
      if (skipDepth) skipDepth--;
      else stack.pop();
      continue;
    }
    if (skipDepth || SKIPPED_CONTAINERS.has(name)) {
      if (!selfClosing) skipDepth++;
      continue;
    }
    const attrs = attrsOf(rest);
    const parent = stack[stack.length - 1];
    const matrix = multiply(parent?.matrix ?? IDENTITY, parseTransform(attrs.transform));
    const hidden = (parent?.hidden ?? false) || styleValue(attrs, 'display') === 'none' || styleValue(attrs, 'visibility') === 'hidden';
    // Le remplissage s'hérite des groupes.
    const fill = styleValue(attrs, 'fill') ?? parent?.fill;
    const cmds = !hidden && fill !== 'none' ? elementCommands(name, attrs) : null;
    if (cmds?.length) {
      all.push(...mapCommands(cmds, (p) => applyMatrix(matrix, p)));
      elements++;
    }
    if (!selfClosing) stack.push({ matrix, hidden, fill });
  }
  if (!all.length) throw new Error('Aucun tracé rempli dans ce SVG (path, rect, circle, ellipse ou polygon attendus)');
  const { d, box } = normalizeCommands(all);
  return { d, aspect: box.w / box.h, elements };
}

// ---------------------------------------------------------------- polygones et étoiles (3.4)

export interface PolygonOptions {
  /** 3 à 12. */
  sides: number;
  /** Creux de l'étoile en % : 0 = polygone régulier, 50 = étoile marquée. */
  inset: number;
  /** Arrondi des sommets en % (0 = vif, 100 = le plus rond possible). */
  rounding: number;
}

export const clampPolygon = (p: PolygonOptions): PolygonOptions => ({
  sides: Math.min(12, Math.max(3, Math.round(p.sides))),
  inset: Math.min(99, Math.max(0, p.inset)),
  rounding: Math.min(100, Math.max(0, p.rounding)),
});

/**
 * Polygone régulier ou étoile, pointe en haut, normalisé 0..1 sur sa boîte exacte. Une étoile a ses
 * sommets intérieurs au rayon de l'apothème × (1 − creux) : à 0 % ils tombent au milieu des côtés, et
 * l'on retrouve le polygone. L'arrondi remplace chaque sommet par une courbe tangente aux deux côtés.
 */
export function polygonPath(options: PolygonOptions): { d: string; aspect: number } {
  const { sides, inset, rounding } = clampPolygon(options);
  const star = inset > 0;
  const count = star ? sides * 2 : sides;
  const inner = Math.cos(Math.PI / sides) * (1 - inset / 100);
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const r = star && i % 2 ? inner : 1;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const lerp = (a: Point, b: Point, k: number): Point => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const cmds: PathCommand[] = [];
  if (rounding <= 0) {
    pts.forEach((p, i) => cmds.push({ c: i ? 'L' : 'M', p }));
  } else {
    // À 100 %, les courbes de deux sommets voisins se rejoignent au milieu du côté.
    const t = (rounding / 100) * 0.5;
    pts.forEach((p, i) => {
      const prev = pts[(i + count - 1) % count];
      const next = pts[(i + 1) % count];
      const dPrev = Math.hypot(prev[0] - p[0], prev[1] - p[1]);
      const dNext = Math.hypot(next[0] - p[0], next[1] - p[1]);
      const cut = t * Math.min(dPrev, dNext);
      const a = lerp(p, prev, cut / dPrev);
      const b = lerp(p, next, cut / dNext);
      cmds.push({ c: i ? 'L' : 'M', p: a });
      cmds.push({ c: 'C', p1: lerp(a, p, KAPPA), p2: lerp(b, p, KAPPA), p: b });
    });
  }
  cmds.push({ c: 'Z' });
  const { d, box } = normalizeCommands(cmds);
  return { d, aspect: box.w / box.h };
}

// ---------------------------------------------------------------- contours éditables (plume, 3.5)

/** Point d'ancrage d'un contour : poignées d'entrée et de sortie (null = segment droit de ce côté). */
export interface PathNode {
  p: Point;
  in: Point | null;
  out: Point | null;
}

export interface Contour {
  nodes: PathNode[];
  closed: boolean;
}

const samePoint = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** Découpe un tracé en contours de points d'ancrage (les quadratiques deviennent cubiques). */
export function pathToContours(d: string): Contour[] {
  const contours: Contour[] = [];
  let current: Contour | null = null;
  for (const cmd of parsePath(d, { convertArcs: true })) {
    if (cmd.c === 'M') {
      current = { nodes: [{ p: cmd.p, in: null, out: null }], closed: false };
      contours.push(current);
      continue;
    }
    if (!current) continue;
    const last: PathNode = current.nodes[current.nodes.length - 1];
    if (cmd.c === 'Z') {
      const first: PathNode = current.nodes[0];
      if (current.nodes.length > 1 && samePoint(last.p, first.p)) {
        first.in = last.in;
        current.nodes.pop();
      }
      current.closed = true;
      // Un tracé qui repart sans M après Z recommence au même point.
      current = { nodes: [{ p: first.p, in: null, out: null }], closed: false };
      contours.push(current);
      continue;
    }
    if (cmd.c === 'L') current.nodes.push({ p: cmd.p, in: null, out: null });
    else if (cmd.c === 'C') {
      last.out = cmd.p1;
      current.nodes.push({ p: cmd.p, in: cmd.p2, out: null });
    } else if (cmd.c === 'Q') {
      const q = cmd.p1;
      last.out = [last.p[0] + ((q[0] - last.p[0]) * 2) / 3, last.p[1] + ((q[1] - last.p[1]) * 2) / 3];
      current.nodes.push({ p: cmd.p, in: [cmd.p[0] + ((q[0] - cmd.p[0]) * 2) / 3, cmd.p[1] + ((q[1] - cmd.p[1]) * 2) / 3], out: null });
    }
  }
  return contours.filter((c) => c.nodes.length > 1 || c.closed);
}

export function contoursToCommands(contours: Contour[]): PathCommand[] {
  const cmds: PathCommand[] = [];
  const segment = (a: PathNode, b: PathNode): PathCommand => (a.out || b.in ? { c: 'C', p1: a.out ?? a.p, p2: b.in ?? b.p, p: b.p } : { c: 'L', p: b.p });
  for (const contour of contours) {
    const n = contour.nodes;
    if (!n.length) continue;
    cmds.push({ c: 'M', p: n[0].p });
    for (let i = 1; i < n.length; i++) cmds.push(segment(n[i - 1], n[i]));
    if (contour.closed) {
      const last = n[n.length - 1];
      // Un retour droit au premier point est implicite dans Z.
      if (last.out || n[0].in) cmds.push(segment(last, n[0]));
      cmds.push({ c: 'Z' });
    }
  }
  return cmds;
}

export const contoursToPath = (contours: Contour[]): string => serializePath(contoursToCommands(contours));

// ---------------------------------------------------------------- formes prêtes (suite) et bibliothèque

function polygonPreset(id: string, name: string, polygon: PolygonOptions): ShapePreset {
  const { d, aspect } = polygonPath(polygon);
  return { id, name, d, aspect, polygon };
}

Object.assign(SHAPE_PRESETS, {
  triangle: polygonPreset('triangle', 'Triangle', { sides: 3, inset: 0, rounding: 0 }),
  hexagone: polygonPreset('hexagone', 'Hexagone', { sides: 6, inset: 0, rounding: 0 }),
  etoile: polygonPreset('etoile', 'Étoile', { sides: 5, inset: 50, rounding: 0 }),
});

/** Forme d'une bibliothèque : prête (SHAPE_PRESETS) ou importée dans le document (`doc.shapes`). */
export function findShape(library: readonly ShapePreset[] | undefined, id: string): ShapePreset | undefined {
  return SHAPE_PRESETS[id] ?? library?.find((s) => s.id === id);
}

/** Contour d'une forme de cadre en mm, dans le repère du cadre (w × h) : masque du recadrage, surlignage. */
export function frameShapePath(shape: ShapeRef, w: number, h: number): string {
  switch (shape.kind) {
    case 'rect':
      return roundedRectPath(0, 0, w, h, shape.radius);
    case 'ellipse':
      return serializePath(ellipseCommands(w / 2, h / 2, w / 2, h / 2));
    case 'path':
      return scalePath(shape.d, w, h);
  }
}
