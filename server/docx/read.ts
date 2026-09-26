// Lecteur .docx maison, sans dépendance, repris du lecteur de fluidplan (qui produisait du Markdown) : il
// rend ici la STRUCTURE du document (src/word/types.ts) que l'éditeur « place » dans ses blocs texte.
//
// Un .docx est un zip de fichiers XML (Office Open XML) : word/document.xml (le texte), word/styles.xml,
// word/numbering.xml (listes), les relations (liens, images) et word/media/ (images). Seule la structure
// compte : paragraphes et leur style Word, titres, listes et leur niveau, alignement, gras / italique /
// souligné, retours à la ligne, tableaux (lignes et cellules), liens, images à leur place dans le flux.
// Les tailles, polices et couleurs de Word ne sont pas reprises ; polices et couleurs sont listées pour le
// rapport. Les refus (.doc, fichier chiffré, zip qui n'est pas un Word, bombe de décompression) sont des
// `DocxError` au message destiné à l'utilisateur.
import type { WordAlign, WordBlock, WordDocument, WordImage, WordInline, WordList, WordParagraph, WordStyle, WordTable, WordTableCell, WordText } from '../../src/word/types';
import { DocxError, ZipLimitError } from './errors';
import { child, decodeXml, find, kids, onOff, parseXml, val, type XmlNode } from './xml';
import { megabytes, openZip, ZIP_LIMITS, ZipFormatError, type ZipArchive, type ZipLimits } from './zip';

export interface DocxMedia {
  image: WordImage;
  bytes: Buffer;
}

export interface DocxReadResult {
  document: WordDocument;
  /** Contenu des images incorporées, dans l'ordre de `document.images` (celles qui ont pu être lues). */
  media: DocxMedia[];
}

export interface ReadDocxOptions {
  /** Nom du fichier, pour les messages (« rapport.docx »). */
  label?: string;
  limits?: ZipLimits;
}

// ---------------------------------------------------------------------------------------------
// Point d'entrée

/** Lit un .docx (contenu du fichier) ; lève une `DocxError` si le fichier est refusé. */
export function readDocx(input: Buffer, options: ReadDocxOptions = {}): DocxReadResult {
  const label = options.label ? `« ${options.label} »` : 'Le fichier';
  const limits = options.limits ?? ZIP_LIMITS;
  if (!input.length) throw new DocxError('empty', `${label} est vide.`);
  if (input.length > limits.inputBytes) {
    throw new DocxError('too-large', `${label} est trop lourd (${megabytes(input.length)}, ${megabytes(limits.inputBytes)} au plus).`);
  }
  if (input.length >= 8 && input.readUInt32BE(0) === 0xd0cf11e0 && input.readUInt32BE(4) === 0xa1b11ae1) {
    // Conteneur OLE : ce qu'écrit Word 97-2003, et ce qu'écrit Word pour un .docx protégé par mot de passe
    // (le vrai paquet y est chiffré dans le flux « EncryptedPackage »).
    if (input.includes(Buffer.from('EncryptedPackage', 'utf16le'))) {
      throw new DocxError(
        'encrypted',
        `${label} est protégé par un mot de passe : ouvrez-le dans Word, retirez le mot de passe (Fichier > Informations > Protéger le document > Chiffrer avec mot de passe) et enregistrez-le au format .docx.`,
      );
    }
    throw new DocxError('legacy-doc', `${label} est un document Word 97-2003 (.doc) : ouvrez-le dans Word et enregistrez-le au format .docx (Fichier > Enregistrer sous > Document Word).`);
  }

  let zip: ZipArchive;
  try {
    zip = openZip(input, limits);
  } catch (error) {
    if (error instanceof ZipFormatError) throw new DocxError('not-zip', `${label} n'est pas un fichier .docx lisible : ${error.message}.`);
    throw error;
  }

  const warnings: string[] = [];
  const bomb = (part: string, error: Error) =>
    new DocxError('too-large', `${label} est refusé : ${part} dépasse les limites de décompression (${error.message}). Archive anormale, peut-être une « bombe de décompression ».`);
  // Une entrée qui dépasse le budget de décompression refuse tout le fichier : un .docx normal n'en a pas.
  const readPart = (name: string): Buffer => {
    try {
      return zip.read(name);
    } catch (error) {
      if (error instanceof ZipLimitError) throw bomb(name, error);
      throw error;
    }
  };
  const readXml = (name: string | undefined, required = false): string | undefined => {
    const found = name && zip.find(name);
    if (!found) return undefined;
    try {
      return decodeXml(readPart(found));
    } catch (error) {
      if (error instanceof DocxError) throw error;
      if (required) throw new DocxError('corrupt', `${label} est abîmé : ${found} est illisible (${(error as Error).message}).`);
      warnings.push(`${found} illisible, ignoré (${(error as Error).message}).`);
      return undefined;
    }
  };

  const docPath = locateMainDocument(zip, readXml);
  if (!docPath) throw new DocxError('not-word', `${label} est une archive zip, mais pas un document Word : word/document.xml est absent.`);
  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const relsXml = readXml(joinPart(docDir, `_rels/${docPath.slice(docDir.length).replace(/^\//, '')}.rels`));
  const docRels = readRels(parseXml(relsXml ?? ''));
  const partOf = (suffix: string, fallback: string) => {
    for (const rel of docRels.values()) if (!rel.external && rel.type.endsWith(suffix)) return resolvePart(docDir, rel.target);
    return joinPart(docDir, fallback);
  };

  const document = convertDocument(readXml(docPath, true)!, {
    stylesXml: readXml(partOf('/styles', 'styles.xml')),
    numberingXml: readXml(partOf('/numbering', 'numbering.xml')),
    themeXml: readXml(partOf('/theme', 'theme/theme1.xml')),
    rels: docRels,
    partDir: docDir,
  });
  document.warnings.unshift(...warnings);

  const media: DocxMedia[] = [];
  for (const image of document.images) {
    const found = zip.find(image.part);
    try {
      if (!found) throw new Error('absente de l’archive');
      media.push({ image, bytes: readPart(found) });
    } catch (error) {
      if (error instanceof DocxError) throw error;
      document.warnings.push(`Image « ${image.name} » illisible (${(error as Error).message}) : non importée.`);
    }
  }
  return { document, media };
}

