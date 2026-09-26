// Édition du texte sur place (tâches 2.6, 2.15, 2.16).
//
// Double-clic sur un bloc texte : un éditeur Tiptap prend sa place, dans la face, à la même position et
// avec la même mise en forme que TextFrameView (la ligne ne saute pas en entrant en édition). Le bloc
// d'origine est masqué le temps de l'édition.
// - Toute l'édition est UN geste du store (beginGesture … commitGesture) : chaque frappe met le
//   document à jour (aperçu, hauteur auto, texte en excès), une seule étape d'annulation à la sortie.
//   Le geste est « autosave » : l'aperçu est enregistré 2 s après la dernière frappe (fermer l'onglet en
//   pleine saisie ne perd rien), sans toucher à l'historique.
// - Sortie : Échap, bouton « Terminé », ou clic hors du bloc et de sa barre.
// - spellcheck et lang="fr" ne sont posés QUE sur ce bloc en édition : le rendu et l'export n'en ont pas.
import { EditorContent, useEditor as useTiptap, useEditorState, type Editor } from '@tiptap/react';
import { Bold, Check, Italic } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { SwatchChip } from '../components/SwatchPicker';
import { Button } from '../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { registerInteraction, registerOverlay, registerTool, toolRegistry, type PageOverlayProps } from '../editor/registry/api';
import { pageBoxToScreen } from '../editor/layout';
import { findCharacterStyle } from '../model/styles';
import type { ColorRef, Id, LayoutDocument, TextObject } from '../model/types';
import { boxStyle } from '../render/box';
import { colorCss } from '../render/color';
import { measureTextContentMm } from '../render/textMetrics';
import { textBlockCss } from '../render/TextFrameView';
import { wrapFloatCss } from '../render/textCss';
import { chainFrames, chainHead } from '../model/threading';
import { wrapIndex } from '../model/wrap';
import { getEditor, useEditor, useEditorShallow } from '../store/documentStore';
import { isSelectable, objectBounds, pageIdOf } from '../store/tree';
import { effectiveValue, setRunValues, textEditorExtensions, type RunValueChange, type TextEditContext } from './extensions';
import { setTextHeight } from './autoHeight';
import { docToParagraphs, paragraphsToDoc, sameParagraphs } from './richText';

export const TEXT_EDIT_MODE = 'text-edit';

export interface TextEditOptions {
  /** Point client où placer le curseur (double-clic). */
  caret?: { x: number; y: number };
  /** Tout sélectionner (texte neuf). */
  selectAll?: boolean;
}

// ---------------------------------------------------------------- session courante

interface TextEditSession {
  objId: Id;
  editor: Editor;
  finish(): void;
}

export const textEditStore = createStore<{ session: TextEditSession | null }>()(() => ({ session: null }));
const useSession = () => useStore(textEditStore, (s) => s.session);

/** Ouvre l'édition d'un bloc texte ; renvoie faux si ce n'est pas possible (verrouillé, autre mode…). */
export function startTextEdit(objId: Id, options: TextEditOptions = {}): boolean {
  let s = getEditor();
  if (s.mode?.id === TEXT_EDIT_MODE) {
    finishTextEdit();
    s = getEditor();
  }
  const doc = s.doc;
  // Texte chaîné (4.12) : l'article se modifie dans son premier bloc, d'où qu'on ait double-cliqué.
  if (doc?.objects[objId]?.type === 'text') objId = chainHead(doc, objId);
  if (!doc || s.mode || s.gesture || doc.objects[objId]?.type !== 'text' || !isSelectable(doc, objId)) return false;
  s.select([objId]);
  s.beginGesture('Modifier le texte', { autosave: true });
  s.setMode({ id: TEXT_EDIT_MODE, target: objId, data: options });
  return true;
}

/** Termine l'édition en cours (le texte est validé, une étape d'annulation). */
export function finishTextEdit(): void {
  textEditStore.getState().session?.finish();
}

// ---------------------------------------------------------------- bloc en édition

/** Le collage ne garde que texte, gras et italique : les marques n'acceptent rien d'autre d'un HTML externe. */
const transformPastedHTML = (html: string) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '');

