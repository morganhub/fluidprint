// Commandes du document : fonctions qui MODIFIENT un brouillon Immer (ou tout document mutable).
// Le store les enveloppe dans `apply(label, draft => …)` pour l'historique ; un agent peut les composer
// dans sa propre action : `store.getState().apply('Aligner', (d) => { moveObjects(d, …); … })`.
//
// Règles communes :
// - coordonnées absolues dans le repère de la face (mm) : déplacer un groupe déplace ses descendants ;
// - seules les valeurs modifiées sont arrondies (au 1/10 000 mm, pour chasser le bruit des flottants) :
//   un objet non touché garde ses coordonnées d'import au bit près (contrôle au pixel) ;
// - la boîte d'un groupe est recalculée quand l'un de ses enfants bouge seul.
import { refitImage } from '../model/frame';
import { findPageOrMaster } from '../model/masters';
import { detachChains } from '../model/threading';
import type { DocObject, FrameObject, GroupObject, Id, Layer, LayoutDocument, MasterPage, Page } from '../model/types';
import {
  ancestorsOf,
  contentBounds,
  descendantsOf,
  objectBounds,
  pageIdOf,
  pageOf,
  parentOf,
  rootsOf,
  siblingsListOf,
  unionBoxes,
  type Box,
} from './tree';

/** Arrondi des valeurs écrites par l'éditeur : 0,0001 mm, bien en deçà de toute précision d'impression. */
export const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

// ---------------------------------------------------------------- identifiants

const ID_PREFIX: Record<DocObject['type'], string> = {
  text: 'txt',
  rect: 'rect',
  ellipse: 'ell',
  line: 'line',
  path: 'path',
  frame: 'frame',
  icon: 'icon',
  svg: 'svg',
  qr: 'qr',
  group: 'grp',
};

/** Identifiant libre dans le document : `<préfixe>-<6 caractères>`. */
export function newObjectId(doc: LayoutDocument, type: DocObject['type'] | string, reserved?: Set<string>): Id {
  const prefix = ID_PREFIX[type as DocObject['type']] ?? type;
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    if (!doc.objects[id] && !reserved?.has(id)) {
      reserved?.add(id);
      return id;
    }
  }
}

// ---------------------------------------------------------------- boîtes des groupes

/** Recalcule la boîte d'un groupe depuis ses descendants (sans rien arrondir de plus que nécessaire). */
export function refreshGroupBounds(doc: LayoutDocument, groupId: Id): void {
  const group = doc.objects[groupId];
  if (group?.type !== 'group') return;
  const box = contentBounds(doc, groupId);
  if (!box) return;
  group.x = round4(box.x);
  group.y = round4(box.y);
  group.w = round4(box.w);
  group.h = round4(box.h);
}

/** Recalcule les boîtes de tous les groupes qui contiennent `id`, du plus proche au plus lointain. */
export function refreshAncestors(doc: LayoutDocument, id: Id): void {
  for (const a of ancestorsOf(doc, id)) refreshGroupBounds(doc, a);
}

// ---------------------------------------------------------------- déplacer, redimensionner

function translate(obj: DocObject, dx: number, dy: number): void {
  if (dx) obj.x = round4(obj.x + dx);
  if (dy) obj.y = round4(obj.y + dy);
}

/** Déplace des objets (et leurs descendants) de dx, dy mm. */
export function moveObjects(doc: LayoutDocument, ids: Id[], dx: number, dy: number): void {
  if (!dx && !dy) return;
  const roots = rootsOf(doc, ids);
  for (const id of roots) {
    const obj = doc.objects[id];
    if (!obj) continue;
    translate(obj, dx, dy);
    for (const d of descendantsOf(doc, id)) translate(doc.objects[d], dx, dy);
  }
  // Un enfant déplacé seul change la boîte de son groupe ; un groupe déplacé entier, non.
  const touched = new Set<Id>();
  for (const id of roots) for (const a of ancestorsOf(doc, id)) touched.add(a);
  for (const g of [...touched].sort((a, b) => ancestorsOf(doc, b).length - ancestorsOf(doc, a).length)) refreshGroupBounds(doc, g);
}

