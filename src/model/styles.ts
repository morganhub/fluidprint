// Styles de paragraphe et de caractère (tâche 2.21, décision E3).
//
// Stockage dénormalisé : `obj.style` (et les champs d'un segment) restent les valeurs EFFECTIVES, lues
// telles quelles par le rendu, l'export et le contrôle en amont. Un bloc référence son style par
// `paragraphStyleId`, un segment par `characterStyleId`. Les écarts d'un bloc sont donc tout ce qui,
// dans le bloc, diffère de son style : ils vivent à part du style (dans le bloc) et se calculent par
// `textOverrides`. Modifier un style ne réécrit que les valeurs égales à l'ANCIENNE valeur du style :
// une retouche locale survit au changement de style.
//
// Un paragraphe peut avoir son propre style (`Paragraph.paragraphStyleId`, intertitre d'un texte importé de
// Word) : les valeurs du style y sont TOUTES écrites, au niveau du paragraphe (corps, interlignage,
// alignement, espaces) et de chacun de ses segments (graisse, italique, nuance, interlettrage, casse). Le
// style du bloc ne déteint donc jamais sur lui, et le rendu n'a rien de plus à savoir.
//
// Toutes les fonctions qui modifient travaillent sur un brouillon (Immer) ou un document mutable.
import type { CharacterStyle, Id, LayoutDocument, Paragraph, ParagraphStyle, TextObject, TextRun, TextStyle } from './types';

export const PARAGRAPH_STYLE_KEYS = [
  'fontFamily',
  'fontWeight',
  'italic',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'transform',
  'color',
  'spaceBefore',
  'spaceAfter',
  'align',
  'textWrap',
] as const satisfies readonly (keyof TextStyle)[];

export type CharacterStyleValues = CharacterStyle['style'];
export const CHARACTER_STYLE_KEYS = ['color', 'fontWeight', 'italic', 'fontSize', 'letterSpacing', 'transform', 'underline'] as const satisfies readonly (keyof CharacterStyleValues)[];

/** Surcharges de paragraphe du modèle (`Paragraph`), comptées comme écarts. */
const PARAGRAPH_OVERRIDE_KEYS = ['fontSize', 'lineHeight', 'align', 'spaceBefore', 'spaceAfter'] as const;

/** Valeurs d'un style propre à un paragraphe écrites dans le paragraphe (`Paragraph`). */
export const PARAGRAPH_LEVEL_KEYS = ['fontSize', 'lineHeight', 'align', 'spaceBefore', 'spaceAfter'] as const satisfies readonly (keyof TextStyle & keyof Paragraph)[];
/** Valeurs d'un style propre à un paragraphe écrites dans chacun de ses segments (`TextRun`). */
export const PARAGRAPH_RUN_KEYS = ['fontWeight', 'italic', 'color', 'letterSpacing', 'transform'] as const satisfies readonly (keyof TextStyle & keyof TextRun)[];

export const STYLE_KEY_LABELS: Record<string, string> = {
  fontFamily: 'police',
  fontWeight: 'graisse',
  italic: 'italique',
  fontSize: 'corps',
  lineHeight: 'interlignage',
  letterSpacing: 'interlettrage',
  transform: 'casse',
  color: 'nuance',
  spaceBefore: 'espace avant',
  spaceAfter: 'espace après',
  align: 'alignement',
  textWrap: 'coupure',
  underline: 'soulignement',
};

