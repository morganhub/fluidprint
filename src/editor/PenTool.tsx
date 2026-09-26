// Outil plume (tâche 3.5) : tracer une forme point par point (clic = sommet vif, clic-glisser = point
// lisse et ses poignées de Bézier), la fermer en cliquant sur le premier point (ou Entrée), puis éditer
// ses points et ses poignées (double-clic sur la forme, ou « Modifier les points » dans Propriétés).
// La forme est un cadre : elle reçoit une photo comme la goutte (décision I1).
import { PenTool as PenIcon } from 'lucide-react';
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { contoursToCommands, frameShapePath, mapCommands, normalizeCommands, pathToContours, type Contour, type PathNode } from '../model/shapes';
import type { FrameObject, Id, LayoutDocument, Mm } from '../model/types';
import { addObjects, refreshAncestors, round4 } from '../store/commands';
import { defaultLayerId, editorStore, getEditor, useEditor } from '../store/documentStore';
import { isSelectable, pageIdOf } from '../store/tree';
import { mouseStepMm, pageSlot, pageToScreen, pxPerMm, quantize, screenToWorld } from './layout';
import { modifiers, trackPointer } from './pointer';
import { registerInteraction, registerOverlay, registerShortcut, registerTool } from './registry/api';
import { defaultColor, makeFrame } from './tools/defaults';

type Point = [number, number];

export const PEN_EDIT_MODE = 'pen-edit';
/** Distance (px écran) sous laquelle un clic attrape un point ou ferme la forme. */
const HIT_PX = 7;
const DRAG_PX = 3;
/** Taille minimale d'une forme tracée (mm). */
const MIN_SHAPE_MM = 0.5;

// ---------------------------------------------------------------- tracé en cours

interface Drawing {
  pageId: Id;
  /** Points en mm dans le repère de la face. */
  nodes: PathNode[];
}

interface PenState {
  drawing: Drawing | null;
  /** Position du pointeur (mm, repère de la face du tracé) : l'élastique du prochain segment. */
  hover: Point | null;
}

export const penStore = createStore<PenState>(() => ({ drawing: null, hover: null }));

/** Point du monde → mm de la face du tracé, au pas « rond » de la souris (voir layout.ts, mouseStepMm). */
const pageOfDrawing = (doc: LayoutDocument, pageId: Id, world: { x: Mm; y: Mm }): Point => {
  const slot = pageSlot(doc, pageId)!;
  const step = mouseStepMm(getEditor().zoom);
  return [quantize(world.x - slot.x, step), quantize(world.y - slot.y, step)];
};

const screenOf = (pageId: Id, [x, y]: Point) => {
  const s = getEditor();
  return pageToScreen(s.doc!, pageId, { x, y }, s.zoom, s.view);
};

/** Crée le cadre de la forme tracée (points en mm de la face) ; renvoie son identifiant. */
export function createPenShape(pageId: Id, nodes: PathNode[]): Id | undefined {
  const s = getEditor();
  const doc = s.doc;
  if (!doc || nodes.length < 2) return undefined;
  let normalized: { d: string; box: { x: Mm; y: Mm; w: Mm; h: Mm } };
  try {
    normalized = normalizeCommands(contoursToCommands([{ nodes, closed: true }]));
  } catch {
    return undefined;
  }
  const { d, box } = normalized;
  if (box.w < MIN_SHAPE_MM || box.h < MIN_SHAPE_MM) return undefined;
  const layerId = defaultLayerId(doc, s.activeLayerId);
  if (!layerId) return undefined;
  return s.apply(
    'Tracer une forme',
    (draft) => {
      const frame = makeFrame(draft, { layerId, box }, { kind: 'path', d, preset: 'plume' }, 'Forme libre');
      delete frame.placeholder;
      frame.fill = defaultColor(draft, 'fill');
      addObjects(draft, [frame], [frame.id], { pageId });
      return frame.id;
    },
    { select: (id) => (id ? [id] : []) },
  );
}

/** Termine le tracé : forme créée s'il a au moins 3 points (ou 2 avec une courbe), sinon abandonné. */
export function finishDrawing(): Id | undefined {
  const drawing = penStore.getState().drawing;
  penStore.setState({ drawing: null, hover: null });
  if (!drawing) return undefined;
  const curved = drawing.nodes.some((n) => n.in || n.out);
  if (drawing.nodes.length < 3 && !(drawing.nodes.length === 2 && curved)) return undefined;
  const id = createPenShape(drawing.pageId, drawing.nodes);
  if (id && getEditor().tool === 'pen') getEditor().setTool('select');
  return id;
}

