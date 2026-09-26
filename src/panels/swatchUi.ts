import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { addSwatch, parseCssColor } from '../model/swatches';
import type { Id } from '../model/types';
import { getEditor } from '../store/documentStore';

// État d'interface du nuancier (hors document) : nuance dépliée dans le panneau, et s'il faut mettre le
// curseur dans son nom (nuance prise à la pipette ou créée sans nom).
interface SwatchUiState {
  openId: string | null;
  focusName: boolean;
  open(id: string | null, focusName?: boolean): void;
}

export const swatchUiStore = createStore<SwatchUiState>()((set) => ({
  openId: null,
  focusName: false,
  open: (id, focusName = false) => set({ openId: id, focusName }),
}));

export function useSwatchUi<T>(selector: (s: SwatchUiState) => T): T {
  return useStore(swatchUiStore, selector);
}

// ---------------------------------------------------------------- créer une nuance (panneau, Propriétés)

/** Ajoute une nuance (une étape d'annulation) et l'ouvre dans le panneau ; renvoie son identifiant. */
export function createSwatch(rgb: string, name?: string): Id | undefined {
  const id = getEditor().apply(name ? `Nouvelle nuance « ${name} »` : 'Nouvelle nuance', (d) => addSwatch(d, { rgb, name }));
  if (id) swatchUiStore.getState().open(id, !name);
  return id;
}

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

export const hasEyeDropper = (): boolean => typeof window !== 'undefined' && 'EyeDropper' in window;

/**
 * Pipette (API EyeDropper de Chrome) : la couleur prise n'importe où à l'écran entre au nuancier sous
 * un nom à compléter (« À nommer »). Renvoie l'identifiant de la nuance ; null si l'utilisateur renonce
 * (Échap) ou si le navigateur n'a pas l'API (le panneau propose alors la saisie hexadécimale).
 */
export async function pickColorToSwatch(): Promise<Id | null> {
  if (!hasEyeDropper()) return null;
  const EyeDropper = (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
  try {
    const { sRGBHex } = await new EyeDropper().open();
    const rgb = parseCssColor(sRGBHex);
    return rgb ? (createSwatch(rgb) ?? null) : null;
  } catch {
    // Échap ou fenêtre quittée : rien à faire.
    return null;
  }
}
