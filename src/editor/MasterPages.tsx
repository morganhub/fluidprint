// Pages types (tâche 4.11), côté éditeur : le menu « Pages types » de la barre du haut (créer, appliquer
// aux faces, renommer, supprimer, déplacer la sélection vers une page type) et le mode d'édition d'une
// page type (bandeau en haut du plan de travail). Pendant l'édition, le plan de travail ne montre que la
// page type : tout ce qu'on y modifie se voit ensuite sur chaque face qui l'utilise.
import { LayoutTemplate, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { addMaster, applyMaster, findMaster, moveToMaster, pagesUsingMaster, removeMaster, renameMaster } from '../model/masters';
import type { Id } from '../model/types';
import { editorStore, getEditor, useEditor } from '../store/documentStore';
import { pageIdOf, parentOf, rootsOf } from '../store/tree';
import { editedMaster, masterView, useMasterEditing, workspacePages } from './masterView';
import { registerOverlay, registerTopbarAction } from './registry/api';

// ---------------------------------------------------------------- mode d'édition

/** Ouvre une page type seule dans le plan de travail (null : retour aux faces). */
export function editMaster(masterId: Id | null): void {
  const s = getEditor();
  if (!s.doc) return;
  if (masterId && !findMaster(s.doc, masterId)) return;
  s.clearSelection({ exitGroups: true });
  s.setHover(null);
  masterView.setState({ editing: masterId });
  getEditor().setActivePage(masterId ?? s.doc.pages[0]?.id ?? null);
  getEditor().fit();
}

// La sélection ne vise jamais un objet que le plan de travail ne montre pas (une annulation peut en
// ramener un de la page type alors qu'on est revenu aux faces) ; une page type disparue ferme son mode.
editorStore.subscribe((next, prev) => {
  if (next.docId !== prev.docId && masterView.getState().editing) masterView.setState({ editing: null });
  const doc = next.doc;
  if (!doc || (next.selection === prev.selection && doc === prev.doc && next.hoverId === prev.hoverId)) return;
  if (masterView.getState().editing && !editedMaster(doc)) masterView.setState({ editing: null });
  const shown = new Set(workspacePages(doc).map((p) => p.id));
  const visible = (id: Id) => shown.has(pageIdOf(doc, id) ?? '');
  if (next.hoverId && !visible(next.hoverId)) next.setHover(null);
  const kept = next.selection.filter(visible);
  if (kept.length !== next.selection.length) next.select(kept);
});

// ---------------------------------------------------------------- menu de la barre du haut

function MasterPagesButton() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const editing = useMasterEditing();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<Id | null>(null);
  if (!doc) return null;
  const masters = doc.masters ?? [];
  // « Déplacer vers la page type » : objets de premier niveau d'une face, hors mode page type.
  const movable = !editing && selection.length > 0 && selection.every((id) => !parentOf(doc, id) && doc.pages.some((p) => p.id === pageIdOf(doc, id)));

  const create = () => {
    const s = getEditor();
    const page = doc.pages.find((p) => p.id === s.activePageId) ?? doc.pages[0];
    const id = s.apply('Nouvelle page type', (d) => {
      const m = addMaster(d, { faceId: page.faceId });
      applyMaster(d, page.id, m);
      return m;
    });
    setOpen(false);
    if (id) editMaster(id);
  };

  const moveSelection = (masterId: Id) => {
    const s = getEditor();
    const ids = rootsOf(doc, s.selection);
    const pages = new Set(ids.map((id) => pageIdOf(doc, id)));
    s.apply(
      'Déplacer vers la page type',
      (d) => {
        moveToMaster(d, ids, masterId);
        for (const p of pages) if (p && !d.pages.find((pg) => pg.id === p)?.masterId) applyMaster(d, p, masterId);
      },
      { select: [] },
    );
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={editing ? 'toggle' : 'outline'} size="sm" aria-pressed={!!editing} data-topbar-action="masters">
          <LayoutTemplate />
          Pages types
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" data-masters-menu>
        <div className="max-h-[60vh] overflow-y-auto">
          {masters.length === 0 && (
            <p className="px-3 py-3 text-[12px] text-neutral-600">
              Aucune page type. Une page type porte les objets communs à plusieurs faces : on les modifie à un seul endroit.
            </p>
          )}
          {masters.map((m) => {
            const used = pagesUsingMaster(doc, m.id);
            return (
              <div key={m.id} data-master-row={m.id} className="border-b border-neutral-100 px-3 py-2">
                <div className="flex items-center gap-1">
                  {renaming === m.id ? (
                    <input
                      autoFocus
                      name="masterRename"
                      defaultValue={m.name}
                      className="h-7 min-w-0 flex-1 rounded border border-neutral-300 px-1.5 text-[12px]"
                      onBlur={(e) => {
                        const name = e.target.value;
                        getEditor().apply('Renommer la page type', (d) => renameMaster(d, m.id, name));
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-[13px] font-medium" onDoubleClick={() => setRenaming(m.id)} title="Double-clic pour renommer">
                      {m.name}
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-action="edit-master"
                    onClick={() => {
                      setOpen(false);
                      editMaster(editing === m.id ? null : m.id);
                    }}
                  >
                    <Pencil />
                    {editing === m.id ? 'Terminer' : 'Modifier'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Supprimer la page type ${m.name}`}
                    title="Supprimer la page type (ses objets disparaissent de toutes les faces)"
                    data-action="delete-master"
                    onClick={() => {
                      if (editing === m.id) editMaster(null);
                      getEditor().apply('Supprimer la page type', (d) => removeMaster(d, m.id), { select: [] });
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-neutral-700">
                  <span className="text-neutral-500">Appliquée à :</span>
                  {doc.pages.map((p) => (
                    <label key={p.id} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-neutral-900"
                        data-master-apply={`${m.id}:${p.id}`}
                        checked={p.masterId === m.id}
                        onChange={(e) => getEditor().apply(e.target.checked ? 'Appliquer la page type' : 'Retirer la page type', (d) => applyMaster(d, p.id, e.target.checked ? m.id : null))}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
                {movable && (
                  <button type="button" data-action="move-to-master" className="mt-1 text-[12px] text-sky-700 underline underline-offset-2" onClick={() => moveSelection(m.id)}>
                    Déplacer la sélection vers cette page type
                  </button>
                )}
                {used.length === 0 && <p className="mt-1 text-[11px] text-neutral-500">Utilisée par aucune face : ses objets ne s'impriment pas.</p>}
              </div>
            );
          })}
        </div>
        <div className="p-2">
          <Button variant="outline" size="sm" className="w-full" data-action="new-master" onClick={create}>
            Nouvelle page type
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- bandeau du mode d'édition

function MasterBanner() {
  const editing = useMasterEditing();
  const doc = useEditor((s) => s.doc);
  const master = doc && editing ? findMaster(doc, editing) : undefined;
  if (!doc || !master) return null;
  const used = pagesUsingMaster(doc, master.id).map((p) => p.name);
  return (
    <div
      data-master-banner={master.id}
      data-editor-handle
      className="pointer-events-auto absolute left-1/2 top-7 z-10 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-[12px] text-violet-950 shadow-sm"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <LayoutTemplate className="size-4 text-violet-700" />
      <span>
        Page type <strong>« {master.name} »</strong> · {used.length ? `modifie : ${used.join(', ')}` : 'utilisée par aucune face'}
      </span>
      <Button size="sm" data-action="master-done" onClick={() => editMaster(null)}>
        Terminer
      </Button>
    </div>
  );
}

registerTopbarAction({ id: 'masters', order: 45, label: 'Pages types', component: MasterPagesButton });
registerOverlay({ id: 'master-banner', order: 5, space: 'viewport', component: MasterBanner });