export function cancelDrawing(): void {
  penStore.setState({ drawing: null, hover: null });
}

function onPenPointerDown(e: PointerEvent, ctx: { state: ReturnType<typeof getEditor>; point: { pageId: Id; x: Mm; y: Mm } | null; world: { x: Mm; y: Mm } }) {
  if (e.button !== 0) return;
  e.preventDefault();
  const doc = ctx.state.doc!;
  let drawing = penStore.getState().drawing;
  if (!drawing) {
    if (!ctx.point) return;
    drawing = { pageId: ctx.point.pageId, nodes: [] };
  }
  const pageId = drawing.pageId;
  const p = pageOfDrawing(doc, pageId, ctx.world);
  const k = pxPerMm(ctx.state.zoom);

  // Clic sur le premier point : la forme se ferme.
  const first = drawing.nodes[0];
  if (first && drawing.nodes.length >= 2 && Math.hypot(first.p[0] - p[0], first.p[1] - p[1]) * k <= HIT_PX) {
    finishDrawing();
    return;
  }

  const node: PathNode = { p, in: null, out: null };
  const nodes = [...drawing.nodes, node];
  penStore.setState({ drawing: { pageId, nodes }, hover: p });
  const start = { x: e.clientX, y: e.clientY };
  trackPointer(e, {
    move: (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_PX) return;
      const st = getEditor();
      const vp = document.querySelector('[data-workspace-viewport]')!.getBoundingClientRect();
      const q = pageOfDrawing(st.doc!, pageId, screenToWorld({ x: ev.clientX - vp.left, y: ev.clientY - vp.top }, st.zoom, st.view));
      // Point lisse : poignée de sortie sous le pointeur, poignée d'entrée symétrique.
      const smooth: PathNode = { p, out: q, in: [2 * p[0] - q[0], 2 * p[1] - q[1]] };
      const d = penStore.getState().drawing;
      if (d) penStore.setState({ drawing: { ...d, nodes: [...d.nodes.slice(0, -1), smooth] }, hover: q });
    },
    end: () => undefined,
  });
}

registerTool({
  id: 'pen',
  label: 'Plume',
  icon: PenIcon,
  order: 65,
  shortcut: 'P',
  cursor: 'crosshair',
  sticky: true,
  onPointerDown: onPenPointerDown,
});

// Changer d'outil en cours de tracé : la forme est gardée si elle a assez de points.
editorStore.subscribe((s, prev) => {
  if (s.tool !== prev.tool && prev.tool === 'pen' && penStore.getState().drawing) finishDrawing();
});

const drawingActive = () => !!penStore.getState().drawing;

registerShortcut({ id: 'pen-finish', keys: 'Enter', label: 'Plume : fermer la forme', group: 'Plume', order: -20, when: drawingActive, run: () => void finishDrawing() });
registerShortcut({
  id: 'pen-escape',
  keys: 'Escape',
  label: 'Plume : terminer (ou abandonner sous 3 points)',
  group: 'Plume',
  order: -20,
  when: drawingActive,
  run: () => {
    if (!finishDrawing()) cancelDrawing();
  },
});
registerShortcut({
  id: 'pen-undo-point',
  keys: ['Backspace', 'Delete'],
  label: 'Plume : retirer le dernier point',
  group: 'Plume',
  order: -20,
  when: drawingActive,
  run: () => {
    const d = penStore.getState().drawing!;
    const nodes = d.nodes.slice(0, -1);
    penStore.setState({ drawing: nodes.length ? { ...d, nodes } : null });
  },
});

// ---------------------------------------------------------------- dessin commun (px écran)

function nodesPath(nodes: PathNode[], closed: boolean, map: (p: Point) => Point): string {
  if (!nodes.length) return '';
  const cmds = mapCommands(contoursToCommands([{ nodes, closed }]), map);
  return cmds
    .map((c) => (c.c === 'Z' ? 'Z' : c.c === 'C' ? `C${c.p1.join(' ')} ${c.p2.join(' ')} ${c.p.join(' ')}` : c.c === 'Q' ? `Q${c.p1.join(' ')} ${c.p.join(' ')}` : `${c.c}${c.p.join(' ')}`))
    .join('');
}

