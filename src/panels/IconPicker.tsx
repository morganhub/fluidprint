// Bibliothèque d'icônes Lucide (tâche 2.14) : recherche (nom anglais, mots-clés Lucide et français),
// aperçu, insertion (options de l'outil Icône) ou remplacement de l'icône sélectionnée (section « Icône »
// du panneau Propriétés). Une icône remplacée garde sa taille, sa position, sa nuance et son épaisseur :
// seuls son dessin et son nom changent.
import { Replace, Search, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { NumberField } from '../components/ui/number-field';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import type { IconObject, Id } from '../model/types';
import { registerPropertySection, registerTool, type PropertySectionProps } from '../editor/registry/api';
import { createOnPage } from '../editor/tools/builtinTools';
import { DEFAULT_ICON, DEFAULT_SIZES, makeIcon } from '../editor/tools/defaults';
import { getEditor } from '../store/documentStore';
import { common, Field, Section } from './properties/common';
import { iconSvg, loadIconLibrary, searchIcons, type IconLibrary } from './iconLibrary';

export interface PickedIcon {
  name: string;
  svg: string;
}

/** Remplace le dessin d'icônes existantes : boîte, nuance et épaisseur de trait inchangées. */
export function replaceIcons(ids: Id[], icon: PickedIcon): void {
  getEditor().update<IconObject>(
    ids,
    (obj) => {
      if (obj.type !== 'icon') return;
      // Un nom donné à la main est gardé ; le nom automatique suit l'icône.
      if (!obj.name || obj.name === `Icône · ${obj.iconName}`) obj.name = `Icône · ${icon.name}`;
      obj.iconName = icon.name;
      obj.svg = icon.svg;
    },
    ids.length > 1 ? 'Remplacer les icônes' : 'Remplacer l’icône',
  );
}

function useIconLibrary(): IconLibrary | null {
  const [library, setLibrary] = useState<IconLibrary | null>(null);
  useEffect(() => {
    let alive = true;
    void loadIconLibrary().then((lib) => alive && setLibrary(lib));
    return () => {
      alive = false;
    };
  }, []);
  return library;
}

/** Aperçu d'une icône (trait courant, viewBox Lucide). */
export function IconPreview({ svg, className }: { svg: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('size-5', className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Recherche et grille d'icônes ; `onPick` reçoit le nom Lucide et le contenu SVG. */
export function IconPicker({ onPick, current, autoFocus = true }: { onPick(icon: PickedIcon): void; current?: string | null; autoFocus?: boolean }) {
  const library = useIconLibrary();
  const [query, setQuery] = useState('');
  const results = useMemo(() => (library ? searchIcons(library, query, 160) : []), [library, query]);
  return (
    <div className="flex w-72 flex-col gap-2" data-icon-picker>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-neutral-400" />
        <Input
          name="iconSearch"
          aria-label="Rechercher une icône"
          placeholder="Rechercher (maison, calendrier, formation…)"
          className="pl-7"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* Hauteur fixe : la bulle garde sa place pendant le chargement et d'une recherche à l'autre. */}
      {!library ? (
        <p className="flex h-[17.5rem] items-center justify-center text-[12px] text-neutral-500">Chargement de la bibliothèque…</p>
      ) : results.length === 0 ? (
        <p className="flex h-[17.5rem] items-center justify-center text-[12px] text-neutral-500">Aucune icône pour « {query} ».</p>
      ) : (
        <div className="flex h-[17.5rem] flex-col gap-1">
          <p className="text-[11px] text-neutral-500">{query.trim() ? `${results.length} icône${results.length > 1 ? 's' : ''}` : 'Icônes courantes'}</p>
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-8 gap-0.5 overflow-y-auto" role="listbox" aria-label="Icônes">
            {results.map((name) => {
              const svg = iconSvg(library.nodes[name]);
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={current === name}
                  aria-label={name}
                  title={name}
                  data-icon-name={name}
                  className={cn('flex size-8 items-center justify-center rounded text-neutral-700 hover:bg-neutral-100', current === name && 'bg-sky-100 text-sky-900')}
                  onClick={() => onPick({ name, svg })}
                >
                  <IconPreview svg={svg} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- section « Icône » (remplacer)

function IconSection({ objects }: PropertySectionProps) {
  const icons = objects as IconObject[];
  const ids = icons.map((o) => o.id);
  const name = common(icons, (o) => (o as IconObject).iconName);
  const svg = common(icons, (o) => (o as IconObject).svg);
  const strokeWidth = common(icons, (o) => (o as IconObject).strokeWidth);
  const [open, setOpen] = useState(false);
  return (
    <Section title="Icône" testId="icon">
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded border border-neutral-200 text-neutral-700">
          {svg ? <IconPreview svg={svg} /> : '—'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-600" data-icon-current>
          {name ?? '— (icônes différentes)'}
        </span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" data-action="replace-icon">
              <Replace />
              Remplacer…
            </Button>
          </PopoverTrigger>
          <PopoverContent side="left" align="start" collisionPadding={8} className="p-3">
            <IconPicker
              current={name}
              onPick={(icon) => {
                replaceIcons(ids, icon);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      <Field label="Trait">
        <NumberField
          ariaLabel="Épaisseur du trait de l’icône"
          name="iconStrokeWidth"
          value={strokeWidth}
          min={0.25}
          max={4}
          step={0.25}
          onCommit={(v) => getEditor().update<IconObject>(ids, { strokeWidth: v }, 'Épaisseur de l’icône')}
        />
      </Field>
    </Section>
  );
}

registerPropertySection({ id: 'icon', title: 'Icône', order: 45, appliesTo: (objects) => objects.every((o) => o.type === 'icon'), component: IconSection });

// ---------------------------------------------------------------- outil Icône : icône à insérer

export const iconToolStore = createStore<{ icon: PickedIcon; set(icon: PickedIcon): void }>()((set) => ({
  icon: { name: DEFAULT_ICON.name, svg: DEFAULT_ICON.svg },
  set: (icon) => set({ icon }),
}));

function IconToolOptions() {
  const current = useStore(iconToolStore, (s) => s.icon);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-neutral-600">
        Icône à poser : <span className="font-medium text-neutral-900">{current.name}</span> — cliquez sur la page (ou tracez un cadre).
      </p>
      <IconPicker current={current.name} autoFocus={false} onPick={(icon) => iconToolStore.getState().set(icon)} />
    </div>
  );
}

// Remplace l'outil Icône de base (même identifiant) : il pose l'icône choisie dans la bibliothèque.
registerTool({
  id: 'icon',
  label: 'Icône',
  icon: Star,
  order: 70,
  shortcut: 'K',
  cursor: 'crosshair',
  sticky: false,
  options: IconToolOptions,
  create: (ctx) => {
    const icon = iconToolStore.getState().icon;
    const size = DEFAULT_SIZES.icon;
    const box = ctx.isClick ? { x: ctx.box.x, y: ctx.box.y, w: size.w, h: size.w } : ctx.box;
    return createOnPage(ctx, 'Ajouter une icône', (d, o) => makeIcon(d, o, icon), box);
  },
});
