// Déposer une photo (tâche 3.2) : un fichier JPG, PNG, TIFF ou WebP glissé depuis l'explorateur (ou une
// photo du panneau Images) sur une forme y est placé en Remplir ; déposé sur le vide, il crée un cadre
// rectangulaire à la taille de la photo (à 300 ppi, ramené à la face). Le fichier part au serveur tel
// quel : l'original est conservé dans assets/originals/, l'écran n'en montre qu'un aperçu.
import { faceSize } from '../model/format';
import { placeImage, printedSizeMm } from '../model/images';
import type { Asset, FrameObject, Id, LayoutDocument, Mm } from '../model/types';
import { addObjects } from '../store/commands';
import { serverFetch } from '../store/http';
import { defaultLayerId, getEditor } from '../store/documentStore';
import { isSelectable } from '../store/tree';
import { makeFrame } from './tools/defaults';

/** Type des données d'un glisser depuis le panneau Images (identifiant de l'asset). */
export const ASSET_DRAG_TYPE = 'application/x-fluidprint-asset';

const ACCEPTED_EXTENSIONS = /\.(jpe?g|jpe|png|tiff?|webp)$/i;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/pjpeg', 'image/png', 'image/tiff', 'image/x-tiff', 'image/webp']);
export const ACCEPTED_LABEL = 'JPG, PNG, TIFF ou WebP';
/** Pour un <input type="file">. */
export const ACCEPT_ATTRIBUTE = '.jpg,.jpeg,.png,.tif,.tiff,.webp,image/jpeg,image/png,image/tiff,image/webp';

/** Taille de création d'un cadre pour une photo déposée sur le vide : sa taille d'impression nominale. */
export const DROP_PPI = 300;

export const isAcceptedImage = (file: { name: string; type: string }): boolean => ACCEPTED_TYPES.has(file.type.toLowerCase()) || ACCEPTED_EXTENSIONS.test(file.name);

/** Envoie une photo au serveur (original gardé tel quel) ; renvoie l'asset créé. */
export async function uploadImage(docId: string, file: File): Promise<Asset> {
  const body = new FormData();
  body.append('file', file, file.name);
  const res = await serverFetch(`/api/assets/${encodeURIComponent(docId)}`, { method: 'POST', body }, 'photo non envoyée, réessayez');
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Envoi refusé (${res.status})`);
  }
  return (await res.json()) as Asset;
}

/** Ajoute l'asset au document s'il n'y est pas (dans le brouillon d'une action). */
function ensureAsset(d: LayoutDocument, asset: Asset): void {
  if (!d.assets.some((a) => a.id === asset.id)) d.assets.push(asset);
}

/** Place une photo dans un cadre, en Remplir (une étape d'annulation, photo ajoutée au document comprise). */
export function placeAssetInFrame(frameId: Id, asset: Asset, label = 'Placer une photo'): void {
  getEditor().apply(
    label,
    (d) => {
      const frame = d.objects[frameId];
      if (frame?.type !== 'frame') return;
      ensureAsset(d, asset);
      frame.image = placeImage(frame, asset, 'fill');
    },
    { select: [frameId] },
  );
}

/** Boîte d'un cadre neuf pour une photo : 300 ppi, réduite pour tenir dans la face, centrée sur `at`. */
export function frameBoxForAsset(doc: LayoutDocument, asset: Pick<Asset, 'width' | 'height'>, at: { x: Mm; y: Mm }) {
  const face = faceSize(doc.format);
  let w = printedSizeMm(asset.width, DROP_PPI);
  let h = printedSizeMm(asset.height, DROP_PPI);
  const k = Math.min(1, face.w / w, face.h / h);
  w *= k;
  h *= k;
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  return { x: clamp(at.x - w / 2, 0, face.w - w), y: clamp(at.y - h / 2, 0, face.h - h), w, h };
}

/** Crée un cadre rectangulaire à la taille de la photo, sur le calque actif ; renvoie son identifiant. */
export function createFrameForAsset(pageId: Id, at: { x: Mm; y: Mm }, asset: Asset): Id | undefined {
  const s = getEditor();
  const doc = s.doc;
  if (!doc) return undefined;
  const layerId = defaultLayerId(doc, s.activeLayerId);
  if (!layerId) return undefined;
  const box = frameBoxForAsset(doc, asset, at);
  return s.apply(
    'Placer une photo',
    (d) => {
      ensureAsset(d, asset);
      const frame: FrameObject = makeFrame(d, { layerId, box }, { kind: 'rect' }, asset.name.replace(/\.[a-z0-9]+$/i, ''));
      delete frame.placeholder;
      frame.image = placeImage(frame, asset, 'fill');
      addObjects(d, [frame], [frame.id], { pageId });
      return frame.id;
    },
    { select: (id) => (id ? [id] : []) },
  );
}

/**
 * Cadre qui recevra une photo lâchée en un point client : le plus haut cadre sous le pointeur, dans une
 * face, même s'il est dans un groupe ; un cadre verrouillé (lui, son calque ou un groupe) ne compte pas.
 */
export function frameAtPoint(root: HTMLElement, clientX: number, clientY: number, doc: LayoutDocument): Id | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!root.contains(el)) continue;
    const objEl = el.closest('[data-obj-id]');
    if (!objEl || !objEl.closest('[data-page-id]')) continue;
    const id = objEl.getAttribute('data-obj-id')!;
    const obj = doc.objects[id];
    if (obj?.type === 'frame' && isSelectable(doc, id)) return id;
  }
  return null;
}
