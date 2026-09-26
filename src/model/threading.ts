// Texte chaîné (tâche 4.12) : un bloc texte continue dans un autre (`TextObject.nextId`).
//
// Le texte de toute la chaîne (l'« article », comme dans InDesign) est porté par le PREMIER bloc : ses
// paragraphes et sa mise en forme. Les blocs suivants ne gardent que leur boîte ; leurs propres
// paragraphes sont ignorés tant qu'ils sont chaînés. Où le texte passe d'un bloc au suivant ne se décide
// qu'au rendu, mesuré par le navigateur (render/textChains.ts) : ce module ne fait que la structure.
import type { DocObject, Id, LayoutDocument, Paragraph, TextObject, TextRun } from './types';

// ---------------------------------------------------------------- lecture de la chaîne

// Index « bloc → bloc précédent », recalculé quand la table des objets change (documents immuables).
const prevCache = new WeakMap<object, Map<Id, Id>>();

export function chainPrevMap(doc: Pick<LayoutDocument, 'objects'>): Map<Id, Id> {
  const frozen = Object.isFrozen(doc.objects);
  let map = frozen ? prevCache.get(doc.objects) : undefined;
  if (map) return map;
  map = new Map();
  for (const obj of Object.values(doc.objects)) {
    if (obj.type === 'text' && obj.nextId && doc.objects[obj.nextId]?.type === 'text' && !map.has(obj.nextId)) map.set(obj.nextId, obj.id);
  }
  if (frozen) prevCache.set(doc.objects, map);
  return map;
}

export function chainPrev(doc: Pick<LayoutDocument, 'objects'>, id: Id): Id | null {
  return chainPrevMap(doc).get(id) ?? null;
}

/** Premier bloc de la chaîne qui contient `id` (lui-même s'il n'est pas chaîné). */
export function chainHead(doc: Pick<LayoutDocument, 'objects'>, id: Id): Id {
  const prev = chainPrevMap(doc);
  const seen = new Set<Id>([id]);
  let cur = id;
  for (let p = prev.get(cur); p && !seen.has(p); p = prev.get(cur)) {
    seen.add(p);
    cur = p;
  }
  return cur;
}

/** Blocs de la chaîne qui contient `id`, du premier au dernier ; un bloc seul donne [id]. */
export function chainFrames(doc: Pick<LayoutDocument, 'objects'>, id: Id): Id[] {
  const head = chainHead(doc, id);
  const out: Id[] = [];
  const seen = new Set<Id>();
  for (let cur: Id | undefined = head; cur && !seen.has(cur); ) {
    const obj: DocObject | undefined = doc.objects[cur];
    if (obj?.type !== 'text') break;
    seen.add(cur);
    out.push(cur);
    cur = obj.nextId;
  }
  return out;
}

/** Vrai si le bloc appartient à une chaîne d'au moins deux blocs. */
export function isChained(doc: Pick<LayoutDocument, 'objects'>, id: Id): boolean {
  const obj = doc.objects[id];
  return obj?.type === 'text' && (!!(obj.nextId && doc.objects[obj.nextId]?.type === 'text') || chainPrevMap(doc).has(id));
}

// ---------------------------------------------------------------- positions dans le texte

/** Position dans un article : paragraphe, puis caractère dans le texte du paragraphe (segments mis bout à bout). */
export interface StoryPos {
  p: number;
  offset: number;
}

export const paragraphText = (para: Paragraph): string => para.runs.map((r) => r.text).join('');

export const comparePos = (a: StoryPos, b: StoryPos): number => a.p - b.p || a.offset - b.offset;

/** Fin de l'article. */
export function storyEnd(paras: Paragraph[]): StoryPos {
  const p = Math.max(0, paras.length - 1);
  return { p, offset: paras[p] ? paragraphText(paras[p]).length : 0 };
}

/**
 * Coupures possibles entre deux blocs, dans l'ordre : début de chaque paragraphe, après une suite
 * d'espaces ou de tabulations, après un retour à la ligne forcé et après un trait d'union ou une barre
 * oblique (là où le navigateur peut lui aussi passer à la ligne). Les insécables (U+00A0, U+202F) ne sont
 * jamais des coupures.
 */
