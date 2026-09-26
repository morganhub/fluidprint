// Photos des cadres : résolution effective, seuils d'alerte, usages, recadrage (tâches 3.1, 3.2, 3.6).
// Tout est en mm, dans le repère du cadre (coin haut-gauche du cadre), comme `FrameImage`.
import { computeImagePlacement, type ImageBox } from './frame';
import type { Asset, DocObject, FrameImage, FrameObject, Id, ImageFit, LayoutDocument, Mm, Page } from './types';
import { effectivePpi, MM_PER_INCH } from './units';

/** Décision I2 : sous 250 ppi, badge orange ; sous 150 ppi, rouge (l'export imprimeur demandera confirmation). */
export const PPI_WARN = 250;
export const PPI_ERROR = 150;

export type PpiLevel = 'ok' | 'warn' | 'error';

export function ppiLevel(ppi: number): PpiLevel {
  if (ppi < PPI_ERROR) return 'error';
  if (ppi < PPI_WARN) return 'warn';
  return 'ok';
}

/**
 * Résolution effective d'une photo placée : pixels de l'original ÷ taille imprimée en pouces. La boîte
 * de la photo garde le rapport de ses pixels ; on prend quand même le plus faible des deux axes.
 * Une photo de 1 200 px posée sur 103 mm : 1 200 × 25,4 / 103 ≈ 296 ppi.
 */
export function imagePpi(image: Pick<FrameImage, 'w' | 'h'>, asset: Pick<Asset, 'width' | 'height'>): number {
  return Math.min(effectivePpi(asset.width, image.w), effectivePpi(asset.height, image.h));
}

/** Taille imprimée (mm) d'une photo à une résolution donnée. */
export const printedSizeMm = (px: number, ppi: number): Mm => (px / ppi) * MM_PER_INCH;

export interface FramePpi {
  frame: FrameObject;
  asset: Asset;
  ppi: number;
  level: PpiLevel;
}

/** Résolution effective d'un cadre ; null sans photo (ou photo introuvable). */
export function framePpi(doc: LayoutDocument, frame: DocObject): FramePpi | null {
  if (frame.type !== 'frame' || !frame.image) return null;
  const asset = doc.assets.find((a) => a.id === frame.image!.assetId);
  if (!asset) return null;
  const ppi = imagePpi(frame.image, asset);
  return { frame, asset, ppi, level: ppiLevel(ppi) };
}

// ---------------------------------------------------------------- usages

export interface AssetUsage {
  frameId: Id;
  /** Nom du cadre (ou son identifiant). */
  name: string;
  pageId: Id | null;
  pageName: string | null;
  ppi: number;
  level: PpiLevel;
}

/** Page de chaque objet (enfants de groupes compris). */
function pagesByObject(doc: LayoutDocument): Map<Id, Page> {
  const map = new Map<Id, Page>();
  const visit = (id: Id, page: Page) => {
    if (map.has(id)) return;
    map.set(id, page);
    const obj = doc.objects[id];
    if (obj?.type === 'group') obj.children.forEach((c) => visit(c, page));
  };
  doc.pages.forEach((page) => page.children.forEach((id) => visit(id, page)));
  return map;
}

/** Où sert chaque photo : cadres, pages et résolution effective (panneau Images). */
export function assetUsages(doc: LayoutDocument): Map<Id, AssetUsage[]> {
  const pages = pagesByObject(doc);
  const out = new Map<Id, AssetUsage[]>(doc.assets.map((a) => [a.id, []]));
  for (const obj of Object.values(doc.objects)) {
    const info = framePpi(doc, obj);
    if (!info) continue;
    const page = pages.get(obj.id) ?? null;
    out.get(info.asset.id)?.push({
      frameId: obj.id,
      name: frameLabel(obj as FrameObject),
      pageId: page?.id ?? null,
      pageName: page?.name ?? null,
      ppi: info.ppi,
      level: info.level,
    });
  }
  return out;
}

/** Nom lisible d'un cadre : « Cadre · Photo de couverture (HD) » devient « Photo de couverture (HD) ». */
export function frameLabel(frame: FrameObject): string {
  return (frame.name ?? frame.placeholder ?? frame.id).replace(/^Cadre\s*·\s*/, '');
}

export interface PlaceholderFrame {
  id: Id;
  name: string;
  page: string | null;
  asset: string;
}

