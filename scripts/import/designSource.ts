// Lecture d'un export Claude Design sans navigateur : titre, taille de page, sections et repères écran.
//
// Tout ce qui décide du format du document (taille, fond perdu, plis, nombre de faces) se lit dans le
// source : on peut ainsi refuser un fichier ou un gabarit incompatible avant de lancer Chrome.
import type { Mm } from '../../src/model/types';

/** Fichier ou choix refusé pour une raison que l'utilisateur peut corriger (message à lui montrer tel quel). */
export class DesignImportError extends Error {}

export interface DesignGuides {
  /** Retrait du cadre de coupe (`inset`), c'est-à-dire le fond perdu, en mm. */
  bleed?: Mm;
  /** Plis verticaux (traits en pointillés), en mm depuis le bord gauche de la face, fond perdu compris. */
  folds: Mm[];
}

export interface DesignSection {
  /** Attribut `id` de la section, ou `page-<n>` à défaut. */
  id: string;
  /** `data-screen-label` tel quel (« 01 Extérieur »), ou l'id. */
  label: string;
  /** Nom lisible : le libellé sans son numéro de tête (« Extérieur »). */
  name: string;
  /** Attributs de la balise `<section>`, tels qu'écrits dans le design. */
  attrs: Record<string, string>;
  /** Contenu HTML de la section. */
  inner: string;
  /** Repères trouvés dans les `<sc-if>` de la section ; null si elle n'en dessine aucun. */
  guides: DesignGuides | null;
}

export interface ParsedDesign {
  /** Contenu de `<title>`, ou null. */
  title: string | null;
  /** Taille d'une page (d'une face), fond perdu compris, en mm. */
  page: { w: Mm; h: Mm; from: string };
  sections: DesignSection[];
  /** Feuilles de style du design (hors sections), sans `@import` : la mesure ne doit rien charger d'Internet. */
  styles: string[];
  /** Remarques de lecture, reprises dans les avertissements du rapport. */
  warnings: string[];
}

// ---------------------------------------------------------------- aides de lecture

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Attributs d'une balise ouvrante (chaîne après le nom de la balise). */
export function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Texte en identifiant : minuscules sans accents, mots séparés par des tirets. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MM_PER_UNIT: Record<string, number> = { mm: 1, cm: 10, q: 0.25, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 };

/** Longueur CSS absolue en mm (`%` : fraction de `percentOf`) ; null si illisible. */
export function lengthToMm(value: string | undefined, percentOf?: Mm): Mm | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(mm|cm|q|in|pt|pc|px|%)?$/i.exec((value ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (!unit) return n === 0 ? 0 : null;
  if (unit === '%') return percentOf === undefined ? null : (n / 100) * percentOf;
  return n * MM_PER_UNIT[unit];
}

function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    out[decl.slice(0, colon).trim().toLowerCase()] = decl.slice(colon + 1).trim();
  }
  return out;
}

/** Remplace les commentaires HTML par des espaces de même longueur : les positions restent valables. */
function blankComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
}

const round2 = (v: number) => Math.round(v * 100) / 100;
export const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** « 303 », « 215,9 » : longueur en mm pour un message. */
export const fmtMm = (v: Mm) => String(round2(v)).replace('.', ',');

// ---------------------------------------------------------------- taille de page

// Mêmes papiers et même repli que doc-page.js (Claude Design) : la page importée est celle que Claude Design affiche.
const PAPER: Record<string, [string, string]> = {
  letter: ['8.5in', '11in'],
  a4: ['210mm', '297mm'],
  legal: ['8.5in', '14in'],
};
const CSS_LENGTH = /^\d+(\.\d+)?(px|in|mm|cm|pt|pc)$/;

function pageSize(attrs: Record<string, string>, warnings: string[]): ParsedDesign['page'] {
  const sizeName = (attrs.size ?? '').trim().toLowerCase();
  const landscape = (attrs.orientation ?? '').trim().toLowerCase() === 'landscape';
  if (sizeName && !PAPER[sizeName]) warnings.push(`<doc-page size="${attrs.size}"> inconnu de Claude Design : format Letter, comme Claude Design l'affiche`);
  const named = PAPER[sizeName] ?? PAPER.letter;
  const paper = landscape ? [named[1], named[0]] : named;
  const side = (name: 'width' | 'height', fallback: string) => {
    const raw = (attrs[name] ?? '').trim();
    if (raw && !CSS_LENGTH.test(raw)) warnings.push(`<doc-page ${name}="${raw}"> illisible : ${name === 'width' ? 'largeur' : 'hauteur'} du papier (${fallback}) à la place`);
    return CSS_LENGTH.test(raw) ? raw : fallback;
  };
  const w = side('width', paper[0]);
  const h = side('height', paper[1]);
  const explicit = CSS_LENGTH.test((attrs.width ?? '').trim()) && CSS_LENGTH.test((attrs.height ?? '').trim());
  const from = explicit
    ? `<doc-page width="${w}" height="${h}">`
    : sizeName && PAPER[sizeName]
      ? `<doc-page size="${sizeName}"${landscape ? ' orientation="landscape"' : ''}>`
      : `format Letter par défaut de Claude Design${landscape ? ', paysage' : ''}`;
  if ((attrs['content-width'] ?? attrs['content-height']) !== undefined) {
    warnings.push('content-width / content-height de <doc-page> ignorés : le design est mesuré à la taille de la page, sans mise à l\'échelle');
  }
  return { w: round4(lengthToMm(w)!), h: round4(lengthToMm(h)!), from };
}


