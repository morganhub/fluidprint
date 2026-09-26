// Surcouche du dépôt de photos (tâche 3.2) : écoute le glisser-déposer sur le plan de travail, surligne
// la forme qui recevra la photo et affiche l'avancement de l'envoi ou l'erreur. Pendant l'envoi, la photo
// lâchée sur une forme y apparaît tout de suite, découpée, depuis le fichier local : l'original part au
// serveur, qui produit l'aperçu d'écran ; le document ne change qu'à son retour (une étape d'annulation).
import { useEffect, useId, useRef, useState } from 'react';
import { computeImagePlacement } from '../model/frame';
import { defaultImageResolver } from '../render/context';
import { frameShapePath } from '../model/shapes';
import type { FrameObject, Id } from '../model/types';
import { getEditor, useEditor } from '../store/documentStore';
import { pageIdOf } from '../store/tree';
import { ACCEPTED_LABEL, ASSET_DRAG_TYPE, createFrameForAsset, frameAtPoint, isAcceptedImage, placeAssetInFrame, uploadImage } from './dropImage';
import { pageBoxToScreen, screenToWorld, worldToPage } from './layout';
import { registerOverlay } from './registry/api';

const MESSAGE_MS = 6000;

const carriesImage = (dt: DataTransfer | null) => !!dt && (dt.types.includes('Files') || dt.types.includes(ASSET_DRAG_TYPE));

function FrameHighlight({ frameId }: { frameId: Id }) {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const frame = doc?.objects[frameId] as FrameObject | undefined;
  const pageId = doc && frame ? pageIdOf(doc, frameId) : null;
  if (!doc || frame?.type !== 'frame' || !pageId) return null;
  const b = pageBoxToScreen(doc, pageId, frame, zoom, view);
  return (
    <svg
      data-drop-target={frameId}
      className="pointer-events-none absolute overflow-visible"
      style={{ left: b.x, top: b.y, transform: frame.rotation ? `rotate(${frame.rotation}deg)` : undefined, transformOrigin: `${b.w / 2}px ${b.h / 2}px` }}
      width={b.w}
      height={b.h}
      viewBox={`0 0 ${frame.w} ${frame.h}`}
      preserveAspectRatio="none"
    >
      <path d={frameShapePath(frame.shape, frame.w, frame.h)} fill="rgba(2, 132, 199, 0.18)" stroke="#0284c7" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface LocalPreview {
  frameId: Id;
  url: string;
  width: number;
  height: number;
}

/** Photo lâchée, affichée depuis le fichier local et découpée par la forme, le temps de l'envoi. */
function LocalPreviewView({ preview }: { preview: LocalPreview }) {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const clipId = `drop-preview-${useId().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const frame = doc?.objects[preview.frameId] as FrameObject | undefined;
  const pageId = doc && frame ? pageIdOf(doc, preview.frameId) : null;
  if (!doc || frame?.type !== 'frame' || !pageId || !(frame.w > 0 && frame.h > 0)) return null;
  const b = pageBoxToScreen(doc, pageId, frame, zoom, view);
  const place = computeImagePlacement('fill', frame.w, frame.h, preview.width, preview.height);
  return (
    <svg
      data-drop-preview={preview.frameId}
      className="pointer-events-none absolute"
      style={{ left: b.x, top: b.y, transform: frame.rotation ? `rotate(${frame.rotation}deg)` : undefined, transformOrigin: `${b.w / 2}px ${b.h / 2}px` }}
      width={b.w}
      height={b.h}
      viewBox={`0 0 ${frame.w} ${frame.h}`}
      preserveAspectRatio="none"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={frameShapePath(frame.shape, frame.w, frame.h)} />
        </clipPath>
      </defs>
      <image href={preview.url} x={place.x} y={place.y} width={place.w} height={place.h} preserveAspectRatio="none" clipPath={`url(#${clipId})`} />
    </svg>
  );
}

/** Dimensions d'une photo locale, si le navigateur sait la lire (pas le TIFF) ; null sinon. */
async function localSize(url: string): Promise<{ width: number; height: number } | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  } catch {
    return null;
  }
}

