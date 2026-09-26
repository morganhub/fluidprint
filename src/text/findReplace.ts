// Rechercher et remplacer dans les blocs texte (tâche 2.19). Seuls les objets texte sont parcourus :
// le logo (objet svg) et les QR codes (adresse) ne sont jamais touchés. Un remplacement garde la mise
// en forme des segments (il prend celle du segment où commence l'occurrence).
import type { Id, LayoutDocument } from '../model/types';
import { applyEditsToRuns, runsText } from './typographyFr';

export interface FindOptions {
  /** Respecter la casse (sinon « atelier » trouve « Atelier »). */
  caseSensitive?: boolean;
  /** Mot entier seulement. */
  wholeWord?: boolean;
}

export interface TextMatch {
  objId: Id;
  paragraph: number;
  from: number;
  to: number;
}

/**
 * Forme de comparaison, de même longueur que le texte : les espaces insécables valent une espace et
 * les apostrophes droite et courbe se confondent (« l'IA » trouve « l’IA »).
 */
function fold(text: string, caseSensitive: boolean): string {
  const t = text.replace(/[  ]/g, ' ').replace(/'/g, '’');
  return caseSensitive ? t : t.toLocaleLowerCase('fr');
}

const WORD = /[\p{L}\p{N}]/u;

/** Blocs texte dans l'ordre de lecture : faces, puis ordre d'empilement, groupes compris. */
export function textObjectsInOrder(doc: LayoutDocument): Id[] {
  const out: Id[] = [];
  const seen = new Set<Id>();
  const visit = (id: Id) => {
    const obj = doc.objects[id];
    if (!obj || seen.has(id)) return;
    seen.add(id);
    if (obj.type === 'text') out.push(id);
    else if (obj.type === 'group') obj.children.forEach(visit);
  };
  doc.pages.forEach((p) => p.children.forEach(visit));
  return out;
}

function matchesIn(text: string, query: string, options: FindOptions): { from: number; to: number }[] {
  const hay = fold(text, !!options.caseSensitive);
  const needle = fold(query, !!options.caseSensitive);
  const out: { from: number; to: number }[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    const end = i + needle.length;
    if (options.wholeWord && ((i > 0 && WORD.test(text[i - 1])) || (end < text.length && WORD.test(text[end])))) continue;
    out.push({ from: i, to: end });
  }
  return out;
}

export function findInDocument(doc: LayoutDocument, query: string, options: FindOptions = {}): TextMatch[] {
  const out: TextMatch[] = [];
  for (const objId of textObjectsInOrder(doc)) {
    const obj = doc.objects[objId];
    if (obj.type !== 'text') continue;
    obj.paragraphs.forEach((para, paragraph) => {
      for (const m of matchesIn(runsText(para.runs), query, options)) out.push({ objId, paragraph, ...m });
    });
  }
  return out;
}

/** Extrait lisible autour d'une occurrence : [avant, occurrence, après]. */
export function matchContext(doc: LayoutDocument, match: TextMatch, span = 24): [string, string, string] {
  const obj = doc.objects[match.objId];
  if (obj?.type !== 'text') return ['', '', ''];
  const text = runsText(obj.paragraphs[match.paragraph]?.runs ?? []).replace(/\n/g, ' ');
  const start = Math.max(0, match.from - span);
  const end = Math.min(text.length, match.to + span);
  return [(start > 0 ? '…' : '') + text.slice(start, match.from), text.slice(match.from, match.to), text.slice(match.to, end) + (end < text.length ? '…' : '')];
}

/** Remplace une occurrence (brouillon) ; faux si le texte a changé depuis la recherche. */
export function replaceMatch(doc: LayoutDocument, match: TextMatch, query: string, replacement: string, options: FindOptions = {}): boolean {
  const obj = doc.objects[match.objId];
  const para = obj?.type === 'text' ? obj.paragraphs[match.paragraph] : undefined;
  if (!para) return false;
  const still = matchesIn(runsText(para.runs), query, options).some((m) => m.from === match.from && m.to === match.to);
  if (!still) return false;
  para.runs = applyEditsToRuns(para.runs, [{ from: match.from, to: match.to, insert: replacement }]);
  return true;
}

/** Remplace toutes les occurrences (brouillon) ; renvoie leur nombre. */
export function replaceAll(doc: LayoutDocument, query: string, replacement: string, options: FindOptions = {}): number {
  let count = 0;
  for (const objId of textObjectsInOrder(doc)) {
    const obj = doc.objects[objId];
    if (obj.type !== 'text') continue;
    for (const para of obj.paragraphs) {
      const found = matchesIn(runsText(para.runs), query, options);
      if (!found.length) continue;
      count += found.length;
      para.runs = applyEditsToRuns(
        para.runs,
        found.map((m) => ({ ...m, insert: replacement })),
      );
    }
  }
  return count;
}
