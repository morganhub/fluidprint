// Rechercher et remplacer (tâche 2.19) : Ctrl+F ouvre une barre en haut à droite du plan de travail.
// Recherche dans tous les blocs texte (jamais dans le logo ni les QR codes), occurrence par occurrence
// (le bloc est sélectionné et centré) ; remplacement un par un ou partout, en une étape d'annulation,
// sans perdre la mise en forme des segments.
import { ChevronDown, ChevronUp, Replace, ReplaceAll, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from '../components/ui/button';
import { registerOverlay, registerShortcut } from '../editor/registry/api';
import { getEditor, useEditor } from '../store/documentStore';
import { findInDocument, matchContext, replaceAll, replaceMatch, type FindOptions } from '../text/findReplace';
import { finishTextEdit, TEXT_EDIT_MODE } from '../text/TextEditor';

interface FindState extends Required<FindOptions> {
  open: boolean;
  query: string;
  replacement: string;
  index: number;
  message: string | null;
  /** Incrémenté à chaque ouverture : remet le focus dans le champ. */
  focusTick: number;
}

export const findStore = createStore<FindState>()(() => ({
  open: false,
  query: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
  index: 0,
  message: null,
  focusTick: 0,
}));

export function openFind(): void {
  if (getEditor().mode?.id === TEXT_EDIT_MODE) finishTextEdit();
  findStore.setState((s) => ({ open: true, focusTick: s.focusTick + 1 }));
}

const closeFind = () => findStore.setState({ open: false, message: null });

function FindReplaceBar() {
  const f = useStore(findStore);
  const doc = useEditor((s) => s.doc);
  const input = useRef<HTMLInputElement>(null);
  const options = { caseSensitive: f.caseSensitive, wholeWord: f.wholeWord };
  const matches = useMemo(() => (doc && f.open ? findInDocument(doc, f.query, options) : []), [doc, f.open, f.query, f.caseSensitive, f.wholeWord]);
  const index = matches.length ? Math.min(f.index, matches.length - 1) : 0;
  const current = matches[index];

  useEffect(() => {
    if (!f.open) return;
    input.current?.focus();
    input.current?.select();
  }, [f.open, f.focusTick]);

  if (!f.open || !doc) return null;

  const show = (i: number) => {
    const list = findInDocument(getEditor().doc!, findStore.getState().query, options);
    if (!list.length) return;
    const next = ((i % list.length) + list.length) % list.length;
    findStore.setState({ index: next, message: null });
    const s = getEditor();
    s.select([list[next].objId]);
    s.centerOn([list[next].objId]);
  };

  const replaceOne = () => {
    if (!current) return;
    getEditor().apply('Remplacer', (d) => void replaceMatch(d, current, f.query, f.replacement, options), { select: [current.objId] });
    // L'occurrence suivante prend la place de celle qui vient d'être remplacée.
    const left = findInDocument(getEditor().doc!, f.query, options);
    if (left.length) show(Math.min(index, left.length - 1));
    else findStore.setState({ index: 0, message: 'Plus aucune occurrence.' });
  };

  const replaceEverywhere = () => {
    const count = getEditor().apply('Tout remplacer', (d) => replaceAll(d, f.query, f.replacement, options)) ?? 0;
    findStore.setState({ index: 0, message: count ? `${count} remplacement${count > 1 ? 's' : ''}.` : 'Aucune occurrence.' });
  };

  const field = 'h-7 min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 text-[13px] focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30';
  const status = f.query ? (matches.length ? `${index + 1} sur ${matches.length}` : 'Aucun résultat') : '';
  const context = current ? matchContext(doc, current) : null;

  return (
    <div
      data-find-replace
      role="search"
      aria-label="Rechercher et remplacer"
      className="absolute right-3 top-3 z-20 flex w-[380px] flex-col gap-1.5 rounded-lg border border-neutral-200 bg-white p-2 text-[13px] shadow-lg"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeFind();
        }
      }}
    >
      <div className="flex items-center gap-1">
        <Search className="size-4 shrink-0 text-neutral-400" />
        <input
          ref={input}
          name="findQuery"
          aria-label="Rechercher"
          placeholder="Rechercher dans les textes"
          className={field}
          value={f.query}
          onChange={(e) => findStore.setState({ query: e.target.value, index: 0, message: null })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              show(e.shiftKey ? index - 1 : current && getEditor().selection.includes(current.objId) ? index + 1 : index);
            }
          }}
        />
        <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-neutral-500" data-find-status>
          {status}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Occurrence précédente" disabled={!matches.length} onClick={() => show(index - 1)}>
          <ChevronUp />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Occurrence suivante" data-action="find-next" disabled={!matches.length} onClick={() => show(current && getEditor().selection.includes(current.objId) ? index + 1 : index)}>
          <ChevronDown />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Fermer la recherche" onClick={closeFind}>
          <X />
        </Button>
      </div>
      <div className="flex items-center gap-1 pl-5">
        <input name="findReplacement" aria-label="Remplacer par" placeholder="Remplacer par" className={field} value={f.replacement} onChange={(e) => findStore.setState({ replacement: e.target.value })} />
        <Button variant="outline" size="sm" data-action="replace-one" disabled={!current} onClick={replaceOne} title="Remplacer cette occurrence">
          <Replace />
          Remplacer
        </Button>
        <Button variant="outline" size="sm" data-action="replace-all" disabled={!matches.length} onClick={replaceEverywhere} title="Remplacer partout">
          <ReplaceAll />
          Tout
        </Button>
      </div>
      <div className="flex items-center gap-3 pl-5 text-[12px] text-neutral-600">
        <label className="flex items-center gap-1">
          <input type="checkbox" name="findCase" className="size-3.5 accent-neutral-900" checked={f.caseSensitive} onChange={(e) => findStore.setState({ caseSensitive: e.target.checked, index: 0 })} />
          Respecter la casse
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="findWord" className="size-3.5 accent-neutral-900" checked={f.wholeWord} onChange={(e) => findStore.setState({ wholeWord: e.target.checked, index: 0 })} />
          Mot entier
        </label>
      </div>
      {context && (
        <p className="truncate pl-5 text-[12px] text-neutral-500" data-find-context>
          {context[0]}
          <mark className="rounded-sm bg-amber-200 px-0.5 text-neutral-900">{context[1]}</mark>
          {context[2]}
        </p>
      )}
      {f.message && (
        <p className="pl-5 text-[12px] text-neutral-700" data-find-message role="status">
          {f.message}
        </p>
      )}
    </div>
  );
}

registerOverlay({ id: 'find-replace', order: 90, space: 'viewport', component: FindReplaceBar });

registerShortcut({
  id: 'find',
  keys: 'Mod+F',
  label: 'Rechercher et remplacer',
  group: 'Édition',
  allowInInput: true,
  allowInMode: true,
  when: (s) => !!s.doc,
  run: () => openFind(),
});

// Échap ferme la barre même quand le focus l'a quittée (bouton désactivé après « Tout remplacer »).
registerShortcut({
  id: 'find-close',
  keys: 'Escape',
  label: 'Fermer la recherche',
  group: 'Édition',
  order: -10,
  hidden: true,
  allowInInput: true,
  when: () => findStore.getState().open,
  run: () => closeFind(),
});