/** Cadres qui portent une photo provisoire (tirée du PDF Canva) : l'export imprimeur les refuse. */
export function placeholderFrames(doc: LayoutDocument): PlaceholderFrame[] {
  const pages = pagesByObject(doc);
  const out: PlaceholderFrame[] = [];
  for (const obj of Object.values(doc.objects)) {
    if (obj.type !== 'frame' || !obj.image || !pages.has(obj.id)) continue;
    const asset = doc.assets.find((a) => a.id === obj.image!.assetId);
    if (asset?.placeholder) out.push({ id: obj.id, name: frameLabel(obj), page: pages.get(obj.id)?.name ?? null, asset: asset.name });
  }
  return out.sort((a, b) => (a.page ?? '').localeCompare(b.page ?? '') || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- placement et recadrage

/** Placement d'une photo neuve dans un cadre (Remplir par défaut : la photo couvre le cadre). */
export function placeImage(frame: Pick<FrameObject, 'w' | 'h'>, asset: Pick<Asset, 'id' | 'width' | 'height'>, fit: Exclude<ImageFit, 'custom'> = 'fill'): FrameImage {
  const box = computeImagePlacement(fit, frame.w, frame.h, asset.width, asset.height);
  return { assetId: asset.id, fit, ...roundBox(box), ...(fit === 'fill' ? { cover: true } : {}) };
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
export const roundBox = (b: ImageBox): ImageBox => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });

/** Vrai si la photo doit couvrir tout le cadre (mode Remplir, même après un recadrage manuel). */
export const mustCover = (image: Pick<FrameImage, 'fit' | 'cover'>): boolean => image.fit === 'fill' || !!image.cover;

/**
 * Contraint une boîte de photo à couvrir un cadre de fw × fh mm : agrandie (autour de son centre) si
 * elle est trop petite, puis recalée pour ne laisser aucun vide sur un bord.
 */
export function constrainCover(box: ImageBox, fw: Mm, fh: Mm): ImageBox {
  let { x, y, w, h } = box;
  const k = Math.max(1, fw / w, fh / h);
  if (k > 1) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    w *= k;
    h *= k;
    x = cx - w / 2;
    y = cy - h / 2;
  }
  x = Math.min(0, Math.max(fw - w, x));
  y = Math.min(0, Math.max(fh - h, y));
  return { x, y, w, h };
}

/** Zoom de la photo autour d'un point du cadre (mm), d'un facteur `k`. */
export function zoomImageAt(box: ImageBox, k: number, at: { x: Mm; y: Mm }): ImageBox {
  return { x: at.x - (at.x - box.x) * k, y: at.y - (at.y - box.y) * k, w: box.w * k, h: box.h * k };
}

/** Taille minimale d'une photo recadrée (mm) : en deçà, elle deviendrait insaisissable. */
export const MIN_IMAGE_MM = 1;

/** Applique les contraintes d'un recadrage (taille minimale, couverture en Remplir). */
export function constrainCrop(box: ImageBox, frame: Pick<FrameObject, 'w' | 'h'>, cover: boolean): ImageBox {
  let b = box;
  if (b.w < MIN_IMAGE_MM || b.h < MIN_IMAGE_MM) {
    const k = Math.max(MIN_IMAGE_MM / b.w, MIN_IMAGE_MM / b.h);
    b = zoomImageAt(b, k, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  }
  return cover ? constrainCover(b, frame.w, frame.h) : b;
}

/** Vrai si la photo laisse un vide dans le cadre (au 1/1000 de mm près). */
export function leavesGap(box: ImageBox, fw: Mm, fh: Mm): boolean {
  const e = 1e-3;
  return box.x > e || box.y > e || box.x + box.w < fw - e || box.y + box.h < fh - e;
}

/** Remplir, Ajuster, Centrer : recalcule la place de la photo ; Remplir rétablit la couverture. */
export function refitFrameImage(frame: Pick<FrameObject, 'w' | 'h'>, image: FrameImage, asset: Pick<Asset, 'width' | 'height'>, fit: Exclude<ImageFit, 'custom'>): FrameImage {
  const box = roundBox(computeImagePlacement(fit, frame.w, frame.h, asset.width, asset.height));
  const next: FrameImage = { ...image, ...box, fit };
  if (fit === 'fill') next.cover = true;
  else delete next.cover;
  return next;
}

/**
 * Photo remplacée (« Remplacer » du panneau Images) : les modes automatiques sont recalculés ; un
 * recadrage manuel garde son centre et sa largeur imprimée, la hauteur suivant le rapport de la
 * nouvelle photo (puis la couverture si le cadre l'exige).
 */
export function relinkImage(frame: Pick<FrameObject, 'w' | 'h'>, image: FrameImage, asset: Pick<Asset, 'id' | 'width' | 'height'>): FrameImage {
  if (image.fit !== 'custom') return { ...refitFrameImage(frame, image, asset, image.fit), assetId: asset.id };
  const cx = image.x + image.w / 2;
  const cy = image.y + image.h / 2;
  const w = image.w;
  const h = (w * asset.height) / asset.width;
  let box: ImageBox = { x: cx - w / 2, y: cy - h / 2, w, h };
  if (image.cover) box = constrainCover(box, frame.w, frame.h);
  return { ...image, ...roundBox(box), assetId: asset.id };
}