function Handles({ nodes, map, selected, onAnchor, onHandle }: {
  nodes: PathNode[];
  map: (p: Point) => Point;
  selected?: number | null;
  onAnchor?: (i: number, e: ReactPointerEvent) => void;
  onHandle?: (i: number, which: 'in' | 'out', e: ReactPointerEvent) => void;
}) {
  const interactive = !!onAnchor;
  return (
    <>
      {nodes.map((n, i) => {
        const p = map(n.p);
        return (
          <g key={i}>
            {(['in', 'out'] as const).map((which) => {
              const h = n[which];
              if (!h) return null;
              const q = map(h);
              return (
                <g key={which}>
                  <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#0284c7" strokeWidth={1} />
                  <circle
                    data-pen-handle={`${i}-${which}`}
                    cx={q[0]}
                    cy={q[1]}
                    r={4}
                    fill="#fff"
                    stroke="#0284c7"
                    strokeWidth={1.5}
                    style={{ pointerEvents: interactive ? 'auto' : 'none', cursor: 'pointer' }}
                    onPointerDown={onHandle ? (e) => onHandle(i, which, e) : undefined}
                  />
                </g>
              );
            })}
            <rect
              data-pen-anchor={i}
              x={p[0] - 4}
              y={p[1] - 4}
              width={8}
              height={8}
              fill={selected === i ? '#0284c7' : '#fff'}
              stroke="#0284c7"
              strokeWidth={1.5}
              style={{ pointerEvents: interactive ? 'auto' : 'none', cursor: 'move' }}
              onPointerDown={onAnchor ? (e) => onAnchor(i, e) : undefined}
            />
          </g>
        );
      })}
    </>
  );
}