// ---------------------------------------------------------------------------------------------
// Paquet : parties et relations

interface Rel {
  type: string;
  target: string;
  external: boolean;
}

function joinPart(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function resolvePart(baseDir: string, target: string): string {
  const clean = String(target).replace(/\\/g, '/');
  const parts = clean.startsWith('/') ? [] : String(baseDir).split('/').filter(Boolean);
  for (const segment of clean.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function readRels(root: XmlNode): Map<string, Rel> {
  const rels = new Map<string, Rel>();
  for (const rel of kids(find(root, 'Relationships'), 'Relationship')) {
    if (!rel.attrs.Id) continue;
    rels.set(rel.attrs.Id, { type: rel.attrs.Type ?? '', target: rel.attrs.Target ?? '', external: /^external$/i.test(rel.attrs.TargetMode ?? '') });
  }
  return rels;
}

function locateMainDocument(zip: ZipArchive, readXml: (name: string) => string | undefined): string | undefined {
  const rootRels = readRels(parseXml(readXml('_rels/.rels') ?? ''));
  for (const rel of rootRels.values()) {
    if (rel.external || !rel.type.endsWith('/officeDocument')) continue;
    const found = zip.find(resolvePart('', rel.target));
    if (found) return found;
  }
  return zip.find('word/document.xml');
}

// ---------------------------------------------------------------------------------------------
// Styles, thème, numérotation

/** « heading 2 », « Titre 2 » (Word en français) → 2 ; 0 sinon. */
function headingFromName(name: string | undefined): number {
  const numbered = /^(?:heading|titre)\s*([1-9])$/i.exec(String(name ?? '').trim());
  return numbered ? Math.min(Number(numbered[1]), 6) : 0;
}

const isTitleName = (name: string | undefined) => /^(?:title|titre)$/i.test(String(name ?? '').trim());

interface FontRef {
  name?: string;
  theme?: string;
}

interface RawStyle {
  type: string;
  name: string;
  basedOn?: string;
  outline?: string;
  numId?: string;
  ilvl?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  jc?: string;
  colors: string[];
  fonts: FontRef[];
}

/** Couleurs d'un rPr : couleur du texte (hors « automatique » et noir), surlignage. */
function rPrColors(rPr: XmlNode | undefined): string[] {
  const out: string[] = [];
  const color = val(child(rPr, 'w:color'));
  if (color && /^[0-9a-f]{6}$/i.test(color) && color !== '000000') out.push(`#${color.toLowerCase()}`);
  const highlight = val(child(rPr, 'w:highlight'));
  if (highlight && highlight !== 'none') out.push(`surlignage ${highlight}`);
  return out;
}

function rPrFonts(rPr: XmlNode | undefined): FontRef[] {
  const f = child(rPr, 'w:rFonts');
  if (!f) return [];
  const out: FontRef[] = [];
  const name = f.attrs['w:ascii'] ?? f.attrs['w:hAnsi'];
  if (name) out.push({ name });
  const theme = f.attrs['w:asciiTheme'] ?? f.attrs['w:hAnsiTheme'];
  if (theme) out.push({ theme });
  return out;
}

const underlined = (rPr: XmlNode | undefined): boolean | undefined => {
  const u = child(rPr, 'w:u');
  if (!u) return undefined;
  return !/^none$/i.test(u.attrs['w:val'] ?? 'single');
};

function readStyles(root: XmlNode) {
  const styles = find(root, 'w:styles');
  const byId = new Map<string, RawStyle>();
  let defaultParagraph: string | undefined;
  for (const style of kids(styles, 'w:style')) {
    const id = style.attrs['w:styleId'];
    if (!id) continue;
    const type = style.attrs['w:type'] ?? 'paragraph';
    const pPr = child(style, 'w:pPr');
    const rPr = child(style, 'w:rPr');
    const numPr = child(pPr, 'w:numPr');
    if (type === 'paragraph' && /^(1|true|on)$/i.test(style.attrs['w:default'] ?? '')) defaultParagraph ??= id;
    byId.set(id, {
      type,
      name: val(child(style, 'w:name')) ?? '',
      basedOn: val(child(style, 'w:basedOn')),
      outline: val(child(pPr, 'w:outlineLvl')),
      numId: val(child(numPr, 'w:numId')),
      ilvl: val(child(numPr, 'w:ilvl')),
      b: onOff(child(rPr, 'w:b')),
      i: onOff(child(rPr, 'w:i')),
      u: underlined(rPr),
      jc: val(child(pPr, 'w:jc')),
      colors: rPrColors(rPr),
      fonts: rPrFonts(rPr),
    });
  }
  const defaultsRPr = find(find(styles, 'w:docDefaults'), 'w:rPr');
  const defaultFonts = rPrFonts(defaultsRPr);

  // Remonte la chaîne basedOn ; la limite de profondeur protège d'une boucle dans un styles.xml abîmé.
  const inherit = <T>(id: string | undefined, pick: (style: RawStyle | undefined, styleId: string) => T | undefined): T | undefined => {
    for (let depth = 0; id && depth < 20; depth++) {
      const style = byId.get(id);
      const value = pick(style, id);
      if (value !== undefined) return value;
      id = style?.basedOn;
    }
    return undefined;
  };
  const chain = (id: string | undefined): RawStyle[] => {
    const out: RawStyle[] = [];
    for (let depth = 0; id && depth < 20; depth++) {
      const style = byId.get(id);
      if (!style) break;
      out.push(style);
      id = style.basedOn;
    }
    return out;
  };

  const kindCache = new Map<string, { heading: number; title: boolean }>();
  return {
    defaultParagraph,
    defaultFonts,
    name: (id: string | undefined) => (id ? (byId.get(id)?.name ?? id) : undefined),
    exists: (id: string | undefined) => !!id && byId.has(id),
    /** Titre (et son niveau) ou « Titre » du document, d'après le nom du style ou son niveau hiérarchique. */
    kind(id: string | undefined): { heading: number; title: boolean } {
      if (!id) return { heading: 0, title: false };
      let cached = kindCache.get(id);
      if (!cached) {
        const title = !!inherit(id, (style, styleId) => (isTitleName(style?.name) || (!style && isTitleName(styleId)) ? true : undefined));
        const heading = title
          ? 0
          : (inherit(id, (style, styleId) => {
              const byName = headingFromName(style?.name);
              if (byName) return byName;
              if (style?.outline !== undefined) {
                const level = parseInt(style.outline, 10);
                if (level >= 0 && level < 9) return Math.min(level + 1, 6);
                if (level === 9) return 0;
              }
              return headingFromName(styleId) || undefined;
            }) ?? 0);
        cached = { heading, title };
        kindCache.set(id, cached);
      }
      return cached;
    },
    numPr: (id: string | undefined) => inherit(id, (style) => (style?.numId !== undefined ? { numId: style.numId, ilvl: style.ilvl } : undefined)),
    /** Mise en forme d'un style de caractère (w:rStyle) : ce que le segment reçoit en plus de son paragraphe. */
    runProps: (id: string | undefined) => ({ b: inherit(id, (s) => s?.b), i: inherit(id, (s) => s?.i), u: inherit(id, (s) => s?.u) }),
    /** Gras / italique d'un style de paragraphe, hérités compris. */
    paragraphRunProps: (id: string | undefined) => ({ b: inherit(id, (s) => s?.b), i: inherit(id, (s) => s?.i) }),
    align: (id: string | undefined) => inherit(id, (s) => s?.jc),
    /** Couleurs et polices d'un style et de ses parents. */
    look: (id: string | undefined) => {
      const styles = chain(id);
      return { colors: styles.flatMap((s) => s.colors), fonts: styles.flatMap((s) => s.fonts) };
    },
  };
}

type Styles = ReturnType<typeof readStyles>;

/** Polices du thème (titres = major, texte = minor) : c'est là que vivent Calibri, Aptos… */
function readTheme(root: XmlNode): { major?: string; minor?: string } {
  const scheme = find(root, 'a:fontScheme');
  const typeface = (name: string) => child(child(scheme, name), 'a:latin')?.attrs.typeface || undefined;
  return { major: typeface('a:majorFont'), minor: typeface('a:minorFont') };
}

interface LevelDef {
  fmt?: string;
  start?: string;
  text?: string;
}

function readNumbering(root: XmlNode, styles: Styles) {
  const numbering = find(root, 'w:numbering');
  const readLevel = (lvl: XmlNode): LevelDef => ({ fmt: val(child(lvl, 'w:numFmt')), start: val(child(lvl, 'w:start')), text: val(child(lvl, 'w:lvlText')) });
  const abstracts = new Map<string | undefined, { levels: Map<number, LevelDef>; styleLink?: string }>();
  for (const abstract of kids(numbering, 'w:abstractNum')) {
    const levels = new Map<number, LevelDef>();
    for (const lvl of kids(abstract, 'w:lvl')) levels.set(parseInt(lvl.attrs['w:ilvl'] ?? '0', 10), readLevel(lvl));
    abstracts.set(abstract.attrs['w:abstractNumId'], { levels, styleLink: val(child(abstract, 'w:numStyleLink')) });
  }
  const nums = new Map<string | undefined, { abstract?: string; overrides: Map<number, LevelDef> }>();
  for (const num of kids(numbering, 'w:num')) {
    const overrides = new Map<number, LevelDef>();
    for (const override of kids(num, 'w:lvlOverride')) {
      const lvl = child(override, 'w:lvl');
      const base = lvl ? readLevel(lvl) : {};
      overrides.set(parseInt(override.attrs['w:ilvl'] ?? '0', 10), { ...base, start: val(child(override, 'w:startOverride')) ?? base.start });
    }
    nums.set(num.attrs['w:numId'], { abstract: val(child(num, 'w:abstractNumId')), overrides });
  }

  const level = (numId: string, ilvl: number, depth = 0): { fmt: string; start: number; text?: string } | null => {
    const num = nums.get(numId);
    const abstract = num && abstracts.get(num.abstract);
    if (!num || !abstract) return null;
    // Une liste peut n'être qu'un renvoi vers un style de liste qui porte la vraie définition.
    if (!abstract.levels.size && abstract.styleLink && depth < 5) {
      const linked = styles.numPr(abstract.styleLink);
      if (linked?.numId && linked.numId !== numId) return level(linked.numId, ilvl, depth + 1);
    }
    const override = num.overrides.get(ilvl);
    const base = abstract.levels.get(ilvl);
    if (!override && !base) return null;
    const start = parseInt(override?.start ?? base?.start ?? '1', 10);
    return { fmt: override?.fmt ?? base?.fmt ?? 'decimal', start: Number.isFinite(start) ? start : 1, text: override?.text ?? base?.text };
  };
  return { level };
}

// ---------------------------------------------------------------------------------------------
// Conversion

interface Field {
  phase: 'code' | 'result';
  code: string;
  hide: boolean;
  link: string | null;
}

interface Ctx {
  warn(message: string): void;
  styles: Styles;
  numbering: ReturnType<typeof readNumbering>;
  theme: { major?: string; minor?: string };
  rels: Map<string, Rel>;
  partDir: string;
  images: WordImage[];
  imagesByPart: Map<string, WordImage>;
  imageNames: Set<string>;
  fields: Field[];
  counters: Map<string, number[]>;
  tables: number;
  notes: number;
  usedStyles: Set<string>;
  usedCharacterStyles: Set<string>;
  fonts: Set<string>;
  colors: Set<string>;
}

interface ConvertOptions {
  stylesXml?: string;
  numberingXml?: string;
  themeXml?: string;
  rels: Map<string, Rel>;
  partDir: string;
}

function convertDocument(documentXml: string, options: ConvertOptions): WordDocument {
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const parsePart = (xml: string | undefined, label: string) => parseXml(xml ?? '', (message) => warn(`${label} : ${message}`));
  const styles = readStyles(parsePart(options.stylesXml, 'styles.xml'));
  const ctx: Ctx = {
    warn,
    styles,
    numbering: readNumbering(parsePart(options.numberingXml, 'numbering.xml'), styles),
    theme: readTheme(parsePart(options.themeXml, 'theme1.xml')),
    rels: options.rels,
    partDir: options.partDir,
    images: [],
    imagesByPart: new Map(),
    imageNames: new Set(),
    fields: [],
    counters: new Map(),
    tables: 0,
    notes: 0,
    usedStyles: new Set(),
    usedCharacterStyles: new Set(),
    fonts: new Set(),
    colors: new Set(),
  };

  const body = find(parsePart(documentXml, 'document.xml'), 'w:body');
  const blocks: WordBlock[] = [];
  if (!body) warn('word/document.xml ne contient pas de w:body : document vide ou format inattendu.');
  for (const node of body?.children ?? []) {
    // Un élément inattendu ne doit coûter que lui-même, pas tout le document.
    try {
      convertBlocks([node], ctx, blocks, false);
    } catch (error) {
      warn(`Élément ${node.name} ignoré : ${(error as Error).message}`);
    }
  }
  if (ctx.notes) warn(`${ctx.notes} appel(s) de note de bas de page ou de fin : le texte des notes n'est pas importé.`);

  // Polices et couleurs : texte (relevées au fil des segments), styles employés, valeurs par défaut du document.
  const addFonts = (refs: FontRef[]) => {
    for (const ref of refs) {
      const name = ref.name ?? (ref.theme ? (/^major/i.test(ref.theme) ? ctx.theme.major : ctx.theme.minor) : undefined);
      if (name) ctx.fonts.add(name);
    }
  };
  for (const id of [...ctx.usedStyles, ...ctx.usedCharacterStyles]) {
    const look = styles.look(id);
    look.colors.forEach((c) => ctx.colors.add(c));
    addFonts(look.fonts);
  }
  addFonts(styles.defaultFonts);
  // Sans police déclarée nulle part, Word compose avec la police « texte » du thème.
  if (!ctx.fonts.size && ctx.theme.minor) ctx.fonts.add(ctx.theme.minor);

  const wordStyles: Record<string, WordStyle> = {};
  for (const id of ctx.usedStyles) {
    const kind = styles.kind(id);
    const runProps = styles.paragraphRunProps(id);
    wordStyles[id] = {
      id,
      name: styles.name(id) ?? id,
      ...(kind.heading ? { heading: kind.heading } : {}),
      ...(runProps.b !== undefined ? { bold: runProps.b } : {}),
      ...(runProps.i !== undefined ? { italic: runProps.i } : {}),
    };
  }

  return { blocks, images: ctx.images, styles: wordStyles, fonts: [...ctx.fonts].sort(), colors: [...ctx.colors], warnings };
}

function skippedContentControl(sdt: XmlNode): boolean {
  const sdtPr = child(sdt, 'w:sdtPr');
  if (child(sdtPr, 'w:showingPlcHdr')) return true;
  return /table of contents/i.test(val(find(sdtPr, 'w:docPartGallery')) ?? '');
}

/** Contenu alternatif (mc:AlternateContent) : la variante moderne d'abord, l'ancienne à défaut. */
function alternative(node: XmlNode): XmlNode[] {
  return (child(node, 'mc:Choice') ?? child(node, 'mc:Fallback'))?.children ?? [];
}

const SKIPPED_BLOCKS = new Set(['w:del', 'w:moveFrom', 'w:sectPr', 'w:sdtPr', 'w:sdtEndPr', 'w:tcPr', 'w:tblPr', 'w:tblGrid', 'w:trPr', 'w:pPr']);

function convertBlocks(nodes: XmlNode[], ctx: Ctx, out: WordBlock[], cell: boolean): void {
  for (const node of nodes) {
    if (SKIPPED_BLOCKS.has(node.name)) continue;
    if (node.name === 'w:p') paragraph(node, ctx, out, cell);
    else if (node.name === 'w:tbl') table(node, ctx, out, cell);
    else if (node.name === 'w:sdt' && skippedContentControl(node)) continue;
    else if (node.name === 'mc:AlternateContent') convertBlocks(alternative(node), ctx, out, cell);
    else if (node.name === 'w:altChunk') ctx.warn('Contenu inséré tel quel (altChunk) ignoré : ouvrez le document dans Word et enregistrez-le pour l’intégrer.');
    else if (node.children.length) convertBlocks(node.children, ctx, out, cell);
  }
}

const ALIGN: Record<string, WordAlign> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', thaiDistribute: 'justify' };

interface InlineState {
  content: WordInline[];
  extra: WordBlock[];
  link: string | null;
}

const hasText = (content: WordInline[]) => content.some((c) => c.type === 'text' && c.text.trim() !== '');

function paragraph(p: XmlNode, ctx: Ctx, out: WordBlock[], cell: boolean): void {
  const pPr = child(p, 'w:pPr');
  // Sans style explicite, le paragraphe suit le style de paragraphe par défaut (« Normal »).
  const styleId = val(child(pPr, 'w:pStyle')) ?? ctx.styles.defaultParagraph;
  const state: InlineState = { content: [], extra: [], link: null };
  inline(p.children, ctx, state, cell);
  if (ctx.fields.some((f) => f.phase === 'code')) {
    // Un code de champ ne traverse pas la fin d'un paragraphe : sans ce garde-fou, un champ mal fermé
    // masquerait tout le reste du document.
    ctx.fields = ctx.fields.filter((f) => f.phase !== 'code');
    ctx.warn('Champ Word mal formé ignoré.');
  }

  const kind = headingOf(pPr, styleId, ctx);
  const list = kind.heading || kind.title ? null : listItem(pPr, styleId, ctx);
  const content = mergeTexts(state.content);
  if (hasText(content) || content.some((c) => c.type === 'image')) {
    if (styleId) ctx.usedStyles.add(styleId);
    const jc = val(child(pPr, 'w:jc')) ?? ctx.styles.align(styleId);
    const align = jc ? ALIGN[jc] : undefined;
    const para: WordParagraph = {
      type: 'paragraph',
      ...(styleId ? { styleId, styleName: ctx.styles.name(styleId) ?? styleId } : {}),
      ...(kind.heading ? { heading: kind.heading } : {}),
      ...(kind.title ? { title: true } : {}),
      ...(list ? { list: listInfo(list, ctx) } : {}),
      ...(align && align !== 'left' ? { align } : {}),
      content,
    };
    out.push(para);
  }
  out.push(...state.extra);
}

function headingOf(pPr: XmlNode | undefined, styleId: string | undefined, ctx: Ctx): { heading: number; title: boolean } {
  const direct = val(child(pPr, 'w:outlineLvl'));
  if (direct !== undefined) {
    const level = parseInt(direct, 10);
    return { heading: level >= 0 && level < 9 ? Math.min(level + 1, 6) : 0, title: false };
  }
  return ctx.styles.kind(styleId);
}

function listItem(pPr: XmlNode | undefined, styleId: string | undefined, ctx: Ctx): { numId: string; level: number } | null {
  const numPr = child(pPr, 'w:numPr');
  let numId = val(child(numPr, 'w:numId'));
  let ilvl = val(child(numPr, 'w:ilvl'));
  if (numId === undefined) {
    const fromStyle = ctx.styles.numPr(styleId);
    numId = fromStyle?.numId;
    ilvl ??= fromStyle?.ilvl;
  }
  // numId 0 : la numérotation héritée du style est explicitement retirée.
  if (numId === undefined || numId === '0') return null;
  return { numId, level: Math.min(Math.max(parseInt(ilvl ?? '0', 10) || 0, 0), 8) };
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/** Numéro dans le format Word (decimal, lowerLetter, upperRoman…), pour le texte du numéro. */
function formatNumber(n: number, fmt: string | undefined): string {
  switch (fmt) {
    case 'lowerLetter':
    case 'upperLetter': {
      // Word répète la lettre après z : aa, bb…
      const letter = String.fromCharCode(97 + ((Math.max(1, n) - 1) % 26)).repeat(Math.floor((Math.max(1, n) - 1) / 26) + 1);
      return fmt === 'upperLetter' ? letter.toUpperCase() : letter;
    }
    case 'lowerRoman':
    case 'upperRoman': {
      let rest = Math.max(1, Math.min(n, 3999));
      let roman = '';
      for (const [value, digits] of ROMAN) {
        while (rest >= value) {
          roman += digits;
          rest -= value;
        }
      }
      return fmt === 'upperRoman' ? roman.toUpperCase() : roman;
    }
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n);
    default:
      return String(n);
  }
}

function listInfo(item: { numId: string; level: number }, ctx: Ctx): WordList {
  const def = ctx.numbering.level(item.numId, item.level);
  if (!def) ctx.warn(`Numérotation inconnue (numId ${item.numId}, niveau ${item.level}) : rendue en liste à puces.`);
  const fmt = def?.fmt ?? 'bullet';
  if (fmt === 'bullet' || fmt === 'none') return { kind: 'bullet', level: item.level, marker: '•' };
  let counters = ctx.counters.get(item.numId);
  if (!counters) ctx.counters.set(item.numId, (counters = []));
  const number = counters[item.level] === undefined ? def!.start : counters[item.level] + 1;
  counters[item.level] = number;
  // Comme dans Word, un élément de niveau supérieur fait repartir la numérotation de ses sous-niveaux.
  counters.length = item.level + 1;
  const text = def!.text ?? `%${item.level + 1}.`;
  const marker = text.replace(/%([1-9])/g, (_m, k: string) => {
    const lvl = Number(k) - 1;
    const value = lvl === item.level ? number : (counters![lvl] ?? ctx.numbering.level(item.numId, lvl)?.start ?? 1);
    return formatNumber(value, lvl === item.level ? fmt : ctx.numbering.level(item.numId, lvl)?.fmt);
  });
  return { kind: 'number', level: item.level, number, format: fmt, marker: marker.trim() || `${number}.` };
}

/** Textes voisins de même mise en forme réunis : la structure reste lisible. */
function mergeTexts(content: WordInline[]): WordInline[] {
  const out: WordInline[] = [];
  for (const item of content) {
    const last = out.at(-1);
    if (
      item.type === 'text' &&
      last?.type === 'text' &&
      last.bold === item.bold &&
      last.italic === item.italic &&
      last.underline === item.underline &&
      last.link === item.link
    ) {
      out[out.length - 1] = { ...last, text: last.text + item.text };
    } else out.push(item.type === 'text' ? { ...item } : item);
  }
  return out;
}

const SKIPPED_INLINE = new Set(['w:pPr', 'w:rPr', 'w:del', 'w:moveFrom', 'w:sdtPr', 'w:sdtEndPr', 'w:customXmlPr', 'w:smartTagPr']);

function inline(nodes: XmlNode[], ctx: Ctx, state: InlineState, cell: boolean): void {
  for (const node of nodes) {
    if (SKIPPED_INLINE.has(node.name)) continue;
    switch (node.name) {
      case 'w:r':
        run(node, ctx, state, cell);
        break;
      case 'w:hyperlink': {
        const saved = state.link;
        state.link = hyperlinkTarget(node, ctx) ?? saved;
        inline(node.children, ctx, state, cell);
        state.link = saved;
        break;
      }
      case 'w:fldSimple': {
        const field = readFieldCode(node.attrs['w:instr'] ?? '');
        if (field.hide) break;
        const saved = state.link;
        state.link = field.link ?? saved;
        inline(node.children, ctx, state, cell);
        state.link = saved;
        break;
      }
      case 'w:sdt':
        if (!skippedContentControl(node)) inline(node.children, ctx, state, cell);
        break;
      case 'mc:AlternateContent':
        inline(alternative(node), ctx, state, cell);
        break;
      case 'm:oMath':
      case 'm:oMathPara':
        math(node, ctx, state);
        break;
      default:
        if (node.children.length) inline(node.children, ctx, state, cell);
    }
  }
}

function hyperlinkTarget(node: XmlNode, ctx: Ctx): string | null {
  const id = node.attrs['r:id'];
  // Sans r:id, c'est une ancre interne (w:anchor) : seul le texte est gardé.
  if (!id) return null;
  const rel = ctx.rels.get(id);
  if (!rel?.target) {
    ctx.warn(`Le lien ${id} n'a pas de cible dans les relations du document : texte gardé sans le lien.`);
    return null;
  }
  return rel.target;
}

interface RunFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  hidden: boolean;
}

function run(r: XmlNode, ctx: Ctx, state: InlineState, cell: boolean): void {
  const rPr = child(r, 'w:rPr');
  const rStyle = val(child(rPr, 'w:rStyle'));
  if (rStyle) ctx.usedCharacterStyles.add(rStyle);
  const base = ctx.styles.runProps(rStyle);
  const directU = underlined(rPr);
  const format: RunFormat = {
    bold: onOff(child(rPr, 'w:b')) ?? base.b,
    italic: onOff(child(rPr, 'w:i')) ?? base.i,
    // Le soulignement du style « Lien hypertexte » ne dit rien du texte : un lien devient du texte simple.
    underline: directU ?? (currentLink(ctx, state) ? undefined : base.u),
    hidden: !!(onOff(child(rPr, 'w:vanish')) || onOff(child(rPr, 'w:webHidden'))),
  };
  if (!format.hidden) {
    rPrColors(rPr).forEach((c) => ctx.colors.add(c));
    for (const ref of rPrFonts(rPr)) {
      const name = ref.name ?? (ref.theme ? (/^major/i.test(ref.theme) ? ctx.theme.major : ctx.theme.minor) : undefined);
      if (name) ctx.fonts.add(name);
    }
  }
  for (const node of r.children) {
    switch (node.name) {
      case 'w:t':
        emitText(ctx, state, format, node.text.replace(/[\r\n]/g, ' '));
        break;
      case 'w:tab':
      case 'w:ptab':
        emitText(ctx, state, format, '\t');
        break;
      case 'w:noBreakHyphen':
        emitText(ctx, state, format, '-');
        break;
      case 'w:br':
        if (!/^(page|column)$/.test(node.attrs['w:type'] ?? '')) emitText(ctx, state, format, '\n');
        break;
      case 'w:cr':
        emitText(ctx, state, format, '\n');
        break;
      case 'w:fldChar':
        fieldChar(node, ctx);
        break;
      case 'w:instrText': {
        const field = ctx.fields[ctx.fields.length - 1];
        if (field?.phase === 'code') field.code += node.text;
        break;
      }
      case 'w:drawing':
      case 'w:pict':
      case 'w:object':
      case 'mc:AlternateContent':
        drawing(node, ctx, state, format, cell);
        break;
      case 'w:footnoteReference':
      case 'w:endnoteReference':
        ctx.notes++;
        break;
      default:
        // w:delText, w:commentReference, w:sym, w:softHyphen, w:lastRenderedPageBreak… : rien à rendre.
        break;
    }
  }
}

// Champs dont le résultat est de la mise en page (sommaire, numéros de page) plutôt que du contenu.
const LAYOUT_FIELDS = new Set(['TOC', 'PAGE', 'NUMPAGES', 'SECTIONPAGES', 'PAGEREF', 'INDEX', 'TOA']);

function readFieldCode(code: string): { hide: boolean; link: string | null } {
  const keyword = (/^\s*([A-Za-z]+)/.exec(code)?.[1] ?? '').toUpperCase();
  let link: string | null = null;
  if (keyword === 'HYPERLINK' && !/\\l\b/.test(code)) link = /"([^"]+)"/.exec(code)?.[1] ?? /HYPERLINK\s+(\S+)/i.exec(code)?.[1] ?? null;
  return { hide: LAYOUT_FIELDS.has(keyword), link };
}

