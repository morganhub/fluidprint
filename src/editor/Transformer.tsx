// Poignées et cadres de sélection (tâches 2.5 et 2.12), en px écran au-dessus des faces. Les poignées de
// redimensionnement viennent de Moveable, posé sur un cadre « témoin » qui couvre la sélection : pendant
// le geste, le document est recalculé depuis son état de départ (une seule étape d'annulation), et la
// taille est arrondie au pas de la souris (voir layout.ts, mouseStepMm).
// Un objet seul tourné a un témoin tourné comme lui : ses poignées suivent ses propres côtés. Une
// sélection multiple (ou un groupe) a pour témoin sa boîte englobante, droite.
// La poignée de rotation (rond au-dessus du cadre) est dessinée ici : elle fait pivoter la sélection
// autour de son centre (Maj : pas de 15°), en un seul geste.
// Le déplacement à la souris est géré par le plan de travail (Workspace.tsx) ; les flèches, par shortcuts.ts.
// Magnétisme… : extensions enregistrées dans registry/transformer.ts (registerTransformerExtension).
import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import Moveable, { type MoveableProps, type OnResize, type OnResizeStart } from 'react-moveable';
import { formatNumber } from '../components/ui/number-field';
import type { Id, LayoutDocument } from '../model/types';
import { getEditor, useEditor } from '../store/documentStore';
import { resizeObjects } from '../store/commands';
import { objectBounds, pageIdOf, rootsOf, unionBoxes, type Box } from '../store/tree';
import { mouseStepMm, pageBoxToScreen, pageToScreen, pxPerMm, quantize, type View } from './layout';
import { modifiers, trackPointer } from './pointer';
import { transformerRegistry, type ResizeContext, type TransformerContext } from './registry/api';
import { normalizeAngle, rotateObjects, rotationCenter } from './rotation';

const MIN_SIZE_MM = 0.5;
/** Distance entre le haut du cadre et la poignée de rotation, px. */
const ROTATE_HANDLE_OFFSET_PX = 22;
const ROTATE_SNAP_DEG = 15;

/** Cadre orienté à l'écran : centre, taille et angle (degrés, sens horaire), px. */
interface Oriented {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

interface ResizeSession {
  ids: Id[];
  pageId: Id;
  /** Boîte de départ en mm : boîte englobante, ou boîte propre de l'objet tourné. */
  startBox: Box;
  startScreen: Box;
  /** Angle du témoin (objet seul tourné), 0 sinon. */
  angle: number;
  /** Pointeur au départ (px client) : la taille se calcule depuis lui, jamais depuis le témoin retouché. */
  pointer: { x: number; y: number };
  frame: number;
  pending: Box | null;
}

interface RotateView {
  proxy: Oriented;
  /** Angle affiché pendant le geste (absolu pour un objet seul, relatif sinon). */
  label: number;
}

const orientedFromBox = (b: Box, angle = 0): Oriented => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle });

/** Cadre orienté d'un objet à l'écran : sa propre boîte tournée ; un groupe : sa boîte englobante. */
function orientedOf(doc: LayoutDocument, id: Id, zoom: number, view: View): Oriented | null {
  const obj = doc.objects[id];
  const pageId = obj ? pageIdOf(doc, id) : null;
  if (!obj || !pageId) return null;
  if (obj.type === 'group' || !obj.rotation) return orientedFromBox(pageBoxToScreen(doc, pageId, objectBounds(obj), zoom, view));
  const c = pageToScreen(doc, pageId, { x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 }, zoom, view);
  const k = pxPerMm(zoom);
  return { cx: c.x, cy: c.y, w: obj.w * k, h: obj.h * k, angle: obj.rotation };
}

const orientedStyle = (o: Oriented): CSSProperties => ({
  left: o.cx - o.w / 2,
  top: o.cy - o.h / 2,
  width: Math.max(0, o.w),
  height: Math.max(0, o.h),
  transform: o.angle ? `rotate(${o.angle}deg)` : undefined,
});

function Outline({ box, color, dashed, thin }: { box: Oriented; color: string; dashed?: boolean; thin?: boolean }) {
  const style: CSSProperties = { ...orientedStyle(box), outline: `${thin ? 1 : 1.5}px ${dashed ? 'dashed' : 'solid'} ${color}` };
  return <div className="pointer-events-none absolute" style={style} />;
}

/** Point du cadre orienté : (u, v) depuis son centre, dans son propre repère (px). */
function orientedPoint(o: Oriented, u: number, v: number): { x: number; y: number } {
  const a = (o.angle * Math.PI) / 180;
  return { x: o.cx + u * Math.cos(a) - v * Math.sin(a), y: o.cy + u * Math.sin(a) + v * Math.cos(a) };
}