// ---------------------------------------------------------------- repères écran (<sc-if>)

function readGuides(inner: string, page: { w: Mm; h: Mm }, sectionId: string, warnings: string[]): DesignGuides | null {
  let bleed: Mm | undefined;
  const folds: Mm[] = [];
  let found = false;
  for (const block of inner.matchAll(/<sc-if\b[^>]*>([\s\S]*?)<\/sc-if>/gi)) {
    for (const tag of block[1].matchAll(/<[a-z][\w-]*\b([^>]*)>/gi)) {
      const style = parseAttributes(tag[1]).style;
      if (!style) continue;
      const d = parseStyle(style);
      const borders = Object.entries(d).filter(([k]) => k.startsWith('border') || k.startsWith('outline'));
      if (!borders.length) continue;
      const dashed = (side: string) => borders.some(([k, v]) => (k === `border-${side}` || k === `border-${side}-style`) && /dashed|dotted/.test(v));
      // Cadre de coupe : trait plein en retrait identique sur les quatre côtés (`inset`, ou top/right/bottom/left).
      // Un cadre en pointillés est une zone de sécurité, pas la coupe.
      const solid = !borders.some(([, v]) => /dashed|dotted/.test(v));
      const insetValues = d.inset?.split(/\s+/) ?? [d.top, d.right, d.bottom, d.left];
      const insets = insetValues.map((v) => lengthToMm(v));
      if (solid && insets.every((v) => v !== null && Math.abs(v - insets[0]!) < 1e-6) && insets[0]! > 0) {
        bleed ??= round4(insets[0]!);
        found = true;
        continue;
      }
      if (d.left !== undefined && (dashed('left') || dashed('right'))) {
        const x = lengthToMm(d.left, page.w);
        if (x !== null) {
          folds.push(round4(x));
          found = true;
        }
        continue;
      }
      if (d.top !== undefined && (dashed('top') || dashed('bottom'))) {
        warnings.push(`section « ${sectionId} » : pli horizontal (top: ${d.top}) ignoré, l'éditeur ne gère que des plis verticaux`);
        found = true;
      }
    }
  }
  return found ? { ...(bleed !== undefined ? { bleed } : {}), folds: [...new Set(folds)].sort((a, b) => a - b) } : null;
}

// ---------------------------------------------------------------- sections

function extractSections(source: string, from: number, to: number, page: { w: Mm; h: Mm }, warnings: string[]): DesignSection[] {
  const scan = blankComments(source.slice(0, to));
  const sections: DesignSection[] = [];
  const tagRe = /<(\/?)section\b([^>]*)>/gi;
  tagRe.lastIndex = from;
  let depth = 0;
  let open: { attrs: Record<string, string>; start: number } | null = null;
  for (let m = tagRe.exec(scan); m; m = tagRe.exec(scan)) {
    if (!m[1]) {
      if (depth === 0) {
        const attrs = parseAttributes(m[2]);
        // Seules les sections `.page` directement dans <doc-page> sont des pages (mode paginé de Claude Design).
        open = (attrs.class ?? '').split(/\s+/).includes('page') ? { attrs, start: m.index + m[0].length } : null;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && open) {
        const inner = source.slice(open.start, m.index);
        const n = sections.length + 1;
        const id = (open.attrs.id ?? '').trim() || `page-${n}`;
        const label = (open.attrs['data-screen-label'] ?? '').trim() || id;
        const name = label.replace(/^\s*\d+[\s.)\-–—:·]*/, '').trim() || label;
        sections.push({ id, label, name, attrs: open.attrs, inner, guides: readGuides(inner, page, id, warnings) });
        open = null;
      }
    }
  }
  return sections;
}

/** Lit un export Claude Design ; refuse (DesignImportError) un fichier qui n'en est pas un. */
export function parseDesign(source: string): ParsedDesign {
  const scan = blankComments(source);
  const docPage = /<doc-page\b([^>]*)>/i.exec(scan);
  if (!docPage) {
    throw new DesignImportError("Ce fichier n'est pas un export Claude Design : aucun élément <doc-page> (exporter le design depuis Claude Design, au format HTML).");
  }
  const warnings: string[] = [];
  const page = pageSize(parseAttributes(docPage[1]), warnings);
  const contentStart = docPage.index + docPage[0].length;
  const closing = scan.toLowerCase().lastIndexOf('</doc-page>');
  const contentEnd = closing > contentStart ? closing : scan.length;
  const sections = extractSections(source, contentStart, contentEnd, page, warnings);
  if (!sections.length) {
    throw new DesignImportError('Export Claude Design sans page : aucune <section class="page"> dans <doc-page> (seuls les designs mis en pages, un format par page, sont importables).');
  }
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.id)) warnings.push(`deux sections portent l'identifiant « ${s.id} »`);
    seen.add(s.id);
  }

  // Titre et styles : hors du contenu de <doc-page> (un <title> de SVG n'est pas le titre du design).
  const outside = source.slice(0, docPage.index) + source.slice(contentEnd);
  const outsideScan = blankComments(outside);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(outsideScan);
  const title = titleMatch ? decodeEntities(outside.slice(titleMatch.index, titleMatch.index + titleMatch[0].length).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() || null : null;
  const styles = [...outsideScan.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1].replace(/@import\b[^;]*;/gi, ''));
  return { title, page, sections, styles, warnings };
}
