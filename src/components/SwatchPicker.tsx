import { Check, Pipette, Plus } from 'lucide-react';
import { useState } from 'react';
import { normalizeHex } from '../model/swatches';
import type { ColorRef, LayoutDocument } from '../model/types';
import { colorCss } from '../render/color';
import { cn } from '../lib/utils';
import { createSwatch, hasEyeDropper, pickColorToSwatch } from '../panels/swatchUi';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/** Pastille de couleur d'une nuance (damier gris si aucune). */
export function SwatchChip({ color, className }: { color: string | undefined; className?: string }) {
  return (
    <span
      className={cn('inline-block size-4 shrink-0 rounded-[3px] border border-black/15', className)}
      style={color ? { background: color } : { background: 'repeating-conic-gradient(#e5e5e5 0% 25%, #fff 0% 50%) 50% / 6px 6px' }}
    />
  );
}

export interface SwatchPickerProps {
  doc: LayoutDocument;
  /** `'mixed'` : valeurs différentes dans la sélection. */
  value: ColorRef | undefined | 'mixed';
  onChange(value: ColorRef | undefined): void;
  /** Propose « Aucun » (remplissage ou filet facultatif). */
  allowNone?: boolean;
  ariaLabel: string;
}

/**
 * Choix d'une nuance : le nuancier d'abord, puis, en pied de liste, une nouvelle nuance (saisie
 * hexadécimale ou pipette) qui entre au nuancier avant d'être appliquée. Le document n'a jamais de
 * couleur en dur (décision P1).
 */
export function SwatchPicker({ doc, value, onChange, allowNone, ariaLabel }: SwatchPickerProps) {
  const [open, setOpen] = useState(false);
  const current = value === 'mixed' || !value ? undefined : doc.swatches.find((s) => s.id === value.swatch);
  const label = value === 'mixed' ? '—' : value ? (current?.name ?? 'Nuance inconnue') : 'Aucun';
  const tint = value !== 'mixed' && value?.tint !== undefined && value.tint < 1 ? ` ${Math.round(value.tint * 100)} %` : '';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md border border-neutral-300 bg-white px-2 text-left text-[13px] hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
      >
        <SwatchChip color={value === 'mixed' ? '#ffffff' : colorCss(doc, value ?? undefined)} />
        <span className="truncate">
          {label}
          {tint}
        </span>
      </PopoverTrigger>
      <PopoverContent className="max-h-80 w-60 overflow-y-auto p-1" data-swatch-list>
        {allowNone && (
          <SwatchOption selected={value !== 'mixed' && !value} onSelect={() => (onChange(undefined), setOpen(false))} name="Aucun" />
        )}
        {doc.swatches.map((s) => (
          <SwatchOption
            key={s.id}
            color={s.rgb}
            name={s.name}
            selected={value !== 'mixed' && value?.swatch === s.id}
            onSelect={() => {
              onChange({ swatch: s.id });
              setOpen(false);
            }}
          />
        ))}
        <NewSwatchFooter
          onCreated={(id) => {
            onChange({ swatch: id });
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function SwatchOption({ color, name, selected, onSelect }: { color?: string; name: string; selected: boolean; onSelect(): void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-neutral-100"
      onClick={onSelect}
    >
      <SwatchChip color={color} />
      <span className="flex-1 truncate">{name}</span>
      {selected && <Check className="size-3.5 text-neutral-600" />}
    </button>
  );
}

/** Pied de la liste : nouvelle nuance depuis un code hexadécimal ou la pipette. */
function NewSwatchFooter({ onCreated }: { onCreated(id: string): void }) {
  const [editing, setEditing] = useState(false);
  const [hex, setHex] = useState('');
  const valid = normalizeHex(hex);
  if (!editing) {
    return (
      <div className="mt-1 flex items-center gap-1 border-t border-neutral-100 pt-1">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-neutral-600 hover:bg-neutral-100"
          data-action="picker-new-swatch"
          onClick={() => setEditing(true)}
        >
          <Plus className="size-3.5" />
          Nouvelle nuance…
        </button>
        {hasEyeDropper() && (
          <button
            type="button"
            aria-label="Pipette"
            title="Pipette : prendre une couleur à l’écran"
            className="rounded p-1 text-neutral-600 hover:bg-neutral-100"
            onClick={async () => {
              const id = await pickColorToSwatch();
              if (id) onCreated(id);
            }}
          >
            <Pipette className="size-3.5" />
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="mt-1 flex items-center gap-1 border-t border-neutral-100 px-1 pt-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const id = createSwatch(valid);
        if (id) onCreated(id);
      }}
    >
      <SwatchChip color={valid ?? undefined} />
      <input
        name="pickerNewSwatchHex"
        aria-label="Couleur hexadécimale de la nouvelle nuance"
        placeholder="#rrggbb"
        autoFocus
        spellCheck={false}
        className="h-7 min-w-0 flex-1 rounded-md border border-neutral-300 px-2 font-mono text-[12px] focus:border-sky-500 focus:outline-none"
        value={hex}
        onChange={(e) => setHex(e.target.value)}
      />
      <button type="submit" disabled={!valid} className="h-7 rounded-md bg-neutral-900 px-2 text-[12px] text-white disabled:opacity-40">
        Ajouter
      </button>
    </form>
  );
}
