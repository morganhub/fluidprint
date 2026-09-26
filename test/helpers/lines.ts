// Lignes de texte rendues d'un bloc, lues dans la page (éditeur, route d'impression) : même regroupement
// par ordonnée que render/lineCount.ts, positions en mm dans le repère de la face (indépendantes du zoom).
import type { Page } from 'puppeteer-core';

export interface RenderedLine {
  top: number;
  bottom: number;
  left: number;
  right: number;
  text: string;
}

/** Lignes du bloc `id` rendu dans la face `faceSelector` (par défaut, la première qui le contient). */
export function renderedLines(page: Page, id: string, faceSelector = '[data-page-id]'): Promise<RenderedLine[]> {
  return page.evaluate(
    (objId, faceSel) => {
      const el = [...document.querySelectorAll<HTMLElement>(`${faceSel} [data-obj-id="${objId}"]`)].find((e) => e.closest('[data-page-id]'));
      if (!el) return [];
      const face = el.closest<HTMLElement>('[data-page-id]')!;
      const fr = face.getBoundingClientRect();
      const k = (fr.width / parseFloat(getComputedStyle(face).width)) * (96 / 25.4);
      const items: { r: DOMRect; text: string }[] = [];
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (let i = 0; i < text.length; i++) {
          if (!text[i].trim()) continue;
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) items.push({ r, text: text[i] });
        }
      }
      items.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
      const lines: { top: number; bottom: number; left: number; right: number; text: string }[] = [];
      for (const { r, text } of items) {
        const mid = (r.top + r.bottom) / 2;
        const last = lines.at(-1);
        if (last && mid <= last.bottom) {
          last.bottom = Math.max(last.bottom, r.bottom);
          last.left = Math.min(last.left, r.left);
          last.right = Math.max(last.right, r.right);
          last.text += text;
        } else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, text });
      }
      const mm = (v: number, o: number) => (v - o) / k;
      return lines.map((l) => ({ top: mm(l.top, fr.top), bottom: mm(l.bottom, fr.top), left: mm(l.left, fr.left), right: mm(l.right, fr.left), text: l.text }));
    },
    id,
    faceSelector,
  );
}
