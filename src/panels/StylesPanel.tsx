// Panneau Styles (tâche 2.21) : styles de paragraphe et de caractère du document. Créer (depuis le bloc
// sélectionné), renommer, supprimer, appliquer à la sélection, et modifier : chaque réglage met à jour
// en direct tous les blocs du style, sauf leurs retouches locales (voir model/styles.ts).
import { ChevronDown, ChevronRight, Paintbrush, Pilcrow, Plus, Trash2, Type } from 'lucide-react';
import { useState } from 'react';
import { SwatchPicker } from '../components/SwatchPicker';
import { Button } from '../components/ui/button';
import { NativeSelect } from '../components/ui/input';
import { NumberField } from '../components/ui/number-field';
import { registerPanel } from '../editor/registry/api';
import { defaultTextStyle } from '../editor/tools/defaults';
import {
  applyParagraphStyle,
  createCharacterStyle,
  createParagraphStyle,
  deleteCharacterStyle,
  deleteParagraphStyle,
  paragraphStyleUsage,
  renameStyle,
  updateCharacterStyle,
  updateParagraphStyle,
  type CharacterStyleValues,
} from '../model/styles';
import type { CharacterStyle, LayoutDocument, ParagraphStyle, TextAlign, TextObject, TextStyle } from '../model/types';
import { colorCss } from '../render/color';
import { getEditor, selectedObjects, useEditor, useEditorShallow } from '../store/documentStore';
import { FONT_FAMILIES, FONT_WEIGHTS } from './properties/TextSection';