/** Égalité de deux valeurs de style ; `italic` absent vaut « non ». */
export function sameStyleValue(key: string, a: unknown, b: unknown): boolean {
  if (key === 'italic') return !!a === !!b;
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function setOrDelete<T extends object>(target: T, key: string, value: unknown): void {
  const t = target as Record<string, unknown>;
  if (value === undefined) delete t[key];
  else t[key] = clone(value);
}

export const findParagraphStyle = (doc: Pick<LayoutDocument, 'styles'>, id: Id | undefined): ParagraphStyle | undefined =>
  id ? doc.styles.paragraph.find((s) => s.id === id) : undefined;

export const findCharacterStyle = (doc: Pick<LayoutDocument, 'styles'>, id: Id | undefined): CharacterStyle | undefined =>
  id ? doc.styles.character.find((s) => s.id === id) : undefined;

/** Identifiant libre et lisible : `ps-intertitre`, `cs-accent-2`… */
export function newStyleId(doc: Pick<LayoutDocument, 'styles'>, prefix: 'ps' | 'cs', name: string): Id {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'style';
  const taken = new Set([...doc.styles.paragraph, ...doc.styles.character].map((s) => s.id));
  let id = `${prefix}-${slug}`;
  for (let i = 2; taken.has(id); i++) id = `${prefix}-${slug}-${i}`;
  return id;
}

// ---------------------------------------------------------------- écarts

export interface TextOverride {
  /** bloc : `obj.style` ; paragraphe : surcharge d'un paragraphe ; segment : mise en forme locale d'un segment. */
  level: 'bloc' | 'paragraphe' | 'segment';
  key: string;
  /** « corps 7,2 pt », lisible dans une bulle. */
  label: string;
}

const fmt = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000).replace('.', ',') : typeof v === 'object' ? ((v as { swatch?: string }).swatch ?? JSON.stringify(v)) : String(v));

/** Valeur qu'un style propre écrit dans un paragraphe (espaces absents du style : 0, pour ne rien hériter du bloc). */
function paragraphLevelValue(ps: ParagraphStyle, key: (typeof PARAGRAPH_LEVEL_KEYS)[number]): unknown {
  const value = ps.style[key];
  return value === undefined && (key === 'spaceBefore' || key === 'spaceAfter') ? 0 : value;
}

/** Valeur qu'un style propre écrit dans chaque segment (italique toujours explicite). */
function paragraphRunValue(ps: ParagraphStyle, key: (typeof PARAGRAPH_RUN_KEYS)[number]): unknown {
  return key === 'italic' ? !!ps.style.italic : ps.style[key];
}

/**
 * Valeurs d'un segment qui ne viennent ni de son style de caractère, ni du style propre de son paragraphe
 * (`own`) : sa mise en forme locale.
 */
export function runLocalKeys(doc: Pick<LayoutDocument, 'styles'>, run: TextRun, own?: ParagraphStyle): (typeof CHARACTER_STYLE_KEYS)[number][] {
  const cs = findCharacterStyle(doc, run.characterStyleId);
  return CHARACTER_STYLE_KEYS.filter((k) => {
    if (run[k] === undefined) return false;
    if (cs && cs.style[k] !== undefined && sameStyleValue(k, run[k], cs.style[k])) return false;
    if (own && (PARAGRAPH_RUN_KEYS as readonly string[]).includes(k) && sameStyleValue(k, run[k], paragraphRunValue(own, k as (typeof PARAGRAPH_RUN_KEYS)[number]))) return false;
    return true;
  });
}

// ---------------------------------------------------------------- style propre d'un paragraphe

/**
 * Donne à un paragraphe son propre style : toutes les valeurs du style y sont écrites (paragraphe et
 * segments), sauf celles qu'un style de caractère fixe. `first` : premier paragraphe de l'article, qui n'a
 * jamais d'espace avant (comme en haut d'un bloc).
 */
export function applyStyleToParagraph(doc: Pick<LayoutDocument, 'styles'>, para: Paragraph, ps: ParagraphStyle, options: { first?: boolean } = {}): void {
  para.paragraphStyleId = ps.id;
  for (const key of PARAGRAPH_LEVEL_KEYS) {
    if (key === 'spaceBefore' && options.first) delete para.spaceBefore;
    else setOrDelete(para, key, paragraphLevelValue(ps, key));
  }
  for (const run of para.runs) {
    const cs = findCharacterStyle(doc, run.characterStyleId);
    for (const key of PARAGRAPH_RUN_KEYS) {
      if (cs && cs.style[key] !== undefined) continue;
      setOrDelete(run, key, paragraphRunValue(ps, key));
    }
  }
}