/** Aperçu du tracé en cours et de l'élastique, au-dessus des faces. */
function DrawingPreview() {
  const drawing = useStore(penStore, (s) => s.drawing);
  const hover = useStore(penStore, (s) => s.hover);
  const tool = useEditor((s) => s.tool);
  useEditor((s) => s.zoom);
  useEditor((s) => s.view);

  // Suivi du pointeur pour l'élastique, tant que l'outil Plume est actif.
  useEffect(() => {
    if (tool !== 'pen') return;
    const move = (e: PointerEvent) => {
      const d = penStore.getState().drawing;
      if (!d || e.buttons) return;
      const st = getEditor();
      const vp = document.querySelector('[data-workspace-viewport]')?.getBoundingClientRect();
      if (!vp || !st.doc) return;
      penStore.setState({ hover: pageOfDrawing(st.doc, d.pageId, screenToWorld({ x: e.clientX - vp.left, y: e.clientY - vp.top }, st.zoom, st.view)) });
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [tool]);

  if (!drawing || !getEditor().doc) return null;
  const map = (p: Point): Point => {
    const s = screenOf(drawing.pageId, p);
    return [s.x, s.y];
  };
  const last = drawing.nodes[drawing.nodes.length - 1];
  let rubber = '';
  if (last && hover) {
    const a = map(last.p);
    const b = map(hover);
    const c = last.out ? map(last.out) : a;
    rubber = `M${a.join(' ')}C${c.join(' ')} ${b.join(' ')} ${b.join(' ')}`;
  }
  return (
    <svg data-pen-preview className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      <path d={nodesPath(drawing.nodes, false, map)} fill="rgba(2, 132, 199, 0.08)" stroke="#0284c7" strokeWidth={1.5} />
      {rubber && <path d={rubber} fill="none" stroke="#0284c7" strokeWidth={1} strokeDasharray="4 3" />}
      <Handles nodes={drawing.nodes} map={map} />
    </svg>
  );
}

registerOverlay({ id: 'pen-preview', space: 'viewport', order: 50, component: DrawingPreview });

// ---------------------------------------------------------------- édition des points

interface EditSession {
  frameId: Id;
  base: FrameObject;
}

let editSession: EditSession | null = null;

/** Ouvre l'édition des points d'un cadre (sa forme devient un tracé libre). */
export function startPenEdit(frameId: Id): boolean {
  const s = getEditor();
  const frame = s.doc?.objects[frameId];
  if (!s.doc || s.mode || s.gesture || frame?.type !== 'frame' || !(frame.w > 0 && frame.h > 0)) return false;
  s.select([frameId]);
  editSession = { frameId, base: frame };
  getEditor().beginGesture('Modifier les points', { autosave: true });
  getEditor().setMode({ id: PEN_EDIT_MODE, target: frameId });
  return true;
}

export function finishPenEdit(commit = true): void {
  const s = getEditor();
  const current = editSession;
  editSession = null;
  if (s.mode?.id === PEN_EDIT_MODE) s.setMode(null);
  if (!current) return;
  if (commit) getEditor().commitGesture({ select: [current.frameId] });
  else getEditor().cancelGesture();
}

/** Contours d'un cadre, en mm dans le repère du cadre (coin haut-gauche, sans rotation). */
export const frameContours = (frame: FrameObject): Contour[] => pathToContours(frameShapePath(frame.shape, frame.w, frame.h));

/** Écrit des contours (mm, repère du cadre de départ) dans le geste : boîte, tracé normalisé, photo immobile. */
function writeContours(contours: Contour[]): void {
  const session = editSession;
  if (!session) return;
  let normalized: ReturnType<typeof normalizeCommands>;
  try {
    normalized = normalizeCommands(contoursToCommands(contours));
  } catch {
    return;
  }
  const { d, box } = normalized;
  if (box.w < MIN_SHAPE_MM / 5 || box.h < MIN_SHAPE_MM / 5) return;
  const base = session.base;
  getEditor().previewGesture((draft) => {
    const f = draft.objects[session.frameId];
    if (f?.type !== 'frame') return;
    f.x = round4(base.x + box.x);
    f.y = round4(base.y + box.y);
    f.w = round4(box.w);
    f.h = round4(box.h);
    f.shape = { kind: 'path', d, preset: 'plume' };
    // La photo ne bouge pas sur la page : seule la découpe change.
    if (base.image) f.image = { ...base.image, x: round4(base.image.x - box.x), y: round4(base.image.y - box.y), fit: 'custom' };
    refreshAncestors(draft, session.frameId);
  });
}

function PenEditor({ frameId }: { frameId: Id }) {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const [contours, setContours] = useState<Contour[]>(() => (editSession ? frameContours(editSession.base) : []));
  const [selected, setSelected] = useState<{ c: number; n: number } | null>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const session = editSession;
  const valid = !!doc && !!session && doc.objects[frameId]?.type === 'frame' && !!pageIdOf(doc, frameId);

  useEffect(() => {
    if (!valid) finishPenEdit(false);
  }, [valid]);

  // Supprimer le point choisi (une forme fermée garde au moins 3 points).
  useEffect(() => {
    const unregister = registerShortcut({
      id: 'pen-edit-delete',
      keys: ['Delete', 'Backspace'],
      label: 'Supprimer le point choisi',
      group: 'Plume',
      order: -20,
      allowInMode: true,
      when: (s) => s.mode?.id === PEN_EDIT_MODE && !!selected,
      run: () => {
        if (!selected) return;
        const next = structuredClone(contours);
        const c = next[selected.c];
        if (!c || c.nodes.length <= (c.closed ? 3 : 2)) return;
        c.nodes.splice(selected.n, 1);
        setSelected(null);
        setContours(next);
        writeContours(next);
      },
    });
    return unregister;
  }, [contours, selected]);

  if (!valid || !session || !doc) return null;
  const pageId = pageIdOf(doc, frameId)!;
  const base = session.base;
  const angle = ((base.rotation ?? 0) * Math.PI) / 180;
  const k = pxPerMm(zoom);
  const center = pageToScreen(doc, pageId, { x: base.x + base.w / 2, y: base.y + base.h / 2 }, zoom, view);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  /** mm du cadre de départ → px écran (rotation du cadre comprise). */
  const map = ([x, y]: Point): Point => {
    const dx = (x - base.w / 2) * k;
    const dy = (y - base.h / 2) * k;
    return [center.x + dx * cos - dy * sin, center.y + dx * sin + dy * cos];
  };
  const unmap = (clientX: number, clientY: number): Point => {
    const vp = overlay!.getBoundingClientRect();
    const dx = clientX - vp.left - center.x;
    const dy = clientY - vp.top - center.y;
    return [(dx * cos + dy * sin) / k + base.w / 2, (-dx * sin + dy * cos) / k + base.h / 2];
  };

  const drag = (e: ReactPointerEvent, apply: (p: Point, alt: boolean) => Contour[]) => {
    e.stopPropagation();
    e.preventDefault();
    trackPointer(
      e.nativeEvent,
      {
        move: (ev) => {
          const next = apply(unmap(ev.clientX, ev.clientY), ev.altKey);
          setContours(next);
          writeContours(next);
        },
        end: () => undefined,
      },
      overlay,
    );
  };

  const onAnchor = (ci: number) => (ni: number, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    setSelected({ c: ci, n: ni });
    // Alt+clic : bascule point vif / point lisse.
    if (e.altKey) {
      e.stopPropagation();
      const next = structuredClone(contours);
      const nodes = next[ci].nodes;
      const node = nodes[ni];
      if (node.in || node.out) {
        node.in = null;
        node.out = null;
      } else {
        const prev = nodes[(ni + nodes.length - 1) % nodes.length].p;
        const after = nodes[(ni + 1) % nodes.length].p;
        const t: Point = [(after[0] - prev[0]) / 6, (after[1] - prev[1]) / 6];
        node.in = [node.p[0] - t[0], node.p[1] - t[1]];
        node.out = [node.p[0] + t[0], node.p[1] + t[1]];
      }
      setContours(next);
      writeContours(next);
      return;
    }
    const start = contours[ci].nodes[ni];
    const from = unmap(e.clientX, e.clientY);
    const step = mouseStepMm(getEditor().zoom);
    drag(e, (p) => {
      const dx = quantize(p[0] - from[0], step);
      const dy = quantize(p[1] - from[1], step);
      const next = structuredClone(contours);
      const move = (q: Point | null): Point | null => (q ? [q[0] + dx, q[1] + dy] : null);
      next[ci].nodes[ni] = { p: move(start.p)!, in: move(start.in), out: move(start.out) };
      return next;
    });
  };

  const onHandle = (ci: number) => (ni: number, which: 'in' | 'out', e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    setSelected({ c: ci, n: ni });
    const start = contours[ci].nodes[ni];
    const other = which === 'in' ? 'out' : 'in';
    // Poignées alignées au départ : elles le restent (point lisse), sauf avec Alt.
    const opposite = start[other];
    const aligned =
      !!opposite && !!start[which] && Math.abs((start[which]![0] - start.p[0]) * (opposite[1] - start.p[1]) - (start[which]![1] - start.p[1]) * (opposite[0] - start.p[0])) < 1e-6;
    drag(e, (p, alt) => {
      const next = structuredClone(contours);
      const node = next[ci].nodes[ni];
      node[which] = p;
      if (aligned && !alt && opposite) {
        const len = Math.hypot(opposite[0] - start.p[0], opposite[1] - start.p[1]);
        const dx = p[0] - start.p[0];
        const dy = p[1] - start.p[1];
        const l = Math.hypot(dx, dy) || 1;
        node[other] = [start.p[0] - (dx / l) * len, start.p[1] - (dy / l) * len];
      }
      return next;
    });
  };

  const onBackground = (e: ReactPointerEvent) => {
    if (e.button !== 0 || modifiers.space || e.target !== e.currentTarget) return;
    finishPenEdit(true);
  };

  return (
    <div ref={setOverlay} data-pen-edit={frameId} className="absolute inset-0" style={{ pointerEvents: 'auto', zIndex: 5 }} onPointerDown={onBackground}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {contours.map((c, ci) => (
          <path key={ci} d={nodesPath(c.nodes, c.closed, map)} fill="none" stroke="#0284c7" strokeWidth={1.5} />
        ))}
        {contours.map((c, ci) => (
          <Handles key={ci} nodes={c.nodes} map={map} selected={selected?.c === ci ? selected.n : null} onAnchor={onAnchor(ci)} onHandle={onHandle(ci)} />
        ))}
      </svg>
      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-neutral-900/85 px-2 py-1 text-[11px] text-white">
        Glisser un point ou une poignée · Alt+clic : point vif ou lisse · Suppr : retirer le point · Échap : valider
      </div>
    </div>
  );
}

function PenEditOverlay() {
  const mode = useEditor((s) => s.mode);
  if (mode?.id !== PEN_EDIT_MODE || !mode.target) return null;
  return <PenEditor key={mode.target} frameId={mode.target} />;
}

registerOverlay({ id: 'pen-edit', space: 'viewport', order: 51, component: PenEditOverlay });

// Double-clic sur une forme libre sans photo : édition de ses points (avec photo, c'est le recadrage).
registerInteraction({
  id: 'pen-edit',
  order: 30,
  onDoubleClick: ({ state, deepId }) => {
    const obj = state.doc?.objects[deepId];
    if (obj?.type !== 'frame' || obj.image || obj.shape.kind !== 'path' || obj.shape.polygon || !isSelectable(state.doc!, deepId)) return false;
    return startPenEdit(deepId);
  },
});

registerShortcut({
  id: 'pen-edit-validate',
  keys: ['Escape', 'Enter'],
  label: 'Valider les points',
  group: 'Plume',
  allowInMode: true,
  when: (s) => s.mode?.id === PEN_EDIT_MODE,
  run: () => finishPenEdit(true),
});

registerShortcut({
  id: 'pen-edit-cancel',
  keys: 'Mod+Z',
  label: 'Annuler l’édition des points',
  group: 'Plume',
  allowInMode: true,
  when: (s) => s.mode?.id === PEN_EDIT_MODE,
  run: () => finishPenEdit(false),
});
