// Historique d'annulation par patches Immer : chaque étape garde ses patches et leurs inverses, plus la
// sélection avant et après (Ctrl+Z remet aussi la sélection). 100 étapes au plus.
import type { Patch } from 'immer';
import type { Id } from '../model/types';

export const HISTORY_LIMIT = 100;
/** Deux retouches de même clé à moins de ce délai (flèches maintenues) forment une seule étape. */
export const COALESCE_MS = 1000;

export interface SelectionSnapshot {
  selection: Id[];
  enteredGroup: Id | null;
}

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  before: SelectionSnapshot;
  after: SelectionSnapshot;
  /** Horodatage de la dernière retouche fusionnée dans l'étape. */
  time: number;
  coalesce?: string;
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Nombre d'étapes annulables (tests, aide). */
  depth: number;
}

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  constructor(private limit = HISTORY_LIMIT) {}

  clear(): void {
    this.past = [];
    this.future = [];
  }

  /** Ajoute une étape ; fusionne avec la précédente si même clé de fusion et assez récente. */
  push(entry: HistoryEntry): void {
    this.future = [];
    const last = this.past.at(-1);
    if (entry.coalesce && last && last.coalesce === entry.coalesce && entry.time - last.time < COALESCE_MS) {
      last.patches = [...last.patches, ...entry.patches];
      last.inverse = [...entry.inverse, ...last.inverse];
      last.after = entry.after;
      last.time = entry.time;
      return;
    }
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
  }

  /** Étape à annuler (déplacée vers « rétablir »). */
  takeUndo(): HistoryEntry | undefined {
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
    return entry;
  }

  takeRedo(): HistoryEntry | undefined {
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
    return entry;
  }

  info(): HistoryInfo {
    return {
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      undoLabel: this.past.at(-1)?.label ?? null,
      redoLabel: this.future.at(-1)?.label ?? null,
      depth: this.past.length,
    };
  }
}
