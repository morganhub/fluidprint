// Mode d'édition d'une page type (tâche 4.11) : le plan de travail montre la page type seule, à la place
// des faces, comme InDesign quand on ouvre un gabarit. Ce module n'importe ni React ni le store de
// l'éditeur : layout.ts (géométrie) le lit pour poser les emplacements des faces.
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { findMaster } from '../model/masters';
import type { Id, LayoutDocument, MasterPage, Page } from '../model/types';

export const masterView = createStore<{ editing: Id | null }>()(() => ({ editing: null }));

export const useMasterEditing = (): Id | null => useStore(masterView, (s) => s.editing);

/** Page type en cours d'édition (et toujours présente dans le document), sinon undefined. */
export function editedMaster(doc: Pick<LayoutDocument, 'masters'>): MasterPage | undefined {
  return findMaster(doc, masterView.getState().editing);
}

/** Ce que montre le plan de travail : la page type en cours d'édition, sinon les faces du document. */
export function workspacePages(doc: Pick<LayoutDocument, 'pages' | 'masters'>): (Page | MasterPage)[] {
  const master = editedMaster(doc);
  return master ? [master] : doc.pages;
}
