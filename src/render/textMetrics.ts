// Mesure des blocs texte rendus à l'écran (tâche 2.26) : hauteur réelle du texte, nombre de lignes.
// Le rendu publie ses mesures ; l'éditeur s'y abonne (texte en excès, hauteur automatique). Sans
// abonné (visionneuse, route d'impression), rien n'est mesuré.
import { PX_PER_MM } from '../model/units';
import { countRenderedLines } from './lineCount';

export interface TextMeasurement {
  id: string;
  /** Hauteur occupée par le texte, en mm (marges des paragraphes comprises). */
  contentH: number;
  /** Nombre de lignes rendues. */
  lines: number;
  /** Étendue réelle du texte (mm, repère du bloc non tourné) : le contrôle en amont (4.8) la compare à la zone de sécurité. */
  ink?: { x: number; y: number; w: number; h: number } | null;
  /** Vrai si le bloc est habillé (4.13) : ses coupures dépendent d'autres objets. */
  wrapped?: boolean;
}

type Listener = (m: TextMeasurement) => void;
const listeners = new Set<Listener>();

export function subscribeTextMeasurements(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const hasTextMeasureListeners = (): boolean => listeners.size > 0;

export function reportTextMeasurement(m: TextMeasurement): void {
  for (const l of listeners) l(m);
}

/**
 * Hauteur du texte (mm) d'un bloc dont `container` contient les paragraphes, indépendante du zoom :
 * l'échelle d'affichage est déduite de la largeur connue du bloc (`boxW`, mm).
 */
export function measureTextContentMm(el: HTMLElement, container: HTMLElement, boxW: number): number {
  const saved = el.style.transform;
  // Une rotation fausserait les boîtes : neutralisée le temps de la mesure (la mise en page n'en dépend pas).
  if (saved && /rotate/.test(saved)) el.style.transform = saved.replace(/rotate\([^)]*\)/g, '').trim() || 'none';
  try {
    // Les flottants d'habillage (4.13) ne sont pas du texte : ils n'entrent pas dans la hauteur.
    const paras = [...container.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.tagName !== 'STYLE' && !c.hasAttribute('data-wrap-float'));
    if (!paras.length) return 0;
    const box = el.getBoundingClientRect();
    const scale = boxW > 0 && box.width > 0 ? box.width / (boxW * PX_PER_MM) : 1;
    const first = paras[0];
    const last = paras[paras.length - 1];
    const mt = parseFloat(getComputedStyle(first).marginTop) || 0;
    const mb = parseFloat(getComputedStyle(last).marginBottom) || 0;
    const top = first.getBoundingClientRect().top - mt * scale;
    const bottom = last.getBoundingClientRect().bottom + mb * scale;
    return (bottom - top) / scale / PX_PER_MM;
  } finally {
    if (saved) el.style.transform = saved;
  }
}

/**
 * Étendue des lignes de texte d'un bloc (union des boîtes des nœuds texte), en mm dans le repère du bloc,
 * indépendante du zoom ; null s'il n'y a aucun texte visible.
 */
export function measureTextInkMm(el: HTMLElement, boxW: number): { x: number; y: number; w: number; h: number } | null {
  const saved = el.style.transform;
  if (saved && /rotate/.test(saved)) el.style.transform = saved.replace(/rotate\([^)]*\)/g, '').trim() || 'none';
  try {
    const box = el.getBoundingClientRect();
    const scale = boxW > 0 && box.width > 0 ? box.width / (boxW * PX_PER_MM) : 1;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (!(r.width > 0 && r.height > 0)) continue;
        x0 = Math.min(x0, r.left);
        y0 = Math.min(y0, r.top);
        x1 = Math.max(x1, r.right);
        y1 = Math.max(y1, r.bottom);
      }
    }
    if (x0 === Infinity) return null;
    const k = scale * PX_PER_MM;
    return { x: (x0 - box.left) / k, y: (y0 - box.top) / k, w: (x1 - x0) / k, h: (y1 - y0) / k };
  } finally {
    if (saved) el.style.transform = saved;
  }
}

/** Mesure complète d'un bloc rendu. */
export function measureTextElement(id: string, el: HTMLElement, boxW: number): TextMeasurement {
  return { id, contentH: measureTextContentMm(el, el, boxW), lines: countRenderedLines(el), ink: measureTextInkMm(el, boxW), wrapped: !!el.querySelector(':scope > [data-wrap-float]') };
}
