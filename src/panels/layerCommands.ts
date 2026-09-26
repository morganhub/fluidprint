// Commandes du panneau Calques (tâche 2.4) : fonctions qui modifient un brouillon (voir store/commands.ts).
// Rappel du modèle : les calques vont du dessous vers le dessus ; une face empile ses objets calque par
// calque, puis dans l'ordre de `page.children` ; un enfant de groupe vit sur le calque de son groupe.
import type { Id, Layer, LayoutDocument } from '../model/types';
import { refreshAncestors, refreshGroupBounds, removeObjects } from '../store/commands';
import { ancestorsOf, descendantsOf, isWithin, pageIdOf, parentOf, siblingsListOf } from '../store/tree';

/** Couleurs de cadre de sélection proposées pour un calque (comme InDesign). */
export const LAYER_COLORS = ['#2563eb', '#e0245e', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#c9a100', '#8a94a6', '#1a1a1a'];

export function newLayerId(doc: LayoutDocument): Id {
  for (let n = doc.layers.length + 1; ; n++) {
    const id = `calque-${n}`;
    if (!doc.layers.some((l) => l.id === id)) return id;
  }
}

/** Nouveau calque, au-dessus de tous les autres ; renvoie son identifiant. */
export function addLayer(doc: LayoutDocument, name?: string): Id {
  const id = newLayerId(doc);
  const used = new Set(doc.layers.map((l) => l.color));
  const color = LAYER_COLORS.find((c) => !used.has(c)) ?? LAYER_COLORS[doc.layers.length % LAYER_COLORS.length];
  let label = name?.trim() || `Calque ${doc.layers.length + 1}`;
  for (let n = 2; doc.layers.some((l) => l.name === label); n++) label = `${name?.trim() || 'Calque'} ${n}`;
  doc.layers.push({ id, name: label, visible: true, locked: false, printable: true, color });
  return id;
}

export function updateLayer(doc: LayoutDocument, id: Id, patch: Partial<Omit<Layer, 'id'>>): void {
  const layer = doc.layers.find((l) => l.id === id);
  if (!layer) return;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'name') {
      const name = String(value).trim();
      if (name) layer.name = name;
    } else if (value !== undefined) (layer as unknown as Record<string, unknown>)[key] = value;
  }
}

/** Place un calque au rang `toIndex` (0 = tout en dessous). */
export function moveLayer(doc: LayoutDocument, id: Id, toIndex: number): void {
  const from = doc.layers.findIndex((l) => l.id === id);
  if (from < 0) return;
  const [layer] = doc.layers.splice(from, 1);
  doc.layers.splice(Math.max(0, Math.min(doc.layers.length, toIndex)), 0, layer);
}

/** Objets de premier niveau d'un calque (toutes faces). */
export function layerRoots(doc: LayoutDocument, layerId: Id): Id[] {
  return doc.pages.flatMap((p) => p.children.filter((id) => doc.objects[id]?.layerId === layerId));
}

/**
 * Supprime un calque. Ses objets passent sur `targetId` (au-dessus de ceux qui y sont déjà, ordre
 * gardé), ou disparaissent si `targetId` est absent. Le dernier calque ne se supprime pas.
 */
export function removeLayer(doc: LayoutDocument, id: Id, targetId?: Id): void {
  if (doc.layers.length <= 1) throw new Error('Un document garde au moins un calque');
  const roots = layerRoots(doc, id);
  if (targetId && targetId !== id && doc.layers.some((l) => l.id === targetId)) {
    for (const root of roots) {
      for (const objId of [root, ...descendantsOf(doc, root)]) doc.objects[objId].layerId = targetId;
      const page = doc.pages.find((p) => p.children.includes(root))!;
      page.children.splice(page.children.indexOf(root), 1);
      page.children.push(root);
    }
  } else if (roots.length) {
    removeObjects(doc, roots);
  }
  doc.layers.splice(
    doc.layers.findIndex((l) => l.id === id),
    1,
  );
}

