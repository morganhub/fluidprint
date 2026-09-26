// Repères déplaçables (tâche 2.25) : tirés depuis une règle, stockés dans la face (`Page.guides`, mm
// depuis le bord du fond perdu), déplacés à la souris, saisis au 0,1 mm, verrouillables, supprimés en les
// ramenant sur la règle ou par Suppr. Le magnétisme les prend en compte (snapping.ts). Surcouches du
// plan de travail : jamais dans l'export. Toute modification passe par `apply` (annulable, enregistrée).
import { Lock, LockOpen, Ruler, Trash2 } from 'lucide-react';
import { useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from '../components/ui/button';
import { formatNumber, NumberField } from '../components/ui/number-field';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { faceSize } from '../model/format';
import type { Guide, Id, LayoutDocument, Mm } from '../model/types';
import { round4 } from '../store/commands';
import { getEditor, useEditor } from '../store/documentStore';
import { mouseStepMm, pageToScreen, quantize, screenToWorld, worldToPage } from './layout';
import { guidesView, useGuidesVisible } from './PageGuides';
import { trackPointer } from './pointer';
import { registerOverlay, registerShortcut, registerStatusbarItem, type PageOverlayProps } from './registry/api';
import { pageTargets, snapThreshold } from './snapping';

/** Épaisseur des règles, en px (Rulers.tsx) : un repère lâché dessus est supprimé. */
export const RULER_SIZE_PX = 20;
const GUIDE_COLOR = '#06b6d4';
const GUIDE_SELECTED = '#2563eb';
/** Zone de saisie d'un repère à l'écran, px. */
const GUIDE_HIT_PX = 7;

interface GuideRef {
  pageId: Id;
  guideId: Id;
}

interface GuideDrag {
  axis: Guide['axis'];
  pageId: Id;
  at: Mm;
  /** Repère existant déplacé (null : nouveau repère tiré d'une règle). */
  guideId: Id | null;
  /** Pointeur au-dessus de la règle : lâcher supprime (ou annule). */
  overRuler: boolean;
}

interface GuideUiState {
  selected: GuideRef | null;
  drag: GuideDrag | null;
}

export const guideUi = createStore<GuideUiState>()(() => ({ selected: null, drag: null }));

const selectGuide = (ref: GuideRef | null) => guideUi.setState({ selected: ref });

export function findGuide(doc: LayoutDocument | null, ref: GuideRef | null): Guide | null {
  if (!doc || !ref) return null;
  return doc.pages.find((p) => p.id === ref.pageId)?.guides?.find((g) => g.id === ref.guideId) ?? null;
}

function newGuideId(doc: LayoutDocument): Id {
  const used = new Set(doc.pages.flatMap((p) => (p.guides ?? []).map((g) => g.id)));
  for (;;) {
    const id = `guide-${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id)) return id;
  }
}

// ---------------------------------------------------------------- commandes (annulables)

export function addGuide(pageId: Id, axis: Guide['axis'], at: Mm): Id | null {
  const s = getEditor();
  if (!s.doc) return null;
  const id = newGuideId(s.doc);
  s.apply('Ajouter un repère', (d) => {
    const page = d.pages.find((p) => p.id === pageId);
    if (page) (page.guides ??= []).push({ id, axis, at: round4(at) });
  });
  return id;
}

export function updateGuide(ref: GuideRef, patch: Partial<Pick<Guide, 'at' | 'locked'>>, label: string): void {
  getEditor().apply(label, (d) => {
    const guide = d.pages.find((p) => p.id === ref.pageId)?.guides?.find((g) => g.id === ref.guideId);
    if (!guide) return;
    if (patch.at !== undefined) guide.at = round4(patch.at);
    if (patch.locked !== undefined) {
      if (patch.locked) guide.locked = true;
      else delete guide.locked;
    }
  });
}

export function removeGuide(ref: GuideRef): void {
  getEditor().apply('Supprimer le repère', (d) => {
    const page = d.pages.find((p) => p.id === ref.pageId);
    if (!page?.guides) return;
    page.guides = page.guides.filter((g) => g.id !== ref.guideId);
    if (!page.guides.length) delete page.guides;
  });
  if (guideUi.getState().selected?.guideId === ref.guideId) selectGuide(null);
}

/** Déplace un repère, éventuellement sur une autre face (tiré d'une face à l'autre). */
function moveGuide(ref: GuideRef, pageId: Id, at: Mm): void {
  getEditor().apply('Déplacer le repère', (d) => {
    const from = d.pages.find((p) => p.id === ref.pageId);
    const guide = from?.guides?.find((g) => g.id === ref.guideId);
    if (!from || !guide) return;
    guide.at = round4(at);
    if (pageId === ref.pageId) return;
    const to = d.pages.find((p) => p.id === pageId);
    if (!to) return;
    from.guides = from.guides!.filter((g) => g.id !== ref.guideId);
    if (!from.guides.length) delete from.guides;
    (to.guides ??= []).push({ ...guide });
  });
}

// ---------------------------------------------------------------- glisser un repère

const viewportEl = () => document.querySelector<HTMLElement>('[data-workspace-viewport]');

/**
 * Tire un repère : depuis une règle (`existing` absent : nouveau repère) ou un repère existant. Position
 * au pas de la souris depuis le format fini, aimantée aux plis, à la coupe et à la sécurité (Alt : non).
 */
export function startGuideDrag(axis: Guide['axis'], start: PointerEvent, existing?: GuideRef): void {
  const viewport = viewportEl();
  if (!viewport || !getEditor().doc) return;
  const startClient = { x: start.clientX, y: start.clientY };
  let moved = false;

  const compute = (ev: PointerEvent): GuideDrag | null => {
    const st = getEditor();
    const doc = st.doc;
    if (!doc) return null;
    const rect = viewport.getBoundingClientRect();
    const local = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const target = worldToPage(doc, screenToWorld(local, st.zoom, st.view), true);
    if (!target) return null;
    const bleed = doc.format.bleed;
    const raw = axis === 'x' ? target.x : target.y;
    let at = bleed + quantize(raw - bleed, mouseStepMm(st.zoom));
    if (!ev.altKey) {
      const threshold = snapThreshold(st.zoom);
      let best: number | null = null;
      for (const t of pageTargets(doc, target.pageId)[axis]) {
        if (t.kind === 'guide') continue;
        if (Math.abs(t.at - raw) <= threshold && (best === null || Math.abs(t.at - raw) < Math.abs(best - raw))) best = t.at;
      }
      if (best !== null) at = best;
    }
    const overRuler = axis === 'y' ? local.y < RULER_SIZE_PX : local.x < RULER_SIZE_PX;
    return { axis, pageId: target.pageId, at: round4(at), guideId: existing?.guideId ?? null, overRuler };
  };

  trackPointer(
    start,
    {
      move: (ev) => {
        if (!moved && Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < 3) return;
        moved = true;
        guideUi.setState({ drag: compute(ev) });
      },
      end: (ev, cancelled) => {
        const drag = moved && !cancelled ? compute(ev) : null;
        guideUi.setState({ drag: null });
        if (!drag) return;
        if (drag.overRuler) {
          if (existing) removeGuide(existing);
          return;
        }
        if (existing) {
          moveGuide(existing, drag.pageId, drag.at);
          selectGuide({ pageId: drag.pageId, guideId: existing.guideId });
        } else {
          const id = addGuide(drag.pageId, axis, drag.at);
          if (id) selectGuide({ pageId: drag.pageId, guideId: id });
        }
      },
    },
    viewport,
  );
}

// ---------------------------------------------------------------- dessin dans les faces

function GuidesOverlay({ doc, page, zoom }: PageOverlayProps) {
  const visible = useGuidesVisible();
  const selected = useStore(guideUi, (s) => s.selected);
  const dragging = useStore(guideUi, (s) => s.drag?.guideId ?? null);
  if (!visible || !page.guides?.length) return null;
  const size = faceSize(doc.format);
  // La surcouche est en mm, mise à l'échelle du zoom : 1 / zoom px = un pixel écran.
  const px = 1 / zoom;
  const hit = GUIDE_HIT_PX / zoom;
  return (
    <>
      {page.guides.map((g) => {
        if (g.id === dragging) return null;
        const vertical = g.axis === 'x';
        const isSelected = selected?.guideId === g.id;
        const color = isSelected ? GUIDE_SELECTED : GUIDE_COLOR;
        const onPointerDown = (e: ReactPointerEvent) => {
          if (e.button !== 0 || getEditor().mode) return;
          e.stopPropagation();
          e.preventDefault();
          getEditor().clearSelection();
          selectGuide({ pageId: page.id, guideId: g.id });
          startGuideDrag(g.axis, e.nativeEvent, { pageId: page.id, guideId: g.id });
        };
        return (
          <div
            key={g.id}
            data-guide-id={g.id}
            data-axis={g.axis}
            data-at={g.at}
            data-locked={g.locked ? 'true' : undefined}
            // Un repère verrouillé laisse passer le clic vers les objets.
            data-editor-handle={g.locked ? undefined : ''}
            onPointerDown={g.locked ? undefined : onPointerDown}
            title={g.locked ? undefined : 'Repère : glisser pour déplacer, ramener sur la règle pour supprimer'}
            style={{
              position: 'absolute',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              pointerEvents: g.locked ? 'none' : 'auto',
              cursor: vertical ? 'col-resize' : 'row-resize',
              ...(vertical
                ? { left: `calc(${g.at}mm - ${hit / 2}px)`, top: 0, width: `${hit}px`, height: `${size.h}mm` }
                : { top: `calc(${g.at}mm - ${hit / 2}px)`, left: 0, height: `${hit}px`, width: `${size.w}mm` }),
            }}
          >
            <div
              style={{
                background: color,
                opacity: g.locked ? 0.55 : 1,
                ...(vertical ? { width: `${isSelected ? 2 * px : px}px`, height: '100%' } : { height: `${isSelected ? 2 * px : px}px`, width: '100%' }),
              }}
            />
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- aperçu du glisser, éditeur du repère

const fromTrim = (doc: LayoutDocument, at: Mm) => Math.round((at - doc.format.bleed) * 10) / 10;

function GuideDragPreview() {
  const drag = useStore(guideUi, (s) => s.drag);
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  if (!drag || !doc || drag.overRuler) return null;
  const p = pageToScreen(doc, drag.pageId, { x: drag.at, y: drag.at }, zoom, view);
  const vertical = drag.axis === 'x';
  return (
    <>
      <div
        data-guide-preview
        className="pointer-events-none absolute"
        style={vertical ? { left: p.x, top: 0, bottom: 0, width: 1, background: GUIDE_SELECTED } : { top: p.y, left: 0, right: 0, height: 1, background: GUIDE_SELECTED }}
      />
      <div
        className="pointer-events-none absolute rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] tabular-nums text-white"
        style={vertical ? { left: p.x + 6, top: RULER_SIZE_PX + 6 } : { left: RULER_SIZE_PX + 6, top: p.y + 6 }}
      >
        {vertical ? 'X' : 'Y'} {formatNumber(fromTrim(doc, drag.at), 1)} mm
      </div>
    </>
  );
}

/** Ligne d'édition d'un repère : position au 0,1 mm depuis le format fini, verrou, suppression. */
function GuideRow({ doc, pageId, guide, compact }: { doc: LayoutDocument; pageId: Id; guide: Guide; compact?: boolean }) {
  const ref = { pageId, guideId: guide.id };
  const bleed = doc.format.bleed;
  return (
    <div className="flex items-center gap-1" data-guide-row={guide.id}>
      {!compact && <span className="w-24 truncate text-[12px] text-neutral-600">{guide.axis === 'x' ? 'Vertical' : 'Horizontal'}</span>}
      <NumberField
        name="guide-at"
        prefix={guide.axis === 'x' ? 'X' : 'Y'}
        ariaLabel={`Position du repère ${guide.axis === 'x' ? 'vertical' : 'horizontal'} (mm depuis le format fini)`}
        unit="mm"
        decimals={1}
        step={0.1}
        value={fromTrim(doc, guide.at)}
        className="w-28"
        onCommit={(v) => updateGuide(ref, { at: v + bleed }, 'Position du repère')}
      />
      <Button
        variant="toggle"
        size="icon-sm"
        aria-pressed={!!guide.locked}
        aria-label={guide.locked ? 'Déverrouiller le repère' : 'Verrouiller le repère'}
        title={guide.locked ? 'Déverrouiller' : 'Verrouiller'}
        data-guide-lock
        onClick={() => updateGuide(ref, { locked: !guide.locked }, guide.locked ? 'Déverrouiller le repère' : 'Verrouiller le repère')}
      >
        {guide.locked ? <Lock /> : <LockOpen />}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Supprimer le repère" title="Supprimer" data-guide-delete onClick={() => removeGuide(ref)}>
        <Trash2 />
      </Button>
    </div>
  );
}

/** Petit éditeur flottant du repère sélectionné, près du repère. */
function GuideEditor() {
  const selected = useStore(guideUi, (s) => s.selected);
  const dragging = useStore(guideUi, (s) => !!s.drag);
  const visible = useGuidesVisible();
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const size = useEditor((s) => s.viewport);
  const guide = findGuide(doc, selected);

  // Un clic ailleurs que sur un repère ou son éditeur le désélectionne.
  useEffect(() => {
    if (!selected) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('[data-guide-id], [data-guide-editor], [data-guides-popover]')) return;
      selectGuide(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [selected]);

  if (!doc || !selected || !guide || !visible || dragging) return null;
  const p = pageToScreen(doc, selected.pageId, { x: guide.at, y: guide.at }, zoom, view);
  const W = 230;
  const H = 40;
  const vertical = guide.axis === 'x';
  const left = vertical ? Math.min(Math.max(RULER_SIZE_PX + 4, p.x + 10), size.w - W - 4) : RULER_SIZE_PX + 10;
  const top = vertical ? RULER_SIZE_PX + 10 : Math.min(Math.max(RULER_SIZE_PX + 4, p.y + 10), size.h - H - 4);
  return (
    <div
      data-guide-editor
      data-editor-handle
      className="absolute flex items-center gap-1 rounded-lg border border-neutral-200 bg-white p-1 pl-2 shadow-md"
      style={{ left, top, pointerEvents: 'auto' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="text-[11px] font-medium text-neutral-500">Repère</span>
      <GuideRow doc={doc} pageId={selected.pageId} guide={guide} compact />
    </div>
  );
}

// ---------------------------------------------------------------- barre d'état : liste des repères

function GuidesStatus() {
  const doc = useEditor((s) => s.doc);
  const visible = useGuidesVisible();
  if (!doc) return null;
  const count = doc.pages.reduce((n, p) => n + (p.guides?.length ?? 0), 0);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-guides-status className="flex items-center gap-1 rounded px-1 hover:bg-neutral-100 hover:text-neutral-800">
          <Ruler className="size-3" />
          Repères{count ? ` (${count})` : ''}
          {!visible && <span className="text-amber-700"> · masqués</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80" data-guides-popover>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={visible} onChange={() => guidesView.getState().toggle()} data-guides-visible />
            Afficher les repères, plis et zone de sécurité <span className="text-neutral-400">(W)</span>
          </label>
          {doc.pages.map((page) => (
            <div key={page.id} className="flex flex-col gap-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{page.name}</div>
              {page.guides?.length ? (
                page.guides.map((g) => <GuideRow key={g.id} doc={doc} pageId={page.id} guide={g} />)
              ) : (
                <p className="text-[12px] text-neutral-400">Aucun repère : tirez-en un depuis une règle.</p>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

registerOverlay({ id: 'guides', space: 'page', order: 20, component: GuidesOverlay });
registerOverlay({ id: 'guide-drag', space: 'viewport', order: 30, component: GuideDragPreview });
registerOverlay({ id: 'guide-editor', space: 'viewport', order: 40, component: GuideEditor });
registerStatusbarItem({ id: 'guides', order: 50, align: 'right', component: GuidesStatus });

const guideSelected = () => !!guideUi.getState().selected && guidesView.getState().visible;
registerShortcut({
  id: 'guide-delete',
  keys: ['Delete', 'Backspace'],
  label: 'Supprimer le repère sélectionné',
  group: 'Repères',
  order: -10,
  when: guideSelected,
  run: () => {
    const ref = guideUi.getState().selected;
    if (ref) removeGuide(ref);
  },
});
registerShortcut({
  id: 'guide-escape',
  keys: 'Escape',
  label: 'Désélectionner le repère',
  group: 'Repères',
  order: -10,
  hidden: true,
  when: guideSelected,
  run: () => selectGuide(null),
});
