// Panneau Nuancier (tâches 2.9 et 2.18) : les nuances du document, leur aperçu et leurs usages.
// Ajouter, renommer, modifier (tous les usages suivent : un objet ne référence qu'une nuance), supprimer
// en proposant une nuance de remplacement, pipette (API EyeDropper de Chrome, repli : saisie
// hexadécimale). Une couleur prise à la pipette entre au nuancier sous un nom « À nommer ».
// Nuancier CMJN (tâche 4.1) : saisie des encres, simulation écran par le profil, encrage total.
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Palette, Pipette, Plus, Printer, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { SwatchChip } from '../components/SwatchPicker';
import { Button } from '../components/ui/button';
import { Input, NativeSelect } from '../components/ui/input';
import { formatNumber, NumberField } from '../components/ui/number-field';
import { Tooltip } from '../components/ui/tooltip';
import { cn } from '../lib/utils';
import {
  closestSwatch,
  deleteSwatch,
  formatCmyk,
  inkCount,
  inkTotal,
  isPendingName,
  normalizeHex,
  swatchUsages,
  updateSwatch,
  type SwatchUsage,
} from '../model/swatches';
import type { Id, LayoutDocument, Swatch } from '../model/types';
import { getEditor, useEditor } from '../store/documentStore';
import { parentOf } from '../store/tree';
import { registerPanel } from '../editor/registry/api';
import { DEFAULT_MAX_INK, SMALL_TEXT_MAX_INKS, SMALL_TEXT_PT } from '../model/preflight';
import { objectLabel } from './PropertiesPanel';
import { applySwatchCmyk, convertSwatchToCmyk, referencePreset, usePresets } from './printColors';
import { createSwatch, hasEyeDropper, pickColorToSwatch, swatchUiStore, useSwatchUi } from './swatchUi';

// ---------------------------------------------------------------- composants

/** Saisie d'une couleur : hexadécimal + sélecteur natif. `onCommit` à la validation (Entrée, sortie). */
export function HexInput({ value, onCommit, onLive, name, autoFocus }: { value: string; onCommit(hex: string): void; onLive?(hex: string): void; name: string; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const hex = normalizeHex(draft);
    if (!hex) {
      setInvalid(draft.trim() !== '' && draft !== value);
      if (!draft.trim()) setDraft(value);
      return;
    }
    setInvalid(false);
    setDraft(hex);
    if (hex !== value) onCommit(hex);
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <input
        type="color"
        aria-label="Choisir la couleur"
        className="size-7 shrink-0 cursor-pointer rounded border border-neutral-300 bg-white p-0.5"
        value={normalizeHex(draft) ?? value}
        onChange={(e) => {
          setDraft(e.target.value);
          if (onLive) onLive(e.target.value);
        }}
        onBlur={commit}
      />
      <Input
        name={name}
        aria-label="Couleur hexadécimale"
        aria-invalid={invalid}
        className={cn('font-mono', invalid && 'border-amber-500')}
        value={draft}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setDraft(value);
            setInvalid(false);
          }
        }}
      />
    </div>
  );
}

