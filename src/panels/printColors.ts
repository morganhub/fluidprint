// Couleurs d'impression côté éditeur (tâche 4.1) : conversions par le serveur (profil de sortie, Pillow),
// préréglages d'export, et actions du nuancier CMJN. Une conversion prend un aller-retour serveur : le
// document n'est modifié qu'une fois le RVB d'affichage connu, en une étape d'annulation.
import { useEffect, useState } from 'react';
import { normalizeCmyk, setSwatchCmyk, type Cmyk } from '../model/swatches';
import type { Id } from '../model/types';
import { getEditor } from '../store/documentStore';

export interface PresetSummary {
  id: string;
  label: string;
  description: string;
  colorMode: 'cmyk' | 'rgb';
  standard: string | null;
  profile: string | null;
  imageIntent?: string;
  bleed: number;
  cropMarks: boolean;
  marksMargin?: number;
  maxInk?: number;
  refusePlaceholders?: boolean;
  downsamplePpi?: number;
  /** Préréglages CMJN : seules les photos affichées au-delà sont ramenées à `downsamplePpi`. */
  downsampleAbovePpi?: number;
  maxBytes?: number;
  pngPpi?: number;
}

export interface PresetsResponse {
  defaultPreset: string;
  profiles: Record<string, { label: string; outputConditionIdentifier: string; outputCondition: string }>;
  presets: Record<string, PresetSummary>;
}

let presetsPromise: Promise<PresetsResponse> | null = null;

export function fetchPresets(): Promise<PresetsResponse> {
  presetsPromise ??= fetch('/api/print/presets').then(async (res) => {
    if (!res.ok) {
      presetsPromise = null;
      throw new Error(`Préréglages illisibles (${res.status})`);
    }
    return (await res.json()) as PresetsResponse;
  });
  return presetsPromise;
}

/** Préréglages d'export (null tant qu'ils chargent). */
export function usePresets(): PresetsResponse | null {
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  useEffect(() => {
    let alive = true;
    fetchPresets().then(
      (p) => alive && setPresets(p),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return presets;
}

/** Préréglage de référence de l'écran : l'imprimeur par défaut (profil, encrage maximal). */
export function referencePreset(presets: PresetsResponse | null): PresetSummary | null {
  if (!presets) return null;
  return presets.presets[presets.defaultPreset] ?? Object.values(presets.presets).find((p) => p.colorMode === 'cmyk') ?? null;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Erreur ${res.status}`);
  return json as T;
}

/** RVB affiché (simulation du profil de sortie) de couleurs CMJN. */
export async function simulateCmyk(values: Cmyk[]): Promise<string[]> {
  return (await post<{ values: string[] }>('/api/color/cmyk-to-rgb', { values })).values;
}

/** CMJN de couleurs `#rrggbb` (colorimétrie relative, point noir compensé, encrage plafonné). */
export async function convertRgb(values: string[]): Promise<Cmyk[]> {
  return (await post<{ values: Cmyk[] }>('/api/color/rgb-to-cmyk', { values })).values;
}

/** Nouvelles encres d'une nuance : le RVB affiché suit (simulation), en une étape d'annulation. */
export async function applySwatchCmyk(id: Id, cmyk: readonly number[], label = 'Modifier la nuance'): Promise<void> {
  const values = normalizeCmyk(cmyk);
  if (!values) throw new Error('Valeurs CMJN invalides');
  const [rgb] = await simulateCmyk([values]);
  getEditor().apply(label, (d) => setSwatchCmyk(d, id, values, rgb), { coalesce: `swatch-cmyk:${id}` });
}

/** Définit une nuance RVB en encres : sa couleur est convertie par le profil, puis gardée comme couleur d'origine. */
export async function convertSwatchToCmyk(id: Id, fromRgb?: string): Promise<void> {
  const swatch = getEditor().doc?.swatches.find((s) => s.id === id);
  if (!swatch) return;
  const source = fromRgb ?? swatch.sourceRgb ?? swatch.rgb;
  const [cmyk] = await convertRgb([source]);
  const [rgb] = await simulateCmyk([cmyk]);
  getEditor().apply(fromRgb ? 'Modifier la nuance' : 'Convertir la nuance en CMJN', (d) => setSwatchCmyk(d, id, cmyk, rgb, { sourceRgb: source }), {
    coalesce: `swatch-cmyk:${id}`,
  });
}
