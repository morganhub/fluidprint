// Plan de travail (tâche 2.3) : les faces côte à côte sur fond gris, zoom (Ctrl+molette autour du
// pointeur, 100 % = taille réelle), vue (molette, espace + glisser, outil Main, bouton du milieu),
// sélection (clic, Maj+clic, lasso), entrée dans un groupe (double-clic) et création par clic-glisser.
// Le déplacement des objets à la souris est ici aussi : aperçu en direct sur le DOM, une seule écriture
// dans le store au lâcher (tâche 2.5).
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import Selecto from 'react-selecto';
import { faceSize } from '../model/format';
import { findPageOrMaster } from '../model/masters';
import { useMasterEditing } from './masterView';
import type { Id, LayoutDocument, Mm, Page } from '../model/types';
import { PageView } from '../render/PageView';
import { getEditor, useEditor } from '../store/documentStore';
import { isSelectable, objectBounds, pageIdOf, resolveAtScope, rootsOf, unionBoxes, type Box } from '../store/tree';
import { hitTest, lassoHits } from './hitTest';
import { mouseStepMm, pageSlots, pxPerMm, quantize, screenToWorld, worldToPage, LABEL_SPACE_PX } from './layout';
import { modifiers, trackPointer } from './pointer';
import { overlayRegistry, toolRegistry, transformerRegistry, interactionRegistry, type CreateContext, type MoveContext } from './registry/api';
import { Transformer } from './Transformer';

/** En deçà de ce déplacement (px), un appui-relâcher reste un clic. */
const DRAG_THRESHOLD_PX = 3;
const DOUBLE_CLICK_MS = 400;

const isHandle = (target: EventTarget | null) => target instanceof Element && !!target.closest('.moveable-control-box, [data-editor-handle]');

/** Une face et ses surcouches « page », dans son emplacement du monde. */
const PageSlotView = memo(function PageSlotView({ doc, page, zoom, left, top }: { doc: LayoutDocument; page: Page; zoom: number; left: number; top: number }) {
  const overlays = overlayRegistry.use();
  const size = faceSize(doc.format);
  return (
    <div style={{ position: 'absolute', left, top }} data-page-slot={page.id}>
      <div
        className="pointer-events-none absolute bottom-full left-0 truncate pb-1 text-[11px] font-medium text-neutral-500"
        style={{ maxWidth: `${size.w * pxPerMm(zoom)}px`, height: LABEL_SPACE_PX }}
      >
        {page.name}
      </div>
      <PageView doc={doc} page={page} mode="screen" zoom={zoom} className="shadow-[0_1px_4px_rgba(0,0,0,0.25)]" />
      <div
        data-page-overlays={page.id}
        style={{ position: 'absolute', left: 0, top: 0, width: `${size.w}mm`, height: `${size.h}mm`, transform: `scale(${zoom})`, transformOrigin: '0 0', pointerEvents: 'none' }}
      >
        {overlays.map((o) => (o.space === 'page' ? <o.component key={o.id} doc={doc} page={page} zoom={zoom} /> : null))}
      </div>
    </div>
  );
});

/** Déplace des éléments d'objets à l'écran (aperçu du glisser), sans toucher au document. */
function previewTranslate(root: HTMLElement, ids: Id[], dx: Mm, dy: Mm, saved: Map<HTMLElement, string>) {
  for (const id of ids) {
    for (const el of root.querySelectorAll<HTMLElement>(`[data-page-id] [data-obj-id="${CSS.escape(id)}"]`)) {
      if (!saved.has(el)) saved.set(el, el.style.transform);
      const base = saved.get(el) ?? '';
      el.style.transform = `translate(${dx}mm, ${dy}mm) ${base}`.trim();
    }
  }
}

function restoreTransforms(saved: Map<HTMLElement, string>) {
  for (const [el, transform] of saved) el.style.transform = transform;
  saved.clear();
}

