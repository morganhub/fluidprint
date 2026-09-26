// Objets neufs créés par la barre d'outils : tailles par défaut, nuances tirées du nuancier. Les
// fabriques travaillent sur un brouillon : si le document n'a aucune nuance utilisable, elles en
// ajoutent une (dans la même étape d'annulation).
import { SHAPE_PRESETS } from '../../model/shapes';
import type {
  ColorRef,
  DocObject,
  EllipseObject,
  FrameObject,
  IconObject,
  Id,
  LayoutDocument,
  LineObject,
  Mm,
  QrObject,
  RectObject,
  ShapeRef,
  Swatch,
  TextObject,
  TextStyle,
} from '../../model/types';
import { newObjectId, round4 } from '../../store/commands';
import type { Box } from '../../store/tree';

/** Taille d'un objet créé d'un simple clic, en mm. */
export const DEFAULT_SIZES: Record<string, { w: Mm; h: Mm }> = {
  text: { w: 60, h: 10 },
  rect: { w: 40, h: 30 },
  ellipse: { w: 30, h: 30 },
  line: { w: 40, h: 0 },
  frame: { w: 40, h: 30 },
  shape: { w: 30, h: 39 },
  icon: { w: 8, h: 8 },
  qr: { w: 20, h: 20 },
};

export const DEFAULT_QR_URL = 'https://example.com';

/** Étoile Lucide : icône posée par l'outil Icône, à remplacer depuis la bibliothèque. */
export const DEFAULT_ICON = {
  name: 'star',
  svg: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />',
};

