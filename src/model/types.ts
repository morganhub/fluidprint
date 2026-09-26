// Modèle de document de l'éditeur.
//
// Conventions, valables partout :
// - positions et tailles en millimètres, dans le repère de la FACE : origine au coin haut-gauche
//   du fond perdu ; la taille d'une face vient du gabarit (`format`) : 303 × 216 mm pour le dépliant
//   pli roulé, 154 × 216 mm pour le flyer A5… ;
// - corps de texte et épaisseurs de filet en points (1 pt = 25,4 / 72 mm) ;
// - coordonnées ABSOLUES sur la face, y compris pour les objets d'un groupe : déplacer un groupe
//   déplace chacun de ses enfants ; la boîte du groupe est tenue à jour ;
// - aucune couleur en dur : toute couleur référence une nuance du nuancier (`ColorRef`).

export type Id = string;
/** Millimètres. */
export type Mm = number;
/** Points typographiques. */
export type Pt = number;

export const DOC_VERSION = 2;

// ---------------------------------------------------------------- couleurs

export interface Swatch {
  id: Id;
  name: string;
  /** Aperçu écran, `#rrggbb` en minuscules. */
  rgb: string;
  /** Valeurs d'encre 0-100 (C, M, J, N) ; renseignées en phase 4 (nuancier CMJN). */
  cmyk?: [number, number, number, number];
  /**
   * Couleur d'origine du design (`#rrggbb`), avant conversion en CMJN : `rgb` devient alors la simulation
   * des encres. Sert au contrôle au pixel de l'import (`/print/:id?colors=source`).
   */
  sourceRgb?: string;
  /**
   * Nuance d'accent admise en petit texte (moins de 9 pt) au-delà de deux encres : intertitres et libellés
   * colorés, teintes claires sur fond foncé, variante « petit texte » à trois encres (scripts/print-swatches.ts). Sans ce
   * drapeau, le contrôle en amont et l'export imprimeur refusent un petit texte à plus de deux encres.
   */
  smallTextException?: boolean;
}

export interface ColorRef {
  swatch: Id;
  /** Teinte 0-1 (1 = nuance pleine). */
  tint?: number;
}

export interface Stroke {
  color: ColorRef;
  width: Pt;
  /** Pointillés, longueurs en mm. */
  dash?: number[];
}

// ---------------------------------------------------------------- format (gabarit)

export interface PanelFormat {
  name: string;
  /** Largeur finie du volet, sans fond perdu. */
  w: Mm;
}

export interface FaceFormat {
  id: Id;
  name: string;
  /** Volets de gauche à droite ; les plis tombent entre deux volets. */
  panels: PanelFormat[];
}

export interface DocumentFormat {
  id: string;
  name: string;
  /** Format fini (après coupe). */
  trim: { w: Mm; h: Mm };
  /** Fond perdu, identique sur les quatre bords. */
  bleed: Mm;
  /** Zone de sécurité, depuis le trait de coupe et de part et d'autre de chaque pli. */
  safety: Mm;
  faces: FaceFormat[];
}

// ---------------------------------------------------------------- pages, calques

export interface Guide {
  id: Id;
  axis: 'x' | 'y';
  /** Position en mm dans le repère de la face. */
  at: Mm;
  locked?: boolean;
}

export interface Page {
  id: Id;
  /** Face du gabarit que cette page imprime. */
  faceId: Id;
  name: string;
  /** Objets de premier niveau, du dessous vers le dessus (au sein de chaque calque). */
  children: Id[];
  guides?: Guide[];
  /** Page type appliquée (tâche 4.11) : ses objets s'affichent sous ceux de la face. */
  masterId?: Id;
}

/**
 * Page type (tâche 4.11) : objets communs affichés sous les objets de chaque face qui l'utilise, et
 * modifiables à un seul endroit. Ses objets vivent dans `objects` comme les autres ; `faceId` donne le
 * gabarit (volets, plis) sur lequel on la dessine en mode d'édition.
 */
export interface MasterPage {
  id: Id;
  faceId: Id;
  name: string;
  /** Objets de premier niveau, du dessous vers le dessus (au sein de chaque calque). */
  children: Id[];
  guides?: Guide[];
}

