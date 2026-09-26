// Store de l'éditeur (Zustand + Immer) : le document, la sélection, l'outil, le zoom et la vue, et
// l'historique d'annulation par patches. Toute modification du document passe par `apply` (une étape
// d'annulation) ou par un geste (`beginGesture` … `commitGesture` : une seule étape, quelle que soit sa
// durée). Voir docs/ARCHITECTURE.md.
import { applyPatches, enablePatches, freeze, produce, produceWithPatches, type Draft, type Patch } from 'immer';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { findPageOrMaster } from '../model/masters';
import type { DocObject, Id, LayoutDocument, Mm } from '../model/types';
import { clampZoom, fitView, stepZoom, zoomAround, type View, pageSlot, pxPerMm } from '../editor/layout';
import {
  addObjects,
  duplicateObjects,
  extractObjects,
  groupObjects,
  moveObjects,
  removeObjects,
  reidentify,
  reorderObjects,
  resizeObjects,
  setBox,
  setObjectsLayer,
  ungroupObjects,
  updateObjects,
  type ClipboardContent,
  type InsertTarget,
  type ReorderMode,
} from './commands';
import { History, type HistoryInfo, type SelectionSnapshot } from './history';
import { isSelectable, objectBounds, pageIdOf, parentOf, rootsOf, unionBoxes, type Box } from './tree';

enablePatches();

/** Décalage d'un duplicata (Ctrl+D) et d'un collage sur la même face, en mm. */
export const DUPLICATE_OFFSET_MM = 5;
/** Flèches : 0,5 mm ; Maj+flèches : 5 mm. */
export const NUDGE_MM = 0.5;
export const NUDGE_BIG_MM = 5;

/** conflict : le fichier a changé sur le disque depuis l'ouverture (autre onglet, script), rien n'a été écrit. */
export type SaveStatus = 'idle' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/**
 * Mode d'édition exclusif posé par un agent (édition de texte, recadrage, plume…) : tant qu'il est
 * actif, le plan de travail ne gère plus les clics sur la page et les poignées disparaissent.
 */
export interface EditorMode {
  id: string;
  target?: Id | null;
  data?: unknown;
}

export interface GestureInfo {
  label: string;
  startedAt: number;
  /**
   * Geste long et modal (édition de texte, recadrage, points de la plume) : son aperçu est enregistré sur
   * le disque au fil de l'eau, comme une modification ordinaire, sans attendre sa fin. Un glisser ou un
   * redimensionnement (quelques secondes au plus) n'enregistre qu'à la fin.
   */
  autosave?: boolean;
}

export interface SelectOptions {
  /** replace (défaut), add, toggle, remove. */
  mode?: 'replace' | 'add' | 'toggle' | 'remove';
}

export interface ApplyOptions<T> {
  /** Clé de fusion : deux étapes de même clé à moins d'une seconde n'en font qu'une (flèches). */
  coalesce?: string;
  /** Sélection après l'action (identifiants, ou calculée depuis le résultat de la recette). */
  select?: Id[] | ((result: T) => Id[]);
}

export interface EditorData {
  docId: string | null;
  doc: LayoutDocument | null;
  /** Incrémenté à chaque changement du document (enregistrement automatique, aperçus…). */
  revision: number;
  /** Objets sélectionnés, au niveau de `enteredGroup` (premier niveau des pages si null). */
  selection: Id[];
  /** Groupe dans lequel on est entré par double-clic : ses enfants se sélectionnent un par un. */
  enteredGroup: Id | null;
  /** Objet survolé, au niveau de sélection courant. */
  hoverId: Id | null;
  /** Dernière face survolée ou cliquée : cible des collages et des créations au clavier. */
  activePageId: Id | null;
  /** Calque où naissent les nouveaux objets (null = le plus haut calque visible, déverrouillé et imprimable). */
  activeLayerId: Id | null;
  /** Outil de la barre d'outils (`select`, `text`, `rect`…, voir registry/tools). */
  tool: string;
  mode: EditorMode | null;
  /** 1 = taille réelle (1 mm CSS = 96 / 25,4 px). */
  zoom: number;
  zoomMode: 'fit' | 'manual';
  view: View;
  /** Taille du plan de travail à l'écran, px. */
  viewport: { w: number; h: number };
  gesture: GestureInfo | null;
  /** Aperçu d'un déplacement à la souris en cours (mm) : les poignées suivent sans toucher au document. */
  dragOffset: { dx: Mm; dy: Mm } | null;
  history: HistoryInfo;
  save: { status: SaveStatus; message: string | null; savedAt: string | null };
  clipboard: ClipboardContent | null;
}

