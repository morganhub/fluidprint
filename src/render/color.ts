import type { ColorRef, LayoutDocument } from '../model/types';

// Couleur de repli bien visible : une référence cassée doit se voir à l'écran, pas passer inaperçue.
const MISSING = '#ff00ff';

/** Couleur CSS d'une référence au nuancier ; une teinte < 1 est mélangée au blanc (comme une trame). */
export function colorCss(doc: Pick<LayoutDocument, 'swatches'>, ref: ColorRef | undefined): string | undefined {
  if (!ref) return undefined;
  const swatch = doc.swatches.find((s) => s.id === ref.swatch);
  if (!swatch) return MISSING;
  const tint = ref.tint ?? 1;
  if (tint >= 1) return swatch.rgb;
  const channel = (i: number) => {
    const v = parseInt(swatch.rgb.slice(1 + 2 * i, 3 + 2 * i), 16);
    return Math.round(255 - (255 - v) * Math.max(0, tint));
  };
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, '0')).join('')}`;
}
