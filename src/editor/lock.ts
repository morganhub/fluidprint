// Verrouiller un objet (tâche 2.13) : Ctrl+L verrouille la sélection, Ctrl+Alt+L déverrouille tout sur
// la face active, sauf les objets des calques non imprimables (trait de coupe et plis, verrouillés dès
// l'import) ; le cadenas du panneau Calques fait de même objet par objet, sans exception. Un objet
// verrouillé (ou dont le calque ou un groupe parent l'est) laisse passer le clic et le lasso (store/tree.ts,
// isSelectable) : il ne peut donc plus être attrapé ni déplacé. Le verrouiller le retire de la sélection.
import { findPageOrMaster } from '../model/masters';
import type { Id } from '../model/types';
import { getEditor, type EditorState } from '../store/documentStore';
import { descendantsOf, isSelectable } from '../store/tree';
import { registerShortcut } from './registry/api';

/** Verrouille (ou déverrouille) des objets ; ceux qui deviennent inattrapables quittent la sélection. */
export function setLocked(ids: Id[], locked: boolean, state: EditorState = getEditor()): void {
  const doc = state.doc;
  if (!doc || !ids.length) return;
  const targets = ids.filter((id) => doc.objects[id] && !!doc.objects[id].locked !== locked);
  if (!targets.length) return;
  const label = locked ? (targets.length > 1 ? `Verrouiller ${targets.length} objets` : 'Verrouiller') : 'Déverrouiller';
  // Sélection après coup : sans les objets verrouillés ni ceux qu'un parent verrouillé rend inattrapables.
  const gone = new Set(locked ? targets.flatMap((id) => [id, ...descendantsOf(doc, id)]) : []);
  const select = state.selection.filter((id) => !gone.has(id));
  state.apply(
    label,
    (d) => {
      for (const id of targets) {
        if (locked) d.objects[id].locked = true;
        else delete d.objects[id].locked;
      }
    },
    // Sélection vidée : on reste dans le groupe « entré » (select: [] en sortirait).
    select.length ? { select } : {},
  );
  if (!select.length) getEditor().clearSelection();
}

/** Ctrl+L : verrouille la sélection. */
export function lockSelection(state: EditorState = getEditor()): void {
  setLocked(state.selection, true, state);
}

/**
 * Ctrl+Alt+L : déverrouille tous les objets de la face active (calques exceptés). Les objets d'un calque
 * non imprimable restent verrouillés : ce sont les repères (trait de coupe, plis) posés verrouillés par
 * l'import ; libérés, le trait de coupe (297 × 210 mm) captait tous les clics et lassos de la face. Ils se
 * déverrouillent un par un, au cadenas du panneau Calques.
 */
export function unlockAllOnPage(state: EditorState = getEditor()): Id[] {
  const doc = state.doc;
  if (!doc) return [];
  const page = findPageOrMaster(doc, state.activePageId ?? '') ?? doc.pages[0];
  if (!page) return [];
  const printable = new Set(doc.layers.filter((l) => l.printable).map((l) => l.id));
  const all = page.children.flatMap((id) => [id, ...descendantsOf(doc, id)]);
  const locked = all.filter((id) => doc.objects[id]?.locked && printable.has(doc.objects[id].layerId));
  if (!locked.length) return [];
  state.apply('Tout déverrouiller', (d) => {
    for (const id of locked) delete d.objects[id].locked;
  });
  // Les objets libérés au premier niveau sont sélectionnés, comme dans InDesign.
  const after = getEditor();
  const roots = locked.filter((id) => page.children.includes(id) && isSelectable(after.doc!, id));
  if (roots.length && !after.enteredGroup) after.select(roots);
  return locked;
}

registerShortcut({
  id: 'lock',
  keys: 'Mod+L',
  label: 'Verrouiller la sélection',
  group: 'Objets',
  when: (s) => !!s.doc && s.selection.length > 0 && !s.gesture,
  run: (_e, s) => lockSelection(s),
});

registerShortcut({
  id: 'unlock-all',
  keys: 'Mod+Alt+L',
  label: 'Tout déverrouiller (face active)',
  group: 'Objets',
  run: (_e, s) => void unlockAllOnPage(s),
});
