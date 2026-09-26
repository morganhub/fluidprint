import { useSyncExternalStore } from 'react';

// Registre générique : une liste de définitions identifiées, triées par `order`. Réenregistrer un même
// identifiant remplace la définition (rechargement à chaud de Vite).
export interface RegistryItem {
  id: string;
  /** Rang d'affichage ou de priorité ; à égalité, l'ordre d'enregistrement. */
  order?: number;
}

export interface Registry<T extends RegistryItem> {
  readonly kind: string;
  register(def: T): () => void;
  unregister(id: string): void;
  get(id: string): T | undefined;
  list(): readonly T[];
  subscribe(listener: () => void): () => void;
  /** Liste réactive pour un composant React. */
  use(): readonly T[];
}

export function createRegistry<T extends RegistryItem>(kind: string): Registry<T> {
  let items: T[] = [];
  let sorted: readonly T[] = [];
  const listeners = new Set<() => void>();
  const seq = new Map<string, number>();
  let counter = 0;

  const refresh = () => {
    sorted = [...items].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || seq.get(a.id)! - seq.get(b.id)!);
    listeners.forEach((l) => l());
  };

  const registry: Registry<T> = {
    kind,
    register(def) {
      if (!seq.has(def.id)) seq.set(def.id, counter++);
      items = [...items.filter((i) => i.id !== def.id), def];
      refresh();
      return () => registry.unregister(def.id);
    },
    unregister(id) {
      if (!items.some((i) => i.id === id)) return;
      items = items.filter((i) => i.id !== id);
      refresh();
    },
    get: (id) => items.find((i) => i.id === id),
    list: () => sorted,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    use() {
      return useSyncExternalStore(registry.subscribe, registry.list, registry.list);
    },
  };
  return registry;
}
