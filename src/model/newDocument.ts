// Document vierge créé depuis un gabarit, copie d'un document, identifiant tiré d'un nom (page d'accueil :
// « Nouveau document », « Dupliquer »). Fonctions pures, sans accès au disque : le serveur
// (server/templates.ts) réserve le dossier, recalcule l'affichage des nuances par le profil et écrit.
import { checkFormat } from './format';
import { TEXT_BLACK_SWATCH, type Cmyk } from './swatches';
import { describeTemplate } from './templates';
import { DOC_VERSION, type DocumentFormat, type FaceFormat, type Id, type Layer, type LayoutDocument, type Mm, type Swatch } from './types';

// ---------------------------------------------------------------- nuancier et calques de départ

/**
 * Nuancier de départ. Les encres font foi : un bleu et un marine de quadrichromie courants, le texte courant
 * en noir seul (N 80, pour que les petits corps ne dépendent pas du repérage) et le noir N 100.
 * `rgb` est leur simulation par FOGRA39 (colorimétrie relative, compensation du point noir),
 * celle que calcule `cmykToRgb` (server/color.ts) : le serveur la recalcule à la création avec le profil du
 * préréglage de référence ; ces valeurs ne servent telles quelles que si Python est absent.
 * test/new-document.test.ts vérifie qu'elles restent celles du profil.
 */
export const STARTER_SWATCHES: readonly (Swatch & { cmyk: Cmyk })[] = [
  { id: 'blanc', name: 'Blanc', rgb: '#ffffff', cmyk: [0, 0, 0, 0] },
  { id: 'noir', name: 'Noir 100 %', rgb: '#1d1d1b', cmyk: [0, 0, 0, 100] },
  { id: TEXT_BLACK_SWATCH.id, name: TEXT_BLACK_SWATCH.name, rgb: '#575756', cmyk: TEXT_BLACK_SWATCH.cmyk },
  { id: 'bleu', name: 'Bleu', rgb: '#005ca9', cmyk: [100, 60, 0, 0] },
  { id: 'marine', name: 'Marine', rgb: '#13315e', cmyk: [100, 80, 25, 35] },
];

/**
 * Calques de départ, ceux d'un design importé. Contrairement à l'import, « Fonds » n'est pas verrouillé :
 * dans un document vierge, c'est justement là qu'on pose les aplats de fond.
 */
export const STARTER_LAYERS: readonly Layer[] = [
  { id: 'fonds', name: 'Fonds', visible: true, locked: false, printable: true, color: '#8a94a6' },
  { id: 'contenu', name: 'Contenu', visible: true, locked: false, printable: true, color: '#2563eb' },
  { id: 'reperes', name: 'Repères et notes', visible: true, locked: false, printable: false, color: '#e0245e' },
];

// ---------------------------------------------------------------- création

export interface BlankDocumentInput {
  id: Id;
  name: string;
  format: DocumentFormat;
  /** Date ISO de création (par défaut : maintenant). */
  createdAt?: string;
}

/** Identifiant de la page qui imprime une face (`p-recto`, `p-exterieur`…). */
export const pageIdForFace = (face: FaceFormat): Id => `p-${face.id}`;

/**
 * Document vierge : une page par face du gabarit, trois calques (fonds, contenu, repères non imprimables),
 * le nuancier de départ, aucun objet ni style. Un gabarit incohérent (volets ≠ format fini) est refusé :
 * l'erreur se verrait sinon à l'impression.
 */
export function createBlankDocument({ id, name, format, createdAt }: BlankDocumentInput): LayoutDocument {
  const errors = checkFormat(format);
  if (errors.length) throw new Error(`Gabarit ${format.id} incohérent : ${errors.join(' ; ')}`);
  return {
    version: DOC_VERSION,
    id,
    name,
    createdAt: createdAt ?? new Date().toISOString(),
    format: structuredClone(format),
    pages: format.faces.map((face) => ({ id: pageIdForFace(face), faceId: face.id, name: face.name, children: [] })),
    layers: STARTER_LAYERS.map((layer) => ({ ...layer })),
    objects: {},
    swatches: STARTER_SWATCHES.map((swatch) => ({ ...swatch, cmyk: [...swatch.cmyk] as Cmyk })),
    styles: { paragraph: [], character: [] },
    assets: [],
  };
}

// ---------------------------------------------------------------- duplication

/** Nom proposé pour la copie d'un document. */
export const duplicateName = (name: string): string => `Copie de ${name}`;

/**
 * Copie d'un document sous un nouvel identifiant : pages, objets, nuancier, styles, images (mêmes chemins
 * relatifs, le serveur copie les fichiers), pages types. `editedAt` est retiré : la copie n'a encore jamais
 * été enregistrée depuis l'éditeur.
 */
export function copyDocument(source: LayoutDocument, { id, name, createdAt }: { id: Id; name: string; createdAt?: string }): LayoutDocument {
  const copy = structuredClone(source);
  delete copy.editedAt;
  return { ...copy, id, name, createdAt: createdAt ?? new Date().toISOString() };
}

// ---------------------------------------------------------------- identifiant tiré du nom

/** Longueur maximale de la base : laisse la place d'un suffixe « -999 » dans les 64 caractères d'un identifiant. */
const ID_BASE_MAX = 56;
// Noms réservés par Windows : un dossier « con » ou « nul » ne peut pas être créé.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;
// Ligatures et lettres que la décomposition Unicode ne ramène pas à l'ASCII (« Œuvre » → « oeuvre »).
const LIGATURES: Record<string, string> = { œ: 'oe', Œ: 'oe', æ: 'ae', Æ: 'ae', ß: 'ss', ø: 'o', Ø: 'o', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd' };

/**
 * Identifiant de dossier tiré d'un nom : minuscules, sans accents, mots séparés par des tirets
 * (« Flyer rentrée 2026 » → `flyer-rentree-2026`). Le serveur y ajoute -2, -3… s'il est déjà pris.
 */
export function docIdFromName(name: string): Id {
  const slug = name
    .replace(/[œŒæÆßøØłŁđĐ]/g, (c) => LIGATURES[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_BASE_MAX)
    .replace(/-+$/, '');
  if (!slug) return 'document';
  return WINDOWS_RESERVED.test(slug) ? `document-${slug}` : slug;
}

// ---------------------------------------------------------------- gabarits pour l'interface

/** Gabarit tel que le décrit GET /api/templates (cartes de la boîte « Nouveau document »). */
export interface TemplateSummary {
  id: string;
  name: string;
  /** « 297 × 210 mm · 2 faces · 3 volets · fond perdu 3 mm ». */
  description: string;
  faces: FaceFormat[];
  trim: { w: Mm; h: Mm };
  bleed: Mm;
}

export function templateSummary(template: DocumentFormat): TemplateSummary {
  return {
    id: template.id,
    name: template.name,
    description: describeTemplate(template),
    faces: structuredClone(template.faces),
    trim: { ...template.trim },
    bleed: template.bleed,
  };
}
