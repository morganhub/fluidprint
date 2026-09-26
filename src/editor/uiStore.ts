import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// État d'interface qui ne touche pas au document : onglet du volet de droite, aide des raccourcis.
export interface UiState {
  /** Onglet actif du volet de droite (identifiant de panneau). */
  activePanel: string;
  helpOpen: boolean;
  setActivePanel(id: string): void;
  setHelpOpen(open: boolean): void;
}

export const uiStore = createStore<UiState>()((set) => ({
  activePanel: 'properties',
  helpOpen: false,
  setActivePanel: (id) => set({ activePanel: id }),
  setHelpOpen: (open) => set({ helpOpen: open }),
}));

export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(uiStore, selector);
}