function fieldChar(node: XmlNode, ctx: Ctx): void {
  const type = node.attrs['w:fldCharType'];
  if (type === 'begin') ctx.fields.push({ phase: 'code', code: '', hide: false, link: null });
  else if (type === 'separate') {
    const field = ctx.fields[ctx.fields.length - 1];
    if (field?.phase === 'code') Object.assign(field, { phase: 'result' }, readFieldCode(field.code));
  } else if (type === 'end') ctx.fields.pop();
}

/** Le code d'un champ n'est jamais du contenu ; son résultat l'est, sauf pour les champs de mise en page. */
const fieldHidden = (ctx: Ctx) => ctx.fields.some((f) => f.phase === 'code' || f.hide);

function currentLink(ctx: Ctx, state: InlineState): string | null {
  if (state.link) return state.link;
  for (let k = ctx.fields.length - 1; k >= 0; k--) if (ctx.fields[k].link) return ctx.fields[k].link;
  return null;
}

function emitText(ctx: Ctx, state: InlineState, format: RunFormat, text: string): void {
  if (!text || format.hidden || fieldHidden(ctx)) return;
  const link = currentLink(ctx, state);
  const item: WordText = { type: 'text', text };
  if (format.bold !== undefined) item.bold = format.bold;
  if (format.italic !== undefined) item.italic = format.italic;
  if (format.underline !== undefined) item.underline = format.underline;
  if (link) item.link = link;
  state.content.push(item);
}