export interface Layer {
  id: Id;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Faux : jamais dans la route d'impression ni dans l'export. */
  printable: boolean;
  /** Couleur du cadre de sélection des objets du calque (interface uniquement). */
  color: string;
}

// ---------------------------------------------------------------- objets

export type ObjectType = 'text' | 'rect' | 'ellipse' | 'line' | 'path' | 'frame' | 'icon' | 'svg' | 'qr' | 'group';

interface BaseObject {
  id: Id;
  type: ObjectType;
  /** Nom lisible (panneau Calques). */
  name?: string;
  /** Calque ; les enfants d'un groupe ont le calque du groupe. */
  layerId: Id;
  x: Mm;
  y: Mm;
  w: Mm;
  h: Mm;
  /** Degrés, sens horaire, autour du centre de la boîte. */
  rotation?: number;
  /** 0-1. */
  opacity?: number;
  locked?: boolean;
  hidden?: boolean;
  /** Habillage (tâche 4.13) : les blocs texte qui chevauchent l'objet contournent sa forme. */
  wrap?: TextWrap;
}

/** Habillage porté par l'objet contourné (comme dans InDesign). */
export interface TextWrap {
  /** Marge entre la forme et le texte, en mm. */
  margin: Mm;
  /** Vrai : le texte reste À L'INTÉRIEUR de la forme (il en épouse le contour) au lieu de la contourner. */
  invert?: boolean;
}

export type TextTransform = 'none' | 'uppercase';
export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** Mise en forme d'un bloc texte (niveau paragraphe) ; les segments peuvent en surcharger une partie. */
export interface TextStyle {
  fontFamily: string;
  fontWeight: number;
  italic?: boolean;
  fontSize: Pt;
  /** Interlignage, multiple du corps (1.5 = 150 %). */
  lineHeight: number;
  /** Interlettrage en em (0.08 = 0,08 em). */
  letterSpacing: number;
  color: ColorRef;
  align: TextAlign;
  transform: TextTransform;
  textWrap?: 'wrap' | 'pretty' | 'balance';
  /** Espace au-dessus de chaque paragraphe sauf le premier du bloc, en mm (styles de paragraphe). */
  spaceBefore?: Mm;
  /** Espace sous chaque paragraphe sauf le dernier du bloc, en mm. */
  spaceAfter?: Mm;
}

/** Segment de texte ; `\n` = retour à la ligne forcé (le `<br>` du HTML). */
export interface TextRun {
  text: string;
  color?: ColorRef;
  fontWeight?: number;
  italic?: boolean;
  fontSize?: Pt;
  letterSpacing?: number;
  transform?: TextTransform;
  /** Souligné (import Word). */
  underline?: boolean;
  /** Style de caractère nommé ; les champs ci-dessus restent les valeurs effectives (dénormalisées). */
  characterStyleId?: Id;
}

export type ListNumberFormat = 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';

/**
 * Paragraphe d'une liste (import Word) : la puce ou le numéro est DESSINÉ dans le retrait suspendu du
 * paragraphe (`firstLineIndent` négatif), il ne fait pas partie du texte. Les numéros se calculent dans
 * l'ordre de l'article (model/lists.ts) : ajouter un élément renumérote les suivants.
 */
export interface ParagraphList {
  kind: 'bullet' | 'number';
  /** Niveau d'imbrication : 0 = premier niveau. */
  level: number;
  /** Numérotation : format du numéro (décimal par défaut) et signe qui le suit (« . » par défaut). */
  format?: ListNumberFormat;
  suffix?: '.' | ')';
  /** Numéro imposé à ce paragraphe (liste qui repart) ; sinon il suit le précédent du même niveau. */
  start?: number;
}

