// Aligner et répartir (tâche 2.11) : commandes sur un brouillon, composables dans `apply`.
// Les boîtes sont celles que l'on voit (objectBounds : rotation comprise, groupe = union de ses enfants),
// en mm dans le repère de la face. Référence « sélection » : la boîte commune des objets ; « volet » : le
// volet (format fini, entre deux plis) qui contient le centre de la sélection.
import { findPageOrMaster } from '../model/masters';
import { faceSize, getFace } from '../model/format';
import type { Id, LayoutDocument } from '../model/types';
import { moveObjects } from '../store/commands';
import { objectBounds, pageIdOf, rootsOf, unionBoxes, type Box } from '../store/tree';

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeAxis = 'x' | 'y';
export type AlignReference = 'selection' | 'panel';

/** Volets d'une face au format fini (sans fond perdu), de gauche à droite. */
export function trimPanels(doc: LayoutDocument, pageId: Id): (Box & { name: string })[] {
  const page = findPageOrMaster(doc, pageId);
  if (!page) return [];
  const { bleed, trim } = doc.format;
  let x = bleed;
  return getFace(doc.format, page.faceId).panels.map((panel) => {
    const box = { name: panel.name, x, y: bleed, w: panel.w, h: trim.h };
    x += panel.w;
    return box;
  });
}

/** Volet qui contient un point (le plus proche s'il tombe dans le fond perdu). */
export function panelAt(doc: LayoutDocument, pageId: Id, x: number): (Box & { name: string }) | null {
  const panels = trimPanels(doc, pageId);
  if (!panels.length) return null;
  const inside = panels.find((p) => x >= p.x && x < p.x + p.w);
  if (inside) return inside;
  return x < panels[0].x ? panels[0] : panels[panels.length - 1];
}

const boxesOf = (doc: LayoutDocument, ids: Id[]) =>
  rootsOf(doc, ids)
    .filter((id) => doc.objects[id])
    .map((id) => ({ id, box: objectBounds(doc.objects[id]) }));

/** Boîte de référence d'un alignement, ou null (sélection vide). */
export function referenceBox(doc: LayoutDocument, ids: Id[], reference: AlignReference): Box | null {
  const items = boxesOf(doc, ids);
  const union = unionBoxes(items.map((i) => i.box));
  if (!union) return null;
  if (reference === 'selection') return union;
  const pageId = pageIdOf(doc, items[0].id);
  if (!pageId) return null;
  const panel = panelAt(doc, pageId, union.x + union.w / 2);
  if (panel) return panel;
  const face = faceSize(doc.format);
  return { x: 0, y: 0, w: face.w, h: face.h };
}

/** Aligne des objets sur un bord ou un axe de la référence. */
export function alignObjects(doc: LayoutDocument, ids: Id[], mode: AlignMode, reference: AlignReference): void {
  const ref = referenceBox(doc, ids, reference);
  if (!ref) return;
  for (const { id, box } of boxesOf(doc, ids)) {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case 'left':
        dx = ref.x - box.x;
        break;
      case 'hcenter':
        dx = ref.x + ref.w / 2 - (box.x + box.w / 2);
        break;
      case 'right':
        dx = ref.x + ref.w - (box.x + box.w);
        break;
      case 'top':
        dy = ref.y - box.y;
        break;
      case 'vcenter':
        dy = ref.y + ref.h / 2 - (box.y + box.h / 2);
        break;
      case 'bottom':
        dy = ref.y + ref.h - (box.y + box.h);
        break;
    }
    moveObjects(doc, [id], dx, dy);
  }
}

/** Nombre minimal d'objets pour répartir : 3 dans la sélection (les extrêmes restent), 1 dans le volet. */
export const minForDistribute = (reference: AlignReference): number => (reference === 'selection' ? 3 : 1);

/**
 * Répartit les ESPACEMENTS : tous les intervalles entre objets voisins deviennent égaux.
 * - référence « sélection » : les deux objets extrêmes restent en place ;
 * - référence « volet » : les marges au bord du volet valent aussi l'intervalle (n + 1 espaces égaux).
 */
export function distributeObjects(doc: LayoutDocument, ids: Id[], axis: DistributeAxis, reference: AlignReference): void {
  const items = boxesOf(doc, ids);
  if (items.length < minForDistribute(reference)) return;
  const pos = (b: Box) => (axis === 'x' ? b.x : b.y);
  const size = (b: Box) => (axis === 'x' ? b.w : b.h);
  // Ordre de lecture : par bord de départ, puis par centre (deux objets alignés à gauche).
  items.sort((a, b) => pos(a.box) - pos(b.box) || pos(a.box) + size(a.box) / 2 - (pos(b.box) + size(b.box) / 2));
  const total = items.reduce((s, i) => s + size(i.box), 0);
  let start: number;
  let gap: number;
  if (reference === 'selection') {
    start = Math.min(...items.map((i) => pos(i.box)));
    const end = Math.max(...items.map((i) => pos(i.box) + size(i.box)));
    gap = (end - start - total) / (items.length - 1);
  } else {
    const ref = referenceBox(doc, ids, 'panel')!;
    gap = ((axis === 'x' ? ref.w : ref.h) - total) / (items.length + 1);
    start = (axis === 'x' ? ref.x : ref.y) + gap;
  }
  let cursor = start;
  for (const { id, box } of items) {
    const delta = cursor - pos(box);
    moveObjects(doc, [id], axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
    cursor += size(box) + gap;
  }
}

/** Intervalles entre objets voisins le long d'un axe (contrôle et tests). */
export function gapsBetween(doc: LayoutDocument, ids: Id[], axis: DistributeAxis): number[] {
  const boxes = boxesOf(doc, ids).map((i) => i.box);
  const pos = (b: Box) => (axis === 'x' ? b.x : b.y);
  const size = (b: Box) => (axis === 'x' ? b.w : b.h);
  boxes.sort((a, b) => pos(a) - pos(b));
  return boxes.slice(1).map((b, i) => pos(b) - (pos(boxes[i]) + size(boxes[i])));
}
