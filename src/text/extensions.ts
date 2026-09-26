// Extensions Tiptap de l'éditeur de texte sur place (tâches 2.6, 2.15) : un schéma réduit au modèle
// (paragraphes, retours à la ligne, fine insécable, marques = champs d'un segment), le collage nettoyé
// et la typographie française à la saisie.
import { Extension, Mark, Node, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Fragment, type Mark as PmMark, type Node as PmNode, type ParseRule, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { CSSProperties } from 'react';
import { listMarkers } from '../model/lists';
import type { ColorRef, LayoutDocument, ParagraphList, TextStyle } from '../model/types';
import { colorCss } from '../render/color';
import { indentCss } from '../render/textCss';
import { getPersistence } from '../store/persistence';
import { NNBSP_RENDER } from '../render/TextFrameView';
import { RUN_MARKS, type RunKey } from './richText';
import { NNBSP, typographyEdits } from './typographyFr';

// ---------------------------------------------------------------- CSS

/** `{ fontSize: '7pt' }` → `font-size: 7pt` (styles en ligne produits par renderHTML). */
export function cssText(props: CSSProperties): string {
  return Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${String(v)}`)
    .join('; ');
}

// ---------------------------------------------------------------- contexte

export interface TextEditContext {
  /** Document courant (nuancier) et style du bloc en cours d'édition. */
  getDoc(): Pick<LayoutDocument, 'swatches' | 'styles'> | null;
  getBlockStyle(): TextStyle | null;
  /** Fin de l'édition (Échap). */
  onExit(): void;
}

// ---------------------------------------------------------------- marques (un champ de segment chacune)

interface RunMarkSpec {
  key: RunKey;
  css(value: unknown, ctx: TextEditContext): CSSProperties;
  /** Règles d'analyse supplémentaires : ce que le collage externe a le droit d'apporter (gras, italique). */
  pasteRules?: ParseRule[];
}

const dataAttr = (key: RunKey) => `data-run-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

function runMark(spec: RunMarkSpec, ctx: TextEditContext) {
  const attr = dataAttr(spec.key);
  return Mark.create({
    name: RUN_MARKS[spec.key],
    addAttributes() {
      return { value: { default: null, rendered: false } };
    },
    parseHTML() {
      return [
        {
          tag: `span[${attr}]`,
          priority: 60,
          getAttrs: (el: HTMLElement) => {
            try {
              return { value: JSON.parse(el.getAttribute(attr) ?? 'null') };
            } catch {
              return false;
            }
          },
        },
        ...(spec.pasteRules ?? []),
      ];
    },
    renderHTML({ mark }) {
      return ['span', { [attr]: JSON.stringify(mark.attrs.value), style: cssText(spec.css(mark.attrs.value, ctx)) }, 0];
    },
  });
}

const BOLD_WORD = /^(bold|bolder|[6-9]00)$/;

function runMarks(ctx: TextEditContext) {
  return [
    runMark({ key: 'color', css: (v, c) => ({ color: colorCss(c.getDoc() ?? { swatches: [] }, v as ColorRef) }) }, ctx),
    runMark(
      {
        key: 'fontWeight',
        css: (v) => ({ fontWeight: v as number }),
        // Collage externe : seul le gras passe (Word : <b>, <strong>, font-weight ; Google Docs enveloppe
        // tout dans <b style="font-weight:normal">, qu'il faut ignorer).
        pasteRules: [
          { tag: 'strong', getAttrs: () => ({ value: 700 }) },
          { tag: 'b', getAttrs: (el: HTMLElement) => (/^(normal|[1-5]00)$/.test(el.style.fontWeight) ? false : { value: 700 }) },
          { style: 'font-weight', getAttrs: (value: string) => (BOLD_WORD.test(value.trim()) ? { value: 700 } : false) },
        ],
      },
      ctx,
    ),
    runMark(
      {
        key: 'italic',
        css: (v) => ({ fontStyle: v ? 'italic' : 'normal' }),
        pasteRules: [
          { tag: 'em', getAttrs: () => ({ value: true }) },
          { tag: 'i', getAttrs: () => ({ value: true }) },
          { style: 'font-style', getAttrs: (value: string) => (/italic|oblique/.test(value) ? { value: true } : false) },
        ],
      },
      ctx,
    ),
    runMark({ key: 'fontSize', css: (v) => ({ fontSize: `${v}pt` }) }, ctx),
    runMark({ key: 'letterSpacing', css: (v) => ({ letterSpacing: `${v}em` }) }, ctx),
    runMark({ key: 'transform', css: (v) => ({ textTransform: v as string }) }, ctx),
    runMark(
      {
        key: 'underline',
        css: (v) => ({ textDecoration: v ? 'underline' : 'none' }),
        pasteRules: [
          { tag: 'u', getAttrs: () => ({ value: true }) },
          { style: 'text-decoration', getAttrs: (value: string) => (/underline/.test(value) ? { value: true } : false) },
        ],
      },
      ctx,
    ),
    runMark({ key: 'characterStyleId', css: () => ({}) }, ctx),
  ];
}

// ---------------------------------------------------------------- nœuds

/** Fine insécable : un atome dessiné comme dans le rendu (U+2009 entre deux gluons U+2060). */
export const NarrowNbsp = Node.create({
  name: 'nnbsp',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'span[data-nnbsp]' }];
  },
  renderHTML() {
    return ['span', { 'data-nnbsp': '' }, NNBSP_RENDER];
  },
  renderText() {
    return NNBSP;
  },
});

