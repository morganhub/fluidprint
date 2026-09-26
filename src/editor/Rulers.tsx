// Règles en millimètres (tâche 2.24), en haut et à gauche du plan de travail. Origine au coin du format
// fini de CHAQUE face (la règle du haut repart de 0 au-dessus de chaque face), comme les X/Y du panneau
// Propriétés. Elles suivent le zoom et la vue ; les plis sont marqués d'un triangle, le pointeur d'un
// trait. Glisser depuis une règle tire un repère (Guides.tsx).
//
// Performance : les graduations (plusieurs centaines d'éléments SVG) ne dépendent que de la géométrie des
// faces, du zoom, de la vue et de la taille du plan de travail. Elles sont mémoïsées : ni un mouvement du
// pointeur ni un geste sur un objet (qui change le document à chaque image) ne les redessinent ; seul le
// trait du pointeur suit la souris. Les redessiner à chaque image coûtait jusqu'à 200 ms par image
// pendant un redimensionnement sur le dépliant.
import { memo, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { foldPositions } from '../model/format';
import { findPageOrMaster } from '../model/masters';
import type { DocumentFormat, LayoutDocument } from '../model/types';
import { useEditor } from '../store/documentStore';
import { pageSlots, pxPerMm, PAGE_GAP_MM, type PageSlot, type View } from './layout';
import { RULER_SIZE_PX, startGuideDrag } from './Guides';
import { workspacePages } from './masterView';
import { registerOverlay } from './registry/api';

const R = RULER_SIZE_PX;
const MAJOR_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
/** Écart minimal à l'écran entre deux graduations chiffrées, et entre deux petites graduations (px). */
const MIN_LABEL_PX = 36;
const MIN_TICK_PX = 3;

export interface RulerSteps {
  /** Graduations chiffrées (mm). */
  major: number;
  /** Graduations moyennes (mm). */
  medium: number;
  /** Plus petites graduations (mm). */
  minor: number;
}

/** Pas des graduations selon le zoom : 10 mm chiffrés et 1 mm gradué à 100 %. */
export function rulerSteps(zoom: number): RulerSteps {
  const k = pxPerMm(zoom);
  const major = MAJOR_STEPS.find((s) => s * k >= MIN_LABEL_PX) ?? 1000;
  const minor = [major / 10, major / 5, major / 2, major].find((s) => s * k >= MIN_TICK_PX) ?? major;
  return { major, medium: major / 2, minor };
}

export interface RulerSegment {
  pageId: string;
  /** Position écran (px, viewport) du 0 de la règle : le coin du format fini. */
  origin: number;
  /** Étendue écran du segment (px). */
  start: number;
  end: number;
}

/** Segments de la règle du haut : un par face, qui se partagent l'écart entre deux faces. */
export function topSegments(doc: Pick<LayoutDocument, 'format'>, zoom: number, view: View, slots: PageSlot[] = pageSlots(doc as LayoutDocument)): RulerSegment[] {
  const k = pxPerMm(zoom);
  return slots.map((slot, i) => ({
    pageId: slot.pageId,
    origin: view.x + (slot.x + doc.format.bleed) * k,
    start: i === 0 ? -Infinity : view.x + (slot.x - PAGE_GAP_MM / 2) * k,
    end: i === slots.length - 1 ? Infinity : view.x + (slot.x + slot.w + PAGE_GAP_MM / 2) * k,
  }));
}

const fmt = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',').replace('-', '−');

/** Nombre de fois où les graduations ont été calculées (développement et tests : window.__editor). */
export const rulerStats = { tickRenders: 0 };

