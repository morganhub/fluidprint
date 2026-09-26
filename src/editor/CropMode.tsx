// Recadrage d'une photo dans sa forme (tâche 3.1), comme dans Canva : double-clic sur un cadre qui porte
// une photo. La photo entière apparaît en transparence autour de la forme ; on la déplace (glisser, flèches),
// on la redimensionne (poignées Moveable, proportions gardées), la molette zoome autour du pointeur.
// Échap, Entrée ou un clic en dehors valident. Tout le recadrage est UN geste : une seule étape
// d'annulation ; son aperçu est enregistré 2 s après la dernière retouche (geste « autosave »), pour
// qu'un onglet fermé en plein recadrage ne perde rien. En Remplir, la photo couvre toujours la forme.
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Moveable, { type OnResize } from 'react-moveable';
import type { ImageBox } from '../model/frame';
import { constrainCrop, imagePpi, mustCover, ppiLevel, roundBox, zoomImageAt } from '../model/images';
import { frameShapePath } from '../model/shapes';
import type { FrameImage, FrameObject, Id } from '../model/types';
import { defaultImageResolver } from '../render/context';
import { getEditor, useEditor, type EditorState } from '../store/documentStore';
import { frameAtPoint } from './dropImage';
import { isSelectable, pageIdOf } from '../store/tree';
import { pageBoxToScreen, pxPerMm } from './layout';
import { modifiers, trackPointer } from './pointer';
import { registerInteraction, registerOverlay, registerShortcut } from './registry/api';

export const CROP_MODE = 'crop';

/** Zoom de la molette : facteur par pixel de défilement. */
const WHEEL_ZOOM = 0.0015;
const NUDGE_MM = 0.5;
const NUDGE_BIG_MM = 5;

interface CropSession {
  frameId: Id;
  /** Photo au début du recadrage (document du début du geste). */
  start: FrameImage;
  cover: boolean;
}

let session: CropSession | null = null;

/** Ouvre le recadrage d'un cadre qui porte une photo ; faux si impossible (pas de photo, geste en cours…). */
export function startCrop(frameId: Id): boolean {
  const s = getEditor();
  const frame = s.doc?.objects[frameId];
  if (!s.doc || s.mode || s.gesture || frame?.type !== 'frame' || !frame.image) return false;
  if (!s.doc.assets.some((a) => a.id === frame.image!.assetId)) return false;
  s.select([frameId]);
  session = { frameId, start: frame.image, cover: mustCover(frame.image) };
  getEditor().beginGesture('Recadrer la photo', { autosave: true });
  getEditor().setMode({ id: CROP_MODE, target: frameId });
  return true;
}

/** Ferme le recadrage : `commit` le garde (une étape d'annulation), sinon tout est rendu comme avant. */
export function finishCrop(commit = true): void {
  const s = getEditor();
  const current = session;
  session = null;
  if (s.mode?.id === CROP_MODE) s.setMode(null);
  if (!current) return;
  if (commit) getEditor().commitGesture({ select: [current.frameId] });
  else getEditor().cancelGesture();
}

/** Écrit la boîte de la photo (mm, repère du cadre), contrainte, dans le geste en cours. */
function writeImageBox(box: ImageBox): void {
  const s = session;
  const frame = s && getEditor().doc?.objects[s.frameId];
  if (!s || frame?.type !== 'frame') return;
  const next = roundBox(constrainCrop(box, frame, s.cover));
  const same = next.x === s.start.x && next.y === s.start.y && next.w === s.start.w && next.h === s.start.h;
  getEditor().previewGesture((d) => {
    const f = d.objects[s.frameId] as FrameObject;
    if (!f?.image || same) return;
    // Recadré à la main : la place n'est plus automatique, mais l'exigence de couverture reste.
    f.image = { ...s.start, ...next, fit: 'custom', ...(s.cover ? { cover: true } : {}) };
  });
}

const currentImage = (): FrameImage | null => {
  const s = session;
  const frame = s && getEditor().doc?.objects[s.frameId];
  return frame?.type === 'frame' && frame.image ? frame.image : null;
};

// ---------------------------------------------------------------- surcouche

