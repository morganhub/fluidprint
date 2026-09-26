// Fichier Word lu (src/word/types.ts) → article du modèle : paragraphes, segments, styles, listes (import Word).
//
// Correspondance :
// - paragraphe Word → `Paragraph` ; son style Word → style de paragraphe du document de même nom (créé
//   s'il manque, word/styles.ts). Le style le plus employé devient celui du bloc ; les autres paragraphes
//   portent leur style propre (`paragraphStyleId`, valeurs écrites chez eux : model/styles.ts) ;
// - gras / italique / souligné directs → graisse, italique, souligné des segments ; retour à la ligne → `\n` ;
// - liste Word → `list` (puce ou numéro, niveau) et retrait suspendu (`leftIndent`, `firstLineIndent`) :
//   la puce est dessinée par le rendu, hors du texte ; les numéros de Word sont gardés (`start` là où la
//   numérotation de Word ne suit pas la règle du rendu) ;
// - tableau → une ligne par paragraphe, cellules séparées par des tabulations (avertissement) ;
// - lien → son texte ; l'adresse part dans le rapport ;
// - image → photo du document (déjà enregistrée par le serveur), non placée : sa position dans le texte est
//   rapportée ;
// - typographie française (facultative) : text/typographyFr.ts sur chaque paragraphe.
import { nextListNumber } from '../model/lists';
import { applyStyleToParagraph } from '../model/styles';
import type { Asset, LayoutDocument, ListNumberFormat, Paragraph, ParagraphList, ParagraphStyle, TextRun, TextStyle } from '../model/types';
import { normalizeRuns } from '../text/richText';
import { applyEditsToRuns, runsText, typographyEdits } from '../text/typographyFr';
import { bodyBaseStyle, resolveStyles, styleTarget, type StyleTarget } from './styles';
import type { WordDocument, WordImage, WordInline, WordParagraph, WordText } from './types';

export interface WordStoryOptions {
  /** Applique la typographie française (espaces insécables, apostrophes, guillemets). */
  typography: boolean;
  /** Mise en forme du bloc visé : base de l'échelle des styles faute de style de corps dans le document. */
  targetStyle?: TextStyle;
}

export interface WordStoryImage {
  image: WordImage;
  /** Photo ajoutée au document ; absente si le serveur n'a pas pu l'enregistrer (format refusé). */
  asset?: Asset;
  /** Rang du paragraphe de l'article devant lequel l'image se trouvait dans Word. */
  paragraph: number;
  /** Début du paragraphe qui la précède (« après « Contexte… » »), ou null en tête du texte. */
  after: string | null;
}

export interface WordLink {
  text: string;
  url: string;
}

export interface WordStory {
  paragraphs: Paragraph[];
  /** Style du bloc (le plus employé du texte). */
  blockStyle: ParagraphStyle;
  stylesCreated: string[];
  stylesReused: string[];
  images: WordStoryImage[];
  links: WordLink[];
  warnings: string[];
  typographyFixes: number;
}

const PT_TO_MM = 25.4 / 72;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Formats de numéro de Word que le rendu sait dessiner. */
const FORMATS: Record<string, ListNumberFormat> = {
  decimal: 'decimal',
  decimalZero: 'decimal',
  lowerLetter: 'lower-alpha',
  upperLetter: 'upper-alpha',
  lowerRoman: 'lower-roman',
  upperRoman: 'upper-roman',
};

const excerpt = (text: string, max = 40) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** Paragraphe Word à placer, avec ses images retirées du texte (elles vont dans le panneau Images). */
interface SourceParagraph {
  word: WordParagraph;
  texts: WordText[];
  images: string[];
}

/** Paragraphes de l'article, tableaux mis à plat (une rangée = un paragraphe, cellules séparées par des tabulations). */
function flatten(document: WordDocument, warnings: string[]): SourceParagraph[] {
  const out: SourceParagraph[] = [];
  const split = (content: WordInline[]) => ({
    texts: content.filter((c): c is WordText => c.type === 'text'),
    images: content.filter((c) => c.type === 'image').map((c) => (c as { image: string }).image),
  });
  for (const block of document.blocks) {
    if (block.type === 'paragraph') {
      out.push({ word: block, ...split(block.content) });
      continue;
    }
    const columns = Math.max(0, ...block.rows.map((r) => r.length));
    warnings.push(
      `Tableau ${block.index} (${block.rows.length} ligne${block.rows.length > 1 ? 's' : ''} × ${columns} colonne${columns > 1 ? 's' : ''}) mis à plat : une ligne par paragraphe, cellules séparées par des tabulations. À remettre en forme dans l’éditeur.`,
    );
    for (const row of block.rows) {
      const content: WordInline[] = [];
      let first: WordParagraph | undefined;
      row.forEach((cell, c) => {
        if (c > 0) content.push({ type: 'text', text: '\t' });
        cell.paragraphs.forEach((p, i) => {
          first ??= p;
          if (i > 0) content.push({ type: 'text', text: ' / ' });
          // Une liste dans une cellule garde sa puce ou son numéro, en texte.
          if (p.list?.marker) content.push({ type: 'text', text: `${p.list.marker} ` });
          content.push(...p.content);
        });
      });
      out.push({ word: { type: 'paragraph', styleId: first?.styleId, styleName: first?.styleName, content }, ...split(content) });
    }
  }
  return out;
}

