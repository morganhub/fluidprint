import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { faceSize } from '../model/format';
import { masterOf } from '../model/masters';
import type { Asset, DocObject, Layer, LayoutDocument, MasterPage, Page } from '../model/types';
import { mm } from './box';
import { ObjectsContext, RenderContext, defaultImageResolver, type RenderContextValue, type RenderMode } from './context';
import { getProofVariant, imageVariantKey, proofUrl, subscribeImageVariant } from './imageVariant';
import { ObjectView } from './ObjectView';
import { createTextFlowStore, TextFlowContext, type TextFlowStore } from './textFlow';

export interface PageViewProps {
  doc: LayoutDocument;
  /** Une face, ou une page type (4.11) quand on l'édite. */
  page: Page | MasterPage;
  mode: RenderMode;
  /** Échelle d'affichage (1 = taille réelle) ; ignorée en impression. */
  zoom?: number;
  /** Par défaut : aperçu à l'écran, original à l'impression, servis par /api/assets. */
  resolveImageUrl?: (asset: Asset) => string;
  onImageSettled?: (assetId: string, ok: boolean) => void;
  onRenderError?: (objId: string, message: string) => void;
  className?: string;
}

/** Calques rendus, du dessous vers le dessus (contrat, point 11). */
export function renderedLayers(doc: LayoutDocument, mode: RenderMode): Layer[] {
  return doc.layers.filter((layer) => layer.visible && (mode === 'screen' || layer.printable));
}

export interface StackedObject {
  obj: DocObject;
  /** Objet de la page type de la face (4.11) : dessiné, mais ni cliquable ni modifiable ici. */
  fromMaster?: boolean;
}

/**
 * Objets de premier niveau d'une page dans l'ordre d'empilement : calque par calque ; dans chaque calque,
 * les objets de la page type (4.11) d'abord, sous ceux de la face, comme dans InDesign.
 */
export function stackedObjects(doc: LayoutDocument, page: Page | MasterPage, mode: RenderMode): DocObject[] {
  return stackedEntries(doc, page, mode).map((e) => e.obj);
}

export function stackedEntries(doc: LayoutDocument, page: Page | MasterPage, mode: RenderMode): StackedObject[] {
  const list = (ids: string[]) => ids.map((id) => doc.objects[id]).filter((o): o is DocObject => !!o);
  const objects = list(page.children);
  const shared = list(masterOf(doc, page)?.children ?? []);
  return renderedLayers(doc, mode).flatMap((layer) => [
    ...shared.filter((o) => o.layerId === layer.id).map((obj) => ({ obj, fromMaster: true })),
    ...objects.filter((o) => o.layerId === layer.id).map((obj) => ({ obj })),
  ]);
}

// Les objets de page type ne se sélectionnent pas sur la face : ils laissent passer le pointeur (le
// plan de travail ne voit que ce qui est sous le curseur). À l'impression, rien à neutraliser.
const MASTER_ITEM: CSSProperties = { position: 'absolute', left: 0, top: 0, width: 0, height: 0 };
const MASTER_ITEM_SCREEN: CSSProperties = { ...MASTER_ITEM, pointerEvents: 'none' };

// Champs du document qui ne changent pas le dessin d'un objet déjà rendu : les objets eux-mêmes (chaque
// vue reçoit le sien), l'arborescence des faces (PageView la relit à chaque rendu) et la date d'édition.
const OUTSIDE_RENDER_CONTEXT = new Set(['objects', 'pages', 'editedAt']);

/** Numéro qui change quand un champ du document lu par les vues (nuancier, calques, images…) change. */
function useRenderVersion(doc: LayoutDocument): number {
  const prev = useRef<{ doc: LayoutDocument; version: number } | null>(null);
  const last = prev.current;
  if (!last) prev.current = { doc, version: 0 };
  else if (last.doc !== doc) {
    const keys = new Set([...Object.keys(last.doc), ...Object.keys(doc)]);
    const changed = [...keys].some((k) => !OUTSIDE_RENDER_CONTEXT.has(k) && (last.doc as unknown as Record<string, unknown>)[k] !== (doc as unknown as Record<string, unknown>)[k]);
    prev.current = { doc, version: last.version + (changed ? 1 : 0) };
  }
  return prev.current!.version;
}