/** Variable CSS de l'espace après d'un paragraphe, lue par la règle `p:not(:last-child)` de l'éditeur (TextEditor). */
export const SPACE_AFTER_VAR = '--fl-space-after';

type AttrKind = 'number' | 'string' | 'json';

/** Surcharges de paragraphe du modèle, en attributs du nœud paragraphe (lues seulement depuis l'éditeur). */
const ParagraphAttributes = Extension.create({
  name: 'paragraphAttributes',
  addGlobalAttributes() {
    const attr = (name: string, css: (v: unknown) => CSSProperties, keepOnSplit = true, kind: AttrKind = 'number') => ({
      default: null,
      keepOnSplit,
      parseHTML: (el: HTMLElement) => {
        const raw = el.getAttribute(`data-para-${name}`);
        if (raw === null) return null;
        if (kind === 'string') return raw;
        if (kind === 'json') {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
        return Number(raw);
      },
      renderHTML: (attrs: Record<string, unknown>) => {
        const value = attrs[name];
        if (value === null || value === undefined) return {};
        const style = cssText(css(value));
        return { [`data-para-${name}`]: kind === 'json' ? JSON.stringify(value) : String(value), ...(style ? { style } : {}) };
      },
    });
    return [
      {
        types: ['paragraph'],
        attributes: {
          fontSize: attr('fontSize', (v) => ({ fontSize: `${v}pt` })),
          lineHeight: attr('lineHeight', (v) => ({ lineHeight: v as number })),
          align: attr('align', (v) => ({ textAlign: v as CSSProperties['textAlign'] }), true, 'string'),
          // Un nouveau paragraphe (Entrée) ne reprend pas l'espace avant du précédent.
          spaceBefore: attr('spaceBefore', (v) => ({ marginTop: `${v}mm` }), false),
          // L'espace après ne s'applique pas au dernier paragraphe : une variable lue par la feuille de l'éditeur.
          spaceAfter: attr('spaceAfter', (v) => ({ [SPACE_AFTER_VAR]: `${v}mm` }) as CSSProperties),
          leftIndent: attr('leftIndent', (v) => indentCss({ leftIndent: v as number })),
          firstLineIndent: attr('firstLineIndent', (v) => indentCss({ firstLineIndent: v as number })),
          // Un nouvel élément de liste (Entrée) reste dans la liste : son numéro se recalcule.
          list: attr('list', () => ({}), true, 'json'),
          paragraphStyleId: attr('paragraphStyleId', () => ({}), true, 'string'),
        },
      },
    ];
  },
});

// ---------------------------------------------------------------- puces et numéros des listes

const listMarkersKey = new PluginKey<DecorationSet>('listMarkers');

/** Puces et numéros dessinés sur les paragraphes de liste, comme au rendu (`data-list-marker`, styles/app.css). */
function markerDecorations(doc: PmNode): DecorationSet {
  const paragraphs: { pos: number; node: PmNode }[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'paragraph') paragraphs.push({ pos: offset, node });
  });
  if (!paragraphs.some((p) => p.node.attrs.list)) return DecorationSet.empty;
  const markers = listMarkers(paragraphs.map((p) => ({ list: (p.node.attrs.list as ParagraphList | null) ?? undefined })));
  const decorations: Decoration[] = [];
  paragraphs.forEach((p, i) => {
    const marker = markers[i];
    if (marker) decorations.push(Decoration.node(p.pos, p.pos + p.node.nodeSize, { 'data-list-marker': marker }));
  });
  return DecorationSet.create(doc, decorations);
}

/** Les numéros suivent chaque modification (un élément ajouté renumérote les suivants). */
export function listMarkersPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: listMarkersKey,
    state: {
      init: (_config, state) => markerDecorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? markerDecorations(tr.doc) : old),
    },
    props: {
      decorations: (state) => listMarkersKey.getState(state),
    },
  });
}

