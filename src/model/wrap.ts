// Habillage (tâche 4.13) : un objet qui porte `wrap` repousse le texte des blocs qui le chevauchent.
//
// Le rendu reste du HTML mis en page par Chrome (écran et PDF) : l'habillage y devient au plus deux
// flottants par bloc texte (un à gauche, un à droite), placés en tête du bloc, dont `shape-outside` est un
// polygone. Ce polygone est échantillonné ici, ligne de balayage par ligne de balayage (tous les
// `ROW_STEP_MM`), depuis le contour exact de l'objet (goutte, ellipse, rectangle arrondi, tracé…),
// rotation comprise, puis élargi de la marge. Chrome prend, pour chaque ligne de texte, l'étendue du
// polygone sur la hauteur de la ligne : le texte suit la courbe.
//
// Deux modes : autour (le texte contourne l'objet, du côté où il a le plus de place) ; à l'intérieur
// (`invert`, le texte reste dans la forme et en épouse le contour).
import { frameShapePath, parsePath, roundedRectPath, scalePath, type PathCommand } from './shapes';
import type { DocObject, Id, LayoutDocument, MasterPage, Mm, Page, TextObject } from './types';

type Point = [number, number];

/** Pas des lignes de balayage (mm) : bien plus fin qu'une ligne de texte (2,9 mm pour du 6,3 pt). */
export const ROW_STEP_MM = 0.25;
/** Segments par courbe de Bézier à l'aplatissement. */
const CURVE_SEGMENTS = 24;

export interface WrapFloat {
  side: 'left' | 'right';
  /** Largeur de la boîte du flottant (mm), depuis le bord gauche (left) ou jusqu'au bord droit (right). */
  width: Mm;
  height: Mm;
  /** Polygone `shape-outside`, en mm dans la boîte du flottant. */
  points: Point[];
}

export interface WrapFloats {
  left?: WrapFloat;
  right?: WrapFloat;
  /** Signature (change quand la géométrie change) : sert à re-rendre le bloc. */
  key: string;
}

// ---------------------------------------------------------------- contours

function flatten(cmds: PathCommand[]): Point[][] {
  const contours: Point[][] = [];
  let cur: Point = [0, 0];
  let contour: Point[] = [];
  const close = () => {
    if (contour.length > 2) contours.push(contour);
    contour = [];
  };
  for (const cmd of cmds) {
    switch (cmd.c) {
      case 'M':
        close();
        contour.push(cmd.p);
        cur = cmd.p;
        break;
      case 'L':
        contour.push(cmd.p);
        cur = cmd.p;
        break;
      case 'C':
      case 'Q': {
        const [x0, y0] = cur;
        for (let i = 1; i <= CURVE_SEGMENTS; i++) {
          const t = i / CURVE_SEGMENTS;
          const u = 1 - t;
          contour.push(
            cmd.c === 'C'
              ? [
                  u ** 3 * x0 + 3 * u * u * t * cmd.p1[0] + 3 * u * t * t * cmd.p2[0] + t ** 3 * cmd.p[0],
                  u ** 3 * y0 + 3 * u * u * t * cmd.p1[1] + 3 * u * t * t * cmd.p2[1] + t ** 3 * cmd.p[1],
                ]
              : [u * u * x0 + 2 * u * t * cmd.p1[0] + t * t * cmd.p[0], u * u * y0 + 2 * u * t * cmd.p1[1] + t * t * cmd.p[1]],
          );
        }
        cur = cmd.p;
        break;
      }
      case 'Z':
        close();
        break;
    }
  }
  close();
  return contours;
}

/** Contour d'un objet en mm dans le repère de sa face, rotation comprise (polygones fermés). */
export function objectOutline(obj: DocObject): Point[][] {
  const { w, h } = obj;
  let d: string;
  switch (obj.type) {
    case 'frame':
      d = frameShapePath(obj.shape, w, h);
      break;
    case 'rect':
      d = roundedRectPath(0, 0, w, h, obj.radius);
      break;
    case 'ellipse':
      d = frameShapePath({ kind: 'ellipse' }, w, h);
      break;
    case 'path':
      d = scalePath(obj.d, w, h);
      break;
    default:
      d = `M0 0L${w} 0L${w} ${h}L0 ${h}Z`;
  }
  let contours: Point[][];
  try {
    contours = flatten(parsePath(d, { convertArcs: true }));
  } catch {
    contours = flatten(parsePath(`M0 0L${w} 0L${w} ${h}L0 ${h}Z`));
  }
  const a = ((obj.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  return contours.map((c) =>
    c.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      return [obj.x + cx + dx * cos - dy * sin, obj.y + cy + dx * sin + dy * cos] as Point;
    }),
  );
}