// ---------------------------------------------------------------- glisser-déposer d'objets

export type ObjectDropTarget =
  /** Au-dessus (à l'écran) ou au-dessous d'un objet, dans la même liste que lui et sur son calque. */
  | { type: 'object'; targetId: Id; position: 'above' | 'below' }
  /** Dans un groupe, au-dessus de ses enfants. */
  | { type: 'group'; groupId: Id }
  /** En haut d'un calque, sur une face (celle de l'objet si absente). */
  | { type: 'layer'; layerId: Id; pageId?: Id };

/** Vrai si le dépôt a un sens (pas dans soi-même, même face pour un dépôt contre un objet). */
export function canDropObject(doc: LayoutDocument, id: Id, target: ObjectDropTarget): boolean {
  if (!doc.objects[id]) return false;
  switch (target.type) {
    case 'object':
      return !!doc.objects[target.targetId] && !isWithin(doc, target.targetId, id) && pageIdOf(doc, target.targetId) === pageIdOf(doc, id);
    case 'group':
      return doc.objects[target.groupId]?.type === 'group' && !isWithin(doc, target.groupId, id) && pageIdOf(doc, target.groupId) === pageIdOf(doc, id);
    case 'layer':
      return doc.layers.some((l) => l.id === target.layerId) && (!target.pageId || doc.pages.some((p) => p.id === target.pageId));
  }
}

/**
 * Déplace un objet dans l'arborescence (panneau Calques) : il prend le calque de sa destination, donc
 * passe dessus ou dessous à l'écran. Un groupe quitté est recalculé (supprimé s'il est vide).
 * Renvoie vrai si quelque chose a bougé.
 */
export function moveObjectTo(doc: LayoutDocument, id: Id, target: ObjectDropTarget): boolean {
  if (!canDropObject(doc, id, target)) return false;
  if (target.type === 'object' && target.targetId === id) return false;
  const oldParent = parentOf(doc, id);
  const oldList = siblingsListOf(doc, id);
  const pageId = pageIdOf(doc, id)!;
  if (!oldList) return false;

  let list: Id[];
  let index: number;
  let layerId: Id;
  let newParent: Id | null;
  // Retiré d'abord : l'index de la destination se lit ensuite dans la liste à jour.
  oldList.splice(oldList.indexOf(id), 1);
  if (target.type === 'object') {
    newParent = parentOf(doc, target.targetId);
    list = siblingsListOf(doc, target.targetId)!;
    index = list.indexOf(target.targetId) + (target.position === 'above' ? 1 : 0);
    layerId = doc.objects[target.targetId].layerId;
  } else if (target.type === 'group') {
    newParent = target.groupId;
    const group = doc.objects[target.groupId];
    list = group.type === 'group' ? group.children : [];
    index = list.length;
    layerId = group.layerId;
  } else {
    newParent = null;
    list = doc.pages.find((p) => p.id === (target.pageId ?? pageId))!.children;
    index = list.length;
    layerId = target.layerId;
  }
  list.splice(index, 0, id);
  for (const objId of [id, ...descendantsOf(doc, id)]) doc.objects[objId].layerId = layerId;
  // Un groupe et ses enfants partagent un calque : déposer dans un groupe d'un autre calque est
  // impossible par construction (le calque suit la destination) ; les ancêtres suivent leur boîte.
  if (newParent) {
    refreshGroupBounds(doc, newParent);
    refreshAncestors(doc, newParent);
  }
  if (oldParent && oldParent !== newParent && doc.objects[oldParent]) {
    const group = doc.objects[oldParent];
    if (group.type === 'group' && group.children.length === 0) removeObjects(doc, [oldParent]);
    else {
      refreshGroupBounds(doc, oldParent);
      refreshAncestors(doc, oldParent);
    }
  }
  return true;
}

/** Profondeur d'un objet dans l'arborescence (0 = premier niveau d'une face). */
export const depthOf = (doc: LayoutDocument, id: Id): number => ancestorsOf(doc, id).length;