interface DrawingScan {
  images: { node: XmlNode; alt: string }[];
  boxes: XmlNode[];
  unsupported: boolean;
  alt: string;
}

function drawing(node: XmlNode, ctx: Ctx, state: InlineState, format: RunFormat, cell: boolean): void {
  if (format.hidden || fieldHidden(ctx)) return;
  const found: DrawingScan = { images: [], boxes: [], unsupported: false, alt: '' };
  // Parent factice : le nœud lui-même passe par l'aiguillage, et un mc:AlternateContent direct ne lit
  // qu'une de ses variantes, pas les deux.
  scanDrawing({ name: '#', attrs: {}, children: [node], text: '' }, found);
  for (const image of found.images) {
    const id = imageRef(image, ctx);
    if (id) state.content.push({ type: 'image', image: id });
  }
  for (const box of found.boxes) convertBlocks(box.children, ctx, state.extra, cell);
  if (!found.images.length && !found.boxes.length && found.unsupported) {
    ctx.warn('Graphique ou SmartArt non importé : seuls le texte et les images du document le sont.');
  }
}

function scanDrawing(node: XmlNode, found: DrawingScan): void {
  const count = () => found.images.length + found.boxes.length;
  for (const c of node.children) {
    if (c.name === 'w:txbxContent') found.boxes.push(c);
    else if (c.name === 'a:blip' || c.name === 'v:imagedata') found.images.push({ node: c, alt: found.alt });
    else if (c.name === 'mc:AlternateContent') {
      const before = count();
      const choice = child(c, 'mc:Choice');
      if (choice) scanDrawing(choice, found);
      // La variante de repli n'est lue que si la moderne n'a rien donné d'utilisable : pour un graphique
      // récent, elle ne contient qu'un message « non disponible dans votre version de Word ».
      const fallback = child(c, 'mc:Fallback');
      if (count() === before && !found.unsupported && fallback) scanDrawing(fallback, found);
    } else {
      if (c.name === 'wp:docPr') found.alt = c.attrs.descr || c.attrs.title || '';
      if (/:(chart|relIds)$/.test(c.name)) found.unsupported = true;
      scanDrawing(c, found);
    }
  }
}

