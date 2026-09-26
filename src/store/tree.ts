// Lecture de l'arborescence d'un document : parents, pages, descendants, boîtes, sélectionnabilité.
// Fonctions pures, utilisables sur un document figé comme sur un brouillon Immer.
import { isDraft } from 'immer';
import { findPageOrMaster } from '../model/masters';
import type { DocObject, GroupObject, Id, LayoutDocument, MasterPage, Mm, Page } from '../model/types';

export interface Box {
  x: Mm;
  y: Mm;
  w: Mm;
  h: Mm;
}

interface DocIndex {
  /** Groupe parent de chaque objet ; null pour un objet de premier niveau d'une page. */
  parent: Map<Id, Id | null>;
  /** Page qui porte chaque objet (y compris les enfants de groupes). */
  page: Map<Id, Id>;
}

// Un document Immer est immuable : l'index calculé pour une version reste valable tant qu'elle vit.
const indexCache = new WeakMap<object, DocIndex>();

function buildIndex(doc: LayoutDocument): DocIndex {
  const parent = new Map<Id, Id | null>();
  const page = new Map<Id, Id>();
  const visit = (id: Id, parentId: Id | null, pageId: Id) => {
    if (page.has(id)) return;
    parent.set(id, parentId);
    page.set(id, pageId);
    const obj = doc.objects[id];
    if (obj?.type === 'group') for (const child of obj.children) visit(child, id, pageId);
  };
  for (const p of doc.pages) for (const id of p.children) visit(id, null, p.id);
  // Objets d'une page type (4.11) : leur « page » est la page type elle-même.
  for (const m of doc.masters ?? []) for (const id of m.children) visit(id, null, m.id);
  return { parent, page };
}

/** Index parent / page ; recalculé à chaque appel sur un brouillon ou un document mutable (qui changent sous nos pieds). */
function getIndex(doc: LayoutDocument): DocIndex {
  if (isDraft(doc) || !Object.isFrozen(doc)) return buildIndex(doc);
  let index = indexCache.get(doc);
  if (!index) {
    index = buildIndex(doc);
    indexCache.set(doc, index);
  }
  return index;
}

export function parentOf(doc: LayoutDocument, id: Id): Id | null {
  return getIndex(doc).parent.get(id) ?? null;
}

export function pageIdOf(doc: LayoutDocument, id: Id): Id | null {
  return getIndex(doc).page.get(id) ?? null;
}

/** Page (ou page type, 4.11) qui porte l'objet. */
export function pageOf(doc: LayoutDocument, id: Id): Page | MasterPage | undefined {
  const pageId = pageIdOf(doc, id);
  return pageId ? findPageOrMaster(doc, pageId) : undefined;
}

/** Ancêtres d'un objet, du plus proche au plus lointain. */
export function ancestorsOf(doc: LayoutDocument, id: Id): Id[] {
  const out: Id[] = [];
  for (let p = parentOf(doc, id); p; p = parentOf(doc, p)) out.push(p);
  return out;
}

/** Descendants d'un objet (enfants, petits-enfants…), sans lui-même, dans l'ordre d'empilement. */
export function descendantsOf(doc: LayoutDocument, id: Id): Id[] {
  const out: Id[] = [];
  const walk = (objId: Id) => {
    const obj = doc.objects[objId];
    if (obj?.type !== 'group') return;
    for (const child of obj.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(id);
  return out;
}

/** Liste d'enfants qui contient l'objet : celle de son groupe, ou celle de sa page. */
export function siblingsListOf(doc: LayoutDocument, id: Id): Id[] | undefined {
  const parent = parentOf(doc, id);
  if (parent) return (doc.objects[parent] as GroupObject | undefined)?.children;
  return pageOf(doc, id)?.children;
}

/** Vrai si `id` est `ancestor` lui-même ou l'un de ses descendants. */
export function isWithin(doc: LayoutDocument, id: Id, ancestor: Id): boolean {
  return id === ancestor || ancestorsOf(doc, id).includes(ancestor);
}

/**
 * Objet à attraper au niveau de sélection courant : l'ancêtre (ou l'objet lui-même) dont le parent est
 * `scope` (null = premier niveau de la page). Null si l'objet n'est pas dans `scope`.
 */
export function resolveAtScope(doc: LayoutDocument, id: Id, scope: Id | null): Id | null {
  let current: Id | null = id;
  while (current) {
    const parent = parentOf(doc, current);
    if (parent === scope) return current;
    current = parent;
  }
  return null;
}

/** Réduit une liste d'identifiants à ses racines : un objet dont un ancêtre est aussi listé est retiré. */
export function rootsOf(doc: LayoutDocument, ids: Iterable<Id>): Id[] {
  const set = new Set(ids);
  return [...set].filter((id) => doc.objects[id] && !ancestorsOf(doc, id).some((a) => set.has(a)));
}

/**
 * Sélectionnable au clic et au lasso : objet visible et non verrouillé, sur un calque visible et non
 * verrouillé, sans ancêtre verrouillé ou masqué.
 */
export function isSelectable(doc: LayoutDocument, id: Id): boolean {
  const obj = doc.objects[id];
  if (!obj || obj.hidden || obj.locked) return false;
  const layer = doc.layers.find((l) => l.id === obj.layerId);
  if (!layer || !layer.visible || layer.locked) return false;
  if (!pageIdOf(doc, id)) return false;
  return ancestorsOf(doc, id).every((a) => {
    const anc = doc.objects[a];
    return anc && !anc.hidden && !anc.locked;
  });
}

// ---------------------------------------------------------------- boîtes

/** Boîte englobante d'un objet, rotation comprise, dans le repère de sa face. */
export function objectBounds(obj: Pick<DocObject, 'x' | 'y' | 'w' | 'h' | 'rotation'>): Box {
  const rot = obj.rotation ?? 0;
  if (!rot) return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
  const a = (rot * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const w = obj.w * cos + obj.h * sin;
  const h = obj.w * sin + obj.h * cos;
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function unionBoxes(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Boîte réelle d'un groupe : l'union de ses descendants visibles (non groupes). */
export function contentBounds(doc: LayoutDocument, groupId: Id): Box | null {
  const boxes = descendantsOf(doc, groupId)
    .map((id) => doc.objects[id])
    .filter((o): o is DocObject => !!o && o.type !== 'group')
    .map(objectBounds);
  return unionBoxes(boxes);
}

export function boxContains(outer: Box, inner: Box, tolerance = 1e-6): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}
