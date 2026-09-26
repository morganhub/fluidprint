// Format du document importé, déduit du design Claude Design (sans navigateur) :
//  a. gabarit imposé (--template, champ « Gabarit » de l'interface) : ses tailles doivent correspondre ;
//  b. sinon, gabarit dont la taille de face (fond perdu compris), le nombre de faces et les repères
//     éventuels (cadre de coupe, plis) correspondent au design ;
//  c. sinon, format sur mesure : taille de <doc-page>, fond perdu et plis lus dans les repères `<sc-if>`.
import { checkFormat, faceSize, foldPositions } from '../../src/model/format';
import { findTemplate, TEMPLATES, templatesForFaceSize } from '../../src/model/templates';
import type { DocumentFormat, FaceFormat, Mm } from '../../src/model/types';
import { DesignImportError, fmtMm, round4, slugify, type DesignSection, type ParsedDesign } from './designSource';

export type FormatOrigin = 'template' | 'detected' | 'custom';

export interface FaceAssignment {
  /** Section du design qui imprime la face. */
  sectionId: string;
  /** Rang de cette section dans le design : deux sections peuvent porter le même id. */
  sectionIndex: number;
  faceId: string;
  /** Nom de la page (celui de la face). */
  name: string;
}

export interface ResolvedFormat {
  format: DocumentFormat;
  origin: FormatOrigin;
  /** Une entrée par face du format, dans l'ordre du format. */
  faces: FaceAssignment[];
  /** Comment le format a été choisi (rapport). */
  notes: string[];
  /** Points à vérifier (avertissements du rapport). */
  warnings: string[];
}

/** Écart admis entre la taille d'une face du design et celle d'un gabarit (même valeur que templatesForFaceSize). */
export const SIZE_TOLERANCE_MM = 0.5;
/** Écart admis entre un repère du design (pli, retrait du cadre de coupe) et le gabarit. */
const GUIDE_TOLERANCE_MM = 0.5;
/** Fond perdu supposé quand la page mesure un format connu plus 2 × 3 mm. */
const STANDARD_BLEED_MM = 3;

/** Formats finis reconnus pour deviner un fond perdu de 3 mm (l'autre orientation est essayée aussi). */
const KNOWN_TRIMS: { name: string; w: Mm; h: Mm; oriented: boolean }[] = [
  { name: 'A3', w: 297, h: 420, oriented: true },
  { name: 'A4', w: 210, h: 297, oriented: true },
  { name: 'A5', w: 148, h: 210, oriented: true },
  { name: 'A6', w: 105, h: 148, oriented: true },
  { name: 'Carte de visite', w: 85, h: 55, oriented: false },
];

const sizeLabel = (w: Mm, h: Mm) => `${fmtMm(w)} × ${fmtMm(h)} mm`;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Nom du format connu de `w × h` mm (« A5 », « A4 paysage », « Carte de visite »), ou null. */
function knownTrim(w: Mm, h: Mm): string | null {
  const near = (a: Mm, b: Mm) => Math.abs(a - b) <= SIZE_TOLERANCE_MM;
  for (const k of KNOWN_TRIMS) {
    if (near(k.w, w) && near(k.h, h)) return k.name;
    if (near(k.h, w) && near(k.w, h)) return k.oriented ? `${k.name} paysage` : k.name;
  }
  return null;
}

/**
 * Sections du design rangées sur les faces d'un format : par identifiant si chaque face trouve la section
 * du même nom (« recto », « verso »), sinon dans l'ordre. `sections` a autant d'éléments que de faces.
 */
export function assignSections(sections: DesignSection[], format: DocumentFormat): FaceAssignment[] {
  const ids = sections.map((s) => slugify(s.id));
  const byId = new Set(ids).size === ids.length && format.faces.every((f) => ids.includes(f.id));
  return format.faces.map((face, i) => {
    const sectionIndex = byId ? ids.indexOf(face.id) : i;
    return { sectionId: sections[sectionIndex].id, sectionIndex, faceId: face.id, name: face.name };
  });
}

/** Désaccords entre les repères dessinés dans le design et un gabarit (vide : compatibles). */
function guideConflicts(design: ParsedDesign, format: DocumentFormat, faces: FaceAssignment[]): string[] {
  const out: string[] = [];
  for (const a of faces) {
    const guides = design.sections[a.sectionIndex].guides;
    if (!guides) continue;
    if (guides.bleed !== undefined && Math.abs(guides.bleed - format.bleed) > GUIDE_TOLERANCE_MM) {
      out.push(`section « ${a.sectionId} » : cadre de coupe à ${fmtMm(guides.bleed)} mm du bord, le gabarit a ${fmtMm(format.bleed)} mm de fond perdu`);
    }
    const expected = foldPositions(format, a.faceId);
    const same = expected.length === guides.folds.length && expected.every((x, i) => Math.abs(x - guides.folds[i]) <= GUIDE_TOLERANCE_MM);
    if (!same) {
      const list = (xs: Mm[]) => (xs.length ? `${xs.map(fmtMm).join(', ')} mm` : 'aucun');
      out.push(`section « ${a.sectionId} » : plis du design ${list(guides.folds)}, plis du gabarit ${list(expected)}`);
    }
  }
  return out;
}

