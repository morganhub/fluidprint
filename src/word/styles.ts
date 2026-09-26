// Styles Word → styles de paragraphe du document (import Word).
//
// Chaque style Word employé correspond à un style de paragraphe du document PORTANT LE MÊME NOM : « Titre 1 »,
// « Normal », « Citation »… (les styles prédéfinis de Word ont un nom interne anglais, « heading 1 », « Quote » :
// on prend le nom que Word affiche en français). Un style du document de ce nom est réutilisé tel quel ;
// sinon il est créé, marqué `origin: 'word'`, sur une échelle de tailles fondée sur le style de corps du
// document (ou le texte par défaut). Les tailles, polices et couleurs de Word ne sont pas reprises : Open Sans
// et les nuances du nuancier seulement.
import { defaultTextStyle } from '../editor/tools/defaults';
import { createParagraphStyle, paragraphStyleUsage } from '../model/styles';
import type { LayoutDocument, ParagraphStyle, TextStyle } from '../model/types';
import type { WordParagraph, WordStyle } from './types';

export type StyleRole = 'body' | 'title' | 'subtitle' | 'heading' | 'quote' | 'intense-quote' | 'caption' | 'other';

/** Style du document visé par un paragraphe Word. */
export interface StyleTarget {
  /** Nom du style dans le document. */
  name: string;
  /** Autres noms qui désignent le même style (nom interne de Word, identifiant). */
  aliases: string[];
  role: StyleRole;
  /** Niveau de titre (1 à 6). */
  level?: number;
  /** Gras / italique du style Word (styles hors échelle : « Emphase », style maison…). */
  bold?: boolean;
  italic?: boolean;
}

/** Styles prédéfinis de Word : nom interne (en minuscules) → nom affiché par Word en français, rôle. */
const BUILTIN: Record<string, { name: string; role: StyleRole }> = {
  normal: { name: 'Normal', role: 'body' },
  title: { name: 'Titre', role: 'title' },
  titre: { name: 'Titre', role: 'title' },
  subtitle: { name: 'Sous-titre', role: 'subtitle' },
  'sous-titre': { name: 'Sous-titre', role: 'subtitle' },
  quote: { name: 'Citation', role: 'quote' },
  citation: { name: 'Citation', role: 'quote' },
  'intense quote': { name: 'Citation intense', role: 'intense-quote' },
  'citation intense': { name: 'Citation intense', role: 'intense-quote' },
  'list paragraph': { name: 'Paragraphe de liste', role: 'body' },
  'paragraphe de liste': { name: 'Paragraphe de liste', role: 'body' },
  caption: { name: 'Légende', role: 'caption' },
  légende: { name: 'Légende', role: 'caption' },
  'no spacing': { name: 'Sans interligne', role: 'body' },
  'sans interligne': { name: 'Sans interligne', role: 'body' },
  'body text': { name: 'Corps de texte', role: 'body' },
  'corps de texte': { name: 'Corps de texte', role: 'body' },
};

const HEADING_NAME = /^(?:heading|titre)\s*([1-9])$/i;

/** Copie d'une valeur du document : elle peut être un brouillon Immer, que structuredClone refuse. */
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Nom comparable : casse, accents et espaces ignorés (« Titre 1 » = « titre1 »). */
export const styleKey = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

/** Style du document visé par un paragraphe Word, d'après le nom de son style et son niveau de titre. */
export function styleTarget(para: Pick<WordParagraph, 'styleId' | 'styleName' | 'heading' | 'title'>, styles: Record<string, WordStyle>): StyleTarget {
  const wordName = (para.styleName ?? para.styleId ?? 'Normal').trim() || 'Normal';
  const aliases = [wordName, para.styleId].filter((a): a is string => !!a);
  const word = para.styleId ? styles[para.styleId] : undefined;
  const numbered = HEADING_NAME.exec(wordName);
  if (para.title) return { name: 'Titre', aliases, role: 'title' };
  if (numbered) {
    const level = Math.min(Number(numbered[1]), 6);
    return { name: `Titre ${level}`, aliases, role: 'heading', level };
  }
  if (para.heading) {
    // Un style maison dérivé d'un titre garde son nom ; un paragraphe « Normal » mis en titre par son niveau
    // hiérarchique (mise en forme directe) rejoint le style de titre de son niveau.
    const own = word?.heading !== undefined && !BUILTIN[wordName.toLowerCase()];
    return { name: own ? wordName : `Titre ${para.heading}`, aliases: own ? aliases : [], role: 'heading', level: para.heading };
  }
  const builtin = BUILTIN[wordName.toLowerCase()];
  if (builtin) return { name: builtin.name, aliases, role: builtin.role };
  return { name: wordName, aliases, role: 'other', bold: word?.bold, italic: word?.italic };
}

// ---------------------------------------------------------------- style de corps et échelle

const PT_TO_MM = 25.4 / 72;
const roundHalf = (v: number) => Math.round(v * 2) / 2;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Nom d'un style de corps de texte, dans un document mis en page. */
const BODY_NAME = /^(normal|corps|texte courant|texte|courant|body|paragraphe|texte principal)\b/i;

/**
 * Style de corps sur lequel fonder l'échelle : le style « Normal » du document, sinon un style dont le nom dit
 * « corps » ou « texte », sinon le style le plus employé de petit corps (12 pt au plus), sinon la mise en
 * forme du bloc visé, sinon le texte par défaut d'un bloc neuf (Open Sans 9 pt).
 */
