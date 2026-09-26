// API d'un agent IA qui pilote la page (Claude dans Chrome, Cowork…) : `window.fluidprint`, exposée sur
// l'accueil et dans l'éditeur, en production aussi (pas sur la route d'impression). Chaque modification
// passe par le store, comme un geste de l'utilisateur : une étape d'annulation (préfixée « Agent IA »),
// enregistrement automatique, objets touchés sélectionnés pour que l'utilisateur voie le résultat.
// Coordonnées en mm depuis le coin haut-gauche du FORMAT FINI (comme le panneau Propriétés et les règles) ;
// le modèle, lui, compte depuis le coin du fond perdu. Mode d'emploi : `fluidprint.help()` (guide.ts).
import { createStore } from 'zustand/vanilla';
import { alignObjects, distributeObjects, trimPanels, type AlignMode, type DistributeAxis } from '../editor/align';
import { createFrameForAsset, placeAssetInFrame, uploadImage } from '../editor/dropImage';
import { DEFAULT_SIZES, makeEllipse, makeFrame, makeIcon, makeLine, makeQr, makeRect, makeShape, makeText } from '../editor/tools/defaults';
import { faceSize } from '../model/format';
import { refitFrameImage } from '../model/images';
import { findPageOrMaster } from '../model/masters';
import { SHAPE_PRESETS } from '../model/shapes';
import { applyParagraphStyle, createParagraphStyle, findParagraphStyle } from '../model/styles';
import { addSwatch, normalizeHex } from '../model/swatches';
import { chainFrames, chainHead, paragraphText } from '../model/threading';
import type { Asset, ColorRef, DocObject, Id, ImageFit, LayoutDocument, MasterPage, Page, Paragraph, TextObject, TextRun, TextStyle } from '../model/types';
import { iconSvg, loadIconLibrary, searchIcons } from '../panels/iconLibrary';
import { recompute as recomputePreflight } from '../panels/PreflightPanel';
import { convertSwatchToCmyk } from '../panels/printColors';
import { addObjects, round4, setBox as setBoxCommand, type ReorderMode } from '../store/commands';
import { defaultLayerId, getEditor } from '../store/documentStore';
import { getPersistence } from '../store/persistence';
import { ancestorsOf, pageIdOf, parentOf } from '../store/tree';
import { replaceAll } from '../text/findReplace';
import { oversetStore } from '../text/overset';
import { applyTypographyToDocument, fixTypography } from '../text/typographyFr';
import { AGENT_GUIDE } from './guide';

// ---------------------------------------------------------------- activité (indicateur du bouton Agent IA)

export const agentActivity = createStore<{ label: string | null; at: number; count: number }>()(() => ({ label: null, at: 0, count: 0 }));
const note = (label: string) => agentActivity.setState((s) => ({ label, at: Date.now(), count: s.count + 1 }));

// ---------------------------------------------------------------- outils

const r2 = (v: number) => Math.round(v * 100) / 100;
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

function need(): LayoutDocument {
  const doc = getEditor().doc;
  if (!doc) throw new Error('Aucun document ouvert : fluidprint.docs() puis fluidprint.open(id)');
  return doc;
}

const bleedOf = (doc: LayoutDocument) => doc.format.bleed;

/** Boîte d'un objet dans le repère du format fini, arrondie au centième de mm. */
function trimBoxOf(doc: LayoutDocument, obj: DocObject) {
  const b = bleedOf(doc);
  return { x: r2(obj.x - b), y: r2(obj.y - b), w: r2(obj.w), h: r2(obj.h) };
}

function list(ref: Id | Id[] | undefined, doc: LayoutDocument): Id[] {
  const ids = ref === undefined ? getEditor().selection : Array.isArray(ref) ? ref : [ref];
  if (!ids.length) throw new Error('Aucun objet : passer un identifiant (fluidprint.objects()) ou sélectionner');
  for (const id of ids) if (!doc.objects[id]) throw new Error(`Objet inconnu : ${id} (fluidprint.objects() liste les objets)`);
  return ids;
}

/** Refuse un objet verrouillé (lui, un groupe parent ou son calque) : c'est à l'utilisateur de le libérer. */
function assertEditable(doc: LayoutDocument, ids: Id[]): void {
  for (const id of ids) {
    const obj = doc.objects[id];
    const layer = doc.layers.find((l) => l.id === obj.layerId);
    if (obj.locked || ancestorsOf(doc, id).some((a) => doc.objects[a]?.locked)) throw new Error(`Objet verrouillé : ${id} (demander à l'utilisateur de le déverrouiller)`);
    if (layer?.locked) throw new Error(`Calque verrouillé : « ${layer.name} » (objet ${id})`);
  }
}

function mutate<T>(label: string, recipe: (d: LayoutDocument) => T, select?: Id[] | ((result: T) => Id[])): T {
  need();
  const result = getEditor().apply(`Agent IA : ${label}`, recipe, select ? { select } : {});
  note(label);
  return result as T;
}

function allPages(doc: LayoutDocument): (Page | MasterPage)[] {
  return [...doc.pages, ...(doc.masters ?? [])];
}

