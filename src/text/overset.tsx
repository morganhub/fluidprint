// Texte en excès et hauteur automatique (tâche 2.26), côté éditeur.
//
// Le rendu (TextFrameView) publie la hauteur réelle de chaque bloc texte à l'écran ; ici :
// - un bloc dont le texte dépasse sa boîte est signalé par un « + » rouge à son coin bas-droit
//   (surcouche d'écran : jamais imprimé) ;
// - un bloc en « Hauteur auto » prend la hauteur de son texte ;
// - `lines` (nombre de lignes que l'export compare) suit un texte modifié dans l'éditeur.
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { registerOverlay, type PageOverlayProps } from '../editor/registry/api';
import type { Id, LayoutDocument, TextObject } from '../model/types';
import { PX_PER_MM } from '../model/units';
import { subscribeTextMeasurements } from '../render/textMetrics';
import { editorStore, getEditor } from '../store/documentStore';
import { pageIdOf } from '../store/tree';
import { isChained } from '../model/threading';
import { AUTO_HEIGHT_EPSILON, setTextHeight } from './autoHeight';

/**
 * Dépassement toléré (mm) : les boîtes importées sont mesurées au dixième de pixel près sur le design ;
 * un quart de point ne se voit pas, une ligne de 6,3 pt (2,9 mm) oui.
 */
export const OVERSET_TOLERANCE_MM = 0.25;

/** Dépassement de chaque bloc en excès, en mm. */
export const oversetStore = createStore<{ excess: Record<Id, number> }>()(() => ({ excess: {} }));

/** Lecture réactive ; comparaison superficielle (le sélecteur peut renvoyer un tableau neuf). */
export const useOverset = <T,>(selector: (excess: Record<Id, number>) => T): T => useStore(oversetStore, useShallow((s) => selector(s.excess)));

/** Dernière hauteur mesurée de chaque bloc (mm) : la case « Hauteur auto » s'en sert. */
export const measuredHeights = new Map<Id, number>();

// Signature de ce qui change les coupures : `lines` n'est resynchronisé que pour un bloc modifié depuis
// l'ouverture (un bloc intact garde la valeur mesurée à l'import).
const layoutSignature = (o: TextObject) => JSON.stringify([o.paragraphs, o.style, o.w, o.verticalAlign]);
let baseline: { docId: string | null; doc: LayoutDocument | null } = { docId: null, doc: null };

function baselineDoc(): LayoutDocument | null {
  const s = getEditor();
  if (baseline.docId !== s.docId) baseline = { docId: s.docId, doc: s.doc };
  return baseline.doc;
}

editorStore.subscribe((next, prev) => {
  // Nouveau document ouvert : les mesures et la référence repartent de zéro.
  if (next.docId !== prev.docId || (next.revision === 0 && next.doc !== prev.doc)) {
    baseline = { docId: next.docId, doc: next.doc };
    measuredHeights.clear();
    oversetStore.setState({ excess: {} });
  }
});

let pendingAuto = new Map<Id, number>();

function flushAutoHeights() {
  const todo = pendingAuto;
  pendingAuto = new Map();
  const s = getEditor();
  if (!s.doc || s.gesture) return;
  const ids = [...todo].filter(([id, h]) => {
    const obj = s.doc!.objects[id];
    return obj?.type === 'text' && obj.autoHeight && Math.abs(obj.h - h) >= AUTO_HEIGHT_EPSILON;
  });
  if (!ids.length) return;
  s.apply('Hauteur auto', (d) => {
    for (const [id, h] of ids) setTextHeight(d, id, h);
  });
}

subscribeTextMeasurements((m) => {
  const s = getEditor();
  const obj = s.doc?.objects[m.id];
  if (obj?.type !== 'text') return;
  measuredHeights.set(m.id, m.contentH);

  const excess = m.contentH - obj.h;
  const current = oversetStore.getState().excess;
  const over = excess > OVERSET_TOLERANCE_MM && !obj.autoHeight;
  if (over ? Math.abs((current[m.id] ?? -1) - excess) > 0.01 : m.id in current) {
    const next = { ...current };
    if (over) next[m.id] = excess;
    else delete next[m.id];
    oversetStore.setState({ excess: next });
  }

  // Hauteur auto : jamais pendant un geste (l'éditeur de texte l'applique dans son propre geste), ni
  // juste après une annulation (rétablir resterait possible : on ne réécrit pas l'histoire).
  if (obj.autoHeight && Math.abs(excess) >= AUTO_HEIGHT_EPSILON && !s.gesture && !s.history.canRedo) {
    if (!pendingAuto.size) queueMicrotask(flushAutoHeights);
    pendingAuto.set(m.id, m.contentH);
  }

  // Un bloc modifié depuis l'ouverture prend le nombre mesuré ; un bloc revenu à son état d'ouverture
  // (annulation) retrouve la valeur d'origine, mesurée à l'import.
  const base = baselineDoc()?.objects[m.id];
  // Un bloc chaîné (4.12) ou habillé (4.13) change de coupures sans changer lui-même (un voisin a bougé) :
  // il suit toujours la mesure.
  const flowing = isChained(s.doc!, m.id) || isChained(baselineDoc() ?? s.doc!, m.id) || m.wrapped === true;
  const modified = flowing || !base || base.type !== 'text' || (base !== obj && layoutSignature(base) !== layoutSignature(obj));
  const target = modified ? (m.lines > 0 ? m.lines : obj.lines) : base.lines;
  if (obj.lines !== target) {
    // Donnée de contrôle, pas une retouche : ni étape d'annulation, ni révision (partira avec le prochain enregistrement).
    queueMicrotask(() =>
      getEditor().patchSilently((d) => {
        const t = d.objects[m.id];
        if (t?.type !== 'text') return;
        if (target === undefined) delete t.lines;
        else t.lines = target;
      }),
    );
  }
});

/** « + » rouge au coin bas-droit des blocs en excès (écran seulement). */
function OversetMarkers({ doc, page, zoom }: PageOverlayProps) {
  const excess = useOverset((e) => e);
  const size = 12 / (PX_PER_MM * zoom);
  const visibleLayers = new Set(doc.layers.filter((l) => l.visible).map((l) => l.id));
  const markers = Object.keys(excess)
    .map((id) => doc.objects[id])
    .filter((o): o is TextObject => o?.type === 'text' && !o.hidden && visibleLayers.has(o.layerId) && pageIdOf(doc, o.id) === page.id);
  return (
    <>
      {markers.map((o) => (
        <div
          key={o.id}
          data-overset-marker={o.id}
          title={`Texte en excès : ${String(Math.round(excess[o.id] * 10) / 10).replace('.', ',')} mm de trop`}
          style={{
            position: 'absolute',
            left: `${o.x + o.w - size / 2}mm`,
            top: `${o.y + o.h - size / 2}mm`,
            width: `${size}mm`,
            height: `${size}mm`,
            background: '#ffffff',
            border: `${1.5 / zoom}px solid #e0245e`,
            color: '#e0245e',
            fontFamily: 'system-ui, sans-serif',
            fontWeight: 700,
            fontSize: `${size * 0.95}mm`,
            lineHeight: `${size * 0.85}mm`,
            textAlign: 'center',
            boxSizing: 'border-box',
          }}
        >
          +
        </div>
      ))}
    </>
  );
}

registerOverlay({ id: 'overset-markers', order: 40, space: 'page', component: OversetMarkers });