function templateLabel(t: DocumentFormat): string {
  return `« ${t.name} » (${t.id})`;
}

// ---------------------------------------------------------------- a. gabarit imposé

function forcedTemplate(design: ParsedDesign, templateId: string): ResolvedFormat {
  const template = findTemplate(templateId);
  if (!template) {
    throw new DesignImportError(`Gabarit inconnu : « ${templateId} ». Gabarits disponibles : ${TEMPLATES.map((t) => t.id).join(', ')}.`);
  }
  const size = faceSize(template);
  const { w, h } = design.page;
  if (Math.abs(size.w - w) > SIZE_TOLERANCE_MM || Math.abs(size.h - h) > SIZE_TOLERANCE_MM) {
    throw new DesignImportError(
      `Le gabarit ${templateLabel(template)} ne correspond pas au design : ses faces mesurent ${sizeLabel(size.w, size.h)} fond perdu compris, ` +
        `celles du design ${sizeLabel(w, h)} (${design.page.from}).`,
    );
  }
  const count = design.sections.length;
  if (count !== template.faces.length) {
    throw new DesignImportError(
      `Le gabarit ${templateLabel(template)} a ${plural(template.faces.length, 'face', 'faces')} (${template.faces.map((f) => f.name).join(', ')}), ` +
        `le design ${plural(count, 'page', 'pages')} (${design.sections.map((s) => s.id).join(', ')}).`,
    );
  }
  const faces = assignSections(design.sections, template);
  return {
    format: template,
    origin: 'template',
    faces,
    notes: [`Gabarit imposé : ${templateLabel(template)}.`],
    warnings: guideConflicts(design, template, faces).map((c) => `repères du design différents du gabarit imposé : ${c}`),
  };
}

// ---------------------------------------------------------------- c. format sur mesure

function safetyFor(trim: { w: Mm; h: Mm }): Mm {
  // Comme les gabarits livrés : 3 mm sur une carte, 5 mm à partir de l'A4 plein, 4 mm entre les deux.
  const side = Math.min(trim.w, trim.h);
  return side <= 60 ? 3 : side >= 200 ? 5 : 4;
}