const ALIGN_LABELS: Record<TextAlign, string> = { left: 'Gauche', center: 'Centré', right: 'Droite', justify: 'Justifié' };
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function uniqueName(existing: { name: string }[], base: string): string {
  const names = new Set(existing.map((s) => s.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

function StyleName({ name, onRename }: { name: string; onRename(name: string): void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <span className="min-w-0 flex-1 truncate" title="Double-cliquer pour renommer" onDoubleClick={() => setEditing(true)}>
        {name}
      </span>
    );
  }
  return (
    <input
      autoFocus
      name="styleName"
      aria-label="Nom du style"
      defaultValue={name}
      className="h-6 min-w-0 flex-1 rounded border border-sky-500 px-1 text-[12px] focus:outline-none"
      onBlur={(e) => {
        onRename(e.target.value);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
        e.stopPropagation();
      }}
    />
  );
}

// ---------------------------------------------------------------- styles de paragraphe

function ParagraphStyleEditor({ style, doc }: { style: ParagraphStyle; doc: LayoutDocument }) {
  const s = style.style;
  const edit = (label: string, patch: Partial<TextStyle>) =>
    getEditor().apply(`Style « ${style.name} » : ${label}`, (d) => updateParagraphStyle(d, style.id, patch));
  const families = [...new Set([...FONT_FAMILIES, s.fontFamily])];
  return (
    <div className="grid grid-cols-2 gap-1.5 border-t border-neutral-100 px-2 py-2" data-style-editor={style.id}>
      <NativeSelect aria-label="Police" value={s.fontFamily} onChange={(e) => edit('police', { fontFamily: e.target.value })} className="col-span-2">
        {families.map((f) => (
          <option key={f}>{f}</option>
        ))}
      </NativeSelect>
      <NativeSelect aria-label="Graisse" value={s.fontWeight} onChange={(e) => edit('graisse', { fontWeight: Number(e.target.value) })}>
        {FONT_WEIGHTS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
        {!FONT_WEIGHTS.some((w) => w.value === s.fontWeight) && <option value={s.fontWeight}>{s.fontWeight}</option>}
      </NativeSelect>
      <NativeSelect aria-label="Casse" value={s.transform} onChange={(e) => edit('casse', { transform: e.target.value as TextStyle['transform'] })}>
        <option value="none">Casse normale</option>
        <option value="uppercase">Capitales</option>
      </NativeSelect>
      <NumberField ariaLabel="Corps (pt)" prefix="C" name="styleFontSize" unit="pt" value={s.fontSize} min={1} step={0.5} onCommit={(v) => edit('corps', { fontSize: v })} />
      <NumberField
        ariaLabel="Interlignage (pt)"
        prefix="I"
        name="styleLeading"
        unit="pt"
        value={round(s.lineHeight * s.fontSize)}
        min={0.5}
        step={0.5}
        onCommit={(v) => edit('interlignage', { lineHeight: round(v / s.fontSize, 4) })}
      />
      <NumberField
        ariaLabel="Interlettrage (millièmes de cadratin)"
        prefix="IL"
        name="styleTracking"
        unit="‰"
        value={round(s.letterSpacing * 1000, 1)}
        decimals={1}
        step={10}
        onCommit={(v) => edit('interlettrage', { letterSpacing: round(v / 1000, 4) })}
      />
      <NativeSelect aria-label="Alignement" value={s.align} onChange={(e) => edit('alignement', { align: e.target.value as TextAlign })}>
        {(Object.keys(ALIGN_LABELS) as TextAlign[]).map((a) => (
          <option key={a} value={a}>
            {ALIGN_LABELS[a]}
          </option>
        ))}
      </NativeSelect>
      <NumberField ariaLabel="Espace avant (mm)" prefix="Av" name="styleSpaceBefore" unit="mm" value={s.spaceBefore ?? 0} min={0} step={0.5} onCommit={(v) => edit('espace avant', { spaceBefore: v || undefined })} />
      <NumberField ariaLabel="Espace après (mm)" prefix="Ap" name="styleSpaceAfter" unit="mm" value={s.spaceAfter ?? 0} min={0} step={0.5} onCommit={(v) => edit('espace après', { spaceAfter: v || undefined })} />
      <div className="col-span-2">
        <SwatchPicker doc={doc} ariaLabel="Nuance du style" value={s.color} onChange={(ref) => ref && edit('nuance', { color: ref })} />
      </div>
    </div>
  );
}

function ParagraphStyleRow({ style, doc, count, selectedTexts }: { style: ParagraphStyle; doc: LayoutDocument; count: number; selectedTexts: string[] }) {
  const [open, setOpen] = useState(false);
  const s = style.style;
  const applied = selectedTexts.length > 0 && selectedTexts.every((id) => (doc.objects[id] as TextObject).paragraphStyleId === style.id);
  return (
    <li className="rounded-md border border-neutral-200" data-paragraph-style={style.id}>
      <div className="flex items-center gap-1 px-1 py-1 text-[12px]">
        <button type="button" aria-label={open ? 'Replier' : 'Modifier le style'} className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100" onClick={() => setOpen(!open)} data-action="edit-style">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <StyleName name={style.name} onRename={(name) => getEditor().apply('Renommer le style', (d) => renameStyle(d, 'paragraph', style.id, name))} />
        {style.origin === 'word' && (
          <span className="shrink-0 rounded bg-sky-100 px-1 text-[10px] font-semibold text-sky-800" data-style-origin="word" title="Créé par l’import d’un fichier Word">
            Word
          </span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-neutral-400" title={`${s.fontSize} pt, ${count} bloc(s)`}>
          {String(s.fontSize).replace('.', ',')} pt · {count}
        </span>
        {selectedTexts.length > 0 && (
          <Button
            variant={applied ? 'default' : 'ghost'}
            size="icon-sm"
            className="size-6"
            aria-label={`Appliquer « ${style.name} » à la sélection`}
            title="Appliquer à la sélection"
            data-action="apply-style"
            onClick={() => getEditor().apply('Appliquer un style de paragraphe', (d) => applyParagraphStyle(d, selectedTexts, style.id))}
          >
            <Paintbrush className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-neutral-400 hover:text-red-600"
          aria-label={`Supprimer « ${style.name} »`}
          title="Supprimer le style (les blocs gardent leur mise en forme)"
          onClick={() => getEditor().apply('Supprimer le style', (d) => deleteParagraphStyle(d, style.id))}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {open && <ParagraphStyleEditor style={style} doc={doc} />}
    </li>
  );
}

// ---------------------------------------------------------------- styles de caractère

function CharacterStyleRow({ style, doc }: { style: CharacterStyle; doc: LayoutDocument }) {
  const [open, setOpen] = useState(false);
  const edit = (label: string, patch: Partial<CharacterStyleValues>) =>
    getEditor().apply(`Style « ${style.name} » : ${label}`, (d) => updateCharacterStyle(d, style.id, patch));
  const color = colorCss(doc, style.style.color);
  return (
    <li className="rounded-md border border-neutral-200" data-character-style={style.id}>
      <div className="flex items-center gap-1 px-1 py-1 text-[12px]">
        <button type="button" aria-label={open ? 'Replier' : 'Modifier le style'} className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="size-3 shrink-0 rounded-sm border border-black/10" style={{ background: color ?? 'transparent' }} />
        <StyleName name={style.name} onRename={(name) => getEditor().apply('Renommer le style', (d) => renameStyle(d, 'character', style.id, name))} />
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-neutral-400 hover:text-red-600"
          aria-label={`Supprimer « ${style.name} »`}
          title="Supprimer le style (les segments gardent leur mise en forme)"
          onClick={() => getEditor().apply('Supprimer le style', (d) => deleteCharacterStyle(d, style.id))}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-1.5 border-t border-neutral-100 px-2 py-2">
          <SwatchPicker doc={doc} allowNone ariaLabel="Nuance du style de caractère" value={style.style.color} onChange={(ref) => edit('nuance', { color: ref })} />
          <NativeSelect aria-label="Graisse" value={style.style.fontWeight ?? ''} onChange={(e) => edit('graisse', { fontWeight: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Graisse du paragraphe</option>
            {FONT_WEIGHTS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- panneau

export function StylesPanel() {
  const doc = useEditor((s) => s.doc);
  const selectedTexts = useEditorShallow((s) => selectedObjects(s).filter((o) => o.type === 'text').map((o) => o.id));
  if (!doc) return null;
  const usage = paragraphStyleUsage(doc);

  const newParagraphStyle = () =>
    getEditor().apply(
      'Nouveau style de paragraphe',
      (d) => {
        const source = selectedTexts.map((id) => d.objects[id]).find((o): o is TextObject => o?.type === 'text');
        const created = createParagraphStyle(d, uniqueName(d.styles.paragraph, 'Nouveau style'), source ? JSON.parse(JSON.stringify(source.style)) : defaultTextStyle(d));
        // Le bloc qui a servi de modèle suit aussitôt son nouveau style.
        if (source) applyParagraphStyle(d, [source.id], created.id);
      },
    );

  const newCharacterStyle = () =>
    getEditor().apply('Nouveau style de caractère', (d) => {
      const color = d.swatches.find((sw) => /bleu/i.test(sw.name)) ?? d.swatches[0];
      createCharacterStyle(d, uniqueName(d.styles.character, 'Accent'), color ? { color: { swatch: color.id } } : { fontWeight: 700 });
    });

  return (
    <div className="flex flex-col gap-4 px-3 py-3 text-[13px]" data-styles-panel>
      <section>
        <header className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            <Pilcrow className="size-3.5" /> Styles de paragraphe
          </h3>
          <Button variant="ghost" size="sm" data-action="new-paragraph-style" onClick={newParagraphStyle} title={selectedTexts.length ? 'Nouveau style d’après le bloc sélectionné' : 'Nouveau style'}>
            <Plus />
            Nouveau
          </Button>
        </header>
        {doc.styles.paragraph.length === 0 ? (
          <p className="text-[12px] text-neutral-500">Aucun style. Sélectionnez un bloc texte puis « Nouveau » pour en créer un à partir de sa mise en forme.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {doc.styles.paragraph.map((ps) => (
              <ParagraphStyleRow key={ps.id} style={ps} doc={doc} count={usage.get(ps.id) ?? 0} selectedTexts={selectedTexts} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <header className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            <Type className="size-3.5" /> Styles de caractère
          </h3>
          <Button variant="ghost" size="sm" data-action="new-character-style" onClick={newCharacterStyle}>
            <Plus />
            Nouveau
          </Button>
        </header>
        {doc.styles.character.length === 0 ? (
          <p className="text-[12px] text-neutral-500">Aucun style de caractère. Ils s’appliquent à une partie du texte, depuis la barre d’édition du texte.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {doc.styles.character.map((cs) => (
              <CharacterStyleRow key={cs.id} style={cs} doc={doc} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

registerPanel({ id: 'styles', title: 'Styles', icon: Pilcrow, order: 40, component: StylesPanel });
