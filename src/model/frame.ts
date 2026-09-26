// Placement d'une photo dans un cadre. La boîte de la photo (mm, relative au coin du cadre) garde
// toujours le rapport largeur / hauteur des pixels : le rendu peut alors poser l'image avec
// preserveAspectRatio="none" sans jamais la déformer.
import type { FrameImage, ImageFit, Mm } from './types';
import { MM_PER_INCH } from './units';

export interface ImageBox {
  x: Mm;
  y: Mm;
  w: Mm;
  h: Mm;
}

/** Résolution de référence du mode « Centrer » : la taille d'impression nominale d'une photo. */
export const CENTER_PPI = 300;

/**
 * - `fill` : la photo couvre tout le cadre (elle déborde d'un côté), centrée ;
 * - `fit` : la photo tient entière dans le cadre, centrée ;
 * - `center` : taille réelle à 300 ppi, centrée.
 */
export function computeImagePlacement(fit: Exclude<ImageFit, 'custom'>, frameW: Mm, frameH: Mm, imagePxW: number, imagePxH: number): ImageBox {
  if (!(imagePxW > 0 && imagePxH > 0)) throw new Error(`Dimensions d'image invalides : ${imagePxW} × ${imagePxH} px`);
  let w: Mm;
  let h: Mm;
  if (fit === 'center') {
    w = (imagePxW / CENTER_PPI) * MM_PER_INCH;
    h = (imagePxH / CENTER_PPI) * MM_PER_INCH;
  } else {
    const sx = frameW / imagePxW;
    const sy = frameH / imagePxH;
    const s = fit === 'fill' ? Math.max(sx, sy) : Math.min(sx, sy);
    w = imagePxW * s;
    h = imagePxH * s;
  }
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h };
}

/**
 * Nouvelle place de la photo quand le cadre passe de `from` à `to` (tailles en mm).
 * Les modes automatiques sont recalculés ; un recadrage manuel (`custom`) est agrandi ou réduit
 * uniformément (le plus grand des deux rapports, pour ne pas découvrir le fond) en gardant le même
 * point de la photo au même endroit relatif du cadre.
 */
export function refitImage(image: FrameImage, from: { w: Mm; h: Mm }, to: { w: Mm; h: Mm }, imagePxW: number, imagePxH: number): FrameImage {
  if (image.fit !== 'custom') return { ...image, ...computeImagePlacement(image.fit, to.w, to.h, imagePxW, imagePxH) };
  const k = Math.max(to.w / from.w, to.h / from.h);
  if (!Number.isFinite(k) || k <= 0) return image;
  const cx = (from.w / 2 - image.x) / image.w;
  const cy = (from.h / 2 - image.y) / image.h;
  const w = image.w * k;
  const h = image.h * k;
  return { ...image, w, h, x: to.w / 2 - cx * w, y: to.h / 2 - cy * h };
}