function imageRef({ node, alt }: { node: XmlNode; alt: string }, ctx: Ctx): string | null {
  const id = node.attrs['r:embed'] ?? node.attrs['r:id'] ?? node.attrs['r:link'];
  if (!id) return null;
  const rel = ctx.rels.get(id);
  if (!rel?.target) {
    ctx.warn(`L'image ${id} n'a pas de cible dans les relations du document : ignorée.`);
    return null;
  }
  if (rel.external) {
    ctx.warn(`Image liée (hors du fichier) ignorée : ${rel.target}. Incorporez-la dans le document Word pour l'importer.`);
    return null;
  }
  const part = resolvePart(ctx.partDir, rel.target);
  let image = ctx.imagesByPart.get(part);
  if (!image) {
    image = { id: `img${ctx.images.length + 1}`, part, name: uniqueMediaName(ctx, part) };
    const label = String(alt ?? '').replace(/\s+/g, ' ').trim();
    if (label) image.alt = label;
    ctx.imagesByPart.set(part, image);
    ctx.images.push(image);
  }
  return image.id;
}

/** Nom de fichier sûr (sans séparateur ni caractère interdit sous Windows), unique quelle que soit la casse. */
function uniqueMediaName(ctx: Ctx, part: string): string {
  let name = (part.split('/').pop() ?? '').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'image';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ctx.imageNames.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
  ctx.imageNames.add(name.toLowerCase());
  return name;
}