function customFormat(design: ParsedDesign, notes: string[]): ResolvedFormat {
  const warnings: string[] = [];
  const { w, h } = design.page;

  // Fond perdu : le cadre de coupe des repères, sinon 3 mm autour d'un format connu, sinon rien.
  let bleed = 0;
  const insets = design.sections.map((s) => s.guides?.bleed).filter((b): b is Mm => b !== undefined);
  if (insets.length) {
    bleed = insets[0];
    if (insets.some((b) => Math.abs(b - bleed) > 0.01)) warnings.push(`cadres de coupe différents selon les pages (${insets.map(fmtMm).join(', ')} mm) : ${fmtMm(bleed)} mm retenu`);
    if (2 * bleed >= Math.min(w, h)) {
      warnings.push(`cadre de coupe à ${fmtMm(bleed)} mm du bord : plus grand que la page, ignoré ; pas de fond perdu`);
      bleed = 0;
    } else {
      notes.push(`Fond perdu : ${fmtMm(bleed)} mm, lu dans le cadre de coupe des repères du design.`);
    }
  } else {
    const known = knownTrim(w - 2 * STANDARD_BLEED_MM, h - 2 * STANDARD_BLEED_MM);
    if (known) {
      bleed = STANDARD_BLEED_MM;
      notes.push(`Fond perdu : 3 mm, car la page (${sizeLabel(w, h)}) mesure le format ${known} plus 2 × 3 mm.`);
    } else {
      warnings.push(
        `pas de fond perdu : ni cadre de coupe dans les repères du design, ni format connu (A3 à A6, carte de visite) à ${sizeLabel(w, h)} moins 2 × 3 mm ; ` +
          `le document est au format de la page, fond perdu 0 mm`,
      );
    }
  }
  const trim = { w: round4(w - 2 * bleed), h: round4(h - 2 * bleed) };

  // Une face par section, identifiant tiré de celui de la section (unique), volets tirés des plis dessinés.
  const used = new Set<string>();
  let panelNumber = 0;
  const faces: FaceFormat[] = design.sections.map((section, i) => {
    let id = slugify(section.id) || `page-${i + 1}`;
    for (let n = 2; used.has(id); n++) id = `${slugify(section.id) || 'page'}-${n}`;
    used.add(id);
    const folds = (section.guides?.folds ?? []).filter((x) => {
      const inside = x > bleed + 1 && x < w - bleed - 1;
      if (!inside) warnings.push(`section « ${section.id} » : pli à ${fmtMm(x)} mm hors du format fini, ignoré`);
      return inside;
    });
    const edges = [bleed, ...folds, w - bleed];
    const widths = edges.slice(1).map((x, k) => round4(x - edges[k]));
    // Le dernier volet ferme exactement la largeur finie : checkFormat compare la somme au centième.
    widths[widths.length - 1] = round4(trim.w - widths.slice(0, -1).reduce((s, v) => s + v, 0));
    const panels = widths.length === 1 ? [{ name: section.name, w: widths[0] }] : widths.map((pw) => ({ name: `Volet ${++panelNumber}`, w: pw }));
    return { id, name: section.name, panels };
  });
  const folded = faces.some((f) => f.panels.length > 1);
  notes.push(folded ? 'Volets : lus dans les repères de pli du design.' : 'Un seul volet par face : aucun repère de pli dans le design.');

  const known = knownTrim(trim.w, trim.h);
  const idPart = (v: Mm) => fmtMm(v).replace(',', '-');
  const format: DocumentFormat = {
    id: `sur-mesure-${idPart(trim.w)}x${idPart(trim.h)}`,
    name: `${known ?? 'Format'} sur mesure ${sizeLabel(trim.w, trim.h)}`,
    trim,
    bleed,
    safety: safetyFor(trim),
    faces,
  };
  const errors = checkFormat(format);
  if (errors.length) throw new Error(`Format sur mesure incohérent : ${errors.join(' ; ')}`);
  return {
    format,
    origin: 'custom',
    faces: faces.map((f, i) => ({ sectionId: design.sections[i].id, sectionIndex: i, faceId: f.id, name: f.name })),
    notes,
    warnings,
  };
}

// ---------------------------------------------------------------- choix

export interface ResolveOptions {
  /** Identifiant d'un gabarit de src/model/templates, imposé. */
  templateId?: string;
}

export function resolveFormat(design: ParsedDesign, options: ResolveOptions = {}): ResolvedFormat {
  const templateId = options.templateId?.trim();
  if (templateId) return forcedTemplate(design, templateId);

  const { w, h } = design.page;
  const count = design.sections.length;
  const notes: string[] = [];
  const candidates = templatesForFaceSize(w, h, count, SIZE_TOLERANCE_MM);
  const rejected: string[] = [];
  const compatible: { template: DocumentFormat; faces: FaceAssignment[] }[] = [];
  for (const template of candidates) {
    const faces = assignSections(design.sections, template);
    const conflicts = guideConflicts(design, template, faces);
    if (conflicts.length) rejected.push(`${templateLabel(template)} écarté : ${conflicts.join(' ; ')}`);
    else compatible.push({ template, faces });
  }
  if (compatible.length) {
    const [{ template, faces }, ...others] = compatible;
    const guided = design.sections.some((s) => s.guides);
    notes.push(
      `Gabarit reconnu : ${templateLabel(template)}, faces de ${sizeLabel(w, h)} fond perdu compris (${design.page.from}), ` +
        `${plural(count, 'page', 'pages')}${guided ? ', repères de coupe et de plis conformes' : ''}.`,
    );
    if (others.length) notes.push(`Également compatibles : ${others.map((o) => templateLabel(o.template)).join(', ')} (à choisir avec --template ou le champ Gabarit).`);
    notes.push(...rejected);
    return { format: template, origin: 'detected', faces, notes, warnings: [] };
  }
  notes.push(
    `Aucun gabarit à ${plural(count, 'face', 'faces')} de ${sizeLabel(w, h)} fond perdu compris : format sur mesure, taille lue dans ${design.page.from}.`,
    ...rejected,
  );
  return customFormat(design, notes);
}

/** « Gabarit reconnu : … » : une ligne pour l'interface et la console. */
export function describeOrigin(resolved: Pick<ResolvedFormat, 'origin' | 'format'>): string {
  const { format } = resolved;
  if (resolved.origin === 'template') return `Gabarit imposé : ${format.name}`;
  if (resolved.origin === 'detected') return `Gabarit reconnu : ${format.name}`;
  return `${format.name}, fond perdu ${fmtMm(format.bleed)} mm`;
}