/** Page par identifiant, nom (« Recto ») ou rang (0 = première) ; défaut : la page active. */
function resolvePage(doc: LayoutDocument, page: Id | number | undefined): Page | MasterPage {
  if (page === undefined) {
    const active = getEditor().activePageId;
    return (active && findPageOrMaster(doc, active)) || doc.pages[0];
  }
  if (typeof page === 'number') {
    const p = doc.pages[page];
    if (!p) throw new Error(`Page ${page} absente : ${doc.pages.length} page(s), rang 0 à ${doc.pages.length - 1}`);
    return p;
  }
  const found = findPageOrMaster(doc, page) ?? allPages(doc).find((p) => fold(p.name) === fold(page));
  if (!found) throw new Error(`Page inconnue : ${page} (pages : ${allPages(doc).map((p) => `${p.id} « ${p.name} »`).join(', ')})`);
  return found;
}

function resolveLayer(doc: LayoutDocument, layer: string | undefined): Id {
  if (layer === undefined) {
    const id = defaultLayerId(doc, getEditor().activeLayerId);
    if (!id) throw new Error('Aucun calque utilisable (tous verrouillés ?)');
    return id;
  }
  const found = doc.layers.find((l) => l.id === layer) ?? doc.layers.find((l) => fold(l.name) === fold(layer));
  if (!found) throw new Error(`Calque inconnu : ${layer} (calques : ${doc.layers.map((l) => l.name).join(', ')})`);
  if (found.locked) throw new Error(`Calque verrouillé : « ${found.name} »`);
  return found.id;
}

export type ColorInput = string | { swatch: string; tint?: number };

/** Nuances créées d'après une couleur hexadécimale : converties en CMJN après l'action. */
let createdSwatches: Id[] = [];

/**
 * Nuance d'après son identifiant, son nom (« Bleu », « Bleu 40% » pour une teinte) ou une couleur `#rrggbb`
 * (nuance existante de même couleur, sinon nuance créée puis convertie en CMJN par le profil du document).
 */
function resolveColor(d: LayoutDocument, input: ColorInput): ColorRef {
  if (typeof input === 'object') {
    const ref = resolveColor(d, input.swatch);
    return input.tint !== undefined && input.tint < 1 ? { ...ref, tint: input.tint } : ref;
  }
  const hex = normalizeHex(input);
  if (hex) {
    const same = d.swatches.find((s) => s.rgb === hex || s.sourceRgb === hex);
    if (same) return { swatch: same.id };
    // sourceRgb : la couleur demandée, retrouvée ensuite même si l'affichage de la nuance est ajusté (distinctRgb, CMJN).
    const id = addSwatch(d, { name: `Couleur ${hex}`, rgb: hex, sourceRgb: hex });
    createdSwatches.push(id);
    return { swatch: id };
  }
  const tinted = /^(.*?)\s+(\d{1,3})\s*%$/.exec(input);
  const name = tinted ? tinted[1] : input;
  const swatch = d.swatches.find((s) => s.id === name) ?? d.swatches.find((s) => fold(s.name) === fold(name));
  if (!swatch) throw new Error(`Nuance inconnue : ${input} (nuances : ${d.swatches.map((s) => s.name).join(', ')} ; ou #rrggbb)`);
  const tint = tinted ? Math.min(100, Number(tinted[2])) / 100 : 1;
  return tint < 1 ? { swatch: swatch.id, tint } : { swatch: swatch.id };
}

function convertCreatedSwatches(): void {
  const ids = createdSwatches;
  createdSwatches = [];
  for (const id of ids) void convertSwatchToCmyk(id).catch(() => undefined);
}

const swatchName = (doc: LayoutDocument, ref: ColorRef | undefined) => {
  if (!ref) return undefined;
  const name = doc.swatches.find((s) => s.id === ref.swatch)?.name ?? ref.swatch;
  return ref.tint !== undefined && ref.tint < 1 ? `${name} ${Math.round(ref.tint * 100)}%` : name;
};

/** Texte brut d'un bloc (celui de toute sa chaîne) : un paragraphe par ligne. */
function storyText(doc: LayoutDocument, id: Id): string {
  const head = doc.objects[chainHead(doc, id)] as TextObject;
  return head.paragraphs.map(paragraphText).join('\n');
}

// ---------------------------------------------------------------- texte

/** `**gras**` et `*italique*` → segments (option `markdown` de setText). */
function markdownRuns(line: string, base: Omit<TextRun, 'text'>): TextRun[] {
  const runs: TextRun[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) runs.push({ ...base, text: line.slice(last, m.index) });
    runs.push(m[1] !== undefined ? { ...base, text: m[1], fontWeight: 700 } : { ...base, text: m[2], italic: true });
    last = m.index + m[0].length;
  }
  if (last < line.length || !runs.length) runs.push({ ...base, text: line.slice(last) });
  return runs;
}

/**
 * Nouveaux paragraphes d'un bloc : le paragraphe i garde les réglages (corps, style propre, retraits, liste) et
 * la mise en forme du premier segment de l'ancien paragraphe i (le dernier au-delà).
 */
function paragraphsFromText(old: Paragraph[], text: string, options: { markdown?: boolean; typo?: boolean }): Paragraph[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((raw, i) => {
    const model = old[Math.min(i, old.length - 1)] ?? { runs: [{ text: '' }] };
    const { runs: modelRuns, ...attrs } = model;
    const { text: _drop, ...base } = modelRuns[0] ?? { text: '' };
    void _drop;
    const line = options.typo === false ? raw : fixTypography(raw);
    return { ...structuredClone(attrs), runs: options.markdown ? markdownRuns(line, base) : [{ ...base, text: line }] };
  });
}