export interface Paragraph {
  runs: TextRun[];
  /** Surcharges de paragraphe (un intitulé et sa durée dans le même bloc, par exemple). */
  fontSize?: Pt;
  lineHeight?: number;
  align?: TextAlign;
  /** Espace au-dessus du paragraphe, en mm. */
  spaceBefore?: Mm;
  /** Espace sous le paragraphe (sauf le dernier du bloc), en mm. */
  spaceAfter?: Mm;
  /** Retrait gauche de tout le paragraphe, en mm. */
  leftIndent?: Mm;
  /** Retrait de la première ligne par rapport au retrait gauche, en mm ; négatif : retrait suspendu (puces). */
  firstLineIndent?: Mm;
  list?: ParagraphList;
  /**
   * Style de paragraphe propre à ce paragraphe quand il diffère de celui du bloc (un intertitre dans un
   * texte importé de Word). Comme pour un bloc, c'est une référence : les valeurs effectives du style sont
   * recopiées dans les surcharges du paragraphe et dans ses segments (voir model/styles.ts).
   */
  paragraphStyleId?: Id;
}

export interface TextObject extends BaseObject {
  type: 'text';
  style: TextStyle;
  paragraphs: Paragraph[];
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** Style de paragraphe nommé (phase 2). */
  paragraphStyleId?: Id;
  /** Vrai : la hauteur du bloc suit celle de son texte (tâche 2.26). */
  autoHeight?: boolean;
  /** Nombre de lignes mesuré lors du dernier rendu de référence (import ou éditeur) : l'export le compare. */
  lines?: number;
  /**
   * Bloc suivant du chaînage (tâche 4.12) : le texte en excès continue dans ce bloc. Le texte de toute la
   * chaîne est porté par le premier bloc ; les paragraphes des blocs suivants sont ignorés.
   */
  nextId?: Id;
}

export interface RectObject extends BaseObject {
  type: 'rect';
  fill?: ColorRef;
  stroke?: Stroke;
  /** Arrondi en mm : une valeur, ou [haut-gauche, haut-droit, bas-droit, bas-gauche]. */
  radius?: Mm | [Mm, Mm, Mm, Mm];
}

export interface EllipseObject extends BaseObject {
  type: 'ellipse';
  fill?: ColorRef;
  stroke?: Stroke;
}

/** Trait droit : du coin haut-gauche au coin bas-droit de sa boîte (bas-gauche → haut-droit si `flip`).
 *  Horizontal si h = 0, vertical si w = 0. Le filet est centré sur le tracé. */
export interface LineObject extends BaseObject {
  type: 'line';
  stroke: Stroke;
  flip?: boolean;
}

/** Tracé libre, normalisé dans la boîte 0..1 (voir `model/shapes.ts`), étiré à la boîte de l'objet. */
export interface PathObject extends BaseObject {
  type: 'path';
  d: string;
  fill?: ColorRef;
  stroke?: Stroke;
  /** Vrai : l'épaisseur du filet ne suit pas l'étirement (traits de vague). */
  nonScalingStroke?: boolean;
}

export type ShapeRef =
  | { kind: 'rect'; radius?: Mm | [Mm, Mm, Mm, Mm] }
  | { kind: 'ellipse' }
  /** Tracé normalisé 0..1 ; `preset` rappelle d'où il vient (goutte, vague…). */
  | { kind: 'path'; d: string; preset?: string; polygon?: PolygonParams };

/** Polygone ou étoile paramétrique (3.4) : le tracé `d` en est recalculé à chaque changement. */
export interface PolygonParams {
  /** Nombre de côtés (ou de branches), 3 à 12. */
  sides: number;
  /** Creux de l'étoile en % (0 = polygone régulier). */
  inset: number;
  /** Arrondi des sommets en % (0 = sommets vifs). */
  rounding: number;
}

/** Forme de la bibliothèque du document (importée d'un SVG, 3.3) : tracé normalisé 0..1. */
export interface ShapeDefinition {
  id: Id;
  name: string;
  d: string;
  /** Rapport largeur / hauteur d'origine. */
  aspect: number;
}

export type ImageFit = 'fill' | 'fit' | 'center' | 'custom';

/** Photo placée dans un cadre : sa boîte en mm, relative au coin haut-gauche du cadre ; elle peut dépasser. */
export interface FrameImage {
  assetId: Id;
  fit: ImageFit;
  x: Mm;
  y: Mm;
  w: Mm;
  h: Mm;
  /** Vrai : la photo doit toujours couvrir le cadre (placée en Remplir, puis recadrée à la main). */
  cover?: boolean;
}

