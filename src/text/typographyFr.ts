// Typographie française automatique (tâche 2.15) : appliquée à la saisie (TextEditor) et à tout le
// document (« Corriger tout le document », avec aperçu).
//
// Règles :
// - espace fine insécable (U+202F) avant ; ! ? — l'espace existante est remplacée, aucune n'est ajoutée
//   (une adresse « site.fr/?q » ou « !? » ne doit pas être touchée) ;
// - espace insécable (U+00A0) avant : — même prudence (« https:// » reste intact) ;
// - espace insécable dans les durées : « 1 h 30 », « 48 h », « 10 min » ;
// - apostrophe courbe (’) ;
// - guillemets « » avec espaces insécables intérieures.
//
// Le calcul se fait sur une chaîne (le texte d'un paragraphe, `\n` = retour à la ligne forcé) et rend
// une liste de modifications, appliquées ensuite aux segments sans toucher à leur mise en forme.
import type { LayoutDocument, TextObject, TextRun } from '../model/types';

export const NBSP = ' ';
export const NNBSP = ' ';

export type TypoRule = 'apostrophe' | 'guillemets' | 'deux-points' | 'ponctuation' | 'duree';

export const TYPO_RULE_LABELS: Record<TypoRule, string> = {
  apostrophe: 'Apostrophe courbe',
  guillemets: 'Guillemets français',
  'deux-points': 'Insécable avant deux-points',
  ponctuation: 'Fine insécable avant ; ! ?',
  duree: 'Insécable dans une durée',
};

/** Remplacement de `text.slice(from, to)` par `insert` (from = to : insertion). */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  rule: TypoRule;
}