export function breakPositions(paras: Paragraph[]): StoryPos[] {
  const out: StoryPos[] = [];
  paras.forEach((para, p) => {
    out.push({ p, offset: 0 });
    const text = paragraphText(para);
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];
      if ((c === ' ' || c === '\n' || c === '\t') && next !== ' ' && next !== '\n' && next !== '\t' && next !== undefined) out.push({ p, offset: i + 1 });
      else if ((c === '-' || c === '/') && next !== undefined && /[\p{L}\p{N}]/u.test(next) && i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1])) out.push({ p, offset: i + 1 });
    }
  });
  out.push(storyEnd(paras));
  return out;
}

/** Segments d'un paragraphe entre deux positions de caractère (fin exclue). */
function sliceRuns(runs: TextRun[], from: number, to: number): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const run of runs) {
    const start = at;
    const end = at + run.text.length;
    at = end;
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (b > a || (run.text === '' && start >= from && start < to)) out.push({ ...run, text: run.text.slice(a - start, b - start) });
  }
  return out;
}

/**
 * Morceau d'article entre deux positions (fin exclue ; null = jusqu'au bout). Un paragraphe coupé en
 * tête garde sa mise en forme mais perd son espace avant (c'est la suite d'un paragraphe, ou le haut
 * d'un bloc) ; la suite d'un paragraphe coupé perd aussi sa puce et son retrait de première ligne (sa
 * première ligne n'est pas celle du paragraphe). Un paragraphe coupé en fin est marqué `continues`
 * (dernière ligne justifiée comme les autres).
 */
export interface StorySlice {
  paragraphs: Paragraph[];
  /** Vrai si le dernier paragraphe continue dans le bloc suivant. */
  continues: boolean;
  /** Rang, dans l'article, du premier paragraphe du morceau (numéros des listes). */
  first: number;
}

export function sliceStory(paras: Paragraph[], from: StoryPos, to: StoryPos | null): StorySlice {
  const end = to ?? storyEnd(paras);
  const out: Paragraph[] = [];
  let continues = false;
  for (let p = from.p; p <= end.p && p < paras.length; p++) {
    const para = paras[p];
    const len = paragraphText(para).length;
    const a = p === from.p ? from.offset : 0;
    const b = p === end.p ? end.offset : len;
    // Une coupure pile au début d'un paragraphe : il part entier dans le bloc suivant.
    if (p === end.p && to && b === 0) break;
    const runs = a === 0 && b === len ? para.runs.map((r) => ({ ...r })) : sliceRuns(para.runs, a, b);
    const piece: Paragraph = { ...para, runs: runs.length ? runs : [{ text: '' }] };
    if (out.length === 0) delete piece.spaceBefore;
    if (a > 0) {
      delete piece.list;
      delete piece.firstLineIndent;
    }
    out.push(piece);
    if (p === end.p && to && b < len) continues = true;
  }
  return { paragraphs: out, continues, first: from.p };
}

// ---------------------------------------------------------------- modifications (sur un brouillon)

export type LinkRefusal = 'not-text' | 'same' | 'has-prev' | 'cycle';

/** Pourquoi `fromId` ne peut pas se chaîner à `toId` (null si c'est possible). */
export function linkRefusal(doc: LayoutDocument, fromId: Id, toId: Id): LinkRefusal | null {
  const from = doc.objects[fromId];
  const to = doc.objects[toId];
  if (from?.type !== 'text' || to?.type !== 'text') return 'not-text';
  if (fromId === toId) return 'same';
  if (chainPrev(doc, toId) && chainPrev(doc, toId) !== fromId) return 'has-prev';
  if (chainFrames(doc, toId).includes(fromId)) return 'cycle';
  return null;
}

export const LINK_REFUSAL_MESSAGES: Record<LinkRefusal, string> = {
  'not-text': 'Seuls deux blocs texte peuvent être chaînés.',
  same: 'Un bloc ne peut pas se chaîner à lui-même.',
  'has-prev': 'Ce bloc suit déjà un autre bloc : rompre d’abord ce chaînage.',
  cycle: 'Ce chaînage ferait une boucle.',
};