/**
 * Une face à taille réelle, en mm. À l'écran, le zoom est un `transform: scale` sur la face : la mise
 * en page, donc les coupures de ligne, ne dépend jamais du zoom (contrat, point 1).
 */
export function PageView({ doc, page, mode, zoom = 1, resolveImageUrl, onImageSettled, onRenderError, className }: PageViewProps) {
  const size = faceSize(doc.format);
  // Le contexte garde son identité tant que seuls les objets changent : les vues mémoïsées des objets
  // non modifiés ne se re-rendent pas. `doc` y est lu à la demande, donc toujours à jour.
  const docRef = useRef(doc);
  docRef.current = doc;
  const version = useRenderVersion(doc);
  // « Aperçu impression » (4.9) : à l'écran, les photos passent par leur épreuve au profil de sortie.
  const variant = useSyncExternalStore(subscribeImageVariant, imageVariantKey, imageVariantKey);
  const ctx = useMemo<RenderContextValue>(() => {
    const proof = mode === 'screen' ? getProofVariant() : null;
    const fallback = defaultImageResolver(docRef.current.id, mode);
    return {
      get doc() {
        return docRef.current;
      },
      mode,
      resolveImageUrl: resolveImageUrl ?? (proof ? (asset: Asset) => proofUrl(docRef.current.id, asset, proof) : fallback),
      onImageSettled,
      onRenderError,
    };
  }, [version, mode, resolveImageUrl, onImageSettled, onRenderError, variant]);
  // Coulée du texte (chaînage 4.12, habillage 4.13) : publiée après chaque rendu de la face.
  const flowRef = useRef<TextFlowStore | null>(null);
  flowRef.current ??= createTextFlowStore();
  const flow = flowRef.current;
  useLayoutEffect(() => flow.publish(doc, mode));
  useEffect(() => flow.attach(), [flow]);
  const scale = mode === 'print' ? 1 : zoom;
  const face: CSSProperties = {
    position: 'relative',
    width: mm(size.w),
    height: mm(size.h),
    overflow: 'hidden',
    // À l'impression, Chrome cale la découpe de la face sur le pixel CSS entier : 303 × 216 mm devenaient
    // 1145 × 816 px, soit 302,95 × 215,9 mm, et un liseré blanc restait au bord du fond perdu. La découpe
    // déborde donc d'un demi-pixel ; l'export ramène ensuite la page du PDF à la taille exacte de la face.
    ...(mode === 'print' ? { overflow: 'clip', overflowClipMargin: '0.5px' } : {}),
    background: '#ffffff',
    transform: scale !== 1 ? `scale(${scale})` : undefined,
    transformOrigin: '0 0',
  };
  const content = (
    <RenderContext.Provider value={ctx}>
      <ObjectsContext.Provider value={doc.objects}>
        <TextFlowContext.Provider value={flow}>
          <div className={mode === 'print' ? className : undefined} data-page-id={page.id} data-face-id={page.faceId} style={face}>
            {stackedEntries(doc, page, mode).map(({ obj, fromMaster }) =>
              fromMaster ? (
                <div key={obj.id} data-master-item={obj.id} style={mode === 'print' ? MASTER_ITEM : MASTER_ITEM_SCREEN}>
                  <ObjectView obj={obj} />
                </div>
              ) : (
                <ObjectView key={obj.id} obj={obj} />
              ),
            )}
          </div>
        </TextFlowContext.Provider>
      </ObjectsContext.Provider>
    </RenderContext.Provider>
  );
  if (mode === 'print') return content;
  // Le conteneur occupe la taille zoomée : la face transformée ne réserve pas sa place d'elle-même.
  return (
    <div className={className} style={{ position: 'relative', width: mm(size.w * scale), height: mm(size.h * scale), flex: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0 }}>{content}</div>
    </div>
  );
}