/** Retire le style propre d'un paragraphe : il reprend celui du bloc (ses retouches locales restent). */
function clearParagraphStyle(doc: Pick<LayoutDocument, 'styles'>, para: Paragraph): void {
  const own = findParagraphStyle(doc, para.paragraphStyleId);
  delete para.paragraphStyleId;
  if (!own) return;
  for (const key of PARAGRAPH_LEVEL_KEYS) if (para[key] !== undefined && sameStyleValue(key, para[key], paragraphLevelValue(own, key))) delete para[key];
  for (const run of para.runs) {
    for (const key of PARAGRAPH_RUN_KEYS) if (run[key] !== undefined && sameStyleValue(key, run[key], paragraphRunValue(own, key))) delete run[key];
  }
}

/** Écarts d'un bloc par rapport à son style de paragraphe (vide s'il n'a pas de style). */
export function textOverrides(doc: Pick<LayoutDocument, 'styles'>, obj: TextObject): TextOverride[] {
  const ps = findParagraphStyle(doc, obj.paragraphStyleId);
  if (!ps) return [];
  const out: TextOverride[] = [];
  for (const key of PARAGRAPH_STYLE_KEYS) {
    if (!sameStyleValue(key, obj.style[key], ps.style[key])) out.push({ level: 'bloc', key, label: `${STYLE_KEY_LABELS[key]} ${fmt(obj.style[key])}` });
  }
  obj.paragraphs.forEach((para, p) => {
    const own = findParagraphStyle(doc, para.paragraphStyleId);
    for (const key of PARAGRAPH_OVERRIDE_KEYS) {
      if (para[key] === undefined) continue;
      // Paragraphe à style propre : seule une valeur différente de ce style est un écart.
      if (own && sameStyleValue(key, para[key], paragraphLevelValue(own, key))) continue;
      out.push({ level: 'paragraphe', key, label: `${STYLE_KEY_LABELS[key]} ${fmt(para[key])} (paragraphe ${p + 1})` });
    }
    for (const run of para.runs) {
      for (const key of runLocalKeys(doc, run, own)) {
        const excerpt = run.text.trim().slice(0, 18);
        out.push({ level: 'segment', key, label: `${STYLE_KEY_LABELS[key]} ${fmt(run[key])} (« ${excerpt}${run.text.trim().length > 18 ? '…' : ''} »)` });
      }
    }
  });
  return out;
}

export const hasOverrides = (doc: Pick<LayoutDocument, 'styles'>, obj: TextObject): boolean => textOverrides(doc, obj).length > 0;

// ---------------------------------------------------------------- styles de paragraphe

function textObjects(doc: LayoutDocument, ids?: Id[]): TextObject[] {
  const list = ids ? ids.map((id) => doc.objects[id]) : Object.values(doc.objects);
  return list.filter((o): o is TextObject => o?.type === 'text');
}

export function createParagraphStyle(doc: LayoutDocument, name: string, style: TextStyle, id?: Id): ParagraphStyle {
  const created: ParagraphStyle = { id: id ?? newStyleId(doc, 'ps', name), name, style: clone(style) };
  doc.styles.paragraph.push(created);
  return created;
}

/**
 * Modifie un style de paragraphe et met à jour en direct les blocs qui le suivent : une valeur égale à
 * l'ancienne valeur du style prend la nouvelle ; une retouche locale (valeur différente) reste.
 */