function math(node: XmlNode, ctx: Ctx, state: InlineState): void {
  if (fieldHidden(ctx)) return;
  const parts: string[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === 'm:t') parts.push(c.text);
      else walk(c);
    }
  };
  walk(node);
  const text = parts.join('').trim();
  if (!text) return;
  state.content.push({ type: 'text', text });
  ctx.warn('Équation(s) importée(s) en texte simple, sans mise en forme mathématique.');
}

// ---------------------------------------------------------------------------------------------
// Tableaux

function collectChildren(node: XmlNode, name: string, skip: Set<string>): XmlNode[] {
  const found: XmlNode[] = [];
  for (const c of node.children) {
    if (c.name === name) found.push(c);
    else if (!skip.has(c.name)) found.push(...collectChildren(c, name, skip));
  }
  return found;
}

const ROW_SKIP = new Set(['w:tblPr', 'w:tblGrid', 'w:del', 'w:moveFrom', 'w:sdtPr', 'w:sdtEndPr']);
const CELL_SKIP = new Set(['w:trPr', 'w:tblPrEx', 'w:del', 'w:moveFrom', 'w:sdtPr', 'w:sdtEndPr']);

const emptyCell = (): WordTableCell => ({ paragraphs: [] });

function table(tbl: XmlNode, ctx: Ctx, out: WordBlock[], cell: boolean): void {
  const index = ++ctx.tables;
  let merged = false;
  const rows: WordTableCell[][] = [];
  for (const tr of collectChildren(tbl, 'w:tr', ROW_SKIP)) {
    const trPr = child(tr, 'w:trPr');
    if (child(trPr, 'w:del')) continue;
    const cells: WordTableCell[] = [];
    const pad = (count: number) => {
      for (let k = 0; k < count; k++) cells.push(emptyCell());
    };
    pad(parseInt(val(child(trPr, 'w:gridBefore')) ?? '0', 10) || 0);
    for (const tc of collectChildren(tr, 'w:tc', CELL_SKIP)) {
      const tcPr = child(tc, 'w:tcPr');
      const span = Math.max(1, parseInt(val(child(tcPr, 'w:gridSpan')) ?? '1', 10) || 1);
      const vMerge = child(tcPr, 'w:vMerge');
      const hMerge = child(tcPr, 'w:hMerge');
      if (span > 1 || vMerge || hMerge) merged = true;
      // Une cellule qui prolonge une fusion n'a pas de texte à elle : elle reste vide.
      const continued = [vMerge, hMerge].some((m) => m && (m.attrs['w:val'] ?? 'continue') === 'continue');
      cells.push(continued ? emptyCell() : cellContent(tc, ctx));
      pad(span - 1);
    }
    pad(parseInt(val(child(trPr, 'w:gridAfter')) ?? '0', 10) || 0);
    rows.push(cells);
  }
  if (merged) ctx.warn(`Tableau ${index} : cellules fusionnées rendues approximativement (cellules vides ajoutées).`);
  if (!rows.length) return;
  const width = Math.max(1, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push(emptyCell());

  if (cell) {
    // Tableau dans une cellule : mis à plat, une ligne de texte par rangée, cellules séparées par « / ».
    ctx.warn(`Tableau ${index} imbriqué dans une cellule : mis à plat en texte.`);
    for (const r of rows) {
      const content: WordInline[] = [];
      for (const c of r) {
        const texts = c.paragraphs.flatMap((p) => p.content).filter((x): x is WordText => x.type === 'text' && x.text.trim() !== '');
        if (!texts.length) continue;
        if (content.length) content.push({ type: 'text', text: ' / ' });
        content.push(...texts);
      }
      if (content.length) out.push({ type: 'paragraph', content: mergeTexts(content) });
    }
    return;
  }
  const block: WordTable = { type: 'table', index, rows };
  out.push(block);
}

function cellContent(tc: XmlNode, ctx: Ctx): WordTableCell {
  const blocks: WordBlock[] = [];
  convertBlocks(tc.children, ctx, blocks, true);
  return { paragraphs: blocks.filter((b): b is WordParagraph => b.type === 'paragraph') };
}