// ---------------------------------------------------------------- résumé des objets

export interface ObjectSummary {
  id: Id;
  type: DocObject['type'];
  name?: string;
  page: Id;
  pageName: string;
  master?: true;
  parent?: Id;
  layer: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  locked?: true;
  hidden?: true;
  text?: string;
  paragraphStyle?: string;
  fontSize?: number;
  color?: string;
  stroke?: string;
  image?: string;
  empty?: true;
  url?: string;
  icon?: string;
  chain?: Id[];
  overset?: number;
  children?: Id[];
}

function summarize(doc: LayoutDocument, id: Id, excess: Record<Id, number>): ObjectSummary {
  const obj = doc.objects[id];
  const pageId = pageIdOf(doc, id)!;
  const page = findPageOrMaster(doc, pageId)!;
  const out: ObjectSummary = {
    id,
    type: obj.type,
    ...(obj.name ? { name: obj.name } : {}),
    page: pageId,
    pageName: page.name,
    ...(doc.masters?.some((m) => m.id === pageId) ? { master: true as const } : {}),
    ...(parentOf(doc, id) ? { parent: parentOf(doc, id)! } : {}),
    layer: doc.layers.find((l) => l.id === obj.layerId)?.name ?? obj.layerId,
    ...trimBoxOf(doc, obj),
    ...(obj.rotation ? { rotation: obj.rotation } : {}),
    ...(obj.locked ? { locked: true as const } : {}),
    ...(obj.hidden ? { hidden: true as const } : {}),
  };
  switch (obj.type) {
    case 'text': {
      const text = storyText(doc, id);
      out.text = text.length > 160 ? `${text.slice(0, 160)}…` : text;
      const ps = findParagraphStyle(doc, obj.paragraphStyleId);
      if (ps) out.paragraphStyle = ps.name;
      out.fontSize = obj.style.fontSize;
      out.color = swatchName(doc, obj.style.color);
      const chain = chainFrames(doc, id);
      if (chain.length > 1) out.chain = chain;
      if ((excess[id] ?? 0) > 0.25) out.overset = r2(excess[id]);
      break;
    }
    case 'rect':
    case 'ellipse':
    case 'path':
      out.color = swatchName(doc, obj.fill);
      out.stroke = swatchName(doc, obj.stroke?.color);
      break;
    case 'frame':
      out.color = swatchName(doc, obj.fill);
      if (obj.image) out.image = doc.assets.find((a) => a.id === obj.image!.assetId)?.name ?? obj.image.assetId;
      else out.empty = true;
      break;
    case 'line':
      out.stroke = swatchName(doc, obj.stroke.color);
      break;
    case 'qr':
      out.url = obj.url;
      out.color = swatchName(doc, obj.color);
      break;
    case 'icon':
      out.icon = obj.iconName;
      out.color = swatchName(doc, obj.color);
      break;
    case 'svg':
      out.color = swatchName(doc, obj.color);
      break;
    case 'group':
      out.children = obj.children;
      break;
  }
  for (const k of Object.keys(out) as (keyof ObjectSummary)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Tous les objets, dans l'ordre des pages puis de l'empilement (dessous → dessus), groupes compris. */
function orderedIds(doc: LayoutDocument, pages: (Page | MasterPage)[]): Id[] {
  const out: Id[] = [];
  const visit = (id: Id) => {
    const obj = doc.objects[id];
    if (!obj) return;
    out.push(id);
    if (obj.type === 'group') obj.children.forEach(visit);
  };
  for (const p of pages) p.children.forEach(visit);
  return out;
}

// ---------------------------------------------------------------- création

export type AddType = 'text' | 'rect' | 'ellipse' | 'line' | 'frame' | 'shape' | 'qr';

export interface AddOptions {
  page?: Id | number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  layer?: string;
  name?: string;
  /** text : contenu (`\n` = nouveau paragraphe) ; `markdown: true` pour **gras** et *italique*. */
  text?: string;
  markdown?: boolean;
  /** text : style de paragraphe (nom ou identifiant). */
  paragraphStyle?: string;
  /** text : réglages du bloc (corps, graisse, alignement…). */
  style?: Partial<Omit<TextStyle, 'color'>>;
  /** text : la hauteur suit le texte. */
  autoHeight?: boolean;
  /** Couleur principale : texte, fond (rect, ellipse, cadre, forme), trait (ligne), modules (QR). */
  color?: ColorInput;
  /** rect, ellipse, cadre, forme : filet. */
  stroke?: { color: ColorInput; width?: number };
  /** rect : arrondi en mm. */
  radius?: number;
  /** shape : forme prédéfinie (goutte…). */
  shape?: string;
  /** qr : adresse encodée. */
  url?: string;
  opacity?: number;
  rotation?: number;
}

type TextPatch = Partial<Omit<TextStyle, 'color'>> & { color?: ColorInput; verticalAlign?: TextObject['verticalAlign']; autoHeight?: boolean };

function applyTextPatch(d: LayoutDocument, obj: TextObject, patch: TextPatch): void {
  const { color, verticalAlign, autoHeight, ...style } = patch;
  Object.assign(obj.style, style);
  if (color !== undefined) obj.style.color = resolveColor(d, color);
  if (verticalAlign !== undefined) obj.verticalAlign = verticalAlign;
  if (autoHeight !== undefined) obj.autoHeight = autoHeight || undefined;
}

// ---------------------------------------------------------------- l'API

export interface ExportResult {
  file: string;
  url: string;
  pages?: number;
  warnings?: unknown[];
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `Requête refusée (${res.status})`);
  return body as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAgentApi() {
  const api = {
    version: 1,

    /** Guide complet (Markdown) : à lire avant toute action. */
    help: (): string => AGENT_GUIDE,

    /** Vrai quand un document est ouvert dans l'éditeur. */
    ready: (): boolean => !!getEditor().doc,

    // ------------------------------------------------ accueil : documents

    /** Documents du dossier (id, nom…). */
    docs: async () => json<unknown[]>(await fetch('/api/doc')),
    /** Gabarits d'un nouveau document (dépliants, flyer, carte de visite…). */
    templates: async () => json<unknown[]>(await fetch('/api/templates')),
    /** Crée un document vierge d'après un gabarit ; renvoie son identifiant (à ouvrir avec open). */
    async create(name: string, template: string): Promise<Id> {
      const res = await fetch('/api/doc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, templateId: template }) });
      return (await json<{ id: Id }>(res)).id;
    },
    /** Ouvre un document dans l'éditeur (recharge la page : attendre fluidprint.ready()). */
    open(id: Id): void {
      location.href = `/doc/${encodeURIComponent(id)}`;
    },

    // ------------------------------------------------ lecture

    /** Vue d'ensemble : format (volets, fond perdu, zone de sécurité), pages, calques, nuances, styles, photos. */
    info() {
      const doc = need();
      const s = getEditor();
      const b = bleedOf(doc);
      return {
        id: doc.id,
        name: doc.name,
        units: 'mm depuis le coin haut-gauche du format fini ; corps et filets en pt',
        format: {
          name: doc.format.name,
          trim: doc.format.trim,
          bleed: b,
          safety: doc.format.safety,
          faces: doc.format.faces.map((f) => ({ id: f.id, name: f.name, panels: trimPanels(doc, doc.pages.find((p) => p.faceId === f.id)?.id ?? '').map((p) => ({ name: p.name, x: r2(p.x - b), w: r2(p.w) })) })),
        },
        pages: doc.pages.map((p, index) => ({ id: p.id, index, name: p.name, faceId: p.faceId, master: p.masterId, objects: orderedIds(doc, [p]).length })),
        masters: (doc.masters ?? []).map((m) => ({ id: m.id, name: m.name, faceId: m.faceId })),
        layers: doc.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, printable: l.printable })),
        swatches: doc.swatches.map((w) => ({ id: w.id, name: w.name, rgb: w.rgb, ...(w.cmyk ? { cmyk: w.cmyk } : {}) })),
        paragraphStyles: doc.styles.paragraph.map((p) => ({ id: p.id, name: p.name, fontSize: p.style.fontSize, fontWeight: p.style.fontWeight, lineHeight: p.style.lineHeight, color: swatchName(doc, p.style.color) })),
        characterStyles: doc.styles.character.map((c) => ({ id: c.id, name: c.name })),
        assets: doc.assets.map((a) => ({ id: a.id, name: a.name, width: a.width, height: a.height })),
        shapes: Object.keys(SHAPE_PRESETS),
        selection: s.selection,
        activePage: s.activePageId,
        save: s.save.status,
      };
    },

    /** Objets résumés (boîte en mm du format fini, texte, style, couleur…). Filtres facultatifs. */
    objects(filter: { page?: Id | number; type?: DocObject['type']; layer?: string; text?: string; masters?: boolean } = {}): ObjectSummary[] {
      const doc = need();
      const pages = filter.page !== undefined ? [resolvePage(doc, filter.page)] : filter.masters ? allPages(doc) : doc.pages;
      const excess = oversetStore.getState().excess;
      const q = filter.text ? fold(filter.text) : null;
      return orderedIds(doc, pages)
        .map((id) => summarize(doc, id, excess))
        .filter((o) => (!filter.type || o.type === filter.type) && (!filter.layer || fold(o.layer) === fold(filter.layer)))
        .filter((o) => !q || fold(`${o.name ?? ''} ${o.text ?? ''}`).includes(q));
    },

    /** Identifiants des objets dont le nom ou le texte contient la requête (sans casse ni accents). */
    find(query: string): Id[] {
      return api.objects({ text: query, masters: true }).map((o) => o.id);
    },

    /** Objet complet, tel que stocké (repère du fond perdu), plus `box` dans le repère du format fini. */
    get(id: Id) {
      const doc = need();
      list(id, doc);
      return { ...structuredClone(doc.objects[id]), box: trimBoxOf(doc, doc.objects[id]) };
    },

    /** Texte brut d'un bloc (toute sa chaîne) : un paragraphe par ligne. */
    getText(id: Id): string {
      const doc = need();
      list(id, doc);
      if (doc.objects[id].type !== 'text') throw new Error(`${id} n'est pas un bloc texte`);
      return storyText(doc, id);
    },

    selection: (): Id[] => getEditor().selection,

    // ------------------------------------------------ texte

    /**
     * Remplace le texte d'un bloc (de toute sa chaîne). `\n` sépare les paragraphes, qui gardent réglages et
     * mise en forme des anciens paragraphes de même rang. Options : markdown (**gras**, *italique*),
     * typo (typographie française, vrai par défaut).
     */
    setText(id: Id, text: string, options: { markdown?: boolean; typo?: boolean } = {}): void {
      const doc = need();
      list(id, doc);
      if (doc.objects[id].type !== 'text') throw new Error(`${id} n'est pas un bloc texte`);
      const head = chainHead(doc, id);
      assertEditable(doc, [head]);
      mutate(
        'Texte',
        (d) => {
          const obj = d.objects[head] as TextObject;
          obj.paragraphs = paragraphsFromText(obj.paragraphs, text, options);
        },
        [id],
      );
    },

    /** Remplace partout (blocs texte seulement, mise en forme gardée) ; renvoie le nombre de remplacements. */
    replaceText(find: string, replacement: string, options: { caseSensitive?: boolean; wholeWord?: boolean } = {}): number {
      return mutate('Remplacer', (d) => replaceAll(d, find, replacement, options)) ?? 0;
    },

    /** Réglages du bloc : fontSize (pt), fontWeight (400, 600, 700, 800), italic, lineHeight (×corps), letterSpacing (em), align, transform, color, verticalAlign, autoHeight. */
    setTextStyle(ids: Id | Id[], patch: TextPatch): void {
      const doc = need();
      const targets = list(ids, doc).filter((id) => doc.objects[id].type === 'text');
      if (!targets.length) throw new Error('Aucun bloc texte parmi ces objets');
      assertEditable(doc, targets);
      mutate('Style du texte', (d) => targets.forEach((id) => applyTextPatch(d, d.objects[id] as TextObject, patch)), targets);
      convertCreatedSwatches();
    },

    /** Applique un style de paragraphe (nom ou identifiant ; null détache). Comme le panneau Styles : les retouches locales des segments restent. */
    applyParagraphStyle(ids: Id | Id[], style: string | null): void {
      const doc = need();
      const targets = list(ids, doc).filter((id) => doc.objects[id].type === 'text');
      assertEditable(doc, targets);
      const ps = style === null ? null : (doc.styles.paragraph.find((p) => p.id === style) ?? doc.styles.paragraph.find((p) => fold(p.name) === fold(style)));
      if (style !== null && !ps) throw new Error(`Style inconnu : ${style} (styles : ${doc.styles.paragraph.map((p) => p.name).join(', ')})`);
      mutate('Style de paragraphe', (d) => applyParagraphStyle(d, targets, ps?.id ?? null), targets);
    },

    /** Crée un style de paragraphe d'après un bloc texte ; renvoie son identifiant. */
    createParagraphStyle(name: string, fromTextId: Id): Id {
      const doc = need();
      list(fromTextId, doc);
      const obj = doc.objects[fromTextId];
      if (obj.type !== 'text') throw new Error(`${fromTextId} n'est pas un bloc texte`);
      return mutate('Nouveau style', (d) => createParagraphStyle(d, name, structuredClone(obj.style)).id);
    },

    /** Typographie française (espaces insécables, apostrophes, guillemets) sur des blocs ou tout le document. */
    typography(ids?: Id | Id[]): number {
      const doc = need();
      const targets = ids === undefined ? undefined : list(ids, doc);
      return mutate('Typographie', (d) => applyTypographyToDocument(d, targets)) ?? 0;
    },

    // ------------------------------------------------ position, apparence

    /** Boîte (mm, format fini) : les champs absents ne changent pas. */
    setBox(id: Id, box: { x?: number; y?: number; w?: number; h?: number }): void {
      const doc = need();
      list(id, doc);
      assertEditable(doc, [id]);
      const b = bleedOf(doc);
      const next = { ...box, ...(box.x !== undefined ? { x: round4(box.x + b) } : {}), ...(box.y !== undefined ? { y: round4(box.y + b) } : {}) };
      mutate('Position et taille', (d) => setBoxCommand(d, id, next), [id]);
    },

    /** Déplace de dx, dy mm. */
    move(ids: Id | Id[], dx: number, dy: number): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      getEditor().move(targets, dx, dy, { label: 'Agent IA : Déplacer' });
      getEditor().select(targets);
      note('Déplacer');
    },

    rotate(ids: Id | Id[], degrees: number): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      mutate('Rotation', (d) => targets.forEach((id) => (d.objects[id].rotation = degrees || undefined)), targets);
    },

    /** Aligne sur la sélection commune ou sur le volet : left, hcenter, right, top, vcenter, bottom. */
    align(ids: Id | Id[], mode: AlignMode, reference: 'selection' | 'panel' = 'panel'): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      mutate('Aligner', (d) => alignObjects(d, targets, mode, reference), targets);
    },

    distribute(ids: Id | Id[], axis: DistributeAxis, reference: 'selection' | 'panel' = 'selection'): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      mutate('Répartir', (d) => distributeObjects(d, targets, axis, reference), targets);
    },

    /** Couleur principale : texte, fond (rect, ellipse, forme, cadre), trait (ligne), QR, icône, SVG. null retire un fond. */
    setColor(ids: Id | Id[], color: ColorInput | null): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      mutate(
        'Couleur',
        (d) => {
          const ref = color === null ? undefined : resolveColor(d, color);
          for (const id of targets) {
            const obj = d.objects[id];
            switch (obj.type) {
              case 'text':
                if (ref) obj.style.color = ref;
                break;
              case 'line':
                if (ref) obj.stroke.color = ref;
                break;
              case 'qr':
              case 'icon':
                if (ref) obj.color = ref;
                break;
              case 'svg':
                obj.color = ref;
                break;
              case 'rect':
              case 'ellipse':
              case 'path':
              case 'frame':
                obj.fill = ref;
                break;
            }
          }
        },
        targets,
      );
      convertCreatedSwatches();
    },

    /** Filet : couleur et épaisseur en pt ; null retire le filet (sauf ligne). */
    setStroke(ids: Id | Id[], stroke: { color: ColorInput; width?: number } | null): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      mutate(
        'Filet',
        (d) => {
          for (const id of targets) {
            const obj = d.objects[id];
            if (obj.type !== 'rect' && obj.type !== 'ellipse' && obj.type !== 'path' && obj.type !== 'frame' && obj.type !== 'line') continue;
            if (!stroke) {
              if (obj.type !== 'line') delete obj.stroke;
              continue;
            }
            const color = resolveColor(d, stroke.color);
            obj.stroke = { ...obj.stroke, color, width: stroke.width ?? obj.stroke?.width ?? 0.5 };
          }
        },
        targets,
      );
      convertCreatedSwatches();
    },

    /** Modification brute du modèle (opacity, radius, url d'un QR, name, locked, hidden…). Couleurs : utiliser fluidprint.color(). */
    update(ids: Id | Id[], patch: Record<string, unknown>): void {
      const doc = need();
      const targets = list(ids, doc);
      const onlyLock = Object.keys(patch).every((k) => k === 'locked' || k === 'hidden');
      if (!onlyLock) assertEditable(doc, targets);
      if ('x' in patch || 'y' in patch) throw new Error('x et y : utiliser setBox (repère du format fini) ou move');
      mutate('Modifier', (d) => targets.forEach((id) => Object.assign(d.objects[id], structuredClone(patch))), targets);
    },

    /** Référence de nuance pour update() : color('Bleu'), color('Bleu 40%'), color('#2a5fa3'). */
    color(input: ColorInput): ColorRef {
      const ref = mutate('Nuance', (d) => resolveColor(d, input));
      convertCreatedSwatches();
      return ref;
    },

    // ------------------------------------------------ création, structure

    /** Crée un objet ; renvoie son identifiant. Type : text, rect, ellipse, line, frame (cadre photo), shape, qr. */
    add(type: AddType, options: AddOptions = {}): Id {
      const doc = need();
      const page = resolvePage(doc, options.page);
      const layerId = resolveLayer(doc, options.layer);
      const b = bleedOf(doc);
      const size = DEFAULT_SIZES[type] ?? { w: 40, h: 30 };
      const box = {
        x: (options.x ?? (doc.format.trim.w - (options.w ?? size.w)) / 2) + b,
        y: (options.y ?? (doc.format.trim.h - (options.h ?? size.h)) / 2) + b,
        w: options.w ?? size.w,
        h: options.h ?? (type === 'line' ? 0 : size.h),
      };
      const id = mutate(
        `Ajouter (${type})`,
        (d) => {
          const o = { layerId, box };
          let obj: DocObject;
          switch (type) {
            case 'text':
              obj = makeText(d, o, '');
              break;
            case 'rect':
              obj = makeRect(d, o);
              if (options.radius) obj.radius = options.radius;
              break;
            case 'ellipse':
              obj = makeEllipse(d, o);
              break;
            case 'line':
              obj = makeLine(d, o);
              break;
            case 'frame':
              obj = makeFrame(d, o);
              break;
            case 'shape':
              if (options.shape && !SHAPE_PRESETS[options.shape]) throw new Error(`Forme inconnue : ${options.shape} (formes : ${Object.keys(SHAPE_PRESETS).join(', ')})`);
              obj = makeShape(d, o, options.shape);
              break;
            case 'qr':
              obj = makeQr(d, o, options.url);
              break;
            default:
              throw new Error(`Type inconnu : ${String(type)} (text, rect, ellipse, line, frame, shape, qr ; icône : addIcon)`);
          }
          if (options.name) obj.name = options.name;
          if (options.opacity !== undefined) obj.opacity = options.opacity;
          if (options.rotation) obj.rotation = options.rotation;
          if (obj.type === 'text') {
            obj.paragraphs = paragraphsFromText([{ runs: [{ text: '' }] }], options.text ?? 'Votre texte', { markdown: options.markdown });
            if (options.paragraphStyle) {
              const ps = d.styles.paragraph.find((p) => p.id === options.paragraphStyle) ?? d.styles.paragraph.find((p) => fold(p.name) === fold(options.paragraphStyle!));
              if (!ps) throw new Error(`Style inconnu : ${options.paragraphStyle}`);
              obj.paragraphStyleId = ps.id;
              Object.assign(obj.style, structuredClone(ps.style));
            }
            applyTextPatch(d, obj, { ...options.style, ...(options.color !== undefined ? { color: options.color } : {}), ...(options.autoHeight ? { autoHeight: true } : {}) });
          } else if (options.color !== undefined) {
            const ref = resolveColor(d, options.color);
            if (obj.type === 'line') obj.stroke.color = ref;
            else if (obj.type === 'qr') obj.color = ref;
            else if (obj.type === 'rect' || obj.type === 'ellipse' || obj.type === 'frame') obj.fill = ref;
          }
          if (options.stroke && (obj.type === 'rect' || obj.type === 'ellipse' || obj.type === 'frame')) {
            obj.stroke = { color: resolveColor(d, options.stroke.color), width: options.stroke.width ?? 0.5 };
          }
          addObjects(d, [obj], [obj.id], { pageId: page.id });
          return obj.id;
        },
        (created) => [created],
      );
      convertCreatedSwatches();
      return id;
    },

    /** Icône Lucide (nom anglais « phone », ou recherche « téléphone ») ; renvoie son identifiant. */
    async addIcon(icon: string, options: Omit<AddOptions, 'text'> = {}): Promise<Id> {
      const library = await loadIconLibrary();
      const name = library.nodes[icon] ? icon : searchIcons(library, icon, 1)[0];
      if (!name) throw new Error(`Icône introuvable : ${icon}`);
      const doc = need();
      const page = resolvePage(doc, options.page);
      const layerId = resolveLayer(doc, options.layer);
      const b = bleedOf(doc);
      const side = options.w ?? DEFAULT_SIZES.icon.w;
      const box = { x: (options.x ?? (doc.format.trim.w - side) / 2) + b, y: (options.y ?? (doc.format.trim.h - side) / 2) + b, w: side, h: options.h ?? side };
      const id = mutate(
        `Icône ${name}`,
        (d) => {
          const obj = makeIcon(d, { layerId, box }, { name, svg: iconSvg(library.nodes[name]) });
          if (options.color !== undefined) obj.color = resolveColor(d, options.color);
          if (options.name) obj.name = options.name;
          addObjects(d, [obj], [obj.id], { pageId: page.id });
          return obj.id;
        },
        (created) => [created],
      );
      convertCreatedSwatches();
      return id;
    },

    /** Recherche d'icônes (français ou anglais) : noms Lucide. */
    async searchIcons(query: string, limit = 20): Promise<string[]> {
      return searchIcons(await loadIconLibrary(), query, limit);
    },

    remove(ids: Id | Id[]): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      note('Supprimer');
      getEditor().remove(targets);
    },

    /** Duplique (décalage en mm, 5 par défaut) ; renvoie les identifiants des copies. */
    duplicate(ids: Id | Id[], offset: { dx: number; dy: number } = { dx: 5, dy: 5 }): Id[] {
      const doc = need();
      const targets = list(ids, doc);
      note('Dupliquer');
      return getEditor().duplicate(targets, offset);
    },

    group(ids: Id[]): Id | null {
      const doc = need();
      assertEditable(doc, list(ids, doc));
      note('Grouper');
      return getEditor().group(ids);
    },

    ungroup(ids: Id | Id[]): Id[] {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      note('Dissocier');
      return getEditor().ungroup(targets);
    },

    /** Ordre d'empilement : front, back, forward, backward. */
    reorder(ids: Id | Id[], mode: ReorderMode): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      note('Ordre');
      getEditor().reorder(mode, targets);
    },

    setLayer(ids: Id | Id[], layer: string): void {
      const doc = need();
      const targets = list(ids, doc);
      assertEditable(doc, targets);
      note('Calque');
      getEditor().setLayer(resolveLayer(doc, layer), targets);
    },

    // ------------------------------------------------ photos

    /**
     * Place une photo dans un cadre (ou une forme) : `source` = identifiant d'une photo du document, URL (même
     * origine, ou serveur qui autorise CORS), File ou Blob. fit : fill (remplir, défaut), fit (entière), center.
     */
    async placeImage(frameId: Id, source: string | Blob, options: { fit?: Exclude<ImageFit, 'custom'> } = {}): Promise<Id> {
      const doc = need();
      list(frameId, doc);
      if (doc.objects[frameId].type !== 'frame') throw new Error(`${frameId} n'est pas un cadre (type frame)`);
      assertEditable(doc, [frameId]);
      const asset = await api.uploadImage(source);
      placeAssetInFrame(frameId, asset, 'Agent IA : Placer une photo');
      if (options.fit && options.fit !== 'fill') {
        mutate('Ajuster la photo', (d) => {
          const frame = d.objects[frameId];
          if (frame.type === 'frame' && frame.image) frame.image = refitFrameImage(frame, frame.image, asset, options.fit!);
        });
      }
      note('Placer une photo');
      return asset.id;
    },

    /** Crée un cadre à la taille de la photo (300 ppi) centré en (x, y) ; renvoie l'identifiant du cadre. */
    async addImage(source: string | Blob, options: { page?: Id | number; x?: number; y?: number; w?: number } = {}): Promise<Id> {
      const doc = need();
      const page = resolvePage(doc, options.page);
      const asset = await api.uploadImage(source);
      const b = bleedOf(doc);
      const at = { x: (options.x ?? doc.format.trim.w / 2) + b, y: (options.y ?? doc.format.trim.h / 2) + b };
      const id = createFrameForAsset(page.id, at, asset);
      if (!id) throw new Error('Cadre non créé (calque verrouillé ?)');
      if (options.w) {
        const frame = getEditor().doc!.objects[id];
        getEditor().setBox(id, { w: options.w, h: (frame.h * options.w) / frame.w }, 'Agent IA : Taille de la photo');
      }
      note('Ajouter une photo');
      return id;
    },

    /** Envoie une photo au serveur (ou retrouve une photo du document par identifiant ou nom) ; renvoie l'asset. */
    async uploadImage(source: string | Blob): Promise<Asset> {
      const doc = need();
      if (typeof source === 'string') {
        const known = doc.assets.find((a) => a.id === source || a.name === source);
        if (known) return known;
        const res = await fetch(source).catch((e: Error) => {
          throw new Error(`Photo inaccessible : ${source} (${e.message} ; une URL d'un autre site doit autoriser CORS)`);
        });
        if (!res.ok) throw new Error(`Photo inaccessible : ${source} (${res.status})`);
        const blob = await res.blob();
        const name = decodeURIComponent(new URL(source, location.href).pathname.split('/').pop() || 'photo.jpg');
        return uploadImage(doc.id, new File([blob], name, { type: blob.type }));
      }
      const file = source instanceof File ? source : new File([source], 'photo.jpg', { type: source.type });
      return uploadImage(doc.id, file);
    },

    // ------------------------------------------------ vue, historique

    /** Sélectionne (l'utilisateur voit les cadres de sélection). */
    select(ids: Id | Id[]): void {
      const doc = need();
      getEditor().select(list(ids, doc));
    },

    /** Sélectionne et centre la vue sur des objets ; zoom facultatif (1 = taille réelle). */
    focus(ids: Id | Id[], zoom?: number): void {
      const doc = need();
      const targets = list(ids, doc);
      getEditor().select(targets);
      if (zoom) getEditor().setZoom(zoom);
      getEditor().centerOn(targets);
    },

    fit: (): void => getEditor().fit(),
    undo: (): void => getEditor().undo(),
    redo: (): void => getEditor().redo(),

    /**
     * Plusieurs modifications en UNE étape d'annulation : `await fluidprint.batch('Mise en page', async () => {…})`.
     * Une erreur annule tout le lot.
     */
    async batch<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
      const s = getEditor();
      need();
      if (s.gesture) throw new Error('Un geste est déjà en cours (lot imbriqué ou action de l’utilisateur)');
      s.beginGesture(`Agent IA : ${label}`);
      try {
        const result = await fn();
        getEditor().commitGesture({ select: getEditor().selection });
        note(label);
        return result;
      } catch (error) {
        getEditor().cancelGesture();
        throw error;
      }
    },

    /** Enregistre tout de suite (sinon 2 s après la dernière modification). */
    async save(): Promise<string> {
      need();
      await getPersistence()?.saveNow();
      return getEditor().save.status;
    },

    // ------------------------------------------------ contrôle, export

    /** Contrôle en amont (zone de sécurité, résolution, encrage, texte en excès…). */
    preflight() {
      const doc = need();
      const report = recomputePreflight();
      return {
        errors: report.errors,
        warnings: report.warnings,
        blocking: report.blocking.length,
        issues: report.issues.map((i) => ({
          severity: i.severity,
          rule: i.rule,
          message: i.message,
          ...(i.objectId ? { objectId: i.objectId } : {}),
          ...(i.pageId ? { page: findPageOrMaster(doc, i.pageId)?.name ?? i.pageId } : {}),
          ...(i.confirm ? { confirm: i.confirm } : {}),
        })),
      };
    },

    /** Blocs dont le texte déborde : { id: excès en mm }. */
    overset(): Record<Id, number> {
      need();
      const out: Record<Id, number> = {};
      for (const [id, mm] of Object.entries(oversetStore.getState().excess)) if (mm > 0.25) out[id] = r2(mm);
      return out;
    },

    /** Préréglages d'export (imprimeur, traits-de-coupe, rvb, email…). */
    presets: async () => json<unknown>(await fetch('/api/print/presets')),

    /**
     * Exporte le PDF (enregistre d'abord) et attend la fin ; renvoie l'adresse du fichier. Confirmations :
     * confirmLowResolution, confirmHiddenLayers (à demander à l'utilisateur).
     */
    async export(preset = 'imprimeur', options: { confirmLowResolution?: boolean; confirmHiddenLayers?: boolean } = {}): Promise<ExportResult> {
      const doc = need();
      await getPersistence()?.saveNow();
      const query = new URLSearchParams({ preset });
      if (options.confirmLowResolution) query.set('confirmLowResolution', '1');
      if (options.confirmHiddenLayers) query.set('confirmHiddenLayers', '1');
      let job = await json<{ id: string; state: string; result?: { file: string; pages?: number; warnings?: unknown[] }; error?: string; details?: unknown }>(
        await fetch(`/api/doc/${encodeURIComponent(doc.id)}/export-jobs?${query}`, { method: 'POST' }),
      );
      note(`Export ${preset}`);
      while (job.state === 'running') {
        await sleep(1000);
        job = await json(await fetch(`/api/export-jobs/${job.id}`));
      }
      if (job.state !== 'done' || !job.result) throw new Error(`Export refusé : ${job.error ?? job.state}${job.details ? ` ${JSON.stringify(job.details)}` : ''}`);
      const file = job.result.file.split(/[\\/]/).pop()!;
      return { file, url: `/api/doc/${encodeURIComponent(doc.id)}/exports/${encodeURIComponent(file)}`, pages: job.result.pages, warnings: job.result.warnings };
    },

    /** Taille d'une face (fond perdu compris) et format fini, en mm. */
    size() {
      const doc = need();
      return { trim: doc.format.trim, face: faceSize(doc.format), bleed: doc.format.bleed, safety: doc.format.safety };
    },
  };
  return api;
}

export type FluidprintAgentApi = ReturnType<typeof createAgentApi>;

declare global {
  interface Window {
    fluidprint?: FluidprintAgentApi;
  }
}

export function installAgentApi(): void {
  window.fluidprint = createAgentApi();
}