export function bodyBaseStyle(doc: LayoutDocument, preferred?: TextStyle): TextStyle {
  const byName = doc.styles.paragraph.find((s) => styleKey(s.name) === 'normal') ?? doc.styles.paragraph.find((s) => BODY_NAME.test(s.name.trim()));
  if (byName) return plain(byName.style);
  const usage = paragraphStyleUsage(doc);
  const used = doc.styles.paragraph.filter((s) => s.style.fontSize <= 12 && (usage.get(s.id) ?? 0) > 0).sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0))[0];
  if (used) return plain(used.style);
  if (preferred && preferred.fontSize <= 12) return plain(preferred);
  return defaultTextStyle(doc);
}

/** Tailles des titres par rapport au corps (Titre 1 à Titre 6). */
const HEADING_SCALE = [1.9, 1.55, 1.3, 1.15, 1, 1];

/** Nuance des titres : celle que l'importeur Claude Design nomme « Titres », sinon celle du corps. */
function headingColor(doc: LayoutDocument, base: TextStyle): TextStyle['color'] {
  const swatch = doc.swatches.find((s) => /^titres?$/i.test(s.name.trim()));
  return swatch ? { swatch: swatch.id } : plain(base.color);
}

/** Mise en forme d'un style créé pour un style Word, sur l'échelle du corps `base`. */
export function scaledStyle(doc: LayoutDocument, base: TextStyle, target: StyleTarget): TextStyle {
  const body = base.fontSize;
  const style: TextStyle = { ...plain(base), letterSpacing: 0, transform: 'none' };
  const sized = (factor: number, lineHeight: number) => {
    style.fontSize = Math.max(body, roundHalf(body * factor));
    style.lineHeight = lineHeight;
  };
  const spacing = (before: number, after: number) => {
    const mm = style.fontSize * PT_TO_MM;
    if (before > 0) style.spaceBefore = round1(mm * before);
    else delete style.spaceBefore;
    if (after > 0) style.spaceAfter = round1(mm * after);
    else delete style.spaceAfter;
  };
  switch (target.role) {
    case 'title':
      sized(2.4, 1.1);
      style.fontWeight = 800;
      style.italic = false;
      style.color = headingColor(doc, base);
      style.textWrap = 'balance';
      spacing(0, 0.5);
      break;
    case 'subtitle':
      sized(1.4, 1.25);
      style.fontWeight = 400;
      style.color = headingColor(doc, base);
      style.textWrap = 'balance';
      spacing(0, 0.6);
      break;
    case 'heading': {
      const level = Math.min(Math.max(target.level ?? 1, 1), 6);
      sized(HEADING_SCALE[level - 1], level <= 2 ? 1.15 : 1.25);
      style.fontWeight = 700;
      style.italic = level === 6;
      style.color = headingColor(doc, base);
      style.textWrap = 'balance';
      spacing(level <= 2 ? 1 : 0.9, 0.35);
      break;
    }
    case 'quote':
      style.italic = true;
      break;
    case 'intense-quote':
      style.italic = true;
      style.fontWeight = 600;
      style.color = headingColor(doc, base);
      break;
    case 'caption':
      sized(0.85, base.lineHeight);
      style.fontSize = Math.max(6, roundHalf(body * 0.85));
      style.italic = true;
      break;
    case 'body':
      // Un corps de texte sans espacement : les paragraphes de Word (espacés par défaut) se distinguent quand même.
      if (style.spaceAfter === undefined && style.spaceBefore === undefined) style.spaceAfter = round1(body * PT_TO_MM * 0.6);
      break;
    case 'other':
      if (target.bold !== undefined) style.fontWeight = target.bold ? 700 : 400;
      if (target.italic !== undefined) style.italic = target.italic;
      if (style.spaceAfter === undefined && style.spaceBefore === undefined) style.spaceAfter = round1(body * PT_TO_MM * 0.6);
      break;
  }
  if (!style.italic) delete style.italic;
  return style;
}

export interface ResolvedStyles {
  /** Style du document de chaque cible, par nom de cible. */
  byName: Map<string, ParagraphStyle>;
  created: string[];
  reused: string[];
}

/**
 * Trouve ou crée (dans le brouillon `doc`) le style de chaque cible. Un style existant est réutilisé s'il porte
 * le nom de la cible (ou l'un de ses alias), casse et accents ignorés.
 */
export function resolveStyles(doc: LayoutDocument, targets: StyleTarget[], base: TextStyle): ResolvedStyles {
  const byName = new Map<string, ParagraphStyle>();
  const created: string[] = [];
  const reused: string[] = [];
  for (const target of targets) {
    if (byName.has(target.name)) continue;
    const keys = new Set([target.name, ...target.aliases].map(styleKey));
    const existing = doc.styles.paragraph.find((s) => keys.has(styleKey(s.name)));
    if (existing) {
      byName.set(target.name, existing);
      if (!reused.includes(existing.name)) reused.push(existing.name);
      continue;
    }
    const style = createParagraphStyle(doc, target.name, scaledStyle(doc, base, target));
    style.origin = 'word';
    byName.set(target.name, style);
    created.push(style.name);
  }
  return { byName, created, reused };
}