/** Étendue horizontale [min, max] du contour sur une ligne horizontale ; null si la ligne ne le coupe pas. */
function rowSpan(contours: Point[][], y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const [x1, y1] = c[i];
      const [x2, y2] = c[(i + 1) % c.length];
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
        const x = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

function outlineBounds(contours: Point[][]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of contours)
    for (const [x, y] of c) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return { x0, y0, x1, y1 };
}

/**
 * Étendue du contour élargi (marge > 0, `grow`) ou rétréci (`shrink`) de `m` mm, à l'ordonnée y :
 * enveloppe des disques de rayon m posés sur les lignes voisines (à m près), échantillonnées au même pas.
 */
function offsetSpan(spanAt: (y: number) => [number, number] | null, y: number, m: number, mode: 'grow' | 'shrink'): [number, number] | null {
  if (m <= 0) return spanAt(y);
  const n = Math.ceil(m / ROW_STEP_MM);
  let lo = mode === 'grow' ? Infinity : -Infinity;
  let hi = mode === 'grow' ? -Infinity : Infinity;
  for (let k = -n; k <= n; k++) {
    const dy = (k / n) * m;
    const s = spanAt(y + dy);
    const r = Math.sqrt(Math.max(0, m * m - dy * dy));
    if (mode === 'grow') {
      if (!s) continue;
      lo = Math.min(lo, s[0] - r);
      hi = Math.max(hi, s[1] + r);
    } else {
      // Rétrécir : toute ligne voisine hors de la forme rend la ligne inutilisable.
      if (!s) return null;
      lo = Math.max(lo, s[0] + r);
      hi = Math.min(hi, s[1] - r);
    }
  }
  return lo < hi ? [lo, hi] : null;
}

// ---------------------------------------------------------------- flottants d'un bloc texte