export function Transformer({ viewport }: { viewport: HTMLDivElement | null }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const hoverId = useEditor((s) => s.hoverId);
  const enteredGroup = useEditor((s) => s.enteredGroup);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const mode = useEditor((s) => s.mode);
  const dragOffset = useEditor((s) => s.dragOffset);
  const gesture = useEditor((s) => s.gesture);
  const extensions = transformerRegistry.use();
  const moveable = useRef<Moveable>(null);
  const [proxy, setProxy] = useState<HTMLDivElement | null>(null);
  const [rotateView, setRotateView] = useState<RotateView | null>(null);
  const session = useRef<ResizeSession | null>(null);

  const k = pxPerMm(zoom);
  const offset = dragOffset ? { x: dragOffset.dx * k, y: dragOffset.dy * k } : { x: 0, y: 0 };
  const shift = (o: Oriented): Oriented => ({ ...o, cx: o.cx + offset.x, cy: o.cy + offset.y });
  const layerColor = (id: Id) => doc?.layers.find((l) => l.id === doc.objects[id]?.layerId)?.color ?? '#2563eb';

  const ids = doc ? rootsOf(doc, selection) : [];
  const boxes = doc ? ids.map((id) => ({ id, box: orientedOf(doc, id, zoom, view) })).filter((b): b is { id: Id; box: Oriented } => !!b.box) : [];
  const aabbs = doc
    ? ids.flatMap((id) => {
        const pageId = pageIdOf(doc, id);
        return pageId ? [pageBoxToScreen(doc, pageId, objectBounds(doc.objects[id]), zoom, view)] : [];
      })
    : [];
  const union = unionBoxes(aabbs);
  const selectionBox = union ? { x: union.x + offset.x, y: union.y + offset.y, w: union.w, h: union.h } : null;
  const samePage = !!doc && ids.length > 0 && ids.every((id) => pageIdOf(doc, id) === pageIdOf(doc, ids[0]));
  const single = ids.length === 1 && doc ? doc.objects[ids[0]] : null;
  // Témoin : l'objet seul (tourné ou non) avec son angle ; sinon la boîte englobante.
  let proxyBox: Oriented | null = null;
  if (rotateView) proxyBox = rotateView.proxy;
  else if (single && single.type !== 'group' && boxes[0]) proxyBox = shift(boxes[0].box);
  else if (selectionBox) proxyBox = orientedFromBox(selectionBox);

  // Moveable mesure son témoin : il faut le prévenir quand la sélection bouge sans lui (zoom, vue, undo).
  useLayoutEffect(() => {
    if (!session.current) moveable.current?.updateRect();
  });

  if (!doc) return null;

  const idle = !!selectionBox && samePage && !mode && !dragOffset;
  const canResize = idle && !rotateView && (!gesture || !!session.current);
  const canRotate = idle && !session.current && (!gesture || !!rotateView);
  let directions: string[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  if (single?.type === 'line') directions = single.h === 0 ? ['w', 'e'] : single.w === 0 ? ['n', 's'] : directions;

  // ------------------------------------------------------------------ redimensionner

  const toMm = (screen: { w: number; h: number }, s: ResizeSession): { w: number; h: number } => {
    // Chaque bord tiré avance d'un nombre entier de pas de souris : 10 mm tirés = 10,0 mm.
    const step = mouseStepMm(getEditor().zoom);
    const kk = pxPerMm(getEditor().zoom);
    const dw = quantize((screen.w - s.startScreen.w) / kk, step);
    const dh = quantize((screen.h - s.startScreen.h) / kk, step);
    return { w: Math.max(MIN_SIZE_MM, s.startBox.w + dw), h: s.startBox.h === 0 ? 0 : Math.max(MIN_SIZE_MM, s.startBox.h + dh) };
  };

  const onResizeStart = (e: OnResizeStart) => {
    const s = getEditor();
    if (!s.doc || !proxyBox) return false;
    const list = rootsOf(s.doc, s.selection);
    const pageId = pageIdOf(s.doc, list[0])!;
    const obj = list.length === 1 ? s.doc.objects[list[0]] : null;
    const angle = obj && obj.type !== 'group' ? (obj.rotation ?? 0) : 0;
    const startBox = angle && obj ? { x: obj.x, y: obj.y, w: obj.w, h: obj.h } : unionBoxes(list.map((id) => objectBounds(s.doc!.objects[id])))!;
    const startScreen = { x: proxyBox.cx - proxyBox.w / 2, y: proxyBox.cy - proxyBox.h / 2, w: proxyBox.w, h: proxyBox.h };
    const input = e.inputEvent as MouseEvent;
    session.current = { ids: list, pageId, startBox, startScreen, angle, pointer: { x: input.clientX, y: input.clientY }, frame: 0, pending: null };
    s.beginGesture('Redimensionner');
    e.setMin([0, 0]);
    return true;
  };

  const onResize = (e: OnResize) => {
    const s = session.current;
    if (!s) return;
    const [dirX, dirY] = e.direction as [number, number];
    // Taille tirée = taille de départ + déplacement du pointeur dans le repère de l'objet. Moveable
    // repartirait de la taille courante du témoin, que le magnétisme retouche : les écarts s'y cumuleraient.
    const input = e.inputEvent as MouseEvent;
    const a = (-s.angle * Math.PI) / 180;
    const px = input.clientX - s.pointer.x;
    const py = input.clientY - s.pointer.y;
    const du = px * Math.cos(a) - py * Math.sin(a);
    const dv = px * Math.sin(a) + py * Math.cos(a);
    let { w, h } = toMm({ w: s.startScreen.w + dirX * du, h: s.startScreen.h + dirY * dv }, s);
    if (modifiers.shift && s.startBox.w > 0 && s.startBox.h > 0) {
      // Maj : proportions gardées, pilotées par le côté tiré (la largeur pour un coin).
      const scale = dirX !== 0 ? w / s.startBox.w : h / s.startBox.h;
      w = s.startBox.w * scale;
      h = s.startBox.h * scale;
    }
    if (dirX === 0) w = s.startBox.w;
    if (dirY === 0) h = s.startBox.h;
    let box: Box;
    if (s.angle) {
      // Objet tourné : le point opposé à la poignée tirée reste fixe, dans le repère de l'objet.
      const a = (s.angle * Math.PI) / 180;
      const rot = (u: number, v: number) => ({ x: u * Math.cos(a) - v * Math.sin(a), y: u * Math.sin(a) + v * Math.cos(a) });
      const c0 = { x: s.startBox.x + s.startBox.w / 2, y: s.startBox.y + s.startBox.h / 2 };
      const a0 = rot((-dirX * s.startBox.w) / 2, (-dirY * s.startBox.h) / 2);
      const a1 = rot((-dirX * w) / 2, (-dirY * h) / 2);
      const c1 = { x: c0.x + a0.x - a1.x, y: c0.y + a0.y - a1.y };
      box = { x: c1.x - w / 2, y: c1.y - h / 2, w, h };
    } else {
      box = {
        x: dirX === -1 ? s.startBox.x + s.startBox.w - w : s.startBox.x,
        y: dirY === -1 ? s.startBox.y + s.startBox.h - h : s.startBox.y,
        w,
        h,
      };
      const ctx: ResizeContext = { state: getEditor(), ids: s.ids, pageId: s.pageId, startBox: s.startBox, event: e.inputEvent, direction: [dirX, dirY] };
      for (const ext of transformerRegistry.list()) if (ext.adjustResize) box = ext.adjustResize(box, ctx);
    }
    // Le témoin suit tout de suite ; le document, à l'image suivante (un seul recalcul par image).
    const st = getEditor();
    const screen = pageBoxToScreen(st.doc!, s.pageId, box, st.zoom, st.view);
    Object.assign((e.target as HTMLElement).style, {
      left: `${screen.x}px`,
      top: `${screen.y}px`,
      width: `${screen.w}px`,
      height: `${screen.h}px`,
      transform: s.angle ? `rotate(${s.angle}deg)` : '',
    });
    s.pending = box;
    if (!s.frame) {
      s.frame = requestAnimationFrame(() => {
        s.frame = 0;
        flush(s);
      });
    }
  };

  const flush = (s: ResizeSession) => {
    const box = s.pending;
    if (!box) return;
    s.pending = null;
    getEditor().previewGesture((d) => resizeObjects(d, s.ids, s.startBox, box));
  };

  const onResizeEnd = () => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    cancelAnimationFrame(s.frame);
    flush(s);
    getEditor().commitGesture({ select: s.ids });
    for (const ext of transformerRegistry.list()) ext.onGestureEnd?.();
    requestAnimationFrame(() => moveable.current?.updateRect());
  };

  // ------------------------------------------------------------------ faire pivoter

  const onRotateDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !viewport || !proxyBox) return;
    e.stopPropagation();
    e.preventDefault();
    const s = getEditor();
    if (!s.doc) return;
    const list = rootsOf(s.doc, s.selection);
    const pivot = rotationCenter(s.doc, list);
    if (!pivot) return;
    const obj = list.length === 1 ? s.doc.objects[list[0]] : null;
    // Objet seul : Maj cale l'angle ABSOLU sur 15° ; sélection multiple ou groupe : la rotation appliquée.
    const startAngle = obj && obj.type !== 'group' ? (obj.rotation ?? 0) : null;
    const start = { ...proxyBox };
    const rect = viewport.getBoundingClientRect();
    const angleAt = (ev: PointerEvent) => (Math.atan2(ev.clientY - rect.top - start.cy, ev.clientX - rect.left - start.cx) * 180) / Math.PI;
    const a0 = angleAt(e.nativeEvent);
    let started = false;
    let frame = 0;
    let pending: number | null = null;
    const flushRotate = () => {
      frame = 0;
      if (pending === null) return;
      const delta = pending;
      pending = null;
      getEditor().previewGesture((d) => rotateObjects(d, list, delta, pivot));
    };
    trackPointer(
      e.nativeEvent,
      {
        move: (ev) => {
          if (!started) {
            started = true;
            getEditor().beginGesture('Faire pivoter');
          }
          let delta = angleAt(ev) - a0;
          if (startAngle !== null) {
            let target = normalizeAngle(startAngle + delta);
            if (ev.shiftKey) target = normalizeAngle(Math.round(target / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG);
            delta = target - startAngle;
          } else if (ev.shiftKey) delta = Math.round(delta / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
          delta = normalizeAngle(delta);
          pending = delta;
          if (!frame) frame = requestAnimationFrame(flushRotate);
          setRotateView({ proxy: { ...start, angle: start.angle + delta }, label: startAngle !== null ? normalizeAngle(startAngle + delta) : delta });
        },
        end: (_ev, cancelled) => {
          cancelAnimationFrame(frame);
          setRotateView(null);
          if (!started) return;
          if (cancelled) {
            getEditor().cancelGesture();
            return;
          }
          flushRotate();
          getEditor().commitGesture({ select: list });
          requestAnimationFrame(() => moveable.current?.updateRect());
        },
      },
      viewport,
    );
  };

  const ctx: TransformerContext | null = selectionBox ? { state: getEditor(), ids, screenBox: selectionBox } : null;
  let extraProps: Partial<MoveableProps> = {};
  if (ctx) for (const ext of extensions) if (ext.moveableProps) extraProps = { ...extraProps, ...ext.moveableProps(ctx) };

  const hoverBox = hoverId && !selection.includes(hoverId) && !gesture ? orientedOf(doc, hoverId, zoom, view) : null;
  const groupBox = enteredGroup ? orientedOf(doc, enteredGroup, zoom, view) : null;

  let rotateHandle = null;
  if (proxyBox && canRotate) {
    const top = orientedPoint(proxyBox, 0, -proxyBox.h / 2);
    const knob = orientedPoint(proxyBox, 0, -proxyBox.h / 2 - ROTATE_HANDLE_OFFSET_PX);
    rotateHandle = (
      <>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
          <line x1={top.x} y1={top.y} x2={knob.x} y2={knob.y} stroke="#1f7ae0" strokeWidth={1} />
        </svg>
        <div
          data-rotation-handle
          data-editor-handle
          title="Faire pivoter (Maj : par pas de 15°)"
          onPointerDown={onRotateDown}
          className="absolute size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#1f7ae0] bg-white"
          style={{ left: knob.x, top: knob.y, pointerEvents: 'auto', cursor: 'grab' }}
        />
        {rotateView && (
          <div
            data-rotation-label
            className="pointer-events-none absolute rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] tabular-nums text-white"
            style={{ left: knob.x + 10, top: knob.y - 22 }}
          >
            {formatNumber(rotateView.label, 1)}°
          </div>
        )}
      </>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-selection-layer>
      {groupBox && <Outline box={groupBox} color="#64748b" dashed thin />}
      {hoverBox && hoverId && <Outline box={hoverBox} color={layerColor(hoverId)} thin />}
      {boxes.map(({ id, box }) => (
        <Outline key={id} box={shift(box)} color={layerColor(id)} />
      ))}
      {proxyBox && <div ref={setProxy} data-selection-box className="pointer-events-none absolute" style={orientedStyle(proxyBox)} />}
      {ctx && extensions.map((ext) => (ext.render ? <ext.render key={ext.id} {...ctx} /> : null))}
      {proxy && proxyBox && canResize && viewport && (
        <Moveable
          ref={moveable}
          target={proxy}
          className="editor-moveable"
          resizable
          keepRatio={false}
          throttleResize={0}
          origin={false}
          renderDirections={directions}
          onResizeStart={onResizeStart}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          {...extraProps}
        />
      )}
      {rotateHandle}
    </div>
  );
}