/** Graduations d'une règle entre deux positions écran, pour une origine donnée. */
function ticks(origin: number, from: number, to: number, k: number, steps: RulerSteps, horizontal: boolean, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const n0 = Math.ceil((from - origin) / k / steps.minor);
  const n1 = Math.floor((to - origin) / k / steps.minor);
  for (let n = n0; n <= n1; n++) {
    const v = Math.round(n * steps.minor * 1000) / 1000;
    const pos = Math.floor(origin + v * k) + 0.5;
    const isMajor = Math.abs(v / steps.major - Math.round(v / steps.major)) < 1e-6;
    const isMedium = !isMajor && Math.abs(v / steps.medium - Math.round(v / steps.medium)) < 1e-6;
    const len = isMajor ? R - 4 : isMedium ? 6 : 3;
    out.push(
      horizontal ? (
        <line key={`${key}${n}`} data-mm={v} x1={pos} x2={pos} y1={R - len} y2={R} />
      ) : (
        <line key={`${key}${n}`} data-mm={v} y1={pos} y2={pos} x1={R - len} x2={R} />
      ),
    );
    if (isMajor) {
      out.push(
        horizontal ? (
          <text key={`${key}t${n}`} x={pos + 2} y={9} className="fill-neutral-500" fontSize={9}>
            {fmt(v)}
          </text>
        ) : (
          <text key={`${key}t${n}`} x={9} y={pos + 2} transform={`rotate(-90 9 ${pos + 2})`} textAnchor="end" className="fill-neutral-500" fontSize={9}>
            {fmt(v)}
          </text>
        ),
      );
    }
  }
  return out;
}

/** Position du pointeur dans le plan de travail (px), null hors de lui. */
function usePointer(): { x: number; y: number } | null {
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let frame = 0;
    let last: PointerEvent | null = null;
    const update = () => {
      frame = 0;
      const el = document.querySelector('[data-workspace-viewport]');
      if (!el || !last) return;
      const r = el.getBoundingClientRect();
      const x = last.clientX - r.left;
      const y = last.clientY - r.top;
      setPointer(x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y } : null);
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener('pointermove', onMove, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      cancelAnimationFrame(frame);
    };
  }, []);
  return pointer;
}

const pull = (axis: 'x' | 'y') => (e: ReactPointerEvent) => {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  startGuideDrag(axis, e.nativeEvent);
};

/** Faces du plan de travail : emplacement (monde, mm) et gabarit de face (plis). */
interface RulerFace {
  slot: PageSlot;
  faceId: string;
}

/**
 * Les deux règles, sans le trait du pointeur. Mémoïsé : ses props ne changent qu'avec le zoom, la vue, la
 * taille du plan de travail ou la géométrie des faces (`format` et `faces` gardent leur identité tant que
 * le gabarit et la liste des faces ne changent pas).
 */