// ---------------------------------------------------------------- commandes de mise en forme

type MarkName = (typeof RUN_MARKS)[RunKey];

/** Valeur effective d'un champ sur la sélection : celle de la marque, sinon celle du bloc ; null si mélangé. */
export function effectiveValue(state: EditorState, key: RunKey, block: unknown): unknown {
  const type = state.schema.marks[RUN_MARKS[key]];
  const { from, to, empty } = state.selection;
  const valueOf = (marks: readonly PmMark[]) => marks.find((m) => m.type === type)?.attrs.value ?? block;
  if (empty) return valueOf(state.storedMarks ?? state.selection.$from.marks());
  let value: unknown = undefined;
  let mixed = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return;
    const v = JSON.stringify(valueOf(node.marks));
    if (value === undefined) value = v;
    else if (value !== v) mixed = true;
  });
  return mixed || value === undefined ? null : JSON.parse(value as string);
}

export interface RunValueChange {
  key: RunKey;
  /** null : retire la marque. */
  value: unknown;
  /** Valeur du bloc : une valeur égale ne crée pas de marque (pas d'écart inutile). Absent : toujours posée. */
  block?: unknown;
}

/** Pose des valeurs de segment sur la sélection (ou sur la saisie à venir), en une transaction. */
export function setRunValues(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, changes: RunValueChange[]): boolean {
  const { from, to, empty } = state.selection;
  const tr = state.tr;
  let stored = [...(state.storedMarks ?? state.selection.$from.marks())];
  for (const { key, value, block } of changes) {
    const type = state.schema.marks[RUN_MARKS[key] as MarkName];
    const same = block !== undefined && (JSON.stringify(value ?? null) === JSON.stringify(block ?? null) || (key === 'italic' && !!value === !!block));
    const put = !same && value !== null && value !== undefined;
    if (empty) {
      stored = stored.filter((m) => m.type !== type);
      if (put) stored = [...type.create({ value }).addToSet(stored)];
    } else {
      tr.removeMark(from, to, type);
      if (put) tr.addMark(from, to, type.create({ value }));
    }
  }
  if (empty) tr.setStoredMarks(stored);
  dispatch?.(tr);
  return true;
}

// ---------------------------------------------------------------- typographie à la saisie

export const typographyKey = new PluginKey('typographyFr');

/** Plages modifiées par des transactions, dans le document final. */
function changedRanges(transactions: readonly Transaction[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  transactions.forEach((tr, t) => {
    tr.mapping.maps.forEach((map, m) => {
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        let from = newStart;
        let to = newEnd;
        const rest = tr.mapping.slice(m + 1);
        from = rest.map(from, -1);
        to = rest.map(to, 1);
        for (const next of transactions.slice(t + 1)) {
          from = next.mapping.map(from, -1);
          to = next.mapping.map(to, 1);
        }
        ranges.push({ from, to });
      });
    });
  });
  return ranges;
}

interface CharPos {
  pos: number;
  node: PmNode;
}

/** Texte d'un paragraphe (`\n` : retour à la ligne, U+202F : fine insécable) et position de chaque caractère. */
function blockText(block: PmNode, start: number): { text: string; chars: CharPos[] } {
  let text = '';
  const chars: CharPos[] = [];
  block.forEach((node, offset) => {
    const pos = start + 1 + offset;
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) chars.push({ pos: pos + i, node });
      text += node.text;
    } else {
      chars.push({ pos, node });
      text += node.type.name === 'hardBreak' ? '\n' : node.type.name === 'nnbsp' ? NNBSP : '￼';
    }
  });
  return { text, chars };
}

function insertNodes(schema: Schema, insert: string, marks: readonly PmMark[]): PmNode[] {
  const nodes: PmNode[] = [];
  for (const piece of insert.split(/( )/)) {
    if (!piece) continue;
    nodes.push(piece === NNBSP ? schema.nodes.nnbsp.create(null, null, marks) : schema.text(piece, marks));
  }
  return nodes;
}

/**
 * Corrige la typographie autour de ce qui vient d'être tapé ou collé (quelques caractères de part et
 * d'autre), jamais le reste du bloc : entrer dans un bloc ne le réécrit pas. Une fine insécable collée
 * en caractère devient un nœud `nnbsp`. Rien n'est fait pendant une annulation (Ctrl+Z rend la saisie brute).
 */