function NameInput({ swatch, autoFocus }: { swatch: Swatch; autoFocus: boolean }) {
  const [draft, setDraft] = useState(swatch.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(swatch.name), [swatch.name]);
  useEffect(() => {
    if (autoFocus) ref.current?.select();
  }, [autoFocus]);
  const commit = () => {
    const name = draft.trim();
    if (!name) setDraft(swatch.name);
    else if (name !== swatch.name) getEditor().apply('Renommer la nuance', (d) => updateSwatch(d, swatch.id, { name }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') setDraft(swatch.name);
  };
  return <Input ref={ref} name="swatchName" aria-label="Nom de la nuance" value={draft} autoFocus={autoFocus} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} />;
}

function UsageList({ doc, usages }: { doc: LayoutDocument; usages: SwatchUsage[] }) {
  // Un objet peut utiliser la nuance plusieurs fois (fond et filet, plusieurs segments) : une ligne par objet.
  const byObject = new Map<string, string[]>();
  const styles: string[] = [];
  for (const u of usages) {
    if (u.objectId) {
      if (!byObject.has(u.objectId)) byObject.set(u.objectId, []);
      const roles = byObject.get(u.objectId)!;
      if (!roles.includes(u.role)) roles.push(u.role);
    } else styles.push(u.path);
  }
  if (!byObject.size && !styles.length) return <p className="text-[12px] text-neutral-400">Nuance inutilisée.</p>;
  const entries = [...byObject.entries()];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-neutral-500">
          {entries.length} objet{entries.length > 1 ? 's' : ''}
          {styles.length ? ` · ${styles.length} style${styles.length > 1 ? 's' : ''}` : ''}
        </span>
        {entries.length > 0 && (
          <button
            type="button"
            className="text-[11px] text-sky-700 hover:underline"
            data-action="select-swatch-usages"
            onClick={() => selectObjects(doc, entries.map(([id]) => id))}
          >
            Tout sélectionner
          </button>
        )}
      </div>
      <ul className="max-h-40 overflow-y-auto rounded border border-neutral-200" data-swatch-usages>
        {entries.slice(0, 200).map(([id, roles]) => {
          const obj = doc.objects[id];
          if (!obj) return null;
          return (
            <li key={id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2 py-0.5 text-left text-[12px] hover:bg-neutral-100"
                data-usage-object={id}
                onClick={() => selectObjects(doc, [id])}
              >
                <span className="min-w-0 flex-1 truncate">{objectLabel(obj)}</span>
                <span className="shrink-0 text-[11px] text-neutral-400">{roles.join(', ')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Sélectionne des objets depuis le panneau (au niveau du premier objet : les autres doivent partager son parent). */
function selectObjects(doc: LayoutDocument, ids: Id[]) {
  const s = getEditor();
  // Une sélection vit au niveau d'un même parent : on garde les objets qui partagent celui du premier.
  const first = ids[0];
  if (!first) return;
  const parent = parentOf(doc, first);
  const same = ids.filter((id) => parentOf(doc, id) === parent);
  s.select(same);
  s.centerOn(same);
}

function DeleteBox({ doc, swatch, used, onDone }: { doc: LayoutDocument; swatch: Swatch; used: number; onDone(): void }) {
  const [replacement, setReplacement] = useState(() => closestSwatch(doc, swatch.rgb, swatch.id)?.id ?? '');
  if (!used) {
    return (
      <Button
        variant="outline"
        size="sm"
        data-action="delete-swatch"
        onClick={() => {
          getEditor().apply(`Supprimer la nuance « ${swatch.name} »`, (d) => deleteSwatch(d, swatch.id));
          onDone();
        }}
      >
        <Trash2 />
        Supprimer
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-red-200 bg-red-50/60 p-2" data-swatch-delete>
      <p className="text-[12px] text-red-900">
        Nuance utilisée {used} fois. Ses usages passeront sur :
      </p>
      <NativeSelect name="replacementSwatch" aria-label="Nuance de remplacement" value={replacement} onChange={(e) => setReplacement(e.target.value)}>
        {doc.swatches
          .filter((s) => s.id !== swatch.id)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.rgb})
            </option>
          ))}
      </NativeSelect>
      <Button
        variant="destructive"
        size="sm"
        data-action="confirm-delete-swatch"
        disabled={!replacement}
        onClick={() => {
          const target = doc.swatches.find((s) => s.id === replacement);
          getEditor().apply(`Supprimer « ${swatch.name} » (remplacée par « ${target?.name} »)`, (d) => deleteSwatch(d, swatch.id, replacement));
          onDone();
        }}
      >
        <Trash2 />
        Supprimer et remplacer
      </Button>
    </div>
  );
}

const INKS = [
  { key: 0, prefix: 'C', label: 'Cyan', name: 'swatchC' },
  { key: 1, prefix: 'M', label: 'Magenta', name: 'swatchM' },
  { key: 2, prefix: 'J', label: 'Jaune', name: 'swatchY' },
  { key: 3, prefix: 'N', label: 'Noir', name: 'swatchK' },
] as const;

/**
 * Couleur d'une nuance (tâche 4.1, décision P1) : saisie des encres C, M, J, N ; l'écran affiche leur
 * simulation par le profil de sortie, calculée par le serveur. Encrage total et alerte au-delà du
 * maximum du préréglage imprimeur. Une nuance encore en RVB (pipette, champ couleur) se convertit d'un clic.
 */
function SwatchColorEditor({ swatch }: { swatch: Swatch }) {
  const presets = usePresets();
  const reference = referencePreset(presets);
  const maxInk = reference?.maxInk ?? DEFAULT_MAX_INK;
  const profile = reference?.profile ? (presets?.profiles[reference.profile]?.label ?? reference.profile) : 'profil de sortie';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<number[] | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    task()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (!swatch.cmyk) {
    return (
      <div className="flex flex-col gap-2" data-swatch-color={swatch.id}>
        <HexInput
          name="swatchHex"
          value={swatch.rgb}
          onLive={(hex) => getEditor().apply('Modifier la nuance', (d) => updateSwatch(d, swatch.id, { rgb: hex }), { coalesce: `swatch-rgb:${swatch.id}` })}
          onCommit={(hex) => getEditor().apply('Modifier la nuance', (d) => updateSwatch(d, swatch.id, { rgb: hex }), { coalesce: `swatch-rgb:${swatch.id}` })}
        />
        <p className="text-[12px] text-neutral-600">
          Nuance en RVB : à l’export imprimeur, elle sera convertie d’office par le profil. Définissez-la en encres pour savoir ce qui sera imprimé.
        </p>
        <div>
          <Button variant="outline" size="sm" disabled={busy} data-action="convert-swatch-cmyk" onClick={() => run(() => convertSwatchToCmyk(swatch.id))}>
            {busy ? <Loader2 className="animate-spin" /> : <Printer />}
            Convertir en CMJN
          </Button>
        </div>
        {error && <p className="text-[12px] text-red-700">{error}</p>}
      </div>
    );
  }

  const cmyk = swatch.cmyk;
  const total = inkTotal(cmyk);
  const commitInk = (index: number, value: number) => {
    // Saisies enchaînées (Tab, Entrée) plus vite que la réponse du serveur : chacune part des encres déjà
    // demandées, et les conversions s'appliquent dans l'ordre.
    const base = pending.current ?? cmyk;
    const next = [...base];
    next[index] = value;
    if (next.every((v, i) => v === base[i])) return;
    pending.current = next;
    const previous = chain.current;
    run(async () => {
      chain.current = previous.catch(() => undefined).then(() => applySwatchCmyk(swatch.id, next)).finally(() => {
        if (pending.current === next) pending.current = null;
      });
      await chain.current;
    });
  };
  return (
    <div className="flex flex-col gap-2" data-swatch-color={swatch.id} data-swatch-cmyk={cmyk.join(',')}>
      <div className="grid grid-cols-4 gap-1">
        {INKS.map((ink) => (
          <NumberField
            key={ink.key}
            name={ink.name}
            prefix={ink.prefix}
            ariaLabel={`${ink.label} (%)`}
            value={cmyk[ink.key]}
            decimals={1}
            min={0}
            max={100}
            onCommit={(v) => commitInk(ink.key, v)}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] text-neutral-500">
        <span data-swatch-ink={total}>
          Encrage : <span className={cn('font-medium tabular-nums', total > maxInk ? 'text-red-700' : 'text-neutral-800')}>{formatNumber(total, 1)} %</span>
        </span>
        <span className="flex items-center gap-1" title={`Simulation à l’écran (${profile})`}>
          {busy && <Loader2 className="size-3 animate-spin" />}
          écran <span className="font-mono">{swatch.rgb}</span>
        </span>
      </div>
      {total > maxInk && (
        <p role="alert" data-swatch-ink-warning className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[12px] text-red-900">
          Encrage de {formatNumber(total, 1)} % au-delà des {maxInk} % admis par le préréglage imprimeur : l’encre risque de maculer. Réduisez C, M ou J.
        </p>
      )}
      <details className="text-[12px] text-neutral-600">
        <summary className="cursor-pointer select-none text-[11px] text-neutral-500">Partir d’une couleur RVB…</summary>
        <div className="mt-1.5 flex flex-col gap-1">
          <HexInput name="swatchHex" value={swatch.sourceRgb ?? swatch.rgb} onCommit={(hex) => run(() => convertSwatchToCmyk(swatch.id, hex))} />
          <span className="text-[11px] text-neutral-500">
            Convertie en encres par {profile}{swatch.sourceRgb ? ` · couleur du design : ${swatch.sourceRgb}` : ''}
          </span>
        </div>
      </details>
      {error && <p className="text-[12px] text-red-700">{error}</p>}
    </div>
  );
}

/**
 * Nuance d'accent : sous 9 pt, deux encres au plus, sauf pour les intertitres
 * et libellés colorés et les teintes claires sur fond foncé, déclarés ici. Sans cette case, le contrôle en
 * amont et l'export imprimeur refusent un petit texte à trois ou quatre encres.
 */
function SmallTextException({ swatch }: { swatch: Swatch }) {
  if (!swatch.cmyk || inkCount(swatch.cmyk) <= SMALL_TEXT_MAX_INKS) return null;
  return (
    <label className="flex items-start gap-2 text-[12px] text-neutral-700" data-swatch-small-text-exception>
      <input
        type="checkbox"
        name="smallTextException"
        className="mt-0.5"
        checked={!!swatch.smallTextException}
        onChange={(e) =>
          getEditor().apply(e.target.checked ? 'Nuance d’accent en petit texte' : 'Nuance retirée des accents', (d) =>
            updateSwatch(d, swatch.id, { smallTextException: e.target.checked ? true : undefined }),
          )
        }
      />
      <span>
        Nuance d’accent : admise en texte de moins de {SMALL_TEXT_PT} pt malgré ses {inkCount(swatch.cmyk)} encres
        <span className="block text-[11px] text-neutral-500">Intertitres et libellés colorés, texte clair sur fond foncé. Sinon : deux encres au plus.</span>
      </span>
    </label>
  );
}

function SwatchRow({ doc, swatch, usages }: { doc: LayoutDocument; swatch: Swatch; usages: SwatchUsage[] }) {
  const openId = useSwatchUi((s) => s.openId);
  const focusName = useSwatchUi((s) => s.focusName);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const open = openId === swatch.id;
  const pending = isPendingName(swatch.name);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) rowRef.current?.scrollIntoView({ block: 'nearest' });
    else setConfirmDelete(false);
  }, [open]);
  const usedObjects = new Set(usages.map((u) => u.objectId ?? u.path)).size;

  return (
    <div ref={rowRef} className={cn('border-b border-neutral-100', open && 'bg-neutral-50')} data-swatch-row={swatch.id} data-swatch-name={swatch.name}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-100"
        aria-expanded={open}
        onClick={() => swatchUiStore.getState().open(open ? null : swatch.id)}
      >
        {open ? <ChevronDown className="size-3 shrink-0 text-neutral-400" /> : <ChevronRight className="size-3 shrink-0 text-neutral-400" />}
        <SwatchChip color={swatch.rgb} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{swatch.name}</span>
        {pending && (
          <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900" data-swatch-pending>
            à nommer
          </span>
        )}
        {swatch.cmyk ? (
          <span className="font-mono text-[11px] text-neutral-400" title={`Encres ${formatCmyk(swatch.cmyk)} · écran ${swatch.rgb}`} data-swatch-total>
            {inkTotal(swatch.cmyk)} %
          </span>
        ) : (
          <span className="rounded bg-neutral-100 px-1 text-[10px] font-medium text-neutral-600" title="Nuance définie en RVB, sans encres" data-swatch-rgb-only>
            RVB
          </span>
        )}
        <span className="w-6 text-right text-[11px] tabular-nums text-neutral-400" title="Objets qui l'utilisent">
          {usedObjects || ''}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-1" data-swatch-editor={swatch.id}>
          <NameInput swatch={swatch} autoFocus={focusName} />
          <SwatchColorEditor swatch={swatch} />
          <SmallTextException swatch={swatch} />
          <UsageList doc={doc} usages={usages} />
          {confirmDelete ? (
            <DeleteBox doc={doc} swatch={swatch} used={usages.length} onDone={() => swatchUiStore.getState().open(null)} />
          ) : (
            <div>
              <Button variant="ghost" size="sm" className="text-red-700 hover:bg-red-50 hover:text-red-800" data-action="ask-delete-swatch" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                Supprimer…
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddSwatchForm({ onClose, reason }: { onClose(): void; reason: 'add' | 'no-eyedropper' }) {
  const [name, setName] = useState('');
  const [hex, setHex] = useState('#2563eb');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const rgb = normalizeHex(hex);
    if (!rgb) {
      setError('Couleur attendue au format #rrggbb.');
      return;
    }
    createSwatch(rgb, name.trim() || undefined);
    onClose();
  };
  return (
    <form
      className="flex flex-col gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-3"
      data-add-swatch-form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {reason === 'no-eyedropper' && (
        <p className="text-[12px] text-neutral-600">La pipette n’est pas disponible dans ce navigateur : saisissez la couleur en hexadécimal.</p>
      )}
      <Input name="newSwatchName" aria-label="Nom de la nouvelle nuance" placeholder="Nom (facultatif : « À nommer »)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex items-center gap-1.5">
        <input type="color" aria-label="Choisir la couleur" className="size-7 shrink-0 cursor-pointer rounded border border-neutral-300 bg-white p-0.5" value={normalizeHex(hex) ?? '#000000'} onChange={(e) => setHex(e.target.value)} />
        <Input
          name="newSwatchHex"
          aria-label="Couleur hexadécimale de la nouvelle nuance"
          className="font-mono"
          value={hex}
          autoFocus={reason === 'no-eyedropper'}
          spellCheck={false}
          onChange={(e) => {
            setHex(e.target.value);
            setError(null);
          }}
        />
      </div>
      {error && <p className="text-[12px] text-red-700">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Annuler
        </Button>
        <Button type="submit" size="sm" data-action="confirm-add-swatch">
          Ajouter
        </Button>
      </div>
    </form>
  );
}

export function SwatchesPanel() {
  const doc = useEditor((s) => s.doc);
  const [form, setForm] = useState<null | 'add' | 'no-eyedropper'>(null);
  const usages = useMemo(() => (doc ? swatchUsages(doc) : new Map<Id, SwatchUsage[]>()), [doc]);
  if (!doc) return null;
  const broken = [...usages.keys()].filter((id) => !doc.swatches.some((s) => s.id === id));

  const eyedropper = async () => {
    if (!hasEyeDropper()) {
      setForm('no-eyedropper');
      return;
    }
    await pickColorToSwatch();
  };

  return (
    <div data-swatches-panel>
      <div className="flex items-center gap-1 border-b border-neutral-200 px-3 py-2">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{doc.swatches.length} nuances</span>
        <Tooltip content="Pipette : prendre une couleur à l’écran">
          <Button variant="ghost" size="icon-sm" aria-label="Pipette" data-action="eyedropper" onClick={() => void eyedropper()}>
            <Pipette />
          </Button>
        </Tooltip>
        <Tooltip content="Nouvelle nuance">
          <Button variant="ghost" size="icon-sm" aria-label="Nouvelle nuance" data-action="add-swatch" onClick={() => setForm(form ? null : 'add')}>
            <Plus />
          </Button>
        </Tooltip>
      </div>
      {form && <AddSwatchForm reason={form} onClose={() => setForm(null)} />}
      {broken.length > 0 && (
        <p role="alert" className="m-3 flex gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[12px] text-amber-900">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Références à des nuances absentes : {broken.join(', ')}
        </p>
      )}
      <div role="list" aria-label="Nuancier">
        {doc.swatches.map((s) => (
          <SwatchRow key={s.id} doc={doc} swatch={s} usages={usages.get(s.id) ?? []} />
        ))}
      </div>
    </div>
  );
}

registerPanel({ id: 'swatches', title: 'Nuancier', icon: Palette, order: 30, component: SwatchesPanel });