export interface EditorActions {
  load(doc: LayoutDocument, docId?: string): void;
  // --- document et historique
  apply<T>(label: string, recipe: (draft: LayoutDocument) => T, options?: ApplyOptions<T>): T | undefined;
  beginGesture(label: string, options?: { autosave?: boolean }): void;
  /** Remplace les changements du geste par ceux de `recipe` appliquée au document du début du geste. */
  previewGesture(recipe: (draft: LayoutDocument) => void): void;
  commitGesture(options?: { select?: Id[] }): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  /** Change le document SANS étape d'annulation ni nouvelle révision (métadonnées : editedAt). */
  patchSilently(recipe: (draft: LayoutDocument) => void): void;
  // --- actions nommées (une étape d'annulation chacune)
  move(ids: Id[], dx: Mm, dy: Mm, options?: { coalesce?: string; label?: string }): void;
  nudge(dx: Mm, dy: Mm): void;
  setBox(id: Id, box: Partial<Box>, label?: string): void;
  resize(ids: Id[], from: Box, to: Box, label?: string): void;
  update<T extends DocObject = DocObject>(ids: Id[], patch: Partial<T> | ((obj: T) => void), label?: string): void;
  add(objects: DocObject[], roots: Id[], target: InsertTarget, label?: string): Id[];
  remove(ids?: Id[]): void;
  duplicate(ids?: Id[], offset?: { dx: Mm; dy: Mm }): Id[];
  group(ids?: Id[]): Id | null;
  ungroup(ids?: Id[]): Id[];
  reorder(mode: ReorderMode, ids?: Id[]): void;
  setLayer(layerId: Id, ids?: Id[]): void;
  copy(ids?: Id[]): void;
  cut(ids?: Id[]): void;
  paste(pageId?: Id): Id[];
  // --- sélection
  select(ids: Id[], options?: SelectOptions): void;
  /** Vide la sélection ; `exitGroups` : revient aussi au premier niveau des faces. */
  clearSelection(options?: { exitGroups?: boolean }): void;
  selectAll(pageId?: Id): void;
  enterGroup(groupId: Id, selectId?: Id | null): void;
  exitGroup(): void;
  setHover(id: Id | null): void;
  // --- outils, modes, vue
  setTool(tool: string): void;
  setMode(mode: EditorMode | null): void;
  setActivePage(pageId: Id | null): void;
  setActiveLayer(layerId: Id | null): void;
  setZoom(zoom: number, anchor?: { x: number; y: number }): void;
  zoomStep(dir: 1 | -1, anchor?: { x: number; y: number }): void;
  fit(): void;
  setView(view: View): void;
  panBy(dx: number, dy: number): void;
  setViewport(size: { w: number; h: number }): void;
  /** Centre la vue sur des objets (ou une face), sans changer le zoom. */
  centerOn(ids: Id[]): void;
  setDragOffset(offset: { dx: Mm; dy: Mm } | null): void;
  setSaveState(save: Partial<EditorData['save']>): void;
}

export type EditorState = EditorData & EditorActions;
export type EditorStore = StoreApi<EditorState>;

const initialData = (): EditorData => ({
  docId: null,
  doc: null,
  revision: 0,
  selection: [],
  enteredGroup: null,
  hoverId: null,
  activePageId: null,
  activeLayerId: null,
  tool: 'select',
  mode: null,
  zoom: 1,
  zoomMode: 'fit',
  view: { x: 0, y: 0 },
  viewport: { w: 0, h: 0 },
  gesture: null,
  dragOffset: null,
  history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, depth: 0 },
  save: { status: 'idle', message: null, savedAt: null },
  clipboard: null,
});