function TextEditorBox({ obj, doc, zoom, options }: { obj: TextObject; doc: LayoutDocument; zoom: number; options: TextEditOptions }) {
  const id = obj.id;
  const objRef = useRef(obj);
  objRef.current = obj;
  const docRef = useRef(doc);
  docRef.current = doc;
  // Texte au début de l'édition : revenir au texte d'origine ne laisse aucune modification.
  const original = useRef(obj.paragraphs);
  const baseH = useRef(obj.h);
  const wrapper = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const finished = useRef(false);
  const finishRef = useRef<() => void>(() => {});
  const editorRef = useRef<Editor | null>(null);

  const ctx = useMemo<TextEditContext>(
    () => ({ getDoc: () => docRef.current, getBlockStyle: () => objRef.current.style, onExit: () => finishRef.current() }),
    [],
  );
  const extensions = useMemo(() => textEditorExtensions(ctx), [ctx]);

  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || finished.current) return;
    const paragraphs = docToParagraphs(editor.getJSON() as never);
    const changed = !sameParagraphs(paragraphs, original.current);
    let height: number | null = null;
    const pm = wrapper.current?.querySelector<HTMLElement>('.ProseMirror');
    if (objRef.current.autoHeight && wrapper.current && pm) height = measureTextContentMm(wrapper.current, pm, objRef.current.w);
    getEditor().previewGesture((d) => {
      const t = d.objects[id];
      if (t?.type !== 'text') return;
      if (changed) t.paragraphs = paragraphs;
      if (height !== null && Math.abs(height - baseH.current) > 0.005) setTextHeight(d, id, height);
    });
  };

  const editor = useTiptap(
    {
      extensions,
      content: paragraphsToDoc(obj.paragraphs),
      injectCSS: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { spellcheck: 'true', lang: 'fr', 'data-text-editor': id, class: 'fl-text-edit' },
        transformPastedHTML,
      },
      onUpdate: () => {
        if (!frame.current) frame.current = requestAnimationFrame(flush);
      },
    },
    [],
  );
  editorRef.current = editor;

  finishRef.current = () => {
    if (finished.current) return;
    flush();
    finished.current = true;
    const s = getEditor();
    if (s.gesture) s.commitGesture({ select: [id] });
    if (s.mode?.id === TEXT_EDIT_MODE) s.setMode(null);
    if (textEditStore.getState().session?.objId === id) textEditStore.setState({ session: null });
  };

  // Session (barre flottante), curseur au point double-cliqué, sortie par clic extérieur.
  useEffect(() => {
    if (!editor) return;
    finished.current = false;
    textEditStore.setState({ session: { objId: id, editor, finish: () => finishRef.current() } });
    const raf = requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      const hit = options.caret ? editor.view.posAtCoords({ left: options.caret.x, top: options.caret.y }) : null;
      if (options.selectAll) editor.commands.selectAll();
      else editor.commands.setTextSelection(hit ? hit.pos : editor.state.doc.content.size);
      // Focus synchrone : celui de Tiptap attend une image et pourrait écraser un déplacement du curseur.
      editor.view.focus();
    });
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(`[data-text-edit-root="${CSS.escape(id)}"], [data-text-toolbar], [data-radix-popper-content-wrapper]`)) return;
      finishRef.current();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [editor, id]);

  // Démontage : si le mode a changé ailleurs (document rechargé…), le geste est validé tel quel. Un
  // démontage alors que le mode vise toujours ce bloc est le double montage de StrictMode : on ne fait rien.
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      const s = getEditor();
      if (s.mode?.id === TEXT_EDIT_MODE && s.mode.target === id) return;
      if (!finished.current) {
        finished.current = true;
        if (s.gesture) s.commitGesture({ select: [id] });
      }
      if (textEditStore.getState().session?.objId === id) textEditStore.setState({ session: null });
    },
    [id],
  );

  const s = obj.style;
  // Habillage (4.13) : les mêmes flottants que le rendu, pour que les lignes ne bougent pas en édition.
  const floats = wrapIndex(doc, false).get(id) ?? null;
  const style: CSSProperties = {
    ...boxStyle(obj),
    ...textBlockCss(floats ? { style: obj.style, verticalAlign: 'top' } : obj, doc),
    pointerEvents: 'auto',
    userSelect: 'text',
    cursor: 'text',
    outline: `${1.5 / zoom}px solid rgba(14, 165, 233, 0.9)`,
    outlineOffset: `${2 / zoom}px`,
  };
  const scope = `[data-text-editor="${CSS.escape(id)}"]`;
  const css = [
    // Le bloc rendu est masqué (il garde sa place et reste mesurable) ; seul l'éditeur se voit. Un article
    // chaîné s'édite en entier dans son premier bloc : les blocs suivants sont masqués eux aussi.
    ...chainFrames(doc, id).map((f) => `[data-page-id] [data-obj-id="${CSS.escape(f)}"] { visibility: hidden !important; }`),
    // pre-wrap : exigé par ProseMirror ; coupures identiques au rendu (les espaces de fin de ligne pendent).
    `${scope} { white-space: pre-wrap; overflow-wrap: normal; line-break: auto; outline: none; ${obj.verticalAlign && obj.verticalAlign !== 'top' ? '' : 'min-height: 100%;'} }`,
    `${scope} p { margin: 0; }`,
    s.spaceBefore !== undefined ? `${scope} p + p { margin-top: ${s.spaceBefore}mm; }` : '',
    s.spaceAfter !== undefined ? `${scope} p:not(:last-child) { margin-bottom: ${s.spaceAfter}mm; }` : '',
    `${scope} [data-nnbsp] { white-space: normal; }`,
  ].join('\n');

  return (
    <div ref={wrapper} data-text-edit-root={id} style={style} onPointerDown={(e) => e.stopPropagation()}>
      <style>{css}</style>
      {[floats?.left, floats?.right].map((f) => f && <div key={f.side} data-wrap-float={f.side} style={wrapFloatCss(f)} />)}
      <EditorContent editor={editor} style={obj.verticalAlign && obj.verticalAlign !== 'top' ? undefined : { height: '100%' }} />
    </div>
  );
}

