// Variante des photos affichées à l'écran : l'aperçu normal, ou son épreuve (RVB → CMJN → RVB par le profil
// de sortie, tâche 4.9, bouton « Aperçu impression »). La route d'impression n'est jamais concernée.
import type { Asset } from '../model/types';

export interface ProofVariant {
  profile: string;
  intent: string;
  maxInk?: number;
}

let proof: ProofVariant | null = null;
let key = 'normal';
const listeners = new Set<() => void>();

export function setProofVariant(next: ProofVariant | null): void {
  proof = next;
  key = next ? `proof:${next.profile}:${next.intent}:${next.maxInk ?? ''}` : 'normal';
  listeners.forEach((fn) => fn());
}

export const getProofVariant = (): ProofVariant | null => proof;

/** Clé stable de la variante courante (pour useSyncExternalStore). */
export const imageVariantKey = (): string => key;

export function subscribeImageVariant(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** URL de l'épreuve d'une photo : servie (et mise en cache) par /api/proof. */
export function proofUrl(docId: string, asset: Asset, variant: ProofVariant): string {
  const relative = asset.preview ?? asset.print ?? asset.original;
  const query = new URLSearchParams({ profile: variant.profile, intent: variant.intent, ...(variant.maxInk ? { maxInk: String(variant.maxInk) } : {}) });
  return `/api/proof/${encodeURIComponent(docId)}/${relative.split('/').map(encodeURIComponent).join('/')}?${query}`;
}