export interface WrapObstacle {
  obj: DocObject;
  margin: Mm;
  invert: boolean;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Retire les points alignés avec leurs voisins (le polygone reste exact, bien plus court). */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    while (out.length >= 2) {
      const [ax, ay] = out[out.length - 2];
      const [bx, by] = out[out.length - 1];
      const cross = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
      if (Math.abs(cross) > 1e-6) break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * Flottants d'habillage d'un bloc texte (repère du bloc, mm), ou null si aucun obstacle ne le touche.
 * Chaque ligne de balayage donne ce que le texte doit laisser libre à gauche (L) et à droite (R) ;
 * `split` sépare les deux flottants pour que leurs boîtes ne se chevauchent jamais (sinon Chrome
 * repousserait le second sous le premier).
 */
export function wrapFloatsFor(text: Pick<TextObject, 'x' | 'y' | 'w' | 'h'>, obstacles: WrapObstacle[]): WrapFloats | null {
  const W = text.w;
  const H = text.h;
  if (!(W > 0 && H > 0) || !obstacles.length) return null;
  const rows = Math.max(1, Math.ceil(H / ROW_STEP_MM));
  const ys = Array.from({ length: rows + 1 }, (_, i) => Math.min(H, i * ROW_STEP_MM));
  const L = ys.map(() => 0);
  const R = ys.map(() => W);
  const blocked = ys.map(() => false);
  let split: number | null = null;
  let hasLeft = false;
  let hasRight = false;

  for (const o of obstacles) {
    const contours = objectOutline(o.obj);
    if (!contours.length) continue;
    const b = outlineBounds(contours);
    const cache = new Map<number, [number, number] | null>();
    const spanAt = (yFace: number) => {
      const key = Math.round(yFace * 1e4);
      if (!cache.has(key)) cache.set(key, rowSpan(contours, yFace));
      return cache.get(key)!;
    };
    if (o.invert) {
      // Le texte épouse la forme de l'intérieur : tout ce qui est hors de la forme (rétrécie de la marge) est exclu.
      split = Math.min(W, Math.max(0, (b.x0 + b.x1) / 2 - text.x));
      hasLeft = hasRight = true;
      ys.forEach((y, i) => {
        const s = offsetSpan(spanAt, text.y + y, o.margin, 'shrink');
        if (!s) blocked[i] = true;
        else {
          L[i] = Math.max(L[i], s[0] - text.x);
          R[i] = Math.min(R[i], s[1] - text.x);
        }
      });
      continue;
    }
    // Autour : le texte passe du côté du bloc où il y a le plus de place.
    const left = (b.x0 + b.x1) / 2 < text.x + W / 2;
    ys.forEach((y, i) => {
      const s = offsetSpan(spanAt, text.y + y, o.margin, 'grow');
      if (!s) return;
      if (left) {
        L[i] = Math.max(L[i], s[1] - text.x);
        hasLeft = true;
      } else {
        R[i] = Math.min(R[i], s[0] - text.x);
        hasRight = true;
      }
    });
  }
  if (!hasLeft && !hasRight) return null;

  const clamp = (v: number) => Math.min(W, Math.max(0, v));
  if (split === null) {
    const maxL = Math.max(...L.map(clamp));
    const minR = Math.min(...R.map(clamp));
    split = !hasRight ? W : !hasLeft ? 0 : maxL <= minR ? maxL : (maxL + minR) / 2;
  }
  const s = split;
  const Lc = L.map((v, i) => (blocked[i] ? s : Math.min(s, clamp(v))));
  const Rc = R.map((v, i) => (blocked[i] ? s : Math.max(s, clamp(v))));

  const out: WrapFloats = { key: '' };
  const leftWidth = Math.max(...Lc);
  if (hasLeft && leftWidth > 0) {
    const pts: Point[] = [[0, 0], ...ys.map((y, i) => [round3(Lc[i]), round3(y)] as Point), [0, round3(H)]];
    out.left = { side: 'left', width: round3(leftWidth), height: round3(H), points: simplify(pts) };
  }
  const rightStart = Math.min(...Rc);
  if (hasRight && rightStart < W) {
    const width = W - rightStart;
    const pts: Point[] = [[round3(width), 0], ...ys.map((y, i) => [round3(Rc[i] - rightStart), round3(y)] as Point), [round3(width), round3(H)]];
    out.right = { side: 'right', width: round3(width), height: round3(H), points: simplify(pts) };
  }
  if (!out.left && !out.right) return null;
  out.key = JSON.stringify([out.left, out.right]);
  return out;
}

// ---------------------------------------------------------------- qui habille qui

const boxesOverlap = (a: { x: number; y: number; w: number; h: number }, b: { x0: number; y0: number; x1: number; y1: number }) =>
  a.x < b.x1 && b.x0 < a.x + a.w && a.y < b.y1 && b.y0 < a.y + a.h;

/**
 * Obstacles de chaque bloc texte d'une page (ou d'une page type) : objets visibles qui portent `wrap` et
 * chevauchent le bloc (marge comprise). Une page voit aussi les objets de sa page type. En impression,
 * les calques non imprimables ne comptent pas.
 */
function pageObstacles(doc: LayoutDocument, page: Page | MasterPage, printing: boolean, out: Map<Id, WrapFloats>): void {
  const layers = new Map(doc.layers.map((l) => [l.id, l]));
  const texts: TextObject[] = [];
  const obstacles: WrapObstacle[] = [];
  const visit = (id: Id) => {
    const obj = doc.objects[id];
    const layer = obj && layers.get(obj.layerId);
    if (!obj || obj.hidden || !layer || !layer.visible || (printing && !layer.printable)) return;
    if (obj.type === 'group') return obj.children.forEach(visit);
    if (obj.type === 'text') texts.push(obj);
    else if (obj.wrap) obstacles.push({ obj, margin: obj.wrap.margin, invert: !!obj.wrap.invert });
  };
  page.children.forEach(visit);
  const master = 'masterId' in page && page.masterId ? doc.masters?.find((m) => m.id === page.masterId) : undefined;
  if (master) {
    // Les obstacles de la page type repoussent aussi le texte de la face ; ses textes, eux, sont traités avec elle.
    const own = texts.length;
    master.children.forEach(visit);
    texts.length = own;
  }
  if (!obstacles.length) return;
  for (const text of texts) {
    if (text.rotation || out.has(text.id)) continue;
    const mine = obstacles.filter((o) => {
      const b = outlineBounds(objectOutline(o.obj));
      const m = o.invert ? 0 : o.margin;
      return boxesOverlap(text, { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });
    });
    const floats = wrapFloatsFor(text, mine);
    if (floats) out.set(text.id, floats);
  }
}

const indexCache = new WeakMap<object, { key: string; map: Map<Id, WrapFloats> }[]>();

/** Flottants d'habillage de chaque bloc texte du document (mémoïsé par version du document). */
export function wrapIndex(doc: LayoutDocument, printing: boolean): Map<Id, WrapFloats> {
  const frozen = Object.isFrozen(doc);
  const mode = printing ? 'print' : 'screen';
  const cached = frozen ? indexCache.get(doc)?.find((c) => c.key === mode) : undefined;
  if (cached) return cached.map;
  const map = new Map<Id, WrapFloats>();
  // Rien à faire sans aucun objet habillé : le cas de presque tous les documents.
  if (Object.values(doc.objects).some((o) => o.wrap)) {
    for (const page of doc.pages) pageObstacles(doc, page, printing, map);
    for (const master of doc.masters ?? []) pageObstacles(doc, master, printing, map);
  }
  if (frozen) {
    const list = indexCache.get(doc) ?? [];
    list.push({ key: mode, map });
    indexCache.set(doc, list);
  }
  return map;
}