/**
 * Textes d'un paragraphe nettoyés : espaces multiples réduites (le rendu les fusionne, l'éditeur non : les
 * coupures différeraient), espaces et tabulations de début et de fin retirées, et celles qui précèdent un
 * retour à la ligne.
 */
function cleanTexts(texts: WordText[]): WordText[] {
  const out = texts.map((t) => ({ ...t, text: t.text.replace(/ {2,}/g, ' ') }));
  // Espaces aux jointures de segments : « mot␣ » + « ␣mot » ne font qu'une espace.
  for (let i = 1; i < out.length; i++) if (/ $/.test(out[i - 1].text) && /^ /.test(out[i].text)) out[i].text = out[i].text.slice(1);
  for (const t of out) t.text = t.text.replace(/[ \t]+\n/g, '\n');
  while (out.length && !out[0].text.replace(/^[ \t\n]+/, '')) out.shift();
  if (out.length) out[0].text = out[0].text.replace(/^[ \t\n]+/, '');
  while (out.length && !out[out.length - 1].text.replace(/[ \t\n]+$/, '')) out.pop();
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/[ \t\n]+$/, '');
  return out.filter((t) => t.text !== '');
}

/** Style retenu pour le bloc : celui qui porte le plus de texte (le corps, d'ordinaire). */
function dominantTarget(items: { target: StyleTarget; chars: number }[]): string {
  const weight = new Map<string, number>();
  for (const { target, chars } of items) {
    // Un titre ne fait pas un bon style de bloc, même dans un texte très court.
    const bonus = target.role === 'heading' || target.role === 'title' || target.role === 'subtitle' ? 0.2 : 1;
    weight.set(target.name, (weight.get(target.name) ?? 0) + chars * bonus + 1);
  }
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Normal';
}

/** Liste Word → liste du modèle (numéro de Word gardé à part, pour la numérotation). */
function toList(word: NonNullable<WordParagraph['list']>, warnings: string[]): ParagraphList {
  if (word.kind === 'bullet') return { kind: 'bullet', level: word.level };
  const format = word.format ? FORMATS[word.format] : 'decimal';
  if (!format) warnings.push(`Numérotation « ${word.format} » de Word rendue en chiffres (1, 2, 3…).`);
  const list: ParagraphList = { kind: 'number', level: word.level };
  if (format && format !== 'decimal') list.format = format;
  if (/\)$/.test(word.marker ?? '')) list.suffix = ')';
  return list;
}

/**
 * Construit l'article d'un fichier Word dans le brouillon `doc` : styles créés ou réutilisés (ajoutés au
 * document), paragraphes prêts à poser dans un bloc dont le style sera `blockStyle`.
 */