/** Cadre : une forme qui peut recevoir une photo, découpée à la forme (clipPath SVG). */
export interface FrameObject extends BaseObject {
  type: 'frame';
  shape: ShapeRef;
  /** Fond de la forme, visible sans photo (la goutte blanche, par exemple). */
  fill?: ColorRef;
  stroke?: Stroke;
  image?: FrameImage;
  /** Légende de la zone vide, affichée à l'écran seulement. */
  placeholder?: string;
}

/** Icône Lucide : trait `currentColor` dans un viewBox 24 × 24. */
export interface IconObject extends BaseObject {
  type: 'icon';
  /** Nom Lucide (pour la remplacer depuis la bibliothèque). */
  iconName: string;
  /** Contenu SVG interne (éléments path, circle…), tel que Lucide le fournit. */
  svg: string;
  color: ColorRef;
  /** Épaisseur du trait dans les unités du viewBox (Lucide : 2). */
  strokeWidth: number;
}

/** Graphique vectoriel importé tel quel (logo) ; `currentColor` prend `color`. */
export interface SvgObject extends BaseObject {
  type: 'svg';
  viewBox: string;
  /** Contenu SVG interne. */
  content: string;
  color?: ColorRef;
  preserveAspectRatio?: string;
}

export interface QrObject extends BaseObject {
  type: 'qr';
  url: string;
  ecc: 'L' | 'M' | 'Q' | 'H';
  color: ColorRef;
  /** Fond, en général blanc ; absent = transparent. */
  background?: ColorRef;
  /** Marge blanche en modules (4 recommandé). */
  margin: number;
}

export interface GroupObject extends BaseObject {
  type: 'group';
  /** Enfants, du dessous vers le dessus. */
  children: Id[];
}

export type DocObject =
  | TextObject
  | RectObject
  | EllipseObject
  | LineObject
  | PathObject
  | FrameObject
  | IconObject
  | SvgObject
  | QrObject
  | GroupObject;

// ---------------------------------------------------------------- styles, images

export interface ParagraphStyle {
  id: Id;
  name: string;
  style: TextStyle;
  /** Créé par l'import d'un fichier Word (même nom que le style Word). */
  origin?: 'word';
}

export interface CharacterStyle {
  id: Id;
  name: string;
  style: Partial<Omit<TextRun, 'text' | 'characterStyleId'>>;
}

export interface Asset {
  id: Id;
  kind: 'image';
  name: string;
  /** Chemin relatif au dossier du document (assets/originals/…) : c'est lui qui part à l'export. */
  original: string;
  /** Aperçu léger pour l'écran (assets/previews/…). */
  preview?: string;
  /**
   * Copie pleine résolution que Chrome sait décoder (assets/print/…), quand l'original ne l'est pas
   * (TIFF) : c'est elle que charge la route d'impression. L'original reste la référence d'archive.
   */
  print?: string;
  /** Dimensions de l'original, en pixels. */
  width: number;
  height: number;
  /** Photo provisoire (tirée du PDF Canva) : l'export imprimeur la refuse. */
  placeholder?: boolean;
}

// ---------------------------------------------------------------- document

export interface LayoutDocument {
  version: typeof DOC_VERSION;
  id: Id;
  name: string;
  createdAt: string;
  /** Posé au premier enregistrement depuis l'éditeur : l'import refuse alors d'écraser le document. */
  editedAt?: string;
  format: DocumentFormat;
  pages: Page[];
  /** Du dessous vers le dessus. */
  layers: Layer[];
  objects: Record<Id, DocObject>;
  swatches: Swatch[];
  styles: { paragraph: ParagraphStyle[]; character: CharacterStyle[] };
  assets: Asset[];
  source?: { kind: 'claude-design'; path: string; importedAt: string };
  /** Formes ajoutées à la bibliothèque du document (import SVG). */
  shapes?: ShapeDefinition[];
  /** Pages types (tâche 4.11). */
  masters?: MasterPage[];
}