export function typographyPlugin(): Plugin {
  return new Plugin({
    key: typographyKey,
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (transactions.some((tr) => tr.getMeta(typographyKey) || tr.getMeta('history$') || tr.getMeta('preventTypography'))) return null;
      const ranges = changedRanges(transactions);
      if (!ranges.length) return null;
      const tr = state.tr;
      const edits: { from: number; to: number; nodes: PmNode[] }[] = [];
      state.doc.descendants((block, start) => {
        if (!block.isTextblock) return true;
        const end = start + block.nodeSize;
        const touching = ranges.filter((r) => r.to >= start && r.from <= end);
        if (!touching.length) return false;
        const { text, chars } = blockText(block, start);
        const indexOf = (pos: number) => {
          const i = chars.findIndex((c) => c.pos >= pos);
          return i < 0 ? chars.length : i;
        };
        const windows = touching.map((r) => ({ from: indexOf(r.from) - 3, to: indexOf(r.to) + 3 }));
        const posOf = (i: number) => (i < chars.length ? chars[i].pos : end - 1);
        const marksAt = (i: number) => (chars[i] ?? chars[i - 1])?.node.marks ?? [];
        for (const e of typographyEdits(text)) {
          if (!windows.some((w) => e.to >= w.from && e.from <= w.to)) continue;
          const marks = e.to > e.from ? marksAt(e.from) : marksAt(e.from - 1);
          edits.push({ from: posOf(e.from), to: posOf(e.to), nodes: insertNodes(state.schema, e.insert, marks) });
        }
        chars.forEach((c, i) => {
          if (c.node.isText && text[i] === NNBSP) edits.push({ from: c.pos, to: c.pos + 1, nodes: insertNodes(state.schema, NNBSP, c.node.marks) });
        });
        return false;
      });
      if (!edits.length) return null;
      edits.sort((a, b) => b.from - a.from);
      let last = Infinity;
      for (const e of edits) {
        if (e.to > last) continue;
        tr.replaceWith(e.from, e.to, Fragment.from(e.nodes));
        last = e.from;
      }
      tr.setMeta(typographyKey, true);
      return tr;
    },
  });
}

// ---------------------------------------------------------------- assemblage

export function textEditorExtensions(ctx: TextEditContext): AnyExtension[] {
  const keymap = Extension.create({
    name: 'fluidprintKeymap',
    addKeyboardShortcuts() {
      const toggleWeight = () => {
        const block = ctx.getBlockStyle();
        const state = this.editor.state;
        const current = effectiveValue(state, 'fontWeight', block?.fontWeight ?? 400);
        const bold = typeof current === 'number' && current >= 600;
        return setRunValues(state, this.editor.view.dispatch, [{ key: 'fontWeight', value: bold ? 400 : 700, block: block?.fontWeight ?? 400 }]);
      };
      const toggleItalic = () => {
        const block = ctx.getBlockStyle();
        const state = this.editor.state;
        const current = effectiveValue(state, 'italic', !!block?.italic);
        return setRunValues(state, this.editor.view.dispatch, [{ key: 'italic', value: current !== true, block: !!block?.italic }]);
      };
      const toggleUnderline = () => {
        const state = this.editor.state;
        const current = effectiveValue(state, 'underline', false);
        return setRunValues(state, this.editor.view.dispatch, [{ key: 'underline', value: current !== true, block: false }]);
      };
      // Début / fin du bloc : Chrome ne déplace pas toujours le curseur de lui-même dans l'éditeur.
      const jump = (toEnd: boolean, extend: boolean) => {
        const { state, view } = this.editor;
        const target = toEnd ? Selection.atEnd(state.doc) : Selection.atStart(state.doc);
        const selection = extend ? TextSelection.create(state.doc, state.selection.anchor, target.head) : target;
        view.dispatch(state.tr.setSelection(selection).scrollIntoView());
        return true;
      };
      return {
        'Mod-Home': () => jump(false, false),
        'Mod-End': () => jump(true, false),
        'Shift-Mod-Home': () => jump(false, true),
        'Shift-Mod-End': () => jump(true, true),
        'Mod-b': toggleWeight,
        'Mod-i': toggleItalic,
        'Mod-u': toggleUnderline,
        Escape: () => {
          ctx.onExit();
          return true;
        },
        // Ctrl+S : le texte en cours est validé d'abord (une étape d'annulation), puis enregistré aussitôt.
        'Mod-s': () => {
          ctx.onExit();
          void getPersistence()?.saveNow();
          return true;
        },
      };
    },
    addProseMirrorPlugins() {
      return [typographyPlugin(), listMarkersPlugin()];
    },
  });

  return [
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      listItem: false,
      listKeymap: false,
      link: false,
      orderedList: false,
      strike: false,
      underline: false,
      trailingNode: false,
    }),
    ParagraphAttributes,
    NarrowNbsp,
    ...runMarks(ctx),
    keymap,
  ];
}