export function buildWordStory(doc: LayoutDocument, word: WordDocument, assets: Record<string, Asset>, options: WordStoryOptions): WordStory {
  const warnings = [...word.warnings];
  const sources = flatten(word, warnings);

  // Paragraphes non vides, leurs cibles de style ; images repérées dans le texte.
  const kept: { source: SourceParagraph; texts: WordText[]; target: StyleTarget }[] = [];
  const images: WordStoryImage[] = [];
  const imageById = new Map(word.images.map((img) => [img.id, img]));
  const placedImages = new Set<string>();
  for (const source of sources) {
    for (const id of source.images) {
      const image = imageById.get(id);
      if (!image || placedImages.has(id)) continue;
      placedImages.add(id);
      const previous = kept.at(-1);
      images.push({ image, asset: assets[id], paragraph: kept.length, after: previous ? excerpt(previous.texts.map((t) => t.text).join('')) : null });
    }
    const texts = cleanTexts(source.texts);
    if (!texts.length) continue;
    kept.push({ source, texts, target: styleTarget(source.word, word.styles) });
  }
  // Images référencées nulle part dans le texte (improbable) : elles restent listées.
  for (const image of word.images) {
    if (!placedImages.has(image.id)) images.push({ image, asset: assets[image.id], paragraph: kept.length, after: null });
  }

  // Styles : un par cible, trouvés ou créés ; le plus employé devient celui du bloc.
  const base = bodyBaseStyle(doc, options.targetStyle);
  const targets = kept.map((k) => k.target);
  if (!targets.length) targets.push({ name: 'Normal', aliases: ['Normal'], role: 'body' });
  const resolved = resolveStyles(doc, targets, base);
  const blockName = dominantTarget(kept.length ? kept.map((k) => ({ target: k.target, chars: k.texts.reduce((n, t) => n + t.text.length, 0) })) : [{ target: targets[0], chars: 0 }]);
  const blockStyle = resolved.byName.get(blockName)!;

  const links: WordLink[] = [];
  const paragraphs: Paragraph[] = [];
  const wordNumbers: (number | undefined)[] = [];
  kept.forEach(({ source, texts }, index) => {
    const style = resolved.byName.get(kept[index].target.name)!;
    const own = style.id !== blockStyle.id ? style : undefined;
    const para: Paragraph = { runs: texts.map((t) => ({ text: t.text })) };
    if (own) applyStyleToParagraph(doc, para, own, { first: index === 0 });
    const effective = (own ?? blockStyle).style;
    // Mise en forme directe de Word, par-dessus le style (seulement ce qui change quelque chose).
    texts.forEach((t, i) => {
      const run: TextRun = para.runs[i];
      if (t.bold === true && effective.fontWeight < 600) run.fontWeight = 700;
      else if (t.bold === false && effective.fontWeight >= 600) run.fontWeight = 400;
      if (t.italic !== undefined && t.italic !== !!effective.italic) run.italic = t.italic;
      if (t.underline) run.underline = true;
    });
    // Un lien couvre souvent plusieurs segments voisins (gras au milieu…) : un seul lien au rapport.
    let current = null as WordLink | null;
    for (const t of texts) {
      if (!t.link) current = null;
      else if (current?.url === t.link) current.text += t.text;
      else {
        current = { text: t.text, url: t.link };
        links.push(current);
      }
    }
    if (source.word.align && source.word.align !== effective.align) para.align = source.word.align;
    if (source.word.list) {
      para.list = toList(source.word.list, warnings);
      // Retrait suspendu : la puce ou le numéro dans 1,5 cadratin, chaque niveau décalé d'autant.
      const hang = round1((own?.style.fontSize ?? blockStyle.style.fontSize) * PT_TO_MM * 1.5);
      para.leftIndent = round1(hang * (source.word.list.level + 1));
      para.firstLineIndent = -hang;
    }
    wordNumbers.push(source.word.list?.kind === 'number' ? source.word.list.number : undefined);
    para.runs = normalizeRuns(para.runs);
    paragraphs.push(para);
  });

  // Numéros : ceux de Word sont gardés ; `start` là où la règle du rendu (model/lists.ts) en donnerait un autre.
  const counters: (number | undefined)[] = [];
  paragraphs.forEach((para, i) => {
    if (!para.list) return;
    const wanted = wordNumbers[i];
    if (para.list.kind === 'number' && wanted !== undefined && nextListNumber([...counters], para.list) !== wanted) para.list.start = wanted;
    nextListNumber(counters, para.list);
  });

  let typographyFixes = 0;
  if (options.typography) {
    for (const para of paragraphs) {
      const edits = typographyEdits(runsText(para.runs));
      if (!edits.length) continue;
      typographyFixes += edits.length;
      para.runs = applyEditsToRuns(para.runs, edits);
    }
  }

  if (word.fonts.some((f) => !/^open sans$/i.test(f))) {
    warnings.push(`Polices du document Word ignorées (${word.fonts.join(', ')}) : tout le texte est composé en Open Sans, la police du document.`);
  }
  if (word.colors.length) {
    warnings.push(`Couleurs du texte Word ignorées (${word.colors.join(', ')}) : le texte prend les nuances du nuancier du document.`);
  }
  const cleanLinks = links.map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), url: l.url })).filter((l) => l.text || l.url);
  if (cleanLinks.length) warnings.push(`${cleanLinks.length} lien${cleanLinks.length > 1 ? 's' : ''} transformé${cleanLinks.length > 1 ? 's' : ''} en texte : les adresses sont dans le rapport.`);
  const missing = images.filter((i) => !i.asset).length;
  if (missing && !warnings.some((w) => /Image/.test(w))) warnings.push(`${missing} image(s) non importée(s).`);

  if (!paragraphs.length) {
    warnings.push('Le fichier Word ne contient pas de texte.');
    paragraphs.push({ runs: [{ text: '' }] });
  }
  return {
    paragraphs,
    blockStyle,
    stylesCreated: resolved.created,
    stylesReused: resolved.reused,
    images,
    links: cleanLinks,
    warnings,
    typographyFixes,
  };
}