const RulerScales = memo(function RulerScales({
  format,
  faces,
  zoom,
  viewX,
  viewY,
  width,
  height,
}: {
  format: DocumentFormat;
  faces: RulerFace[];
  zoom: number;
  viewX: number;
  viewY: number;
  width: number;
  height: number;
}) {
  rulerStats.tickRenders++;
  const k = pxPerMm(zoom);
  const steps = rulerSteps(zoom);
  const segments = topSegments({ format }, zoom, { x: viewX, y: viewY }, faces.map((f) => f.slot));
  const originY = viewY + format.bleed * k;
  return (
    <>
      <svg
        data-ruler="top"
        data-editor-handle
        width={width}
        height={R}
        className="absolute left-0 top-0 select-none"
        style={{ pointerEvents: 'auto', cursor: 'row-resize' }}
        onPointerDown={pull('y')}
      >
        <title>Règle (mm depuis le format fini) : glisser pour tirer un repère horizontal</title>
        <rect width={width} height={R} fill="#f8f8f9" />
        {segments.map((seg, i) => {
          const from = Math.max(R, seg.start);
          const to = Math.min(width, seg.end);
          if (to <= from) return null;
          const faceId = faces[i].faceId;
          return (
            <g key={seg.pageId} data-ruler-face={seg.pageId}>
              {i > 0 && <line x1={Math.floor(seg.start) + 0.5} x2={Math.floor(seg.start) + 0.5} y1={0} y2={R} stroke="#c4c7cd" />}
              <g stroke="#8b919c" strokeWidth={1}>
                {ticks(seg.origin, from, to, k, steps, true, seg.pageId)}
              </g>
              {foldPositions(format, faceId).map((f) => {
                const v = Math.round((f - format.bleed) * 1000) / 1000;
                const x = seg.origin + v * k;
                if (x < from || x > to) return null;
                return <path key={f} data-ruler-fold={v} d={`M${x - 4} ${R} L${x + 4} ${R} L${x} ${R - 5} Z`} fill="#0891b2" />;
              })}
            </g>
          );
        })}
        <line x1={0} x2={width} y1={R - 0.5} y2={R - 0.5} stroke="#c4c7cd" />
      </svg>
      <svg
        data-ruler="left"
        data-editor-handle
        width={R}
        height={height}
        className="absolute left-0 top-0 select-none"
        style={{ pointerEvents: 'auto', cursor: 'col-resize' }}
        onPointerDown={pull('x')}
      >
        <title>Règle (mm depuis le format fini) : glisser pour tirer un repère vertical</title>
        <rect width={R} height={height} fill="#f8f8f9" />
        <g stroke="#8b919c" strokeWidth={1}>
          {ticks(originY, R, height, k, steps, false, 'v')}
        </g>
        <line y1={0} y2={height} x1={R - 0.5} x2={R - 0.5} stroke="#c4c7cd" />
      </svg>
    </>
  );
});

/** Trait du pointeur sur les deux règles : le seul élément redessiné quand la souris bouge. */
function RulerPointer({ width, height }: { width: number; height: number }) {
  const pointer = usePointer();
  if (!pointer) return null;
  return (
    <>
      {pointer.x > R && (
        <svg width={width} height={R} className="pointer-events-none absolute left-0 top-0" aria-hidden>
          <line data-ruler-pointer="x" x1={Math.floor(pointer.x) + 0.5} x2={Math.floor(pointer.x) + 0.5} y1={0} y2={R} stroke="#e0245e" />
        </svg>
      )}
      {pointer.y > R && (
        <svg width={R} height={height} className="pointer-events-none absolute left-0 top-0" aria-hidden>
          <line data-ruler-pointer="y" y1={Math.floor(pointer.y) + 0.5} y2={Math.floor(pointer.y) + 0.5} x1={0} x2={R} stroke="#e0245e" />
        </svg>
      )}
    </>
  );
}

export function Rulers() {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const size = useEditor((s) => s.viewport);
  const format = doc?.format;
  // Faces montrées (ou page type éditée), en chaîne : la géométrie n'est recalculée que si elle change
  // vraiment, alors qu'un geste sur un objet recrée le document à chaque image.
  const facesKey = doc ? workspacePages(doc).map((p) => `${p.id}:${p.faceId}`).join('|') : '';
  const faces = useMemo<RulerFace[]>(
    () => (doc ? pageSlots(doc).map((slot) => ({ slot, faceId: findPageOrMaster(doc, slot.pageId)!.faceId })) : []),
    // Le document n'est lu que pour ces deux informations : le gabarit et la liste des faces.
    [format, facesKey],
  );
  if (!doc || !format || !size.w) return null;
  return (
    <>
      <RulerScales format={format} faces={faces} zoom={zoom} viewX={view.x} viewY={view.y} width={size.w} height={size.h} />
      <RulerPointer width={size.w} height={size.h} />
      <div
        data-ruler="corner"
        data-editor-handle
        className="absolute left-0 top-0 border-b border-r border-[#c4c7cd] bg-[#f8f8f9]"
        style={{ width: R, height: R, pointerEvents: 'auto' }}
        title="Règles en mm, depuis le coin du format fini de chaque face"
        onPointerDown={(e) => e.stopPropagation()}
      />
    </>
  );
}

registerOverlay({ id: 'rulers', space: 'viewport', order: 100, component: Rulers });
