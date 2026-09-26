// Conversion entre le modèle (paragraphes et segments) et le document Tiptap (JSON ProseMirror).
//
// Correspondance :
// - un `Paragraph` = un nœud `paragraph` ; ses surcharges (corps, interlignage, alignement, espace
//   avant) sont des attributs du nœud ;
// - un segment = du texte portant une marque par champ défini (nuance, graisse, italique, corps,
//   interlettrage, casse, style de caractère) : couper, fusionner ou retaper un segment garde ses champs,
//   donc « pour vous. » reste bleu ;
// - `\n` dans un segment = nœud `hardBreak` (Maj+Entrée) ;
// - U+202F (fine insécable) = nœud `nnbsp` : Open Sans n'a pas ce glyphe, il est dessiné comme le rendu
//   (voir TextFrameView), sinon la ligne changerait de largeur en entrant en édition.
import type { ColorRef, Paragraph, TextAlign, TextRun, TextTransform } from '../model/types';
import { NNBSP } from './typographyFr';

export interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: JsonMark[];
  text?: string;
}

/** Champ d'un segment → nom de la marque Tiptap (attribut unique `value`). */
export const RUN_MARKS = {
  color: 'runColor',
  fontWeight: 'runWeight',
  italic: 'runItalic',
  fontSize: 'runSize',
  letterSpacing: 'runTracking',
  transform: 'runCase',
  characterStyleId: 'charStyle',
} as const satisfies Record<Exclude<keyof TextRun, 'text'>, string>;

export type RunKey = keyof typeof RUN_MARKS;
const RUN_KEYS = Object.keys(RUN_MARKS) as RunKey[];
const MARK_TO_KEY = Object.fromEntries(RUN_KEYS.map((k) => [RUN_MARKS[k], k])) as Record<string, RunKey>;

/** Attributs de paragraphe conservés par l'éditeur. */
export const PARAGRAPH_ATTRS = ['fontSize', 'lineHeight', 'align', 'spaceBefore'] as const;

type RunAttrs = Omit<TextRun, 'text'>;

function runMarks(run: RunAttrs): JsonMark[] {
  const marks: JsonMark[] = [];
  for (const key of RUN_KEYS) {
    const value = run[key];
    if (value !== undefined) marks.push({ type: RUN_MARKS[key], attrs: { value: structuredClone(value) } });
  }
  return marks;
}

function withMarks(node: JsonNode, marks: JsonMark[]): JsonNode {
  return marks.length ? { ...node, marks } : node;
}

/** Paragraphes du modèle → document Tiptap. */
export function paragraphsToDoc(paragraphs: Paragraph[]): JsonNode {
  return {
    type: 'doc',
    content: paragraphs.map((para) => {
      const attrs: Record<string, unknown> = {};
      for (const key of PARAGRAPH_ATTRS) attrs[key] = para[key] ?? null;
      const content: JsonNode[] = [];
      for (const run of para.runs) {
        const { text, ...rest } = run;
        const marks = runMarks(rest);
        for (const piece of text.split(/(\n| )/)) {
          if (piece === '') continue;
          if (piece === '\n') content.push(withMarks({ type: 'hardBreak' }, marks));
          else if (piece === NNBSP) content.push(withMarks({ type: 'nnbsp' }, marks));
          else content.push(withMarks({ type: 'text', text: piece }, marks));
        }
      }
      return { type: 'paragraph', attrs, ...(content.length ? { content } : {}) };
    }),
  };
}

function marksToRun(marks: JsonMark[] | undefined): RunAttrs {
  const run: Record<string, unknown> = {};
  for (const mark of marks ?? []) {
    const key = MARK_TO_KEY[mark.type];
    if (key && mark.attrs?.value !== undefined && mark.attrs.value !== null) run[key] = mark.attrs.value;
  }
  return run as RunAttrs;
}

const sameAttrs = (a: RunAttrs, b: RunAttrs) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** Segments fusionnés quand leur mise en forme est identique ; segments vides retirés. */
export function normalizeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    if (run.text === '') continue;
    const { text, ...attrs } = run;
    const last = out.at(-1);
    if (last) {
      const { text: lastText, ...lastAttrs } = last;
      if (sameAttrs(attrs, lastAttrs)) {
        out[out.length - 1] = { ...last, text: lastText + text };
        continue;
      }
    }
    out.push(structuredClone(run));
  }
  return out;
}

/** Document Tiptap → paragraphes du modèle. */
export function docToParagraphs(doc: JsonNode): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const block of doc.content ?? []) {
    if (block.type !== 'paragraph') continue;
    const runs: TextRun[] = [];
    for (const node of block.content ?? []) {
      const attrs = marksToRun(node.marks);
      const text = node.type === 'text' ? (node.text ?? '') : node.type === 'hardBreak' ? '\n' : node.type === 'nnbsp' ? NNBSP : '';
      if (!text) continue;
      const last = runs.at(-1);
      // Un retour à la ligne sans marque suit le segment qui le précède (pas de segment coupé pour rien).
      if (last && node.type === 'hardBreak' && !node.marks?.length) last.text += text;
      else runs.push({ text, ...attrs });
    }
    const para: Paragraph = { runs: normalizeRuns(runs) };
    for (const key of PARAGRAPH_ATTRS) {
      const value = block.attrs?.[key];
      if (value !== null && value !== undefined) (para as unknown as Record<string, unknown>)[key] = value;
    }
    paragraphs.push(para);
  }
  return paragraphs.length ? paragraphs : [{ runs: [] }];
}

/** Paragraphes équivalents (mêmes textes, mêmes mises en forme), segments normalisés. */
export function sameParagraphs(a: Paragraph[], b: Paragraph[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((pa, i) => {
    const pb = b[i];
    if (PARAGRAPH_ATTRS.some((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]))) return false;
    const ra = normalizeRuns(pa.runs);
    const rb = normalizeRuns(pb.runs);
    return ra.length === rb.length && ra.every((r, j) => r.text === rb[j].text && sameAttrs({ ...r, text: undefined } as RunAttrs, { ...rb[j], text: undefined } as RunAttrs));
  });
}

// Types utiles aux marques et aux attributs (TextEditor).
export type { ColorRef, TextAlign, TextTransform };