const hasText = (paras: Paragraph[]) => paras.some((p) => p.runs.some((r) => r.text !== ''));
const emptyParagraphs = (): Paragraph[] => [{ runs: [{ text: '' }] }];

/**
 * Chaîne `fromId` à `toId` : le texte en excès de `fromId` continuera dans `toId`. Le texte que portait
 * `toId` (s'il était le premier de sa propre chaîne) s'ajoute à la fin de l'article, comme dans InDesign.
 * Un bloc qui suivait déjà `fromId` est remplacé (la suite de l'ancienne chaîne est rattachée derrière `toId`).
 */
export function linkFrames(doc: LayoutDocument, fromId: Id, toId: Id): void {
  const refusal = linkRefusal(doc, fromId, toId);
  if (refusal) throw new Error(LINK_REFUSAL_MESSAGES[refusal]);
  const from = doc.objects[fromId] as TextObject;
  const to = doc.objects[toId] as TextObject;
  const head = doc.objects[chainHead(doc, fromId)] as TextObject;
  if (!chainPrev(doc, toId) && hasText(to.paragraphs)) {
    head.paragraphs = hasText(head.paragraphs) ? [...head.paragraphs, ...to.paragraphs] : to.paragraphs;
  }
  // Une chaîne existante derrière `fromId` passe derrière le dernier bloc de la chaîne de `toId`.
  const oldNext = from.nextId && from.nextId !== toId ? from.nextId : undefined;
  const toTail = chainFrames(doc, toId).at(-1)!;
  from.nextId = toId;
  if (oldNext && toTail !== oldNext) (doc.objects[toTail] as TextObject).nextId = oldNext;
  for (const id of chainFrames(doc, fromId).slice(1)) (doc.objects[id] as TextObject).paragraphs = emptyParagraphs();
}

/** Rompt le chaînage APRÈS `id` : le texte reste dans l'article, les blocs qui suivaient se vident. */
export function unlinkAfter(doc: LayoutDocument, id: Id): void {
  const obj = doc.objects[id];
  if (obj?.type !== 'text' || !obj.nextId) return;
  const all = chainFrames(doc, id);
  const rest = all.slice(all.indexOf(id) + 1);
  delete obj.nextId;
  for (const r of rest) {
    const t = doc.objects[r] as TextObject;
    t.paragraphs = emptyParagraphs();
  }
}

/** Sort un bloc de sa chaîne : ses voisins se rejoignent (le texte reste dans l'article). */
export function removeFromChain(doc: LayoutDocument, id: Id): void {
  detachChains(doc, new Set([id]));
  const obj = doc.objects[id];
  if (obj?.type === 'text') obj.paragraphs = emptyParagraphs();
}

/**
 * Avant de supprimer des objets : chaque bloc supprimé quitte sa chaîne. Son prédécesseur est relié au
 * bloc suivant encore présent ; un premier bloc supprimé transmet l'article (texte et mise en forme) au
 * premier bloc qui reste. Appelé par `removeObjects` (store/commands.ts).
 */
export function detachChains(doc: LayoutDocument, doomed: Set<Id>): void {
  for (const id of doomed) {
    const obj = doc.objects[id];
    if (obj?.type !== 'text' || !isChained(doc, id)) continue;
    const frames = chainFrames(doc, id);
    const survivors = frames.filter((f) => !doomed.has(f));
    if (frames[0] === id && survivors.length) {
      const heir = doc.objects[survivors[0]] as TextObject;
      heir.paragraphs = obj.paragraphs;
      heir.style = obj.style;
      if (obj.paragraphStyleId) heir.paragraphStyleId = obj.paragraphStyleId;
      else delete heir.paragraphStyleId;
    }
    // Relie les survivants entre eux, dans l'ordre ; les blocs supprimés sortent de la chaîne.
    survivors.forEach((f, i) => {
      const t = doc.objects[f] as TextObject;
      if (i < survivors.length - 1) t.nextId = survivors[i + 1];
      else delete t.nextId;
    });
    for (const f of frames) if (doomed.has(f)) delete (doc.objects[f] as TextObject).nextId;
  }
}
