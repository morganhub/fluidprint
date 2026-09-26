import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';

/** Nombre au format français, sans zéros inutiles (« 52 », « 52,5 », « 0,25 »). */
export function formatNumber(value: number, decimals = 2): string {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: decimals, useGrouping: false }).format(value);
}

/** Lit une saisie française ou anglaise (« 52,5 », « 52.5 mm », « −3 ») ; null si illisible. */
export function parseNumber(text: string): number | null {
  const cleaned = text
    .replace(/[\s  ]/g, '')
    .replace(/[−–]/g, '-')
    .replace(',', '.')
    .replace(/[a-z%°‰]+$/i, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

export interface NumberFieldProps {
  /** null : valeurs différentes dans la sélection, affichées « — ». */
  value: number | null;
  onCommit(value: number): void;
  /** Préfixe court dans le champ (X, Y, L, H…), sert aussi d'étiquette accessible si `ariaLabel` manque. */
  prefix?: string;
  ariaLabel?: string;
  unit?: string;
  /** Décimales affichées (et précision de saisie). */
  decimals?: number;
  /** Pas des flèches haut / bas (Maj : × 10). */
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  name?: string;
}

/** Champ numérique d'un panneau : saisie au clavier validée par Entrée ou à la sortie, Échap annule. */
export function NumberField({ value, onCommit, prefix, ariaLabel, unit, decimals = 2, step = 1, min, max, disabled, invalid, className, name }: NumberFieldProps) {
  const shown = value === null ? '' : formatNumber(value, decimals);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const round = (v: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;

  const commit = (text: string) => {
    const parsed = parseNumber(text);
    if (parsed === null) {
      setDraft(shown);
      return;
    }
    const next = clamp(round(parsed));
    setDraft(formatNumber(next, decimals));
    if (value === null || Math.abs(next - value) > 10 ** -(decimals + 2)) onCommit(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(draft);
      input.current?.select();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(shown);
      setEditing(false);
      input.current?.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parseNumber(draft) ?? value ?? 0;
      const next = clamp(round(base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
      setDraft(formatNumber(next, decimals));
      onCommit(next);
    }
  };

  return (
    <div
      className={cn(
        'flex h-7 min-w-0 items-center rounded-md border border-neutral-300 bg-white text-[13px] focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-500/30',
        invalid && 'border-amber-500',
        disabled && 'opacity-50',
        className,
      )}
    >
      {prefix && <span className="w-5 shrink-0 select-none pl-1.5 text-[11px] font-medium text-neutral-400">{prefix}</span>}
      <input
        ref={input}
        name={name}
        aria-label={ariaLabel ?? prefix}
        inputMode="decimal"
        disabled={disabled}
        className="h-full w-full min-w-0 bg-transparent px-1.5 tabular-nums text-neutral-900 placeholder:text-neutral-500 focus:outline-none"
        value={draft}
        placeholder={value === null ? '—' : undefined}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setEditing(false);
          if (draft !== shown) commit(draft);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {unit && <span className="shrink-0 select-none pr-1.5 text-[11px] text-neutral-400">{unit}</span>}
    </div>
  );
}
