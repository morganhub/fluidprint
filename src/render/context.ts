import { createContext, useContext } from 'react';
import type { Asset, LayoutDocument } from '../model/types';

export type RenderMode = 'screen' | 'print';

export interface RenderContextValue {
  doc: LayoutDocument;
  mode: RenderMode;
  /** URL de l'image d'un asset (aperçu à l'écran, original ou sa copie décodable à l'impression). */
  resolveImageUrl: (asset: Asset) => string;
  /** Prévenu quand une photo a fini de charger (ou échoué) : la route d'impression l'attend. */
  onImageSettled?: (assetId: string, ok: boolean) => void;
  /** Prévenu quand un objet n'a pas pu être rendu : la route d'impression le signale à l'export. */
  onRenderError?: (objId: string, message: string) => void;
}

export const RenderContext = createContext<RenderContextValue | null>(null);

/**
 * Objets du document, dans un contexte à part : seuls les groupes s'y abonnent (pour rendre leurs
 * enfants). Le contexte de rendu, lui, ne change que si autre chose que les objets change (nuancier,
 * calques, images…) : un objet modifié ne re-rend que lui-même et ses groupes (éditeur, 60 images/s).
 */
export const ObjectsContext = createContext<LayoutDocument['objects'] | null>(null);

export function useRender(): RenderContextValue {
  const ctx = useContext(RenderContext);
  if (!ctx) throw new Error('Rendu hors de <PageView> : contexte absent');
  return ctx;
}

/** Fichier d'un document servi par l'API (chemin relatif au dossier du document). */
export function assetUrl(docId: string, relative: string): string {
  return `/api/assets/${encodeURIComponent(docId)}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

export const defaultImageResolver =
  (docId: string, mode: RenderMode) =>
  (asset: Asset): string =>
    assetUrl(docId, mode === 'print' ? (asset.print ?? asset.original) : (asset.preview ?? asset.original));