function DropImageOverlay() {
  const anchor = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Id | null>(null);
  const [preview, setPreview] = useState<LocalPreview | null>(null);
  const [message, setMessage] = useState<{ kind: 'busy' | 'error'; text: string } | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    const viewport = anchor.current?.closest<HTMLElement>('[data-workspace-viewport]');
    if (!viewport) return;
    const show = (kind: 'busy' | 'error', text: string) => {
      window.clearTimeout(timer.current);
      setMessage({ kind, text });
      if (kind === 'error') timer.current = window.setTimeout(() => setMessage(null), MESSAGE_MS);
    };

    const over = (e: DragEvent) => {
      const s = getEditor();
      if (!carriesImage(e.dataTransfer)) return;
      e.preventDefault();
      if (!s.doc || s.mode) {
        e.dataTransfer!.dropEffect = 'none';
        return;
      }
      e.dataTransfer!.dropEffect = 'copy';
      const id = frameAtPoint(viewport, e.clientX, e.clientY, s.doc);
      setTarget((prev) => (prev === id ? prev : id));
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget || !viewport.contains(e.relatedTarget as Node)) setTarget(null);
    };
    const drop = async (e: DragEvent) => {
      const s = getEditor();
      if (!carriesImage(e.dataTransfer)) return;
      e.preventDefault();
      setTarget(null);
      if (!s.doc || s.mode) return;
      const doc = s.doc;
      const frameId = frameAtPoint(viewport, e.clientX, e.clientY, doc);
      const rect = viewport.getBoundingClientRect();
      const world = screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, s.zoom, s.view);
      const point = worldToPage(doc, world, true);

      // Photo déjà dans le document, glissée depuis le panneau Images.
      const assetId = e.dataTransfer!.getData(ASSET_DRAG_TYPE);
      if (assetId) {
        const asset = doc.assets.find((a) => a.id === assetId);
        if (!asset) return;
        if (frameId) placeAssetInFrame(frameId, asset);
        else if (point) createFrameForAsset(point.pageId, point, asset);
        return;
      }

      const files = [...(e.dataTransfer!.files ?? [])];
      const accepted = files.filter(isAcceptedImage);
      if (!accepted.length) {
        show('error', files.length ? `Format refusé (${files.map((f) => f.name).join(', ')}) : ${ACCEPTED_LABEL} attendu` : 'Aucun fichier reçu');
        return;
      }
      const docId = s.docId ?? doc.id;
      show('busy', accepted.length > 1 ? `Envoi de ${accepted.length} photos…` : `Envoi de ${accepted[0].name}…`);
      try {
        // Sur une forme : la première photo seulement ; sur le vide, un cadre par photo, en cascade.
        const list = frameId ? accepted.slice(0, 1) : accepted;
        for (const [i, file] of list.entries()) {
          let local: string | null = null;
          if (frameId) {
            local = URL.createObjectURL(file);
            const size = await localSize(local);
            if (size) setPreview({ frameId, url: local, ...size });
          }
          try {
            const asset = await uploadImage(docId, file);
            if (frameId && getEditor().doc?.objects[frameId]) {
              placeAssetInFrame(frameId, asset);
              // L'aperçu local reste jusqu'à ce que celui du serveur soit décodé : pas de clignotement.
              const ready = new Image();
              ready.src = defaultImageResolver(docId, 'screen')(asset);
              await ready.decode().catch(() => undefined);
            } else if (point) createFrameForAsset(point.pageId, { x: point.x + i * 5, y: point.y + i * 5 }, asset);
          } finally {
            if (local) {
              setPreview(null);
              URL.revokeObjectURL(local);
            }
          }
        }
        setMessage(null);
        if (files.length > accepted.length) show('error', `Fichiers ignorés : ${files.filter((f) => !isAcceptedImage(f)).map((f) => f.name).join(', ')} (${ACCEPTED_LABEL} attendu)`);
      } catch (error) {
        show('error', `Photo non placée : ${(error as Error).message}`);
      }
    };

    // Un fichier lâché à côté du plan de travail (panneaux, barre d'outils) ne doit pas faire quitter
    // l'éditeur : le navigateur ouvrirait la photo à la place de la page.
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files') && !viewport.contains(e.target as Node)) e.preventDefault();
    };

    viewport.addEventListener('dragover', over);
    viewport.addEventListener('dragleave', leave);
    viewport.addEventListener('drop', drop);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      viewport.removeEventListener('dragover', over);
      viewport.removeEventListener('dragleave', leave);
      viewport.removeEventListener('drop', drop);
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
      window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div ref={anchor} className="pointer-events-none absolute inset-0" data-drop-layer>
      {preview && <LocalPreviewView preview={preview} />}
      {target && <FrameHighlight frameId={target} />}
      {message && (
        <div
          data-drop-message={message.kind}
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={
            'pointer-events-auto absolute bottom-4 left-1/2 max-w-[70%] -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow ' +
            (message.kind === 'error' ? 'border border-red-300 bg-red-50 text-red-900' : 'bg-neutral-900/90 text-white')
          }
          onClick={() => setMessage(null)}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

registerOverlay({ id: 'drop-image', space: 'viewport', order: 30, component: DropImageOverlay });