const SPACE = /[   ]/;
const OPENING_CONTEXT = /[\s([{—–/'’-]/;

/** Modifications typographiques d'un texte, triées et sans chevauchement. */
export function typographyEdits(text: string): TextEdit[] {
  const edits: TextEdit[] = [];
  const at = (i: number) => (i >= 0 && i < text.length ? text[i] : '');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") edits.push({ from: i, to: i + 1, insert: '’', rule: 'apostrophe' });
    else if (c === '"') {
      const opening = i === 0 || OPENING_CONTEXT.test(at(i - 1));
      if (opening) {
        let end = i + 1;
        while (SPACE.test(at(end))) end++;
        edits.push({ from: i, to: end, insert: `«${NBSP}`, rule: 'guillemets' });
      } else {
        let start = i;
        while (start > 0 && SPACE.test(at(start - 1))) start--;
        edits.push({ from: start, to: i + 1, insert: `${NBSP}»`, rule: 'guillemets' });
      }
    } else if (c === '«') {
      const next = at(i + 1);
      if (next === ' ' || next === NNBSP) edits.push({ from: i + 1, to: i + 2, insert: NBSP, rule: 'guillemets' });
      else if (next && next !== NBSP && next !== '\n') edits.push({ from: i + 1, to: i + 1, insert: NBSP, rule: 'guillemets' });
    } else if (c === '»') {
      const prev = at(i - 1);
      if (prev === ' ' || prev === NNBSP) edits.push({ from: i - 1, to: i, insert: NBSP, rule: 'guillemets' });
      else if (prev && prev !== NBSP && prev !== '\n') edits.push({ from: i, to: i, insert: NBSP, rule: 'guillemets' });
    } else if (c === ':') {
      const prev = at(i - 1);
      if (prev === ' ' || prev === NNBSP) edits.push({ from: i - 1, to: i, insert: NBSP, rule: 'deux-points' });
    } else if (c === ';' || c === '!' || c === '?') {
      const prev = at(i - 1);
      if (prev === ' ' || prev === NBSP) edits.push({ from: i - 1, to: i, insert: NNBSP, rule: 'ponctuation' });
    }
  }

  // Durées : « 48 h », « 10 min », puis l'espace entre « h » et les minutes de « 1 h 30 ».
  for (const m of text.matchAll(/(?<=\d) (?=(?:h|min)(?![\p{L}\p{N}]))/gu)) edits.push({ from: m.index, to: m.index + 1, insert: NBSP, rule: 'duree' });
  for (const m of text.matchAll(/(?<=\d[  ]h) (?=\d{2}(?!\d))/g)) edits.push({ from: m.index, to: m.index + 1, insert: NBSP, rule: 'duree' });

  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  const out: TextEdit[] = [];
  for (const e of edits) {
    const last = out.at(-1);
    // Deux règles sur le même caractère (espace avant « : » dans une durée…) : la première l'emporte.
    if (last && (e.from < last.to || (e.from === last.from && e.to === last.to))) continue;
    out.push(e);
  }
  return out;
}

export function applyEdits(text: string, edits: Pick<TextEdit, 'from' | 'to' | 'insert'>[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

export const fixTypography = (text: string): string => applyEdits(text, typographyEdits(text));

/**
 * Applique des modifications (positions dans le texte concaténé des segments) aux segments, en gardant
 * la mise en forme de chacun : un remplacement prend le style du segment où il commence ; une insertion
 * prend celui du caractère qui la précède.
 */
export function applyEditsToRuns(runs: TextRun[], edits: Pick<TextEdit, 'from' | 'to' | 'insert'>[]): TextRun[] {
  // Copie par JSON : les segments peuvent être des brouillons Immer.
  const out: TextRun[] = runs.map((r) => JSON.parse(JSON.stringify(r)));
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    const starts: number[] = [];
    let acc = 0;
    for (const r of out) {
      starts.push(acc);
      acc += r.text.length;
    }
    const runAt = (pos: number, preferPrevious: boolean) => {
      for (let i = out.length - 1; i >= 0; i--) {
        if (preferPrevious ? starts[i] < pos : starts[i] <= pos) return i;
      }
      return 0;
    };
    const a = runAt(e.from, e.from === e.to && e.from > 0);
    const b = e.to > e.from ? runAt(e.to - 1, false) : a;
    const head = out[a].text.slice(0, e.from - starts[a]);
    const tail = out[b].text.slice(e.to - starts[b]);
    if (a === b) out[a].text = head + e.insert + tail;
    else {
      out[a].text = head + e.insert;
      for (let i = a + 1; i < b; i++) out[i].text = '';
      out[b].text = tail;
    }
  }
  const kept = out.filter((r) => r.text !== '');
  return kept.length ? kept : [out[0] ?? { text: '' }];
}

export const runsText = (runs: TextRun[]): string => runs.map((r) => r.text).join('');

// ---------------------------------------------------------------- tout le document

export interface TypographyChange {
  objId: string;
  paragraph: number;
  rule: TypoRule;
  /** Extrait avant / après, quelques caractères autour de la correction. */
  before: string;
  after: string;
}

const CONTEXT = 14;

/** Corrections proposées pour un bloc (aperçu). */
export function textTypographyChanges(obj: TextObject): TypographyChange[] {
  const changes: TypographyChange[] = [];
  obj.paragraphs.forEach((para, p) => {
    const text = runsText(para.runs);
    for (const e of typographyEdits(text)) {
      const start = Math.max(0, e.from - CONTEXT);
      const end = Math.min(text.length, e.to + CONTEXT);
      changes.push({
        objId: obj.id,
        paragraph: p,
        rule: e.rule,
        before: text.slice(start, end),
        after: text.slice(start, e.from) + e.insert + text.slice(e.to, end),
      });
    }
  });
  return changes;
}

/** Toutes les corrections du document, bloc par bloc, dans l'ordre des faces. */
export function documentTypographyChanges(doc: LayoutDocument): TypographyChange[] {
  const out: TypographyChange[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const obj = doc.objects[id];
    if (!obj || seen.has(id)) return;
    seen.add(id);
    if (obj.type === 'text') out.push(...textTypographyChanges(obj));
    else if (obj.type === 'group') obj.children.forEach(visit);
  };
  doc.pages.forEach((page) => page.children.forEach(visit));
  return out;
}

/** Corrige les blocs donnés (tous par défaut) ; renvoie le nombre de corrections. */
export function applyTypographyToDocument(doc: LayoutDocument, objIds?: string[]): number {
  let count = 0;
  const ids = objIds ?? Object.keys(doc.objects);
  for (const id of ids) {
    const obj = doc.objects[id];
    if (obj?.type !== 'text') continue;
    for (const para of obj.paragraphs) {
      const edits = typographyEdits(runsText(para.runs));
      if (!edits.length) continue;
      count += edits.length;
      para.runs = applyEditsToRuns(para.runs, edits);
    }
  }
  return count;
}
