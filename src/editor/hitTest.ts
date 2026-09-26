// Ce qui est sous le pointeur, et ce qu'un lasso couvre, au niveau de sélection courant.
import type { DocObject, Id, LayoutDocument } from '../model/types';
import { ptToMm } from '../model/units';
import type { EditorState } from '../store/documentStore';
import { boxContains, isSelectable, objectBounds, pageIdOf, resolveAtScope, type Box } from '../store/tree';
import { pageBoxToScreen, pageSlot, pxPerMm, screenToWorld } from './layout';
import { workspacePages } from './masterView';

export interface Hit {
  /** Objet à attraper au niveau courant (le groupe, hors d'un groupe « entré »). */
  id: Id;
  /** Objet le plus profond sous le pointeur. */
  deepId: Id;
  /** Vrai si l'objet est hors du groupe dans lequel on est entré : cliquer dessus en fait sortir. */
  outsideScope: boolean;
}

type HitState = Pick<EditorState, 'doc' | 'enteredGroup' | 'zoom' | 'view'>;

/**
 * Objet sélectionnable le plus haut sous un point écran. Les objets verrouillés (eux-mêmes ou par leur
 * calque) sont transparents au clic : on attrape ce qu'il y a dessous, comme dans InDesign. Un rectangle
 * ou une ellipse sans fond ne s'attrape que près de son contour (son intérieur laisse passer le clic).
 */
export function hitTest(root: HTMLElement, clientX: number, clientY: number, state: HitState): Hit | null {
  const exact = hitAt(root, clientX, clientY, state);
  if (exact) return exact;
  // Tolérance de quelques pixels autour du pointeur : un filet de 0,5 pt ne fait qu'un pixel à l'écran.
  for (const [dx, dy] of HIT_TOLERANCE) {
    const near = hitAt(root, clientX + dx, clientY + dy, state);
    if (near) return near;
  }
  return null;
}

const T = 3;
const HIT_TOLERANCE: [number, number][] = [
  [0, -T],
  [0, T],
  [-T, 0],
  [T, 0],
  [-T, -T],
  [T, -T],
  [-T, T],
  [T, T],
];

/** Distance (px écran) au contour en deçà de laquelle un rectangle ou une ellipse sans fond est attrapé. */
const OUTLINE_HIT_PX = 3;

/**
 * Vrai si le point tombe à l'intérieur d'un rectangle ou d'une ellipse SANS fond, loin de son contour :
 * rien n'y est dessiné, le clic doit passer à ce qu'il y a dessous (comme dans InDesign).
 */
function missesHollowShape(obj: DocObject, root: HTMLElement, clientX: number, clientY: number, state: HitState): boolean {
  if ((obj.type !== 'rect' && obj.type !== 'ellipse') || obj.fill || !state.doc) return false;
  const pageId = pageIdOf(state.doc, obj.id);
  const slot = pageId ? pageSlot(state.doc, pageId) : undefined;
  if (!slot) return false;
  const r = root.getBoundingClientRect();
  const world = screenToWorld({ x: clientX - r.left, y: clientY - r.top }, state.zoom, state.view);
  // Point dans le repère de l'objet : origine au centre, rotation annulée.
  const a = (-(obj.rotation ?? 0) * Math.PI) / 180;
  const px = world.x - slot.x - (obj.x + obj.w / 2);
  const py = world.y - slot.y - (obj.y + obj.h / 2);
  const u = px * Math.cos(a) - py * Math.sin(a);
  const v = px * Math.sin(a) + py * Math.cos(a);
  const halfW = obj.w / 2;
  const halfH = obj.h / 2;
  let distance: number;
  if (obj.type === 'rect') {
    const dx = Math.abs(u) - halfW;
    const dy = Math.abs(v) - halfH;
    distance = dx <= 0 && dy <= 0 ? Math.min(-dx, -dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  } else {
    // Ellipse : distance au bord mesurée le long du rayon (assez juste pour un clic).
    const k = Math.hypot(u / (halfW || 1e-9), v / (halfH || 1e-9));
    distance = k < 1e-9 ? Math.min(halfW, halfH) : Math.hypot(u, v) * Math.abs(1 - 1 / k);
  }
  const tolerance = Math.max(ptToMm(obj.stroke?.width ?? 0) / 2, OUTLINE_HIT_PX / pxPerMm(state.zoom));
  return distance > tolerance;
}

function hitAt(root: HTMLElement, clientX: number, clientY: number, state: HitState): Hit | null {
  const doc = state.doc;
  if (!doc) return null;
  const scope = state.enteredGroup;
  const seen = new Set<string>();
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!root.contains(el)) continue;
    const objEl = el.closest('[data-obj-id]');
    // Seuls les objets rendus dans une face comptent (pas les vignettes d'un panneau, par exemple).
    if (!objEl || !root.contains(objEl) || !objEl.closest('[data-page-id]')) continue;
    const deepId = objEl.getAttribute('data-obj-id')!;
    if (seen.has(deepId) || !doc.objects[deepId]) continue;
    seen.add(deepId);
    let id = scope ? resolveAtScope(doc, deepId, scope) : null;
    let outsideScope = false;
    if (!id) {
      id = resolveAtScope(doc, deepId, null);
      outsideScope = !!scope;
    }
    if (!id || !isSelectable(doc, id) || !isSelectable(doc, deepId)) continue;
    if (missesHollowShape(doc.objects[deepId], root, clientX, clientY, state)) continue;
    return { id, deepId, outsideScope };
  }
  return null;
}

/** Objets candidats au niveau de sélection courant (enfants du groupe entré, ou premier niveau des faces). */
export function scopeCandidates(doc: LayoutDocument, scope: Id | null): Id[] {
  if (scope) {
    const group = doc.objects[scope];
    return group?.type === 'group' ? group.children : [];
  }
  return workspacePages(doc).flatMap((p) => p.children);
}

/** Objets sélectionnables ENTIÈREMENT couverts par un rectangle écran (px, repère du viewport). */
export function lassoHits(doc: LayoutDocument, scope: Id | null, rect: Box, zoom: number, view: { x: number; y: number }): Id[] {
  return scopeCandidates(doc, scope).filter((id) => {
    if (!isSelectable(doc, id)) return false;
    const pageId = pageIdOf(doc, id);
    if (!pageId) return false;
    return boxContains(rect, pageBoxToScreen(doc, pageId, objectBounds(doc.objects[id]), zoom, view), 0.5);
  });
}