function CropEditor({ frameId }: { frameId: Id }) {
  const doc = useEditor((s) => s.doc);
  const docId = useEditor((s) => s.docId);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const maskId = `crop-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const moveable = useRef<Moveable>(null);
  const resizeStart = useRef<ImageBox | null>(null);

  const frame = doc?.objects[frameId];
  const pageId = doc ? pageIdOf(doc, frameId) : null;
  const valid = !!doc && frame?.type === 'frame' && !!frame.image && !!pageId;

  // Le cadre a disparu (supprimé, annulé ailleurs) : on sort sans rien garder.
  useEffect(() => {
    if (!valid) finishCrop(false);
  }, [valid]);

  const geometry = () => {
    const st = getEditor();
    const f = st.doc!.objects[frameId] as FrameObject;
    const screen = pageBoxToScreen(st.doc!, pageIdOf(st.doc!, frameId)!, { x: f.x, y: f.y, w: f.w, h: f.h }, st.zoom, st.view);
    return { f, screen, k: pxPerMm(st.zoom), angle: ((f.rotation ?? 0) * Math.PI) / 180 };
  };

  /** Point client → mm dans le repère du cadre (rotation comprise). */
  const toFrame = (clientX: number, clientY: number) => {
    const { f, screen, k, angle } = geometry();
    const vp = overlay!.getBoundingClientRect();
    const dx = clientX - vp.left - (screen.x + screen.w / 2);
    const dy = clientY - vp.top - (screen.y + screen.h / 2);
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    return { x: (dx * cos - dy * sin) / k + f.w / 2, y: (dx * sin + dy * cos) / k + f.h / 2 };
  };

  // Molette : zoom de la photo autour du pointeur ; Ctrl+molette garde le zoom du plan de travail.
  useEffect(() => {
    if (!overlay) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const image = currentImage();
      if (!image) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      writeImageBox(zoomImageAt(image, Math.exp(-e.deltaY * unit * WHEEL_ZOOM), toFrame(e.clientX, e.clientY)));
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', onWheel);
  });

  useEffect(() => {
    moveable.current?.updateRect();
  });

  if (!valid || !doc || frame?.type !== 'frame' || !frame.image || !pageId) return null;
  const asset = doc.assets.find((a) => a.id === frame.image!.assetId);
  if (!asset) return null;

  const k = pxPerMm(zoom);
  const screen = pageBoxToScreen(doc, pageId, { x: frame.x, y: frame.y, w: frame.w, h: frame.h }, zoom, view);
  const img = frame.image;
  const ppi = imagePpi(img, asset);
  const level = ppiLevel(ppi);
  const href = defaultImageResolver(docId ?? doc.id, 'screen')(asset);

  const onOutside = (e: ReactPointerEvent) => {
    // Main temporaire et bouton du milieu : la vue se déplace, le recadrage continue.
    if (e.button !== 0 || modifiers.space || e.target !== e.currentTarget) return;
    finishCrop(true);
  };

  const startDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0 || modifiers.space) return;
    e.stopPropagation();
    e.preventDefault();
    const start = currentImage();
    if (!start) return;
    const from = toFrame(e.clientX, e.clientY);
    trackPointer(
      e.nativeEvent,
      {
        move: (ev) => {
          const p = toFrame(ev.clientX, ev.clientY);
          writeImageBox({ ...start, x: start.x + p.x - from.x, y: start.y + p.y - from.y });
        },
        end: () => undefined,
      },
      overlay,
    );
  };

  const onResize = (e: OnResize) => {
    const start = resizeStart.current;
    if (!start) return;
    const [dirX, dirY] = e.direction as [number, number];
    const w = Math.max(1e-3, e.width / k);
    const h = (w * start.h) / start.w;
    writeImageBox({
      x: dirX === -1 ? start.x + start.w - w : start.x,
      y: dirY === -1 ? start.y + start.h - h : start.y,
      w,
      h,
    });
    // Le témoin reprend la place que le document a retenue (contrainte de couverture comprise).
    const now = currentImage();
    if (now) Object.assign((e.target as HTMLElement).style, { left: `${now.x * k}px`, top: `${now.y * k}px`, width: `${now.w * k}px`, height: `${now.h * k}px`, transform: '' });
  };

  const shapePath = frameShapePath(frame.shape, frame.w, frame.h);
  const pad = 10_000;

  return (
    <div
      ref={setOverlay}
      data-crop-overlay
      className="absolute inset-0"
      style={{ pointerEvents: 'auto', cursor: 'default', zIndex: 5 }}
      onPointerDown={onOutside}
    >
      <div
        data-crop-frame={frameId}
        className="pointer-events-none absolute"
        style={{
          left: screen.x,
          top: screen.y,
          width: screen.w,
          height: screen.h,
          transform: frame.rotation ? `rotate(${frame.rotation}deg)` : undefined,
          transformOrigin: 'center',
        }}
      >
        <svg
          className="absolute left-0 top-0 overflow-visible"
          width={screen.w}
          height={screen.h}
          viewBox={`0 0 ${frame.w} ${frame.h}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={-pad} y={-pad} width={2 * pad} height={2 * pad}>
              <rect x={-pad} y={-pad} width={2 * pad} height={2 * pad} fill="white" />
              <path d={shapePath} fill="black" />
            </mask>
          </defs>
          {/* Hors de la forme seulement : dedans, c'est le vrai rendu de la page qui se voit. */}
          <image href={href} x={img.x} y={img.y} width={img.w} height={img.h} preserveAspectRatio="none" opacity={0.45} mask={`url(#${maskId})`} />
          <rect x={img.x} y={img.y} width={img.w} height={img.h} fill="none" stroke="#0284c7" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          <path d={shapePath} fill="none" stroke="#0284c7" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
        <div
          ref={setTarget}
          data-crop-image
          className="pointer-events-auto absolute"
          style={{ left: img.x * k, top: img.y * k, width: img.w * k, height: img.h * k, cursor: 'move' }}
          onPointerDown={startDrag}
        />
        {target && (
          <Moveable
            ref={moveable}
            target={target}
            className="editor-moveable editor-crop-moveable"
            resizable
            keepRatio
            throttleResize={0}
            origin={false}
            renderDirections={['nw', 'ne', 'sw', 'se']}
            onResizeStart={(e) => {
              resizeStart.current = currentImage();
              e.setMin([2, 2]);
            }}
            onResize={onResize}
            onResizeEnd={() => {
              resizeStart.current = null;
              requestAnimationFrame(() => moveable.current?.updateRect());
            }}
          />
        )}
      </div>
      <div
        data-crop-ppi={level}
        className="pointer-events-none absolute rounded bg-neutral-900/85 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
        style={{ left: screen.x, top: screen.y + screen.h + 8 }}
      >
        <span className={level === 'error' ? 'text-red-300' : level === 'warn' ? 'text-amber-300' : 'text-emerald-300'}>{Math.round(ppi)} ppi</span>
        <span className="ml-2 text-neutral-300">Échap ou clic dehors pour valider</span>
      </div>
    </div>
  );
}