const luminance = (rgb: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(rgb.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Nuances d'impression (les repères de coupe, rose vif, ne servent pas aux objets). */
const printable = (doc: LayoutDocument) => doc.swatches.filter((s) => !/rep[èe]re/i.test(s.name));

function ensureSwatch(doc: LayoutDocument, name: string, rgb: string): Swatch {
  const existing = doc.swatches.find((s) => s.rgb === rgb);
  if (existing) return existing;
  let id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  while (doc.swatches.some((s) => s.id === id)) id += '-2';
  const swatch: Swatch = { id, name, rgb };
  doc.swatches.push(swatch);
  return swatch;
}

export type SwatchRole = 'text' | 'fill' | 'stroke' | 'dark' | 'white';

/** Nuance par défaut d'un rôle : texte courant, bleu, noir, blanc… (créée si absente). */
export function defaultColor(doc: LayoutDocument, role: SwatchRole): ColorRef {
  const list = printable(doc);
  const byName = (re: RegExp) => list.find((s) => re.test(s.name));
  const darkest = () => [...list].sort((a, b) => luminance(a.rgb) - luminance(b.rgb))[0];
  let swatch: Swatch | undefined;
  switch (role) {
    case 'text':
      // « Texte courant » : nuancier de départ ; « Texte principal » : rôle donné par l'importeur.
      swatch = byName(/^texte courant$/i) ?? byName(/^texte principal$/i) ?? darkest();
      break;
    case 'fill':
      swatch = byName(/^bleu$/i) ?? byName(/bleu/i) ?? list.find((s) => luminance(s.rgb) > 0.2 && luminance(s.rgb) < 0.8);
      break;
    case 'stroke':
    case 'dark':
      swatch = byName(/noir/i) ?? darkest();
      break;
    case 'white':
      swatch = list.find((s) => s.rgb === '#ffffff');
      break;
  }
  if (!swatch) {
    const fallback: Record<SwatchRole, [string, string]> = {
      text: ['Texte courant', '#4b4c50'],
      fill: ['Bleu', '#2a5fa3'],
      stroke: ['Noir', '#1a1a1a'],
      dark: ['Noir', '#1a1a1a'],
      white: ['Blanc', '#ffffff'],
    };
    swatch = ensureSwatch(doc, ...fallback[role]);
  }
  return { swatch: swatch.id };
}

/** Style de texte d'un bloc neuf : Open Sans 9 pt, interlignage 140 %, texte courant. */
export function defaultTextStyle(doc: LayoutDocument): TextStyle {
  return {
    fontFamily: 'Open Sans',
    fontWeight: 400,
    fontSize: 9,
    lineHeight: 1.4,
    letterSpacing: 0,
    color: defaultColor(doc, 'text'),
    align: 'left',
    transform: 'none',
    textWrap: 'pretty',
  };
}

const boxOf = (box: Box) => ({ x: round4(box.x), y: round4(box.y), w: round4(box.w), h: round4(box.h) });

export interface NewObjectOptions {
  layerId: Id;
  box: Box;
}

export function makeText(doc: LayoutDocument, { layerId, box }: NewObjectOptions, text = 'Votre texte'): TextObject {
  return {
    id: newObjectId(doc, 'text'),
    type: 'text',
    name: 'Texte',
    layerId,
    ...boxOf(box),
    style: defaultTextStyle(doc),
    paragraphs: [{ runs: [{ text }] }],
  };
}

export function makeRect(doc: LayoutDocument, { layerId, box }: NewObjectOptions): RectObject {
  return { id: newObjectId(doc, 'rect'), type: 'rect', name: 'Rectangle', layerId, ...boxOf(box), fill: defaultColor(doc, 'fill') };
}

export function makeEllipse(doc: LayoutDocument, { layerId, box }: NewObjectOptions): EllipseObject {
  return { id: newObjectId(doc, 'ellipse'), type: 'ellipse', name: 'Ellipse', layerId, ...boxOf(box), fill: defaultColor(doc, 'fill') };
}

export function makeLine(doc: LayoutDocument, { layerId, box }: NewObjectOptions, flip = false): LineObject {
  return {
    id: newObjectId(doc, 'line'),
    type: 'line',
    name: 'Ligne',
    layerId,
    ...boxOf(box),
    stroke: { color: defaultColor(doc, 'stroke'), width: 0.5 },
    ...(flip ? { flip: true } : {}),
  };
}

export function makeFrame(doc: LayoutDocument, { layerId, box }: NewObjectOptions, shape: ShapeRef = { kind: 'rect' }, name = 'Cadre photo'): FrameObject {
  return { id: newObjectId(doc, 'frame'), type: 'frame', name, layerId, ...boxOf(box), shape, placeholder: 'Photo' };
}

/** Forme = cadre à tracé (toute forme peut recevoir une photo, décision I1), remplie de la nuance de marque. */
export function makeShape(doc: LayoutDocument, options: NewObjectOptions, presetId = 'goutte'): FrameObject {
  const preset = SHAPE_PRESETS[presetId] ?? SHAPE_PRESETS.goutte;
  const frame = makeFrame(doc, options, { kind: 'path', d: preset.d, preset: preset.id }, preset.name);
  delete frame.placeholder;
  frame.fill = defaultColor(doc, 'fill');
  return frame;
}

export function makeIcon(doc: LayoutDocument, { layerId, box }: NewObjectOptions, icon = DEFAULT_ICON): IconObject {
  return {
    id: newObjectId(doc, 'icon'),
    type: 'icon',
    name: `Icône · ${icon.name}`,
    layerId,
    ...boxOf(box),
    iconName: icon.name,
    svg: icon.svg,
    color: defaultColor(doc, 'fill'),
    strokeWidth: 2,
  };
}

export function makeQr(doc: LayoutDocument, { layerId, box }: NewObjectOptions, url = DEFAULT_QR_URL): QrObject {
  const side = Math.max(box.w, box.h);
  return {
    id: newObjectId(doc, 'qr'),
    type: 'qr',
    name: 'QR code',
    layerId,
    ...boxOf({ ...box, w: side, h: side }),
    url,
    ecc: 'M',
    color: defaultColor(doc, 'dark'),
    background: defaultColor(doc, 'white'),
    margin: 4,
  };
}

export type ObjectFactory = (doc: LayoutDocument, options: NewObjectOptions) => DocObject;