export function Workspace() {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const tool = useEditor((s) => s.tool);
  useMasterEditing();
  const overlays = overlayRegistry.use();
  toolRegistry.use();
  const [viewport, setViewportEl] = useState<HTMLDivElement | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [draftBox, setDraftBox] = useState<Box | null>(null);
  /** Dernier clic (appui relâché sans bouger) : premier clic possible d'un double-clic. */
  const lastClick = useRef<{ time: number; x: number; y: number } | null>(null);
  const lassoBase = useRef<Id[]>([]);
  const hoverFrame = useRef(0);

  // Taille du plan de travail → store (le zoom « Ajuster » en dépend).
  useLayoutEffect(() => {
    if (!viewport) return;
    const update = () => getEditor().setViewport({ w: viewport.clientWidth, h: viewport.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  // Molette : défilement ; Ctrl+molette (ou pincement du pavé tactile) : zoom autour du pointeur.
  useEffect(() => {
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = getEditor();
      const rect = viewport.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      if (e.ctrlKey || e.metaKey) {
        s.setZoom(s.zoom * Math.exp(-e.deltaY * unit * 0.002), { x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else if (e.shiftKey && !e.deltaX) {
        s.panBy(-e.deltaY * unit, 0);
      } else {
        s.panBy(-e.deltaX * unit, -e.deltaY * unit);
      }
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [viewport]);

  // Espace maintenu : main temporaire.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e) || getEditor().mode) return;
      e.preventDefault();
      modifiers.space = true;
      if (!e.repeat) setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      modifiers.space = false;
      setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  if (!doc) return null;

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = viewport!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const worldAt = (e: { clientX: number; clientY: number }) => {
    const s = getEditor();
    return screenToWorld(local(e), s.zoom, s.view);
  };

  // ------------------------------------------------------------------ vue

  const startPan = (e: ReactPointerEvent) => {
    e.preventDefault();
    const s = getEditor();
    const start = { x: e.clientX, y: e.clientY };
    const startView = s.view;
    setPanning(true);
    trackPointer(
      e.nativeEvent,
      {
        move: (ev) => getEditor().setView({ x: startView.x + ev.clientX - start.x, y: startView.y + ev.clientY - start.y }),
        end: () => setPanning(false),
      },
      viewport,
    );
  };

  // ------------------------------------------------------------------ création

  const startCreate = (e: ReactPointerEvent, toolId: string) => {
    e.preventDefault();
    const s = getEditor();
    const def = toolRegistry.get(toolId);
    if (!def?.create) return;
    const startLocal = local(e);
    const startWorld = worldAt(e);
    const target = worldToPage(s.doc!, startWorld, true);
    if (!target) return;
    const slot = pageSlots(s.doc!).find((p) => p.pageId === target.pageId)!;
    const step = mouseStepMm(s.zoom);
    let last = { local: startLocal, shift: e.shiftKey, alt: e.altKey };
    const geometry = () => {
      const st = getEditor();
      const end = screenToWorld(last.local, st.zoom, st.view);
      let dx = quantize(end.x - startWorld.x, step);
      let dy = quantize(end.y - startWorld.y, step);
      if (last.shift) {
        if (toolId === 'line') {
          // Ligne : horizontale, verticale ou à 45°.
          const a = Math.abs(dx);
          const b = Math.abs(dy);
          if (a > 2 * b) dy = 0;
          else if (b > 2 * a) dx = 0;
          else dy = Math.sign(dy || 1) * a;
        } else {
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          dx = Math.sign(dx || 1) * side;
          dy = Math.sign(dy || 1) * side;
        }
      }
      const x0 = quantize(startWorld.x - slot.x, 0.01);
      const y0 = quantize(startWorld.y - slot.y, 0.01);
      return { start: { x: x0, y: y0 }, end: { x: x0 + dx, y: y0 + dy } };
    };
    trackPointer(
      e.nativeEvent,
      {
        move: (ev) => {
          last = { local: local(ev), shift: ev.shiftKey, alt: ev.altKey };
          const { start, end } = geometry();
          const st = getEditor();
          const k = pxPerMm(st.zoom);
          const x = st.view.x + (slot.x + Math.min(start.x, end.x)) * k;
          const y = st.view.y + (slot.y + Math.min(start.y, end.y)) * k;
          setDraftBox({ x, y, w: Math.abs(end.x - start.x) * k, h: Math.abs(end.y - start.y) * k });
        },
        end: (ev, cancelled) => {
          setDraftBox(null);
          if (cancelled) return;
          last = { local: local(ev), shift: ev.shiftKey, alt: ev.altKey };
          const moved = Math.hypot(last.local.x - startLocal.x, last.local.y - startLocal.y) >= DRAG_THRESHOLD_PX;
          const { start, end } = geometry();
          const box = moved
            ? { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }
            : { x: start.x, y: start.y, w: 0, h: 0 };
          const st = getEditor();
          const ctx: CreateContext = { doc: st.doc!, state: st, pageId: target.pageId, box, isClick: !moved, start, end: moved ? end : start, shiftKey: ev.shiftKey, altKey: ev.altKey };
          def.create!(ctx);
          if (!def.sticky) getEditor().setTool('select');
        },
      },
      viewport,
    );
  };

  // ------------------------------------------------------------------ déplacement à la souris

  const startMove = (e: ReactPointerEvent, clickedId: Id) => {
    const s = getEditor();
    const startClient = { x: e.clientX, y: e.clientY };
    let ids = rootsOf(s.doc!, s.selection);
    const pageId = pageIdOf(s.doc!, ids[0]);
    if (!ids.length || !pageId) return;
    const startBox = unionBoxes(ids.map((id) => objectBounds(s.doc!.objects[id])))!;
    const saved = new Map<HTMLElement, string>();
    let started = false;
    let delta = { dx: 0, dy: 0 };
    const wasSelected = s.selection.length > 1;

    trackPointer(
      e.nativeEvent,
      {
        move: (ev) => {
          const st = getEditor();
          if (!started) {
            if (Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < DRAG_THRESHOLD_PX) return;
            started = true;
            // Alt+glisser : on emporte des copies, les originaux restent en place.
            const duplicate = ev.altKey || e.altKey;
            st.beginGesture(duplicate ? 'Dupliquer' : 'Déplacer');
            if (duplicate) ids = getEditor().duplicate(ids, { dx: 0, dy: 0 });
          }
          const k = pxPerMm(st.zoom);
          const step = mouseStepMm(st.zoom);
          let dx = quantize((ev.clientX - startClient.x) / k, step);
          let dy = quantize((ev.clientY - startClient.y) / k, step);
          // Maj : déplacement contraint à l'horizontale ou à la verticale.
          if (ev.shiftKey) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          const ctx: MoveContext = { state: getEditor(), ids, pageId, startBox, event: ev };
          for (const ext of transformerRegistry.list()) if (ext.adjustMove) ({ dx, dy } = ext.adjustMove({ dx, dy }, ctx));
          delta = { dx, dy };
          previewTranslate(viewport!, ids, dx, dy, saved);
          getEditor().setDragOffset(delta);
        },
        end: (_ev, cancelled) => {
          restoreTransforms(saved);
          const st = getEditor();
          st.setDragOffset(null);
          if (!started) {
            // Clic simple sur un objet d'une sélection multiple : il reste seul sélectionné.
            if (wasSelected && !e.shiftKey) st.select([clickedId]);
            return;
          }
          if (cancelled) st.cancelGesture();
          else {
            st.move(ids, delta.dx, delta.dy);
            st.commitGesture({ select: ids });
          }
          for (const ext of transformerRegistry.list()) ext.onGestureEnd?.();
        },
      },
      viewport,
    );
  };

  // ------------------------------------------------------------------ pointeur

  /**
   * Retient un appui comme premier clic d'un double-clic, mais seulement s'il est relâché sans avoir
   * bougé : deux petits glissers rapprochés (ajustement fin) restent deux déplacements, et n'ouvrent ni
   * le groupe, ni l'édition de texte, ni le recadrage.
   */
  const watchClick = (down: PointerEvent, time: number) => {
    const start = { x: down.clientX, y: down.clientY };
    let moved = false;
    trackPointer(down, {
      move: (ev) => {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= DRAG_THRESHOLD_PX) moved = true;
      },
      end: (_ev, cancelled) => {
        if (!moved && !cancelled) lastClick.current = { time, x: start.x, y: start.y };
      },
    });
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!viewport) return;
    // Le champ en cours de saisie (panneau Propriétés) valide sa valeur avant toute action sur la page.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !viewport.contains(active)) active.blur();

    const s = getEditor();
    if (e.button === 1 || (e.button === 0 && (modifiers.space || s.tool === 'hand'))) {
      startPan(e);
      return;
    }
    if (e.button !== 0 || isHandle(e.target) || s.mode) return;

    const world = worldAt(e);
    const point = worldToPage(s.doc!, world);
    if (point) s.setActivePage(point.pageId);

    const def = toolRegistry.get(s.tool);
    if (def?.onPointerDown) {
      def.onPointerDown(e.nativeEvent, { state: s, point, world });
      return;
    }
    if (def?.create) {
      startCreate(e, s.tool);
      return;
    }

    // Outil Sélection.
    const now = performance.now();
    const prev = lastClick.current;
    // Maj+clics rapprochés : des bascules de sélection, pas un double-clic.
    const isDouble = !e.shiftKey && !!prev && now - prev.time < DOUBLE_CLICK_MS && Math.hypot(prev.x - e.clientX, prev.y - e.clientY) < 5;
    lastClick.current = null;
    if (!isDouble) watchClick(e.nativeEvent, now);

    const hit = hitTest(viewport, e.clientX, e.clientY, s);
    if (!hit) {
      // Clic dans le vide : on désélectionne et on sort du groupe ; le lasso (Selecto) prend la suite.
      if (!e.shiftKey) s.clearSelection({ exitGroups: true });
      return;
    }
    e.preventDefault();

    if (isDouble && onDoubleClick(e, hit.id, hit.deepId)) return;

    if (e.shiftKey) {
      s.select([hit.id], { mode: 'toggle' });
      if (!getEditor().selection.includes(hit.id)) return;
    } else if (!s.selection.includes(hit.id) || hit.outsideScope) {
      s.select([hit.id]);
    }
    startMove(e, hit.id);
  };

  /** Double-clic : d'abord les interactions enregistrées (texte, recadrage…), sinon entrer dans un groupe. */
  const onDoubleClick = (e: ReactPointerEvent, id: Id, deepId: Id): boolean => {
    const s = getEditor();
    for (const def of interactionRegistry.list()) {
      if (def.onDoubleClick?.({ state: s, objectId: id, deepId, event: e.nativeEvent })) return true;
    }
    const obj = s.doc!.objects[id];
    if (obj?.type !== 'group') return false;
    const inner = resolveAtScope(s.doc!, deepId, id);
    s.enterGroup(id, inner && isSelectable(s.doc!, inner) ? inner : null);
    return true;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (e.buttons || !viewport) return;
    const client = { clientX: e.clientX, clientY: e.clientY };
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      const s = getEditor();
      if (!s.doc || s.gesture) return;
      const point = worldToPage(s.doc, worldAt(client));
      if (point) s.setActivePage(point.pageId);
      const hit = s.tool === 'select' && !s.mode ? hitTest(viewport, client.clientX, client.clientY, s) : null;
      s.setHover(hit ? hit.id : null);
    });
  };

  // ------------------------------------------------------------------ lasso

  const lassoAllowed = (input: MouseEvent | TouchEvent): boolean => {
    const s = getEditor();
    if (!viewport || s.tool !== 'select' || s.mode || modifiers.space) return false;
    if (!('button' in input) || input.button !== 0 || isHandle(input.target)) return false;
    return !hitTest(viewport, input.clientX, input.clientY, s);
  };

  const applyLasso = (rect: { left: number; top: number; width: number; height: number }) => {
    if (!viewport) return;
    const s = getEditor();
    const vp = viewport.getBoundingClientRect();
    const box = { x: rect.left - vp.left, y: rect.top - vp.top, w: rect.width, h: rect.height };
    const found = lassoHits(s.doc!, s.enteredGroup, box, s.zoom, s.view);
    const next = lassoBase.current.length ? [...lassoBase.current, ...found.filter((id) => !lassoBase.current.includes(id))] : found;
    s.select(next);
  };

  const slots = pageSlots(doc);
  const k = pxPerMm(zoom);
  const toolCursor = toolRegistry.get(tool)?.cursor;
  const cursor = panning ? 'grabbing' : spaceHeld ? 'grab' : (toolCursor ?? 'default');
  const canvasStyle: CSSProperties = { position: 'absolute', left: 0, top: 0, transform: `translate(${view.x}px, ${view.y}px)` };

  return (
    <div
      ref={setViewportEl}
      data-workspace-viewport
      // isolate : les poignées de Moveable (z-index 3000) restent sous les dialogues et les bulles.
      className="relative isolate min-h-0 min-w-0 flex-1 touch-none select-none overflow-hidden bg-[#d6d8dd]"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => getEditor().setHover(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div data-workspace-canvas style={canvasStyle}>
        {slots.map((slot) => {
          const page = findPageOrMaster(doc, slot.pageId)!;
          return <PageSlotView key={page.id} doc={doc} page={page} zoom={zoom} left={slot.x * k} top={slot.y * k} />;
        })}
      </div>
      <Transformer viewport={viewport} />
      {overlays.map((o) => (o.space === 'viewport' ? <o.component key={o.id} /> : null))}
      {draftBox && (
        <div
          data-creation-preview
          className="pointer-events-none absolute border border-sky-600 bg-sky-500/10"
          style={{ left: draftBox.x, top: draftBox.y, width: Math.max(1, draftBox.w), height: Math.max(1, draftBox.h) }}
        />
      )}
      {viewport && (
        <Selecto
          container={viewport}
          dragContainer={viewport}
          selectableTargets={[]}
          selectByClick={false}
          selectFromInside={false}
          hitRate={100}
          ratio={0}
          className="editor-lasso"
          dragCondition={(e) => lassoAllowed(e.inputEvent)}
          onDragStart={(e) => {
            lassoBase.current = e.inputEvent.shiftKey ? getEditor().selection : [];
          }}
          onDrag={(e) => applyLasso(e.rect)}
          onDragEnd={(e) => {
            if (e.isDrag) applyLasso(e.rect);
          }}
        />
      )}
    </div>
  );
}