/** Donne à un objet la position de sa boîte (x, y) sans toucher à sa taille ; un groupe emmène ses enfants. */
export function setPosition(doc: LayoutDocument, id: Id, x: number | undefined, y: number | undefined): void {
  const obj = doc.objects[id];
  if (!obj) return;
  moveObjects(doc, [id], x === undefined ? 0 : x - obj.x, y === undefined ? 0 : y - obj.y);
}

/** Largeur et hauteur en pixels d'une photo, pour recaler un cadre redimensionné. */
function assetSize(doc: LayoutDocument, assetId: string): { w: number; h: number } | null {
  const asset = doc.assets.find((a) => a.id === assetId);
  return asset ? { w: asset.width, h: asset.height } : null;
}

/** Boîte d'un objet ramenée d'une boîte de référence `from` à `to` (mise à l'échelle affine). */
function mapBox(obj: Box, from: Box, to: Box): Box {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (obj.x - from.x) * sx, y: to.y + (obj.y - from.y) * sy, w: obj.w * sx, h: obj.h * sy };
}

/** Applique une nouvelle boîte à un objet seul (pas ses enfants) ; recale la photo d'un cadre. */
function applyBox(doc: LayoutDocument, obj: DocObject, box: Box): void {
  const before = { w: obj.w, h: obj.h };
  obj.x = round4(box.x);
  obj.y = round4(box.y);
  obj.w = round4(Math.max(0, box.w));
  obj.h = round4(Math.max(0, box.h));
  if (obj.type === 'frame' && obj.image && before.w > 0 && before.h > 0 && obj.w > 0 && obj.h > 0) {
    const size = assetSize(doc, obj.image.assetId);
    if (size) (obj as FrameObject).image = refitImage(obj.image, before, { w: obj.w, h: obj.h }, size.w, size.h);
  }
}

/**
 * Redimensionne des objets en faisant passer leur boîte commune de `from` à `to` : chaque objet (et
 * chaque descendant d'un groupe) est placé et mis à l'échelle en proportion. Le texte n'est pas mis à
 * l'échelle (seul son bloc change, comme dans InDesign), ni les filets.
 */
export function resizeObjects(doc: LayoutDocument, ids: Id[], from: Box, to: Box): void {
  const roots = rootsOf(doc, ids);
  for (const id of roots) {
    const all = [id, ...descendantsOf(doc, id)];
    for (const objId of all) {
      const obj = doc.objects[objId];
      if (!obj) continue;
      applyBox(doc, obj, mapBox(obj, from, to));
    }
    // Les boîtes de groupes suivent exactement leurs enfants après une mise à l'échelle.
    for (const objId of [...all].reverse()) if (doc.objects[objId]?.type === 'group') refreshGroupBounds(doc, objId);
  }
  const touched = new Set<Id>();
  for (const id of roots) for (const a of ancestorsOf(doc, id)) touched.add(a);
  for (const g of [...touched].sort((a, b) => ancestorsOf(doc, b).length - ancestorsOf(doc, a).length)) refreshGroupBounds(doc, g);
}

