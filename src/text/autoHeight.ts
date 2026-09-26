// Hauteur automatique d'un bloc texte (tâche 2.26) : le bloc prend la hauteur de son texte, en gardant
// fixe son bord de référence (haut, milieu ou bas selon l'alignement vertical).
import type { Id, LayoutDocument } from '../model/types';
import { refreshAncestors, round4 } from '../store/commands';

/** Écart en deçà duquel la hauteur n'est pas réécrite (mm). */
export const AUTO_HEIGHT_EPSILON = 0.01;

export function setTextHeight(doc: LayoutDocument, id: Id, height: number): void {
  const obj = doc.objects[id];
  if (obj?.type !== 'text') return;
  const h = round4(Math.max(0, height));
  if (Math.abs(obj.h - h) < AUTO_HEIGHT_EPSILON) return;
  const valign = obj.verticalAlign ?? 'top';
  if (valign === 'bottom') obj.y = round4(obj.y + obj.h - h);
  else if (valign === 'middle') obj.y = round4(obj.y + (obj.h - h) / 2);
  obj.h = h;
  refreshAncestors(doc, id);
}