export function updateParagraphStyle(doc: LayoutDocument, styleId: Id, patch: Partial<TextStyle>): void {
  const ps = findParagraphStyle(doc, styleId);
  if (!ps) return;
  const before = clone(ps.style);
  for (const [key, value] of Object.entries(patch)) setOrDelete(ps.style, key, value);
  const changed = PARAGRAPH_STYLE_KEYS.filter((k) => !sameStyleValue(k, before[k], ps.style[k]));
  if (!changed.length) return;
  const old: ParagraphStyle = { ...ps, style: before };
  for (const obj of textObjects(doc)) {
    if (obj.paragraphStyleId === styleId) {
      for (const key of changed) {
        if (sameStyleValue(key, obj.style[key], before[key])) setOrDelete(obj.style, key, ps.style[key]);
      }
    }
    // Paragraphes à style propre : même règle, valeur par valeur, dans le paragraphe et ses segments.
    for (const para of obj.paragraphs) {
      if (para.paragraphStyleId !== styleId) continue;
      for (const key of PARAGRAPH_LEVEL_KEYS) {
        if (changed.includes(key) && para[key] !== undefined && sameStyleValue(key, para[key], paragraphLevelValue(old, key))) setOrDelete(para, key, paragraphLevelValue(ps, key));
      }
      for (const key of PARAGRAPH_RUN_KEYS) {
        if (!changed.includes(key)) continue;
        for (const run of para.runs) if (sameStyleValue(key, run[key], paragraphRunValue(old, key))) setOrDelete(run, key, paragraphRunValue(ps, key));
      }
    }
  }
}

/** Applique un style de paragraphe (null : détache le bloc de son style, sans rien changer à l'œil). */
export function applyParagraphStyle(doc: LayoutDocument, ids: Id[], styleId: Id | null): void {
  const ps = styleId ? findParagraphStyle(doc, styleId) : undefined;
  for (const obj of textObjects(doc, ids)) {
    if (!ps) {
      delete obj.paragraphStyleId;
      continue;
    }
    obj.paragraphStyleId = ps.id;
    for (const key of PARAGRAPH_STYLE_KEYS) setOrDelete(obj.style, key, ps.style[key]);
    // Appliqué au bloc, le style vaut pour tous ses paragraphes : les styles propres (intertitres Word) partent.
    for (const para of obj.paragraphs) if (para.paragraphStyleId) clearParagraphStyle(doc, para);
  }
}

/** « Effacer les écarts » : le bloc reprend son style ; seules les mises en forme des styles de caractère restent. */
export function clearOverrides(doc: LayoutDocument, ids: Id[]): void {
  for (const obj of textObjects(doc, ids)) {
    const ps = findParagraphStyle(doc, obj.paragraphStyleId);
    if (!ps) continue;
    for (const key of PARAGRAPH_STYLE_KEYS) setOrDelete(obj.style, key, ps.style[key]);
    obj.paragraphs.forEach((para, p) => {
      const own = findParagraphStyle(doc, para.paragraphStyleId);
      if (own) {
        // Un paragraphe à style propre reprend exactement ce style (ses segments aussi).
        for (const run of para.runs) for (const key of runLocalKeys(doc, run, own)) delete run[key];
        applyStyleToParagraph(doc, para, own, { first: p === 0 });
        return;
      }
      for (const key of PARAGRAPH_OVERRIDE_KEYS) delete para[key];
      for (const run of para.runs) for (const key of runLocalKeys(doc, run)) delete run[key];
    });
  }
}

/** « Redéfinir le style » : le style prend la mise en forme du bloc ; les autres blocs suivent. */
export function redefineParagraphStyle(doc: LayoutDocument, objId: Id): void {
  const obj = doc.objects[objId];
  if (obj?.type !== 'text' || !obj.paragraphStyleId) return;
  const patch: Partial<TextStyle> = {};
  for (const key of PARAGRAPH_STYLE_KEYS) (patch as Record<string, unknown>)[key] = obj.style[key];
  updateParagraphStyle(doc, obj.paragraphStyleId, patch);
}

export function renameStyle(doc: LayoutDocument, kind: 'paragraph' | 'character', id: Id, name: string): void {
  const style = (kind === 'paragraph' ? doc.styles.paragraph : doc.styles.character).find((s) => s.id === id);
  if (style && name.trim()) style.name = name.trim();
}