/** Donne une boîte à un objet (x, y, w, h en mm ; les champs absents sont conservés). */
export function setBox(doc: LayoutDocument, id: Id, box: Partial<Box>): void {
  const obj = doc.objects[id];
  if (!obj) return;
  const from: Box = { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
  const to: Box = { x: box.x ?? obj.x, y: box.y ?? obj.y, w: box.w ?? obj.w, h: box.h ?? obj.h };
  if (from.w === to.w && from.h === to.h) {
    moveObjects(doc, [id], to.x - from.x, to.y - from.y);
    return;
  }
  resizeObjects(doc, [id], from, to);
}

// ---------------------------------------------------------------- propriétés

/** Fusionne des champs dans des objets ; une fonction permet une retouche plus fine. */
export function updateObjects<T extends DocObject = DocObject>(doc: LayoutDocument, ids: Id[], patch: Partial<T> | ((obj: T) => void)): void {
  for (const id of ids) {
    const obj = doc.objects[id] as T | undefined;
    if (!obj) continue;
    if (typeof patch === 'function') patch(obj);
    else {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'type') continue;
        if (value === undefined) delete (obj as unknown as Record<string, unknown>)[key];
        else (obj as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
}

// ---------------------------------------------------------------- ajouter, supprimer

export interface InsertTarget {
  pageId: Id;
  /** Groupe d'accueil ; absent = premier niveau de la page. */
  groupId?: Id | null;
  /** Rang d'insertion dans la liste d'enfants ; absent = au-dessus de tout. */
  index?: number;
}

/**
 * Ajoute des objets. `objects` contient les racines ET leurs descendants (les enfants des groupes) ;
 * `roots` liste celles qui entrent dans la page ou le groupe d'accueil, dans l'ordre d'empilement.
 */
export function addObjects(doc: LayoutDocument, objects: DocObject[], roots: Id[], target: InsertTarget): void {
  for (const obj of objects) doc.objects[obj.id] = obj;
  const list = target.groupId ? (doc.objects[target.groupId] as GroupObject).children : findPageOrMaster(doc, target.pageId)!.children;
  const at = target.index === undefined ? list.length : Math.max(0, Math.min(list.length, target.index));
  list.splice(at, 0, ...roots);
  if (target.groupId) {
    // Un enfant de groupe vit sur le calque de son groupe.
    const layerId = doc.objects[target.groupId].layerId;
    for (const id of roots) for (const objId of [id, ...descendantsOf(doc, id)]) doc.objects[objId].layerId = layerId;
    refreshGroupBounds(doc, target.groupId);
    refreshAncestors(doc, target.groupId);
  }
}

/** Retire un identifiant de la liste d'enfants de son parent (page ou groupe). */
function detach(doc: LayoutDocument, id: Id): void {
  const list = siblingsListOf(doc, id);
  if (!list) return;
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

/** Supprime des objets et leurs descendants ; un groupe vidé disparaît aussi. */
export function removeObjects(doc: LayoutDocument, ids: Id[]): void {
  const roots = rootsOf(doc, ids);
  const parents = new Set<Id>();
  // Blocs chaînés (4.12) : les voisins se rejoignent, l'article passe au premier bloc qui reste.
  detachChains(doc, new Set(roots.flatMap((id) => [id, ...descendantsOf(doc, id)])));
  for (const id of roots) {
    const parent = parentOf(doc, id);
    const doomed = [id, ...descendantsOf(doc, id)];
    detach(doc, id);
    for (const d of doomed) delete doc.objects[d];
    if (parent) parents.add(parent);
  }
  for (const g of parents) {
    const group = doc.objects[g];
    if (group?.type !== 'group') continue;
    if (group.children.length === 0) removeObjects(doc, [g]);
    else {
      refreshGroupBounds(doc, g);
      refreshAncestors(doc, g);
    }
  }
}

// ---------------------------------------------------------------- copier, dupliquer

export interface ClipboardContent {
  /** Racines et descendants, copies profondes. */
  objects: DocObject[];
  roots: Id[];
  /** Page d'origine, pour décaler un collage sur la même face. */
  sourcePageId: Id | null;
}

/** Copie profonde (valeurs JSON) de racines et de leurs descendants, identifiants inchangés. */
export function extractObjects(doc: LayoutDocument, ids: Id[]): ClipboardContent {
  const roots = sortByStacking(doc, rootsOf(doc, ids));
  const objects: DocObject[] = [];
  for (const id of roots) for (const objId of [id, ...descendantsOf(doc, id)]) objects.push(JSON.parse(JSON.stringify(doc.objects[objId])));
  return { objects, roots, sourcePageId: roots.length ? pageIdOf(doc, roots[0]) : null };
}

/** Nouveaux identifiants pour un lot d'objets (et les références entre eux), décalés de dx, dy mm. */
export function reidentify(doc: LayoutDocument, content: ClipboardContent, dx = 0, dy = 0): ClipboardContent {
  const reserved = new Set<string>();
  const map = new Map<Id, Id>();
  for (const obj of content.objects) map.set(obj.id, newObjectId(doc, obj.type, reserved));
  const objects = content.objects.map((src) => {
    const obj = JSON.parse(JSON.stringify(src)) as DocObject;
    obj.id = map.get(src.id)!;
    if (obj.type === 'group') obj.children = obj.children.map((c) => map.get(c) ?? c);
    // Chaînage (4.12) : gardé entre blocs copiés ensemble, rompu vers un bloc resté en place.
    if (obj.type === 'text' && obj.nextId !== undefined) {
      if (map.has(obj.nextId)) obj.nextId = map.get(obj.nextId)!;
      else delete obj.nextId;
    }
    if (dx) obj.x = round4(obj.x + dx);
    if (dy) obj.y = round4(obj.y + dy);
    return obj;
  });
  return { objects, roots: content.roots.map((r) => map.get(r)!), sourcePageId: content.sourcePageId };
}

/** Ordre d'empilement de racines d'un même parent (sinon ordre du document). */
export function sortByStacking(doc: LayoutDocument, ids: Id[]): Id[] {
  const rank = (id: Id) => {
    const list = siblingsListOf(doc, id);
    return list ? list.indexOf(id) : 0;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

/**
 * Duplique des objets (groupes compris) juste au-dessus de chacun des originaux, décalés de dx, dy mm.
 * Renvoie les identifiants des copies, dans l'ordre des originaux.
 */
export function duplicateObjects(doc: LayoutDocument, ids: Id[], dx: number, dy: number): Id[] {
  const roots = sortByStacking(doc, rootsOf(doc, ids));
  const created: Id[] = [];
  for (const id of roots) {
    const copy = reidentify(doc, extractObjects(doc, [id]), dx, dy);
    const list = siblingsListOf(doc, id);
    const parent = parentOf(doc, id);
    const pageId = pageIdOf(doc, id)!;
    addObjects(doc, copy.objects, copy.roots, { pageId, groupId: parent, index: list ? list.indexOf(id) + 1 : undefined });
    created.push(...copy.roots);
  }
  return created;
}

// ---------------------------------------------------------------- grouper

/** Calque le plus haut parmi ceux des objets (un groupe ne vit que sur un calque). */
function topmostLayer(doc: LayoutDocument, ids: Id[]): Layer | undefined {
  const used = new Set(ids.map((id) => doc.objects[id]?.layerId));
  return [...doc.layers].reverse().find((l) => used.has(l.id));
}

/**
 * Groupe des objets d'une même face (et d'un même parent). Des objets de calques différents passent
 * sur le plus haut d'entre eux, comme dans InDesign. Renvoie l'identifiant du groupe, ou null.
 */
export function groupObjects(doc: LayoutDocument, ids: Id[], options: { id?: Id; name?: string } = {}): Id | null {
  const roots = sortByStacking(doc, rootsOf(doc, ids));
  if (roots.length === 0) return null;
  const pageId = pageIdOf(doc, roots[0]);
  const parent = parentOf(doc, roots[0]);
  if (!pageId || roots.some((id) => pageIdOf(doc, id) !== pageId || parentOf(doc, id) !== parent)) return null;
  const layer = topmostLayer(doc, roots);
  if (!layer) return null;
  const list = siblingsListOf(doc, roots[0])!;
  // Le groupe prend la place du plus haut des objets groupés.
  const topIndex = Math.max(...roots.map((id) => list.indexOf(id)));
  const box = unionBoxes(roots.map((id) => objectBounds(doc.objects[id])))!;
  const id = options.id ?? newObjectId(doc, 'group');
  for (const r of roots) for (const objId of [r, ...descendantsOf(doc, r)]) doc.objects[objId].layerId = layer.id;
  const group: GroupObject = {
    id,
    type: 'group',
    name: options.name ?? 'Groupe',
    layerId: layer.id,
    x: round4(box.x),
    y: round4(box.y),
    w: round4(box.w),
    h: round4(box.h),
    children: [...roots],
  };
  doc.objects[id] = group;
  const insertAt = topIndex - (roots.length - 1);
  for (const r of roots) list.splice(list.indexOf(r), 1);
  list.splice(Math.max(0, insertAt), 0, id);
  refreshGroupBounds(doc, id);
  if (parent) refreshAncestors(doc, id);
  return id;
}

/** Dissocie des groupes : leurs enfants prennent leur place. Renvoie les enfants libérés. */
export function ungroupObjects(doc: LayoutDocument, ids: Id[]): Id[] {
  const freed: Id[] = [];
  for (const id of rootsOf(doc, ids)) {
    const group = doc.objects[id];
    if (group?.type !== 'group') continue;
    const list = siblingsListOf(doc, id);
    if (!list) continue;
    const at = list.indexOf(id);
    const children = [...group.children];
    // Opacité du groupe reportée sur ses enfants : le rendu ne change pas.
    if (group.opacity !== undefined && group.opacity < 1) {
      for (const c of children) {
        const child = doc.objects[c];
        child.opacity = round4((child.opacity ?? 1) * group.opacity);
      }
    }
    list.splice(at, 1, ...children);
    delete doc.objects[id];
    freed.push(...children);
    const parent = parentOf(doc, children[0]);
    if (parent) refreshAncestors(doc, children[0]);
  }
  return freed;
}

// ---------------------------------------------------------------- ordre, calques

export type ReorderMode = 'front' | 'back' | 'forward' | 'backward';

/** Change l'ordre d'empilement dans la liste du parent (premier plan, arrière-plan, un cran). */
export function reorderObjects(doc: LayoutDocument, ids: Id[], mode: ReorderMode): void {
  const roots = rootsOf(doc, ids);
  const byList = new Map<Id[], Id[]>();
  for (const id of roots) {
    const list = siblingsListOf(doc, id);
    if (!list) continue;
    if (!byList.has(list)) byList.set(list, []);
    byList.get(list)!.push(id);
  }
  for (const [list, moving] of byList) {
    const set = new Set(moving);
    if (mode === 'front' || mode === 'back') {
      const kept = list.filter((id) => !set.has(id));
      const ordered = list.filter((id) => set.has(id));
      list.splice(0, list.length, ...(mode === 'front' ? [...kept, ...ordered] : [...ordered, ...kept]));
      continue;
    }
    // Un cran : on passe le voisin du même calque (l'empilement se fait calque par calque) ; un voisin
    // lui-même déplacé bloque, pour que deux objets voisins montent ensemble sans se croiser.
    const sameLayer = (a: Id, b: Id) => doc.objects[a]?.layerId === doc.objects[b]?.layerId;
    if (mode === 'forward') {
      for (let i = list.length - 1; i >= 0; i--) {
        if (!set.has(list[i])) continue;
        let j = i + 1;
        while (j < list.length && !sameLayer(list[j], list[i])) j++;
        if (j >= list.length || set.has(list[j])) continue;
        const [item] = list.splice(i, 1);
        list.splice(j, 0, item);
      }
    } else {
      for (let i = 0; i < list.length; i++) {
        if (!set.has(list[i])) continue;
        let j = i - 1;
        while (j >= 0 && !sameLayer(list[j], list[i])) j--;
        if (j < 0 || set.has(list[j])) continue;
        const [item] = list.splice(i, 1);
        list.splice(j, 0, item);
      }
    }
  }
}

/** Fait passer des objets de premier niveau (et leurs descendants) sur un autre calque, au-dessus. */
export function setObjectsLayer(doc: LayoutDocument, ids: Id[], layerId: Id): void {
  if (!doc.layers.some((l) => l.id === layerId)) return;
  for (const id of rootsOf(doc, ids)) {
    // Un enfant de groupe suit le calque de son groupe : c'est le groupe entier qui change de calque.
    const top = [id, ...ancestorsOf(doc, id)].at(-1)!;
    for (const objId of [top, ...descendantsOf(doc, top)]) doc.objects[objId].layerId = layerId;
    const page = pageOf(doc, top);
    if (page) {
      page.children.splice(page.children.indexOf(top), 1);
      page.children.push(top);
    }
  }
}

/** Page (ou page type, 4.11) par identifiant, erreur explicite sinon. */
export function getPage(doc: LayoutDocument, pageId: Id): Page | MasterPage {
  const page = findPageOrMaster(doc, pageId);
  if (!page) throw new Error(`Page inconnue : ${pageId}`);
  return page;
}
