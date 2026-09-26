// Barre d'état : niveau de sélection (groupe « entré »), sélection, et éléments enregistrés
// (registry/statusbar.ts).
import { CornerLeftUp } from 'lucide-react';
import { describeSelection } from '../panels/PropertiesPanel';
import { getEditor, selectedObjects, useEditor, useEditorShallow } from '../store/documentStore';
import { statusbarRegistry } from './registry/api';

export function StatusBar() {
  const items = statusbarRegistry.use();
  const objects = useEditorShallow((s) => selectedObjects(s));
  const entered = useEditor((s) => (s.enteredGroup && s.doc?.objects[s.enteredGroup] ? (s.doc.objects[s.enteredGroup].name ?? 'Groupe') : null));
  const left = items.filter((i) => i.align !== 'right');
  const right = items.filter((i) => i.align === 'right');
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-neutral-200 bg-white px-3 text-[11px] text-neutral-500" data-statusbar>
      {entered && (
        <button type="button" className="flex items-center gap-1 rounded px-1 text-sky-700 hover:bg-sky-50" onClick={() => getEditor().exitGroup()} title="Sortir du groupe (Échap)">
          <CornerLeftUp className="size-3" />
          Dans le groupe « {entered} »
        </button>
      )}
      <span data-status-selection>{describeSelection(objects)}</span>
      {left.map((i) => (
        <i.component key={i.id} />
      ))}
      <span className="flex-1" />
      {right.map((i) => (
        <i.component key={i.id} />
      ))}
    </footer>
  );
}
