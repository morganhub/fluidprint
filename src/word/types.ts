// Structure d'un fichier Word (.docx) telle que la lit le serveur (server/docx/read.ts) et que la reçoit
// l'éditeur pour la « Placer » (src/word/place.ts). Rien ici ne dépend de Node : l'éditeur et le serveur
// partagent ces types.
import type { Asset } from '../model/types';
//
// Le lecteur rend la STRUCTURE du document (paragraphes et leur style Word, listes, tableaux, images,
// liens), pas sa mise en page : tailles, polices et couleurs de Word ne sont pas reprises (le document n'a
// qu'Open Sans et un nuancier CMJN). Les polices et couleurs rencontrées sont seulement listées, pour le
// signaler dans le rapport.

export type WordAlign = 'left' | 'center' | 'right' | 'justify';

/** Texte d'un paragraphe ; `\n` = retour à la ligne forcé (Maj+Entrée), `\t` = tabulation. */
export interface WordText {
  type: 'text';
  text: string;
  /** Mise en forme DIRECTE (ou d'un style de caractère) ; absente = celle du style de paragraphe. */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Adresse du lien hypertexte qui porte ce texte. */
  link?: string;
}

/** Image incorporée, à sa place dans le flux du texte. */
export interface WordImageRef {
  type: 'image';
  /** Identifiant dans `WordDocument.images`. */
  image: string;
}

export type WordInline = WordText | WordImageRef;

export interface WordList {
  kind: 'bullet' | 'number';
  /** Niveau d'imbrication : 0 = premier niveau. */
  level: number;
  /** Numéro que Word affiche (listes numérotées). */
  number?: number;
  /** Format Word du numéro : decimal, lowerLetter, upperRoman… */
  format?: string;
  /** Numéro tel que Word l'écrit (« 3. », « b) », « 1.2. ») ; « • » pour une puce. */
  marker?: string;
}

export interface WordParagraph {
  type: 'paragraph';
  /** Style Word : identifiant (w:styleId, « Titre1 ») et nom (w:name, « heading 1 », « Normal », « Quote »). */
  styleId?: string;
  styleName?: string;
  /** Niveau de titre 1 à 6 (style de titre ou niveau hiérarchique) ; absent pour un paragraphe ordinaire. */
  heading?: number;
  /** « Titre » du document (style Title). */
  title?: boolean;
  list?: WordList;
  /** Alignement direct ou du style Word ; absent = à gauche. */
  align?: WordAlign;
  content: WordInline[];
}

export interface WordTableCell {
  paragraphs: WordParagraph[];
}

export interface WordTable {
  type: 'table';
  /** Numéro du tableau dans le document (1, 2…), pour les messages. */
  index: number;
  rows: WordTableCell[][];
}

export type WordBlock = WordParagraph | WordTable;

export interface WordImage {
  /** `img1`, `img2`… */
  id: string;
  /** Partie du paquet (`word/media/image1.png`). */
  part: string;
  /** Nom de fichier sûr (`image1.png`). */
  name: string;
  /** Texte de remplacement saisi dans Word. */
  alt?: string;
}

/** Style de paragraphe Word employé par le document. */
export interface WordStyle {
  id: string;
  /** Nom interne de Word (« heading 1 », « Title », « Normal », « Quote »…), en anglais pour les styles prédéfinis. */
  name: string;
  heading?: number;
  /** Gras / italique définis par le style (ou hérités de son style parent). */
  bold?: boolean;
  italic?: boolean;
}

export interface WordDocument {
  blocks: WordBlock[];
  images: WordImage[];
  /** Styles de paragraphe employés, par identifiant. */
  styles: Record<string, WordStyle>;
  /** Polices rencontrées (texte, styles, thème) : ignorées, le texte est composé en Open Sans. */
  fonts: string[];
  /** Couleurs rencontrées (#rrggbb, surlignages) : ignorées, le texte prend les nuances du nuancier. */
  colors: string[];
  /** Avertissements de lecture, en français, destinés à l'utilisateur. */
  warnings: string[];
}

/** Réponse de POST /api/doc/:id/word : la structure lue et les photos déjà enregistrées dans le document. */
export interface WordImportResponse {
  /** Nom du fichier reçu (« rapport.docx »). */
  fileName: string;
  document: WordDocument;
  /** Photos enregistrées comme des photos déposées (originaux intacts, aperçus), par identifiant d'image Word. */
  assets: Record<string, Asset>;
}

/** Réponse de POST /api/doc/from-word : le document créé d'après un gabarit, et le fichier Word lu. */
export interface NewFromWordResponse extends WordImportResponse {
  id: string;
}
