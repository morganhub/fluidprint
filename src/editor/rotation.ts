// Rotation des objets (tâche 2.12) : commandes sur un brouillon Immer, utilisées par la poignée de
// rotation (Transformer.tsx) et le champ Angle (panels/properties/RotationSection.tsx).
// Angle en degrés, sens horaire, autour du centre de la boîte (`BaseObject.rotation`), ramené dans
// ]-180, 180]. Un groupe n'a pas d'angle propre (il n'est qu'un conteneur) : le faire pivoter fait
// pivoter chacun de ses objets autour du centre du groupe, et sa boîte est recalculée.
import type { DocObject, Id, LayoutDocument, Mm } from '../model/types';
import { refreshAncestors, refreshGroupBounds, round4 } from '../store/commands';
import { descendantsOf, objectBounds, rootsOf, unionBoxes } from '../store/tree';

/** Angle ramené dans ]-180, 180], au 1/10 000 de degré. */
export function normalizeAngle(a: number): number {
  let r = ((a % 360) + 360) % 360;
  if (r > 180) r -= 360;
  r = Math.round(r * 1e4) / 1e4;
  return r === 0 ? 0 : r;
}

/** Objets qui portent réellement un angle : l'objet lui-même, ou les objets d'un groupe. */
export function rotationLeaves(doc: LayoutDocument, id: Id): DocObject[] {
  const obj = doc.objects[id];
  if (!obj) return [];
  if (obj.type !== 'group') return [obj];
  return descendantsOf(doc, id)
    .map((d) => doc.objects[d])
    .filter((o): o is DocObject => !!o && o.type !== 'group');
}

/** Angle affiché d'un objet ; pour un groupe, celui de ses objets s'ils ont tous le même, sinon null. */
export function angleOf(doc: LayoutDocument, id: Id): number | null {
  const leaves = rotationLeaves(doc, id);
  if (!leaves.length) return null;
  const first = normalizeAngle(leaves[0].rotation ?? 0);
  return leaves.every((o) => Math.abs(normalizeAngle(o.rotation ?? 0) - first) < 1e-6) ? first : null;
}

/** Centre de la boîte (englobante, rotation comprise pour un groupe) d'un objet, en mm. */
export function rotationCenter(doc: LayoutDocument, ids: Id[]): { x: Mm; y: Mm } | null {
  const box = unionBoxes(ids.map((id) => doc.objects[id]).filter(Boolean).map((o) => (o.type === 'group' ? o : objectBounds(o))));
  return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null;
}

function rotateLeaf(obj: DocObject, delta: number, pivot: { x: Mm; y: Mm }): void {
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const a = (delta * Math.PI) / 180;
  const dx = cx - pivot.x;
  const dy = cy - pivot.y;
  // Repère écran (y vers le bas) : un angle positif tourne dans le sens horaire, comme CSS rotate().
  const nx = pivot.x + dx * Math.cos(a) - dy * Math.sin(a);
  const ny = pivot.y + dx * Math.sin(a) + dy * Math.cos(a);
  // Seules les valeurs modifiées sont écrites : un objet qui tourne sur lui-même garde x et y au bit près.
  if (Math.abs(nx - cx) > 1e-7) obj.x = round4(nx - obj.w / 2);
  if (Math.abs(ny - cy) > 1e-7) obj.y = round4(ny - obj.h / 2);
  const r = normalizeAngle((obj.rotation ?? 0) + delta);
  if (r === 0) delete obj.rotation;
  else obj.rotation = r;
}

/**
 * Fait pivoter des objets de `delta` degrés. `pivot` : centre commun (poignée sur une sélection
 * multiple) ; absent, chaque objet pivote autour de son propre centre (champ Angle).
 */
export function rotateObjects(doc: LayoutDocument, ids: Id[], delta: number, pivot?: { x: Mm; y: Mm }): void {
  if (!delta) return;
  for (const id of rootsOf(doc, ids)) {
    const obj = doc.objects[id];
    if (!obj) continue;
    const center = pivot ?? rotationCenter(doc, [id]);
    if (!center) continue;
    for (const leaf of rotationLeaves(doc, id)) rotateLeaf(leaf, delta, center);
    if (obj.type === 'group') {
      for (const g of [id, ...descendantsOf(doc, id)].reverse()) if (doc.objects[g]?.type === 'group') refreshGroupBounds(doc, g);
    }
    refreshAncestors(doc, id);
  }
}

/** Donne un angle absolu à chaque objet (autour de son centre) ; un groupe d'angles mêlés pivote de `angle`. */
export function setRotation(doc: LayoutDocument, ids: Id[], angle: number): void {
  for (const id of rootsOf(doc, ids)) {
    const current = angleOf(doc, id) ?? 0;
    rotateObjects(doc, [id], normalizeAngle(angle - current));
  }
}
