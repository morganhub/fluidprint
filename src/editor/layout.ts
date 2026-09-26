// Géométrie du plan de travail. Trois repères :
// - FACE : mm depuis le coin haut-gauche du fond perdu d'une face (celui des objets du document) ;
// - MONDE : mm, les faces posées côte à côte (face i à x = i × (largeur + écart), y = 0) ;
// - ÉCRAN : px CSS dans la zone du plan de travail (`viewport`), écran = vue + monde × px/mm × zoom.
// Tout ce qui se superpose aux faces (sélection, règles, repères…) passe par ces fonctions.
import { faceSize } from '../model/format';
import type { Id, LayoutDocument, Mm } from '../model/types';
import { PX_PER_MM } from '../model/units';
import type { Box } from '../store/tree';
import { workspacePages } from './masterView';

/** Écart entre deux faces, en mm. */
export const PAGE_GAP_MM = 24;
/** Marge autour des faces quand on ajuste le zoom à l'écran, en px. */
export const FIT_MARGIN_PX = 48;
/** Place réservée au-dessus des faces pour leur nom, en px. */
export const LABEL_SPACE_PX = 22;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 16;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];

export interface View {
  /** Position écran (px, dans le viewport) de l'origine du monde. */
  x: number;
  y: number;
}

export interface PageSlot {
  pageId: Id;
  /** Boîte de la face dans le monde (mm). */
  x: Mm;
  y: Mm;
  w: Mm;
  h: Mm;
}

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Emplacement de chaque face dans le monde. */
export function pageSlots(doc: LayoutDocument): PageSlot[] {
  const { w, h } = faceSize(doc.format);
  // En mode d'édition d'une page type (4.11), elle occupe seule le plan de travail.
  return workspacePages(doc).map((page, i) => ({ pageId: page.id, x: i * (w + PAGE_GAP_MM), y: 0, w, h }));
}

export function pageSlot(doc: LayoutDocument, pageId: Id): PageSlot | undefined {
  return pageSlots(doc).find((s) => s.pageId === pageId);
}

/** Boîte de toutes les faces dans le monde. */
export function worldBounds(doc: LayoutDocument): Box {
  const slots = pageSlots(doc);
  const x1 = Math.max(...slots.map((s) => s.x + s.w));
  const y1 = Math.max(...slots.map((s) => s.y + s.h));
  return { x: 0, y: 0, w: x1, h: y1 };
}

export const pxPerMm = (zoom: number): number => PX_PER_MM * zoom;

export function worldToScreen(p: { x: Mm; y: Mm }, zoom: number, view: View): { x: number; y: number } {
  return { x: view.x + p.x * pxPerMm(zoom), y: view.y + p.y * pxPerMm(zoom) };
}

export function screenToWorld(p: { x: number; y: number }, zoom: number, view: View): { x: Mm; y: Mm } {
  return { x: (p.x - view.x) / pxPerMm(zoom), y: (p.y - view.y) / pxPerMm(zoom) };
}

/** Point d'une face (mm, repère de la face) → écran (px dans le viewport). */
export function pageToScreen(doc: LayoutDocument, pageId: Id, p: { x: Mm; y: Mm }, zoom: number, view: View): { x: number; y: number } {
  const slot = pageSlot(doc, pageId);
  if (!slot) throw new Error(`Page inconnue : ${pageId}`);
  return worldToScreen({ x: slot.x + p.x, y: slot.y + p.y }, zoom, view);
}

/** Boîte d'une face (mm) → rectangle écran (px dans le viewport). */
export function pageBoxToScreen(doc: LayoutDocument, pageId: Id, box: Box, zoom: number, view: View): Box {
  const tl = pageToScreen(doc, pageId, box, zoom, view);
  return { x: tl.x, y: tl.y, w: box.w * pxPerMm(zoom), h: box.h * pxPerMm(zoom) };
}

/** Face sous un point du monde, et le point dans le repère de cette face ; `nearest` : la plus proche. */
export function worldToPage(doc: LayoutDocument, p: { x: Mm; y: Mm }, nearest = false): { pageId: Id; x: Mm; y: Mm } | null {
  const slots = pageSlots(doc);
  let best: PageSlot | null = null;
  let bestDist = Infinity;
  for (const s of slots) {
    const dx = Math.max(s.x - p.x, 0, p.x - (s.x + s.w));
    const dy = Math.max(s.y - p.y, 0, p.y - (s.y + s.h));
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  if (!best || (!nearest && bestDist > 0)) return null;
  return { pageId: best.pageId, x: p.x - best.x, y: p.y - best.y };
}

/** Zoom et vue qui font tenir toutes les faces dans un viewport de w × h px, centrées. */
export function fitView(doc: LayoutDocument, viewport: { w: number; h: number }): { zoom: number; view: View } {
  const world = worldBounds(doc);
  const availW = Math.max(50, viewport.w - 2 * FIT_MARGIN_PX);
  const availH = Math.max(50, viewport.h - 2 * FIT_MARGIN_PX - LABEL_SPACE_PX);
  const zoom = clampZoom(Math.min(availW / (world.w * PX_PER_MM), availH / (world.h * PX_PER_MM)));
  const contentW = world.w * pxPerMm(zoom);
  const contentH = world.h * pxPerMm(zoom);
  return { zoom, view: { x: (viewport.w - contentW) / 2, y: (viewport.h - contentH + LABEL_SPACE_PX) / 2 } };
}

/** Nouvelle vue après un changement de zoom qui garde immobile le point écran `anchor`. */
export function zoomAround(zoom: number, nextZoom: number, view: View, anchor: { x: number; y: number }): View {
  const world = screenToWorld(anchor, zoom, view);
  return { x: anchor.x - world.x * pxPerMm(nextZoom), y: anchor.y - world.y * pxPerMm(nextZoom) };
}

/** Palier de zoom suivant (dir = 1) ou précédent (dir = -1). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 1e-6) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6);
  return next ?? (dir > 0 ? MAX_ZOOM : MIN_ZOOM);
}

/**
 * Pas de déplacement à la souris, en mm : le plus fin des pas « ronds » qui dépasse un pixel écran.
 * Une souris ne se déplace que par pixels entiers : un glisser de 10 mm à l'écran donne alors 10,0 mm
 * dans le document, à tout zoom, au lieu de 10,05 ou 9,79. Le clavier et le panneau Propriétés
 * restent au 0,01 mm.
 */
export const MOUSE_STEPS_MM = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];

export function mouseStepMm(zoom: number): number {
  const onePx = 1 / pxPerMm(zoom);
  return MOUSE_STEPS_MM.find((s) => s > onePx * 1.01) ?? 10;
}

export function quantize(v: number, step: number): number {
  return Math.round(Math.round(v / step) * step * 1e4) / 1e4;
}
