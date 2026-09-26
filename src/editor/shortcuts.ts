// Raccourcis de base (tâche 2.8) et moteur de raccourcis : un seul écouteur clavier parcourt le registre
// (registry/shortcuts.ts) dans l'ordre et exécute le premier raccourci qui correspond.
import { getEditor, NUDGE_BIG_MM, NUDGE_MM, type EditorState } from '../store/documentStore';
import { getPersistence } from '../store/persistence';
import { isTypingTarget, matchesCombo, parseCombo, type KeyCombo } from './keys';
import { registerShortcut, shortcutRegistry, toolRegistry, type ShortcutDefinition } from './registry/api';
import { uiStore } from './uiStore';

const hasDoc = (s: EditorState) => !!s.doc;
const hasSelection = (s: EditorState) => !!s.doc && s.selection.length > 0 && !s.gesture;

// ---------------------------------------------------------------- moteur

const comboCache = new Map<string, KeyCombo>();
const combo = (spec: string) => {
  let c = comboCache.get(spec);
  if (!c) comboCache.set(spec, (c = parseCombo(spec)));
  return c;
};

/** Raccourcis des outils, dérivés de leur touche (`ToolDefinition.shortcut`). */
function toolShortcuts(): ShortcutDefinition[] {
  return toolRegistry
    .list()
    .filter((t) => t.shortcut)
    .map((t) => ({
      id: `tool:${t.id}`,
      keys: t.shortcut!,
      label: t.label,
      group: 'Outils',
      order: 1000 + (t.order ?? 100),
      run: (_e, s) => s.setTool(t.id),
    }));
}

export function allShortcuts(): ShortcutDefinition[] {
  return [...shortcutRegistry.list(), ...toolShortcuts()];
}

