// Magnétisme et repères intelligents (tâche 2.10, repères 2.25). Pendant un déplacement ou un
// redimensionnement à la souris, les bords et le centre de la sélection s'aimantent aux bords et centres
// des objets visibles, au format fini, aux plis, à la zone de sécurité, aux milieux des volets et aux
// repères de la face. Seuil : 1 mm à 100 % (constant à l'écran : 0,5 mm à 200 %). Alt pendant le geste
// coupe l'aimantation. Tout se calcule en mm dans le repère de la face (pas avec le `snappable` de
// Moveable, qui ne voit que le cadre témoin en px écran).
import { createElement, Fragment, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { panelBounds } from '../model/format';
import { findPageOrMaster } from '../model/masters';
import type { Id, LayoutDocument, Mm } from '../model/types';
import { formatNumber } from '../components/ui/number-field';
import { useEditor } from '../store/documentStore';
import { ancestorsOf, descendantsOf, objectBounds, type Box } from '../store/tree';
import { pageSlot, pageToScreen } from './layout';
import { guidesView, pageGuideGeometry } from './PageGuides';
import { registerStatusbarItem, registerTransformerExtension, type TransformerContext } from './registry/api';

/** Seuil d'aimantation à 100 %, en mm (il reste constant à l'écran). */
export const SNAP_THRESHOLD_MM = 1;

export type SnapKind = 'guide' | 'fold' | 'trim' | 'safety' | 'bleed' | 'panel-center' | 'object';

export interface SnapTarget {
  axis: 'x' | 'y';
  /** Position en mm (repère de la face). */
  at: Mm;
  kind: SnapKind;
  /** Étendue sur l'autre axe (pour tracer la ligne d'alignement), mm. */
  from: Mm;
  to: Mm;
  /** Objet visé (kind = 'object'). */
  objectId?: Id;
}

export interface SnapLine {
  axis: 'x' | 'y';
  at: Mm;
  from: Mm;
  to: Mm;
  kind: SnapKind;
  /** Écart entre la sélection et l'objet aligné, sur l'autre axe (mm) ; affiché au milieu de l'écart. */
  gap?: { from: Mm; to: Mm; at: Mm };
}

export interface SnapTargets {
  x: SnapTarget[];
  y: SnapTarget[];
}

// À distance égale, un repère posé exprès l'emporte sur un pli, un pli sur le format…
const PRIORITY: Record<SnapKind, number> = { guide: 0, fold: 1, trim: 2, safety: 3, 'panel-center': 4, bleed: 5, object: 6 };

export const snapThreshold = (zoom: number): Mm => SNAP_THRESHOLD_MM / zoom;

/** Cibles de la face (format, plis, sécurité, milieux des volets, repères). `withGuides` : faux en aperçu (W). */
export function pageTargets(doc: LayoutDocument, pageId: Id, withGuides = true): SnapTargets {
  const page = findPageOrMaster(doc, pageId);
  if (!page) return { x: [], y: [] };
  const g = pageGuideGeometry(doc.format, page.faceId);
  const { w, h } = g.bleed;
  const x: SnapTarget[] = [];
  const y: SnapTarget[] = [];
  const vx = (at: Mm, kind: SnapKind) => x.push({ axis: 'x', at, kind, from: 0, to: h });
  const hy = (at: Mm, kind: SnapKind) => y.push({ axis: 'y', at, kind, from: 0, to: w });
  vx(0, 'bleed');
  vx(w, 'bleed');
  hy(0, 'bleed');
  hy(h, 'bleed');
  vx(g.trim.x, 'trim');
  vx(g.trim.x + g.trim.w, 'trim');
  hy(g.trim.y, 'trim');
  hy(g.trim.y + g.trim.h, 'trim');
  hy(g.trim.y + g.trim.h / 2, 'panel-center');
  for (const p of panelBounds(doc.format, page.faceId)) {
    // Milieu du volet fini (sans le fond perdu des volets de bord).
    const x0 = Math.max(p.x0, g.trim.x);
    const x1 = Math.min(p.x1, g.trim.x + g.trim.w);
    vx((x0 + x1) / 2, 'panel-center');
  }
  if (withGuides) {
    for (const f of g.folds) vx(f, 'fold');
    for (const b of g.safety) {
      vx(b.x, 'safety');
      vx(b.x + b.w, 'safety');
    }
    if (g.safety.length) {
      hy(g.safety[0].y, 'safety');
      hy(g.safety[0].y + g.safety[0].h, 'safety');
    }
    for (const guide of page.guides ?? []) {
      if (guide.axis === 'x') vx(guide.at, 'guide');
      else hy(guide.at, 'guide');
    }
  }
  return { x, y };
}

/** Objets visibles de la face (à toute profondeur), hors de la sélection, de ses descendants et de ses ancêtres. */
export function objectTargets(doc: LayoutDocument, pageId: Id, moving: Id[]): SnapTargets {
  const excluded = new Set<Id>();
  for (const id of moving) {
    excluded.add(id);
    for (const d of descendantsOf(doc, id)) excluded.add(d);
    for (const a of ancestorsOf(doc, id)) excluded.add(a);
  }
  const visibleLayers = new Set(doc.layers.filter((l) => l.visible).map((l) => l.id));
  const x: SnapTarget[] = [];
  const y: SnapTarget[] = [];
  const page = findPageOrMaster(doc, pageId);
  const visit = (id: Id) => {
    const obj = doc.objects[id];
    if (!obj || obj.hidden || !visibleLayers.has(obj.layerId)) return;
    if (!excluded.has(id) && (obj.w > 0 || obj.h > 0)) {
      const b = objectBounds(obj);
      for (const at of [b.x, b.x + b.w / 2, b.x + b.w]) x.push({ axis: 'x', at, kind: 'object', from: b.y, to: b.y + b.h, objectId: id });
      for (const at of [b.y, b.y + b.h / 2, b.y + b.h]) y.push({ axis: 'y', at, kind: 'object', from: b.x, to: b.x + b.w, objectId: id });
    }
    if (obj.type === 'group') obj.children.forEach(visit);
  };
  page?.children.forEach(visit);
  return { x, y };
}

export function collectTargets(doc: LayoutDocument, pageId: Id, moving: Id[], withGuides = true): SnapTargets {
  const a = pageTargets(doc, pageId, withGuides);
  const b = objectTargets(doc, pageId, moving);
  return { x: [...a.x, ...b.x], y: [...a.y, ...b.y] };
}

interface AxisSnap {
  /** Correction à ajouter (mm). */
  delta: Mm;
  target: SnapTarget;
}

/** Meilleure correction pour un jeu de positions candidates (bords, centre) : la plus petite sous le seuil. */
function bestSnap(candidates: Mm[], targets: SnapTarget[], threshold: Mm): AxisSnap | null {
  let best: AxisSnap | null = null;
  for (const c of candidates) {
    for (const t of targets) {
      const delta = t.at - c;
      const d = Math.abs(delta);
      if (d > threshold + 1e-9) continue;
      if (!best || d < Math.abs(best.delta) - 1e-9 || (Math.abs(d - Math.abs(best.delta)) <= 1e-9 && PRIORITY[t.kind] < PRIORITY[best.target.kind])) {
        best = { delta, target: t };
      }
    }
  }
  return best;
}

/**
 * Lignes d'aide : les cibles alignées (à 1e-6 mm près) sur un bord ou le centre de la boîte finale. Les
 * objets alignés sur une même position ne font qu'une ligne, qui les couvre tous, avec l'écart au plus
 * proche d'entre eux.
 */
function alignmentLines(box: Box, axis: 'x' | 'y', targets: SnapTarget[], positions: Mm[]): SnapLine[] {
  const lines = new Map<string, SnapLine>();
  const [b0, b1] = axis === 'x' ? [box.y, box.y + box.h] : [box.x, box.x + box.w];
  for (const t of targets) {
    if (!positions.some((p) => Math.abs(p - t.at) < 1e-6)) continue;
    const key = `${t.kind}:${t.at.toFixed(4)}`;
    const existing = lines.get(key);
    if (t.kind !== 'object') {
      if (!existing) lines.set(key, { axis, at: t.at, kind: t.kind, from: t.from, to: t.to });
      continue;
    }
    const line = existing ?? { axis, at: t.at, kind: t.kind, from: b0, to: b1 };
    line.from = Math.min(line.from, t.from);
    line.to = Math.max(line.to, t.to);
    // Écart le long de l'autre axe entre la sélection et l'objet aligné.
    let gap: SnapLine['gap'];
    if (t.to <= b0) gap = { from: t.to, to: b0, at: t.at };
    else if (t.from >= b1) gap = { from: b1, to: t.from, at: t.at };
    if (gap && (!line.gap || gap.to - gap.from < line.gap.to - line.gap.from)) line.gap = gap;
    lines.set(key, line);
  }
  return [...lines.values()];
}

export interface MoveSnapResult {
  dx: Mm;
  dy: Mm;
  lines: SnapLine[];
}

/** Aimante un déplacement : `box` = boîte de départ, (dx, dy) = déplacement voulu. */
export function snapMove(box: Box, dx: Mm, dy: Mm, targets: SnapTargets, threshold: Mm): MoveSnapResult {
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const xs = [moved.x, moved.x + moved.w / 2, moved.x + moved.w];
  const ys = [moved.y, moved.y + moved.h / 2, moved.y + moved.h];
  const sx = bestSnap(xs, targets.x, threshold);
  const sy = bestSnap(ys, targets.y, threshold);
  const ndx = dx + (sx?.delta ?? 0);
  const ndy = dy + (sy?.delta ?? 0);
  const final = { x: box.x + ndx, y: box.y + ndy, w: box.w, h: box.h };
  const lines = [
    ...(sx ? alignmentLines(final, 'x', targets.x, [final.x, final.x + final.w / 2, final.x + final.w]) : []),
    ...(sy ? alignmentLines(final, 'y', targets.y, [final.y, final.y + final.h / 2, final.y + final.h]) : []),
  ];
  return { dx: ndx, dy: ndy, lines };
}

export interface ResizeSnapResult {
  box: Box;
  lines: SnapLine[];
}

/** Aimante les bords tirés d'un redimensionnement ; `direction` : [-1|0|1, -1|0|1]. */
export function snapResize(box: Box, direction: [number, number], targets: SnapTargets, threshold: Mm): ResizeSnapResult {
  const out = { ...box };
  const lines: SnapLine[] = [];
  const [dirX, dirY] = direction;
  if (dirX !== 0) {
    const edge = dirX > 0 ? box.x + box.w : box.x;
    const s = bestSnap([edge], targets.x, threshold);
    if (s) {
      if (dirX > 0) out.w = Math.max(0, box.w + s.delta);
      else {
        out.x = box.x + s.delta;
        out.w = Math.max(0, box.w - s.delta);
      }
      lines.push(...alignmentLines(out, 'x', targets.x, [edge + s.delta]));
    }
  }
  if (dirY !== 0 && box.h > 0) {
    const edge = dirY > 0 ? box.y + box.h : box.y;
    const s = bestSnap([edge], targets.y, threshold);
    if (s) {
      if (dirY > 0) out.h = Math.max(0, box.h + s.delta);
      else {
        out.y = box.y + s.delta;
        out.h = Math.max(0, box.h - s.delta);
      }
      lines.push(...alignmentLines(out, 'y', targets.y, [edge + s.delta]));
    }
  }
  return { box: out, lines };
}

// ---------------------------------------------------------------- extension des poignées

interface SnapUiState {
  /** Interrupteur « Magnétisme » de la barre d'état (Alt le coupe le temps d'un geste). */
  enabled: boolean;
  pageId: Id | null;
  lines: SnapLine[];
}

export const snapUi = createStore<SnapUiState>()(() => ({ enabled: true, pageId: null, lines: [] }));

/** Cibles gardées le temps d'un geste (le document ne change pas pendant un déplacement). */
let cache: { key: string; doc: LayoutDocument; targets: SnapTargets } | null = null;

function targetsFor(doc: LayoutDocument, pageId: Id, ids: Id[]): SnapTargets {
  const withGuides = guidesView.getState().visible;
  const key = `${pageId}|${ids.join(',')}|${withGuides}`;
  if (cache && cache.key === key && cache.doc === doc) return cache.targets;
  cache = { key, doc, targets: collectTargets(doc, pageId, ids, withGuides) };
  return cache.targets;
}

const setLines = (pageId: Id | null, lines: SnapLine[]) => {
  const prev = snapUi.getState();
  if (!prev.lines.length && !lines.length) return;
  snapUi.setState({ pageId, lines });
};

const LABELS: Partial<Record<SnapKind, string>> = {
  fold: 'Pli',
  trim: 'Coupe',
  safety: 'Sécurité',
  guide: 'Repère',
  'panel-center': 'Milieu',
  bleed: 'Fond perdu',
};

const LINE_COLOR = '#e0245e';

/** Lignes d'alignement et distances, en px écran. */
function SnapLines(_ctx: TransformerContext) {
  const { pageId, lines } = useStore(snapUi);
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  if (!doc || !pageId || !lines.length || !pageSlot(doc, pageId)) return null;
  const toScreen = (x: Mm, y: Mm) => pageToScreen(doc, pageId, { x, y }, zoom, view);
  const items: ReactNode[] = [];
  lines.forEach((l, i) => {
    const a = l.axis === 'x' ? toScreen(l.at, l.from) : toScreen(l.from, l.at);
    const b = l.axis === 'x' ? toScreen(l.at, l.to) : toScreen(l.to, l.at);
    const style = l.axis === 'x' ? { left: a.x, top: a.y, width: 1, height: b.y - a.y } : { left: a.x, top: a.y, width: b.x - a.x, height: 1 };
    items.push(createElement('div', { key: `l${i}`, 'data-snap-line': l.kind, 'data-axis': l.axis, 'data-at': l.at, className: 'pointer-events-none absolute', style: { ...style, background: LINE_COLOR } }));
    const label = LABELS[l.kind];
    if (label) {
      items.push(
        createElement(
          'div',
          { key: `t${i}`, className: 'pointer-events-none absolute rounded-sm px-1 text-[10px] font-medium leading-4 text-white', style: { left: a.x + 3, top: a.y + 3, background: LINE_COLOR } },
          label,
        ),
      );
    }
    if (l.gap && l.gap.to - l.gap.from > 0.05) {
      const g0 = l.axis === 'x' ? toScreen(l.gap.at, l.gap.from) : toScreen(l.gap.from, l.gap.at);
      const g1 = l.axis === 'x' ? toScreen(l.gap.at, l.gap.to) : toScreen(l.gap.to, l.gap.at);
      items.push(
        createElement(
          'div',
          {
            key: `g${i}`,
            'data-snap-distance': formatNumber(l.gap.to - l.gap.from, 1),
            className: 'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white px-1 text-[10px] font-medium leading-4 tabular-nums shadow-sm',
            style: { left: (g0.x + g1.x) / 2, top: (g0.y + g1.y) / 2, color: LINE_COLOR, border: `1px solid ${LINE_COLOR}` },
          },
          `${formatNumber(l.gap.to - l.gap.from, 1)} mm`,
        ),
      );
    }
  });
  return createElement(Fragment, null, ...items);
}

registerTransformerExtension({
  id: 'snapping',
  order: 10,
  adjustMove: ({ dx, dy }, ctx) => {
    const doc = ctx.state.doc;
    if (!doc || ctx.event.altKey || !snapUi.getState().enabled) {
      setLines(null, []);
      return { dx, dy };
    }
    const result = snapMove(ctx.startBox, dx, dy, targetsFor(doc, ctx.pageId, ctx.ids), snapThreshold(ctx.state.zoom));
    setLines(ctx.pageId, result.lines);
    return { dx: result.dx, dy: result.dy };
  },
  adjustResize: (box, ctx) => {
    const doc = ctx.state.doc;
    // Maj garde les proportions : aimanter un bord les casserait.
    if (!doc || ctx.event.altKey || ctx.event.shiftKey || !snapUi.getState().enabled) {
      setLines(null, []);
      return box;
    }
    const result = snapResize(box, ctx.direction, targetsFor(doc, ctx.pageId, ctx.ids), snapThreshold(ctx.state.zoom));
    setLines(ctx.pageId, result.lines);
    return result.box;
  },
  onGestureEnd: () => {
    cache = null;
    setLines(null, []);
  },
  render: SnapLines,
});

/** Interrupteur de la barre d'état. */
function SnapToggle() {
  const enabled = useStore(snapUi, (s) => s.enabled);
  return createElement(
    'button',
    {
      type: 'button',
      'data-snapping-toggle': '',
      'aria-pressed': enabled,
      title: 'Magnétisme : bords et centres des objets, format, plis, sécurité et repères (Alt pendant un geste le coupe)',
      className: 'flex items-center gap-1 rounded px-1 hover:bg-neutral-100 hover:text-neutral-800',
      onClick: () => snapUi.setState({ enabled: !snapUi.getState().enabled }),
    },
    createElement('span', { className: `inline-block size-1.5 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-neutral-300'}` }),
    enabled ? 'Magnétisme' : 'Magnétisme coupé',
  );
}

registerStatusbarItem({ id: 'snapping', order: 40, align: 'right', component: SnapToggle });