/** Supprime un style de paragraphe : ses blocs gardent leur mise en forme, sans référence. */
export function deleteParagraphStyle(doc: LayoutDocument, id: Id): void {
  doc.styles.paragraph = doc.styles.paragraph.filter((s) => s.id !== id);
  for (const obj of textObjects(doc)) {
    if (obj.paragraphStyleId === id) delete obj.paragraphStyleId;
    // Les paragraphes à ce style propre gardent leur mise en forme (écrite chez eux), sans référence.
    for (const para of obj.paragraphs) if (para.paragraphStyleId === id) delete para.paragraphStyleId;
  }
}

/** Nombre de blocs qui suivent chaque style de paragraphe (en entier, ou par l'un de leurs paragraphes). */
export function paragraphStyleUsage(doc: LayoutDocument): Map<Id, number> {
  const usage = new Map<Id, number>();
  for (const obj of textObjects(doc)) {
    const ids = new Set([obj.paragraphStyleId, ...obj.paragraphs.map((p) => p.paragraphStyleId)].filter((id): id is Id => !!id));
    for (const id of ids) usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  return usage;
}

// ---------------------------------------------------------------- styles de caractère

export function createCharacterStyle(doc: LayoutDocument, name: string, style: CharacterStyleValues, id?: Id): CharacterStyle {
  const created: CharacterStyle = { id: id ?? newStyleId(doc, 'cs', name), name, style: clone(style) };
  doc.styles.character.push(created);
  return created;
}

function forEachRun(doc: LayoutDocument, fn: (run: TextRun, obj: TextObject) => void): void {
  for (const obj of textObjects(doc)) for (const para of obj.paragraphs) for (const run of para.runs) fn(run, obj);
}

/** Modifie un style de caractère ; les segments qui le suivent sont mis à jour (sauf leurs retouches). */
export function updateCharacterStyle(doc: LayoutDocument, styleId: Id, patch: Partial<CharacterStyleValues>): void {
  const cs = findCharacterStyle(doc, styleId);
  if (!cs) return;
  const before = clone(cs.style);
  for (const [key, value] of Object.entries(patch)) setOrDelete(cs.style, key, value);
  const changed = CHARACTER_STYLE_KEYS.filter((k) => !sameStyleValue(k, before[k], cs.style[k]) || (before[k] === undefined) !== (cs.style[k] === undefined));
  if (!changed.length) return;
  forEachRun(doc, (run) => {
    if (run.characterStyleId !== styleId) return;
    for (const key of changed) {
      const local = run[key];
      // Valeur venue du style (égale à l'ancienne) ou absente alors que le style n'en fixait pas.
      if ((before[key] === undefined && local === undefined) || (before[key] !== undefined && sameStyleValue(key, local, before[key]))) setOrDelete(run, key, cs.style[key]);
    }
  });
}

/** Pose (ou retire, avec null) un style de caractère sur un segment : ses valeurs deviennent celles du segment. */
export function applyCharacterStyleToRun(doc: Pick<LayoutDocument, 'styles'>, run: TextRun, styleId: Id | null): void {
  const previous = findCharacterStyle(doc, run.characterStyleId);
  // Les valeurs apportées par l'ancien style partent avec lui.
  if (previous) for (const key of CHARACTER_STYLE_KEYS) if (previous.style[key] !== undefined && sameStyleValue(key, run[key], previous.style[key])) delete run[key];
  const cs = styleId ? findCharacterStyle(doc, styleId) : undefined;
  if (!cs) {
    delete run.characterStyleId;
    return;
  }
  run.characterStyleId = cs.id;
  for (const key of CHARACTER_STYLE_KEYS) if (cs.style[key] !== undefined) setOrDelete(run, key, cs.style[key]);
}

export function deleteCharacterStyle(doc: LayoutDocument, id: Id): void {
  doc.styles.character = doc.styles.character.filter((s) => s.id !== id);
  forEachRun(doc, (run) => {
    if (run.characterStyleId === id) delete run.characterStyleId;
  });
}