export function handleKeyDown(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const state = getEditor();
  const typing = isTypingTarget(e.target);
  for (const def of allShortcuts()) {
    const keys = Array.isArray(def.keys) ? def.keys : [def.keys];
    if (!keys.some((k) => matchesCombo(e, combo(k)))) continue;
    if (typing && !def.allowInInput) continue;
    if (state.mode && !def.allowInMode) continue;
    if (def.when ? !def.when(state) : !hasDoc(state)) continue;
    if (def.run(e, state) === false) continue;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  return false;
}

/** Branche le clavier sur la fenêtre ; renvoie de quoi le débrancher. */
export function installShortcuts(): () => void {
  const listener = (e: KeyboardEvent) => void handleKeyDown(e);
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}

// ---------------------------------------------------------------- raccourcis de base

const nudge = (dx: number, dy: number) => (_e: KeyboardEvent, s: EditorState) => s.nudge(dx, dy);

const BASE: ShortcutDefinition[] = [
  { id: 'save', keys: 'Mod+S', label: 'Enregistrer maintenant', group: 'Fichier', allowInInput: true, allowInMode: true, run: () => void getPersistence()?.saveNow() },
  { id: 'undo', keys: 'Mod+Z', label: 'Annuler', group: 'Édition', run: (_e, s) => s.undo() },
  { id: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], label: 'Rétablir', group: 'Édition', run: (_e, s) => s.redo() },
  { id: 'copy', keys: 'Mod+C', label: 'Copier', group: 'Édition', when: hasSelection, run: (_e, s) => s.copy() },
  { id: 'cut', keys: 'Mod+X', label: 'Couper', group: 'Édition', when: hasSelection, run: (_e, s) => s.cut() },
  { id: 'paste', keys: 'Mod+V', label: 'Coller (sur la face survolée)', group: 'Édition', when: (s) => !!s.doc && !!s.clipboard, run: (_e, s) => void s.paste() },
  { id: 'duplicate', keys: 'Mod+D', label: 'Dupliquer (décalé de 5 mm)', group: 'Édition', when: hasSelection, run: (_e, s) => void s.duplicate() },
  { id: 'delete', keys: ['Delete', 'Backspace'], label: 'Supprimer', group: 'Édition', when: hasSelection, run: (_e, s) => s.remove() },
  { id: 'group', keys: 'Mod+G', label: 'Grouper', group: 'Objets', when: hasSelection, run: (_e, s) => void s.group() },
  { id: 'ungroup', keys: 'Mod+Shift+G', label: 'Dissocier', group: 'Objets', when: hasSelection, run: (_e, s) => void s.ungroup() },
  { id: 'front', keys: 'Mod+Shift+]', label: 'Premier plan', group: 'Objets', when: hasSelection, run: (_e, s) => s.reorder('front') },
  { id: 'forward', keys: 'Mod+]', label: 'Avancer', group: 'Objets', when: hasSelection, run: (_e, s) => s.reorder('forward') },
  { id: 'backward', keys: 'Mod+[', label: 'Reculer', group: 'Objets', when: hasSelection, run: (_e, s) => s.reorder('backward') },
  { id: 'back', keys: 'Mod+Shift+[', label: 'Arrière-plan', group: 'Objets', when: hasSelection, run: (_e, s) => s.reorder('back') },
  { id: 'nudge-left', keys: 'ArrowLeft', label: 'Déplacer de 0,5 mm', group: 'Objets', when: hasSelection, run: nudge(-NUDGE_MM, 0) },
  { id: 'nudge-right', keys: 'ArrowRight', label: 'Déplacer de 0,5 mm', group: 'Objets', hidden: true, when: hasSelection, run: nudge(NUDGE_MM, 0) },
  { id: 'nudge-up', keys: 'ArrowUp', label: 'Déplacer de 0,5 mm', group: 'Objets', hidden: true, when: hasSelection, run: nudge(0, -NUDGE_MM) },
  { id: 'nudge-down', keys: 'ArrowDown', label: 'Déplacer de 0,5 mm', group: 'Objets', hidden: true, when: hasSelection, run: nudge(0, NUDGE_MM) },
  { id: 'nudge-left-big', keys: 'Shift+ArrowLeft', label: 'Déplacer de 5 mm', group: 'Objets', when: hasSelection, run: nudge(-NUDGE_BIG_MM, 0) },
  { id: 'nudge-right-big', keys: 'Shift+ArrowRight', label: 'Déplacer de 5 mm', group: 'Objets', hidden: true, when: hasSelection, run: nudge(NUDGE_BIG_MM, 0) },
  { id: 'nudge-up-big', keys: 'Shift+ArrowUp', label: 'Déplacer de 5 mm', group: 'Objets', hidden: true, when: hasSelection, run: nudge(0, -NUDGE_BIG_MM) },
  { id: 'nudge-down-big', keys: 'Shift+ArrowDown', label: 'Déplacer de 5 mm', group: 'Objets', hidden: true, when: hasSelection, run: nudge(0, NUDGE_BIG_MM) },
  { id: 'select-all', keys: 'Mod+A', label: 'Tout sélectionner (face active)', group: 'Sélection', run: (_e, s) => s.selectAll() },
  {
    id: 'escape',
    keys: 'Escape',
    label: 'Sortir du groupe, désélectionner, revenir à la sélection',
    group: 'Sélection',
    run: (_e, s) => {
      if (s.tool !== 'select') s.setTool('select');
      else if (s.enteredGroup) s.exitGroup();
      else if (s.selection.length) s.clearSelection();
      else return false;
    },
  },
  { id: 'zoom-in', keys: ['Mod+=', 'Mod++'], label: 'Zoom avant', group: 'Affichage', run: (_e, s) => s.zoomStep(1) },
  { id: 'zoom-out', keys: 'Mod+-', label: 'Zoom arrière', group: 'Affichage', run: (_e, s) => s.zoomStep(-1) },
  { id: 'zoom-fit', keys: 'Mod+0', label: 'Ajuster à l’écran', group: 'Affichage', run: (_e, s) => s.fit() },
  { id: 'zoom-100', keys: 'Mod+1', label: 'Taille réelle (100 %)', group: 'Affichage', run: (_e, s) => s.setZoom(1) },
  {
    id: 'help',
    keys: ['Mod+?', 'Mod+/'],
    label: 'Aide des raccourcis',
    group: 'Aide',
    allowInMode: true,
    when: () => true,
    run: () => uiStore.getState().setHelpOpen(true),
  },
];

BASE.forEach((def, i) => registerShortcut({ order: i, ...def }));
