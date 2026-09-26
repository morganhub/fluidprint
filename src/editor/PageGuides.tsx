// Repères de page (tâches 2.23 et 2.27) : cadre du fond perdu, trait de coupe, zone de sécurité et plis,
// lus dans le gabarit du document. Surcouches du plan de travail : jamais dans PageView, donc jamais à
// l'impression ni dans l'export. La touche W bascule en « aperçu » comme dans InDesign : repères,
// règles de repère et calques non imprimables disparaissent de l'écran (le document n'est pas modifié).
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { faceSize, foldPositions, trimBox } from '../model/format';
import type { DocumentFormat, Id, LayoutDocument, Mm } from '../model/types';
import { PX_PER_MM } from '../model/units';
import { useEditor } from '../store/documentStore';
import type { Box } from '../store/tree';
import { registerOverlay, registerShortcut, type PageOverlayProps } from './registry/api';

// ---------------------------------------------------------------- affichage (W)

interface GuidesViewState {
  /** Faux : aperçu (W), repères et objets non imprimables masqués à l'écran. */
  visible: boolean;
  setVisible(visible: boolean): void;
  toggle(): void;
}

export const guidesView = createStore<GuidesViewState>()((set, get) => ({
  visible: true,
  setVisible: (visible) => set({ visible }),
  toggle: () => set({ visible: !get().visible }),
}));

export const useGuidesVisible = (): boolean => useStore(guidesView, (s) => s.visible);

// ---------------------------------------------------------------- géométrie

export interface PageGuideGeometry {
  /** Face entière, fond perdu compris. */
  bleed: Box;
  /** Format fini (trait de coupe). */
  trim: Box;
  /** Plis, en mm depuis le bord du fond perdu. */
  folds: Mm[];
  /** Zone de sécurité de chaque volet : `safety` mm en retrait du trait de coupe et de chaque pli. */
  safety: Box[];
}

export function pageGuideGeometry(format: DocumentFormat, faceId: Id): PageGuideGeometry {
  const size = faceSize(format);
  const trim = trimBox(format);
  const folds = foldPositions(format, faceId);
  const s = format.safety;
  const edges = [trim.x, ...folds, trim.x + trim.w];
  const safety: Box[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const x0 = edges[i] + s;
    const x1 = edges[i + 1] - s;
    safety.push({ x: x0, y: trim.y + s, w: Math.max(0, x1 - x0), h: Math.max(0, trim.h - 2 * s) });
  }
  return { bleed: { x: 0, y: 0, w: size.w, h: size.h }, trim, folds, safety };
}

// ---------------------------------------------------------------- dessin

const COLORS = {
  bleed: '#e0245e',
  trim: '#1f2937',
  safety: '#8b5cf6',
  fold: '#0891b2',
};

/** Dessin en mm dans la face (la surcouche est à l'échelle du zoom) ; traits d'un pixel écran. */
function PageGuidesOverlay({ doc, page, zoom }: PageOverlayProps) {
  const visible = useGuidesVisible();
  if (!visible) return null;
  const g = pageGuideGeometry(doc.format, page.faceId);
  const px = 1 / (PX_PER_MM * zoom);
  const dash = (a: number, b: number) => `${a * px} ${b * px}`;
  return (
    <svg
      data-page-guides={page.id}
      width={`${g.bleed.w}mm`}
      height={`${g.bleed.h}mm`}
      viewBox={`0 0 ${g.bleed.w} ${g.bleed.h}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
      fill="none"
    >
      <rect data-page-guide="bleed" x={px / 2} y={px / 2} width={g.bleed.w - px} height={g.bleed.h - px} stroke={COLORS.bleed} strokeWidth={px} />
      <rect data-page-guide="trim" x={g.trim.x} y={g.trim.y} width={g.trim.w} height={g.trim.h} stroke={COLORS.trim} strokeWidth={px} strokeOpacity={0.7} />
      {g.safety.map((b, i) => (
        <rect key={i} data-page-guide="safety" data-panel={i} x={b.x} y={b.y} width={b.w} height={b.h} stroke={COLORS.safety} strokeWidth={px} strokeDasharray={dash(3, 3)} />
      ))}
      {g.folds.map((x) => (
        <line key={x} data-page-guide="fold" data-at={x} x1={x} x2={x} y1={0} y2={g.bleed.h} stroke={COLORS.fold} strokeWidth={px} strokeDasharray={dash(8, 5)} />
      ))}
    </svg>
  );
}

/**
 * Aperçu (W) : les objets de premier niveau des calques non imprimables (repères du design, notes)
 * sont masqués à l'écran par une feuille de style, sans toucher au document ni au rendu.
 */
function PreviewStyle() {
  const visible = useGuidesVisible();
  const doc = useEditor((s) => s.doc);
  if (visible || !doc) return null;
  const hidden = hiddenInPreview(doc);
  if (!hidden.length) return null;
  const rule = hidden.map((id) => `[data-workspace-canvas] [data-page-id] > [data-obj-id="${CSS.escape(id)}"]`).join(',\n');
  return <style data-preview-style>{`${rule} { display: none !important; }`}</style>;
}

function hiddenInPreview(doc: LayoutDocument): Id[] {
  const nonPrintable = new Set(doc.layers.filter((l) => !l.printable).map((l) => l.id));
  return doc.pages.flatMap((p) => p.children).filter((id) => nonPrintable.has(doc.objects[id]?.layerId));
}

registerOverlay({ id: 'page-guides', space: 'page', order: 10, component: PageGuidesOverlay });
registerOverlay({ id: 'preview-style', space: 'viewport', order: 0, component: PreviewStyle });
registerShortcut({
  id: 'toggle-guides',
  keys: 'W',
  label: 'Afficher / masquer les repères (aperçu)',
  group: 'Affichage',
  run: () => guidesView.getState().toggle(),
});