/** Calque par défaut des nouveaux objets : le plus haut calque visible, déverrouillé et imprimable. */
export function defaultLayerId(doc: LayoutDocument, preferred: Id | null): Id | null {
  const usable = (id: Id | null) => {
    const layer = doc.layers.find((l) => l.id === id);
    return !!layer && layer.visible && !layer.locked;
  };
  if (preferred && usable(preferred)) return preferred;
  const layers = [...doc.layers].reverse();
  return (layers.find((l) => l.visible && !l.locked && l.printable) ?? layers.find((l) => !l.locked) ?? layers[0])?.id ?? null;
}

/** Parent commun d'une sélection (groupe), ou null si premier niveau ou parents différents. */
function commonParent(doc: LayoutDocument, ids: Id[]): Id | null {
  if (!ids.length) return null;
  const first = parentOf(doc, ids[0]);
  return ids.every((id) => parentOf(doc, id) === first) ? first : null;
}

export function createEditorStore(): EditorStore {
  const history = new History();
  // Geste en cours : document de départ, patches accumulés, sélection de départ.
  let gesture: { base: LayoutDocument; patches: Patch[]; before: SelectionSnapshot } | null = null;

  return createStore<EditorState>()((set, get) => {
    const snapshot = (): SelectionSnapshot => ({ selection: get().selection, enteredGroup: get().enteredGroup });

    /** Sélection nettoyée des objets disparus ; groupe d'entrée abandonné s'il n'existe plus. */
    const sanitize = (doc: LayoutDocument, sel: SelectionSnapshot): SelectionSnapshot => ({
      selection: sel.selection.filter((id) => doc.objects[id] && pageIdOf(doc, id)),
      enteredGroup: sel.enteredGroup && doc.objects[sel.enteredGroup] ? sel.enteredGroup : null,
    });

    const commitDoc = (doc: LayoutDocument, extra: Partial<EditorData> = {}) => {
      const sel = sanitize(doc, { selection: extra.selection ?? get().selection, enteredGroup: extra.enteredGroup !== undefined ? extra.enteredGroup : get().enteredGroup });
      set({ ...extra, doc, revision: get().revision + 1, ...sel, history: history.info() });
    };

    const requireDoc = (): LayoutDocument => {
      const doc = get().doc;
      if (!doc) throw new Error('Aucun document ouvert');
      return doc;
    };

    const targets = (ids?: Id[]) => ids ?? get().selection;

    const apply: EditorActions['apply'] = (label, recipe, options = {}) => {
      const doc = get().doc;
      if (!doc) return undefined;
      let result!: ReturnType<typeof recipe>;
      const [next, patches, inverse] = produceWithPatches(doc, (draft: Draft<LayoutDocument>) => {
        result = recipe(draft as LayoutDocument);
      });
      const selectAfter = typeof options.select === 'function' ? options.select(result) : options.select;
      if (!patches.length) {
        if (selectAfter) get().select(selectAfter);
        return result;
      }
      const after: SelectionSnapshot = selectAfter
        ? { selection: selectAfter, enteredGroup: commonParent(next, selectAfter) }
        : { selection: get().selection, enteredGroup: get().enteredGroup };
      if (gesture) {
        gesture.patches.push(...patches);
      } else {
        history.push({ label, patches, inverse, before: snapshot(), after: sanitize(next, after), time: Date.now(), coalesce: options.coalesce });
      }
      commitDoc(next, after);
      return result;
    };

    const selectAfterTargets = (ids: Id[]) => {
      const doc = get().doc;
      return doc ? ids.filter((id) => doc.objects[id]) : ids;
    };

    return {
      ...initialData(),

      load(doc, docId) {
        history.clear();
        gesture = null;
        const frozen = freeze(structuredClone(doc), true);
        set({
          ...initialData(),
          docId: docId ?? doc.id,
          doc: frozen,
          revision: 0,
          activePageId: frozen.pages[0]?.id ?? null,
          viewport: get().viewport,
          history: history.info(),
          save: { status: 'saved', message: null, savedAt: null },
        });
        if (get().viewport.w > 0) get().fit();
      },

      apply,

      beginGesture(label, options = {}) {
        const doc = get().doc;
        if (!doc || gesture) return;
        gesture = { base: doc, patches: [], before: snapshot() };
        set({ gesture: { label, startedAt: Date.now(), ...(options.autosave ? { autosave: true } : null) } });
      },

      previewGesture(recipe) {
        if (!gesture) return;
        const [next, patches] = produceWithPatches(gesture.base, (draft: Draft<LayoutDocument>) => {
          recipe(draft as LayoutDocument);
        });
        gesture.patches = patches;
        commitDoc(next);
      },

      commitGesture(options = {}) {
        const g = gesture;
        const info = get().gesture;
        gesture = null;
        if (!g || !info) {
          set({ gesture: null });
          return;
        }
        const doc = get().doc!;
        // Les patches accumulés sont rejoués sur le document de départ : Immer n'en garde que l'effet
        // net, une seule étape d'annulation quel que soit le nombre d'images du geste.
        const [, patches, inverse] = produceWithPatches(g.base, (draft: Draft<LayoutDocument>) => {
          applyPatches(draft, g.patches);
        });
        const after = sanitize(doc, options.select ? { selection: options.select, enteredGroup: commonParent(doc, options.select) } : snapshot());
        if (patches.length) history.push({ label: info.label, patches, inverse, before: g.before, after, time: Date.now() });
        set({ gesture: null, history: history.info(), ...after });
      },

      cancelGesture() {
        const g = gesture;
        gesture = null;
        if (!g) return;
        set({ gesture: null });
        if (get().doc !== g.base) commitDoc(g.base, g.before);
      },

      undo() {
        if (gesture) get().cancelGesture();
        const entry = history.takeUndo();
        if (!entry) return;
        commitDoc(applyPatches(requireDoc(), entry.inverse), entry.before);
      },

      redo() {
        if (gesture) return;
        const entry = history.takeRedo();
        if (!entry) return;
        commitDoc(applyPatches(requireDoc(), entry.patches), entry.after);
      },

      patchSilently(recipe) {
        const doc = get().doc;
        if (!doc) return;
        set({ doc: produce(doc, (draft: Draft<LayoutDocument>) => void recipe(draft as LayoutDocument)) });
      },

      // ------------------------------------------------------------ actions nommées

      move(ids, dx, dy, options = {}) {
        if (!ids.length || (!dx && !dy)) return;
        apply(options.label ?? 'Déplacer', (d) => moveObjects(d, ids, dx, dy), { coalesce: options.coalesce });
      },

      nudge(dx, dy) {
        get().move(get().selection, dx, dy, { coalesce: 'nudge', label: 'Déplacer' });
      },

      setBox(id, box, label = 'Redimensionner') {
        apply(label, (d) => setBox(d, id, box));
      },

      resize(ids, from, to, label = 'Redimensionner') {
        apply(label, (d) => resizeObjects(d, ids, from, to));
      },

      update(ids, patch, label = 'Modifier') {
        if (!ids.length) return;
        apply(label, (d) => updateObjects(d, ids, patch));
      },

      add(objects, roots, target, label = 'Ajouter') {
        apply(label, (d) => addObjects(d, objects, roots, target), { select: roots });
        return roots;
      },

      remove(ids) {
        const list = targets(ids);
        if (!list.length) return;
        apply('Supprimer', (d) => removeObjects(d, list), { select: [] });
      },

      duplicate(ids, offset = { dx: DUPLICATE_OFFSET_MM, dy: DUPLICATE_OFFSET_MM }) {
        const list = targets(ids);
        if (!list.length) return [];
        return apply('Dupliquer', (d) => duplicateObjects(d, list, offset.dx, offset.dy), { select: (created) => created }) ?? [];
      },

      group(ids) {
        const list = targets(ids);
        if (!list.length) return null;
        return apply('Grouper', (d) => groupObjects(d, list), { select: (id) => (id ? [id] : list) }) ?? null;
      },

      ungroup(ids) {
        const list = targets(ids).filter((id) => get().doc?.objects[id]?.type === 'group');
        if (!list.length) return [];
        return apply('Dissocier', (d) => ungroupObjects(d, list), { select: (freed) => freed }) ?? [];
      },

      reorder(mode, ids) {
        const list = targets(ids);
        if (!list.length) return;
        const labels: Record<ReorderMode, string> = { front: 'Premier plan', back: 'Arrière-plan', forward: 'Avancer', backward: 'Reculer' };
        apply(labels[mode], (d) => reorderObjects(d, list, mode));
      },

      setLayer(layerId, ids) {
        const list = targets(ids);
        if (!list.length) return;
        apply('Changer de calque', (d) => setObjectsLayer(d, list, layerId));
      },

      copy(ids) {
        const doc = get().doc;
        const list = targets(ids);
        if (!doc || !list.length) return;
        set({ clipboard: extractObjects(doc, list) });
      },

      cut(ids) {
        const list = targets(ids);
        if (!list.length) return;
        get().copy(list);
        apply('Couper', (d) => removeObjects(d, list), { select: [] });
      },

      paste(pageId) {
        const doc = get().doc;
        const clip = get().clipboard;
        if (!doc || !clip || !clip.objects.length) return [];
        const targetPage = pageId ?? get().activePageId ?? doc.pages[0]?.id;
        if (!targetPage || !findPageOrMaster(doc, targetPage)) return [];
        // Sur la face d'origine, alors que les originaux sont toujours là : décalé, comme un duplicata.
        const originalsHere = clip.sourcePageId === targetPage && clip.roots.some((id) => doc.objects[id] && pageIdOf(doc, id) === targetPage);
        const offset = originalsHere ? DUPLICATE_OFFSET_MM : 0;
        const content = reidentify(doc, clip, offset, offset);
        const fallbackLayer = defaultLayerId(doc, get().activeLayerId);
        for (const obj of content.objects) {
          const layer = doc.layers.find((l) => l.id === obj.layerId);
          if ((!layer || layer.locked) && fallbackLayer) obj.layerId = fallbackLayer;
        }
        apply('Coller', (d) => addObjects(d, content.objects, content.roots, { pageId: targetPage }), { select: content.roots });
        set({ activePageId: targetPage });
        return content.roots;
      },

      // ------------------------------------------------------------ sélection

      select(ids, options = {}) {
        const doc = get().doc;
        if (!doc) return;
        const current = get().selection;
        let next: Id[];
        switch (options.mode ?? 'replace') {
          case 'add':
            next = [...current, ...ids.filter((id) => !current.includes(id))];
            break;
          case 'remove':
            next = current.filter((id) => !ids.includes(id));
            break;
          case 'toggle':
            next = [...current.filter((id) => !ids.includes(id)), ...ids.filter((id) => !current.includes(id))];
            break;
          default:
            next = [...new Set(ids)];
        }
        next = selectAfterTargets(next);
        const same = next.length === current.length && next.every((id, i) => id === current[i]);
        const entered = next.length ? commonParent(doc, next) : get().enteredGroup;
        if (same && entered === get().enteredGroup) return;
        const page = next.length ? pageIdOf(doc, next[0]) : null;
        set({ selection: next, enteredGroup: entered, ...(page ? { activePageId: page } : {}) });
      },

      clearSelection(options = {}) {
        const exit = options.exitGroups && get().enteredGroup !== null;
        if (get().selection.length || exit) set({ selection: [], ...(exit ? { enteredGroup: null } : {}) });
      },

      selectAll(pageId) {
        const doc = get().doc;
        if (!doc) return;
        const scope = get().enteredGroup;
        let candidates: Id[];
        if (scope) {
          const group = doc.objects[scope];
          candidates = group?.type === 'group' ? group.children : [];
        } else {
          const page = findPageOrMaster(doc, pageId ?? get().activePageId ?? '') ?? doc.pages[0];
          candidates = page?.children ?? [];
        }
        const ids = candidates.filter((id) => isSelectable(doc, id));
        set({ selection: ids });
      },

      enterGroup(groupId, selectId = null) {
        const doc = get().doc;
        if (doc?.objects[groupId]?.type !== 'group') return;
        set({ enteredGroup: groupId, selection: selectId && doc.objects[selectId] ? [selectId] : [], hoverId: null });
      },

      exitGroup() {
        const doc = get().doc;
        const g = get().enteredGroup;
        if (!doc || !g) return;
        // On ressort avec le groupe sélectionné, au niveau de son propre parent.
        set({ enteredGroup: parentOf(doc, g), selection: doc.objects[g] ? [g] : [], hoverId: null });
      },

      setHover(id) {
        if (get().hoverId !== id) set({ hoverId: id });
      },

      // ------------------------------------------------------------ outils, vue

      setTool(tool) {
        if (get().tool !== tool) set({ tool });
      },

      setMode(mode) {
        set({ mode });
      },

      setActivePage(pageId) {
        if (get().activePageId !== pageId) set({ activePageId: pageId });
      },

      setActiveLayer(layerId) {
        set({ activeLayerId: layerId });
      },

      setZoom(zoom, anchor) {
        const z = clampZoom(zoom);
        const { viewport, view } = get();
        const a = anchor ?? { x: viewport.w / 2, y: viewport.h / 2 };
        set({ zoom: z, zoomMode: 'manual', view: zoomAround(get().zoom, z, view, a) });
      },

      zoomStep(dir, anchor) {
        get().setZoom(stepZoom(get().zoom, dir), anchor);
      },

      fit() {
        const doc = get().doc;
        const viewport = get().viewport;
        if (!doc || viewport.w <= 0 || viewport.h <= 0) {
          set({ zoomMode: 'fit' });
          return;
        }
        const { zoom, view } = fitView(doc, viewport);
        set({ zoom, view, zoomMode: 'fit' });
      },

      setView(view) {
        set({ view });
      },

      panBy(dx, dy) {
        const v = get().view;
        set({ view: { x: v.x + dx, y: v.y + dy } });
      },

      setViewport(size) {
        const prev = get().viewport;
        if (prev.w === size.w && prev.h === size.h) return;
        if (get().zoomMode === 'fit' || prev.w <= 0 || prev.h <= 0) {
          set({ viewport: size });
          if (get().zoomMode === 'fit') get().fit();
          return;
        }
        // Zoom manuel : ce qui était au centre du plan de travail y reste. Une colonne qui s'ouvre à
        // gauche (options d'outil) ne pousse plus la page de toute sa largeur hors de l'écran.
        const v = get().view;
        set({ viewport: size, view: { x: v.x + (size.w - prev.w) / 2, y: v.y + (size.h - prev.h) / 2 } });
      },

      centerOn(ids) {
        const doc = get().doc;
        if (!doc) return;
        const boxes: Box[] = [];
        for (const id of ids) {
          const page = findPageOrMaster(doc, id);
          const pageId = page ? page.id : pageIdOf(doc, id);
          const slot = pageId ? pageSlot(doc, pageId) : undefined;
          if (!slot) continue;
          const box = page ? { x: 0, y: 0, w: slot.w, h: slot.h } : objectBounds(doc.objects[id]);
          boxes.push({ x: slot.x + box.x, y: slot.y + box.y, w: box.w, h: box.h });
        }
        const box = unionBoxes(boxes);
        if (!box) return;
        const { zoom, viewport } = get();
        const k = pxPerMm(zoom);
        set({ view: { x: viewport.w / 2 - (box.x + box.w / 2) * k, y: viewport.h / 2 - (box.y + box.h / 2) * k }, zoomMode: 'manual' });
      },

      setDragOffset(offset) {
        set({ dragOffset: offset });
      },

      setSaveState(save) {
        set({ save: { ...get().save, ...save } });
      },
    };
  });
}

/** Store unique de l'application. Les tests unitaires créent le leur avec `createEditorStore()`. */
export const editorStore = createEditorStore();

/** Lecture réactive du store : `const zoom = useEditor((s) => s.zoom)`. */
export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(editorStore, selector);
}

/** Variante à comparaison superficielle, pour un sélecteur qui renvoie un objet ou un tableau neuf. */
export function useEditorShallow<T>(selector: (state: EditorState) => T): T {
  return useStore(editorStore, useShallow(selector));
}

export const getEditor = (): EditorState => editorStore.getState();

/** Racines de la sélection (les objets eux-mêmes). */
export function selectedObjects(state: Pick<EditorData, 'doc' | 'selection'>): DocObject[] {
  const doc = state.doc;
  if (!doc) return [];
  return rootsOf(doc, state.selection)
    .map((id) => doc.objects[id])
    .filter((o): o is DocObject => !!o);
}
