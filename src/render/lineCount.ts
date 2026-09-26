// Comptage des lignes réellement rendues d'un bloc texte. Sert à la route d'impression
// (window.__lineCounts, comparé par l'export au nombre mesuré à l'import) et à la visionneuse.

/**
 * Boîtes de texte (Range.getClientRects, nœud texte par nœud texte pour ne pas ramasser les boîtes
 * des paragraphes), regroupées par ordonnée : une boîte dont le milieu tombe dans la hauteur de la
 * ligne en cours appartient à cette ligne (segments de corps différents sur une même ligne).
 */
export function countRenderedLines(el: HTMLElement): number {
  // Une rotation rendrait les boîtes obliques : on la neutralise le temps de la mesure (la mise en
  // page, donc les coupures, n'en dépend pas).
  const savedTransform = el.style.transform;
  if (savedTransform) el.style.transform = 'none';
  try {
    const rects: DOMRect[] = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
    }
    rects.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
    let lines = 0;
    let bottom = -Infinity;
    for (const r of rects) {
      const middle = (r.top + r.bottom) / 2;
      if (middle > bottom) {
        lines++;
        bottom = r.bottom;
      } else bottom = Math.max(bottom, r.bottom);
    }
    return lines;
  } finally {
    if (savedTransform) el.style.transform = savedTransform;
  }
}

/** Nombre de lignes de chaque bloc texte rendu sous `root`, par identifiant d'objet. */
export function measureLineCounts(root: ParentNode = document): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of root.querySelectorAll<HTMLElement>('[data-obj-type="text"][data-obj-id]')) {
    out[el.dataset.objId!] = countRenderedLines(el);
  }
  return out;
}