function CropOverlay() {
  const mode = useEditor((s) => s.mode);
  if (mode?.id !== CROP_MODE || !mode.target) return null;
  return <CropEditor key={mode.target} frameId={mode.target} />;
}

registerOverlay({ id: 'crop-mode', space: 'viewport', order: 40, component: CropOverlay });

/**
 * Cadre photo à recadrer sous un double-clic : l'objet touché, ou, s'il n'en est pas un, le cadre photo
 * juste dessous (un trait de vague posé sur le bandeau couvre toute sa boîte, alors qu'on vise la photo).
 */
function cropTarget(state: EditorState, deepId: Id, event: MouseEvent): Id | null {
  const doc = state.doc!;
  const hasPhoto = (id: Id | null): id is Id => {
    const obj = id ? doc.objects[id] : undefined;
    return obj?.type === 'frame' && !!obj.image && isSelectable(doc, id!);
  };
  if (hasPhoto(deepId)) return deepId;
  if (doc.objects[deepId]?.type === 'text') return null;
  const root = document.querySelector<HTMLElement>('[data-workspace-viewport]');
  const below = root ? frameAtPoint(root, event.clientX, event.clientY, doc) : null;
  return hasPhoto(below) ? below : null;
}

registerInteraction({
  id: 'crop',
  order: 20,
  onDoubleClick: ({ state, deepId, event }) => {
    const target = cropTarget(state, deepId, event);
    return target ? startCrop(target) : false;
  },
});

const inCrop = (s: { mode: { id: string } | null }) => s.mode?.id === CROP_MODE;

registerShortcut({
  id: 'crop-validate',
  keys: ['Escape', 'Enter'],
  label: 'Valider le recadrage',
  group: 'Photos',
  allowInMode: true,
  when: inCrop,
  run: () => finishCrop(true),
});

registerShortcut({
  id: 'crop-cancel',
  keys: 'Mod+Z',
  label: 'Annuler le recadrage en cours',
  group: 'Photos',
  allowInMode: true,
  when: inCrop,
  run: () => finishCrop(false),
});

const nudgePhoto = (dx: number, dy: number) => () => {
  const image = currentImage();
  if (image) writeImageBox({ ...image, x: image.x + dx, y: image.y + dy });
};

for (const [key, dx, dy] of [
  ['ArrowLeft', -1, 0],
  ['ArrowRight', 1, 0],
  ['ArrowUp', 0, -1],
  ['ArrowDown', 0, 1],
] as const) {
  registerShortcut({ id: `crop-nudge-${key}`, keys: key, label: 'Déplacer la photo (0,5 mm)', group: 'Photos', hidden: key !== 'ArrowLeft', allowInMode: true, when: inCrop, run: nudgePhoto(dx * NUDGE_MM, dy * NUDGE_MM) });
  registerShortcut({ id: `crop-nudge-big-${key}`, keys: `Shift+${key}`, label: 'Déplacer la photo (5 mm)', group: 'Photos', hidden: key !== 'ArrowLeft', allowInMode: true, when: inCrop, run: nudgePhoto(dx * NUDGE_BIG_MM, dy * NUDGE_BIG_MM) });
}