/** Surcouche « page » : l'éditeur du bloc en cours d'édition, dans sa face. */
function TextEditOverlay({ doc, page, zoom }: PageOverlayProps) {
  const mode = useEditor((s) => s.mode);
  if (mode?.id !== TEXT_EDIT_MODE || !mode.target) return null;
  const obj = doc.objects[mode.target];
  if (obj?.type !== 'text' || pageIdOf(doc, obj.id) !== page.id) return null;
  return <TextEditorBox key={obj.id} obj={obj} doc={doc} zoom={zoom} options={(mode.data as TextEditOptions) ?? {}} />;
}

// ---------------------------------------------------------------- barre flottante

function ToolbarSwatches({ doc, value, onPick }: { doc: LayoutDocument; value: ColorRef | null; onPick(ref: ColorRef): void }) {
  const [open, setOpen] = useState(false);
  const current = value ? doc.swatches.find((sw) => sw.id === value.swatch) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Nuance du texte"
        title="Nuance du texte"
        data-action="text-color"
        className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] hover:bg-neutral-100"
        onMouseDown={(e) => e.preventDefault()}
      >
        <SwatchChip color={value ? colorCss(doc, value) : '#ffffff'} />
        <span className="max-w-24 truncate">{value ? (current?.name ?? '?') : '—'}</span>
      </PopoverTrigger>
      <PopoverContent data-text-toolbar className="max-h-72 w-56 overflow-y-auto p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
        {doc.swatches.map((sw) => (
          <button
            key={sw.id}
            type="button"
            data-swatch-option={sw.id}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-neutral-100"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onPick({ swatch: sw.id });
              setOpen(false);
            }}
          >
            <SwatchChip color={sw.rgb} />
            <span className="flex-1 truncate">{sw.name}</span>
            {value?.swatch === sw.id && <Check className="size-3.5" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function TextEditToolbar() {
  const session = useSession();
  const { doc, zoom, view, mode } = useEditorShallow((s) => ({ doc: s.doc, zoom: s.zoom, view: s.view, mode: s.mode }));
  const editor = session?.editor ?? null;
  const obj = doc && mode?.id === TEXT_EDIT_MODE && mode.target ? doc.objects[mode.target] : undefined;
  const block = obj?.type === 'text' ? obj.style : null;
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed || !block) return null;
      const weight = effectiveValue(ed.state, 'fontWeight', block.fontWeight);
      return {
        bold: typeof weight === 'number' && weight >= 600,
        italic: effectiveValue(ed.state, 'italic', !!block.italic) === true,
        color: effectiveValue(ed.state, 'color', block.color) as ColorRef | null,
        charStyle: effectiveValue(ed.state, 'characterStyleId', null) as string | null,
      };
    },
  });
  if (!doc || !editor || !obj || obj.type !== 'text' || !block || !state || editor.isDestroyed) return null;
  const pageId = pageIdOf(doc, obj.id);
  if (!pageId) return null;
  const box = pageBoxToScreen(doc, pageId, objectBounds(obj), zoom, view);

  const apply = (changes: RunValueChange[]) => {
    setRunValues(editor.state, editor.view.dispatch, changes);
    editor.commands.focus();
  };
  const applyCharStyle = (styleId: string) => {
    const cs = findCharacterStyle(doc, styleId || undefined);
    const changes: RunValueChange[] = [{ key: 'characterStyleId', value: cs?.id ?? null }];
    if (cs) for (const [key, value] of Object.entries(cs.style)) changes.push({ key: key as RunValueChange['key'], value });
    apply(changes);
  };

  return (
    <div
      data-text-toolbar
      role="toolbar"
      aria-label="Mise en forme du texte"
      className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-neutral-200 bg-white p-1 shadow-md"
      style={{ left: Math.max(4, box.x), top: Math.max(4, box.y - 44) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Button
        variant="toggle"
        size="icon-sm"
        aria-label="Gras (Ctrl+B)"
        title="Gras (Ctrl+B)"
        data-action="text-bold"
        aria-pressed={state.bold}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => apply([{ key: 'fontWeight', value: state.bold ? 400 : 700, block: block.fontWeight }])}
      >
        <Bold />
      </Button>
      <Button
        variant="toggle"
        size="icon-sm"
        aria-label="Italique (Ctrl+I)"
        title="Italique (Ctrl+I)"
        data-action="text-italic"
        aria-pressed={state.italic}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => apply([{ key: 'italic', value: !state.italic, block: !!block.italic }])}
      >
        <Italic />
      </Button>
      <span className="mx-1 h-5 w-px bg-neutral-200" />
      <ToolbarSwatches doc={doc} value={state.color} onPick={(ref) => apply([{ key: 'color', value: ref, block: block.color }])} />
      <span className="mx-1 h-5 w-px bg-neutral-200" />
      <select
        aria-label="Style de caractère"
        data-action="text-char-style"
        className="h-7 max-w-36 rounded-md border border-neutral-300 bg-white px-1 text-[12px]"
        value={state.charStyle ?? ''}
        onChange={(e) => applyCharStyle(e.target.value)}
      >
        <option value="">Aucun style de caractère</option>
        {doc.styles.character.map((cs) => (
          <option key={cs.id} value={cs.id}>
            {cs.name}
          </option>
        ))}
      </select>
      <span className="mx-1 h-5 w-px bg-neutral-200" />
      <Button variant="ghost" size="sm" data-action="text-done" onMouseDown={(e) => e.preventDefault()} onClick={() => finishTextEdit()}>
        <Check />
        Terminé
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- branchements

registerOverlay({ id: 'text-editor', order: 50, space: 'page', component: TextEditOverlay });
registerOverlay({ id: 'text-editor-toolbar', order: 50, space: 'viewport', component: TextEditToolbar });

registerInteraction({
  id: 'text-edit',
  order: 10,
  onDoubleClick: ({ state, objectId, deepId, event }) => {
    // Un texte dans un groupe non « entré » : le premier double-clic entre dans le groupe (décision S2),
    // le suivant, sur le texte désormais au niveau courant, l'édite.
    if (objectId !== deepId || state.doc?.objects[deepId]?.type !== 'text') return false;
    return startTextEdit(deepId, { caret: { x: event.clientX, y: event.clientY } });
  },
});

// Un texte créé par l'outil Texte s'ouvre aussitôt en édition, tout sélectionné.
const textTool = toolRegistry.get('text');
if (textTool?.create && !(textTool as { editsAfterCreate?: boolean }).editsAfterCreate) {
  const create = textTool.create;
  registerTool({
    ...textTool,
    editsAfterCreate: true,
    create: (ctx) => {
      const ids = create(ctx);
      if (ids?.length) requestAnimationFrame(() => startTextEdit(ids[0], { selectAll: true }));
      return ids;
    },
  } as typeof textTool);
}
