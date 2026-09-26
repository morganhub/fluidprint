// Gabarits livrés avec l'éditeur : un document nouveau part de l'un d'eux, et l'importeur reconnaît un
// design Claude Design dont les faces ont la taille de l'un d'eux (sinon il en déduit un sur mesure).
import type { DocumentFormat, Mm } from '../types';
import { checkFormat, faceSize } from '../format';
import depliantPliRoule from './depliant-3-volets.json';
import depliantAccordeon from './depliant-a4-accordeon.json';
import a4RectoVerso from './a4-recto-verso.json';
import flyerA5 from './flyer-a5.json';
import carteDeVisite from './carte-de-visite.json';
import afficheA3 from './affiche-a3.json';

export const TEMPLATES: readonly DocumentFormat[] = [
  depliantPliRoule,
  depliantAccordeon,
  a4RectoVerso,
  flyerA5,
  carteDeVisite,
  afficheA3,
] as DocumentFormat[];

/** Le dépliant A4 pli roulé, gabarit proposé par défaut. */
export const DEFAULT_TEMPLATE_ID = depliantPliRoule.id;

export function findTemplate(id: string): DocumentFormat | undefined {
  const template = TEMPLATES.find((t) => t.id === id);
  return template && structuredClone(template);
}

/** Gabarits dont une face mesure `w × h` mm fond perdu compris (à `tolerance` près) et qui ont `faceCount` faces. */
export function templatesForFaceSize(w: Mm, h: Mm, faceCount?: number, tolerance: Mm = 0.5): DocumentFormat[] {
  return TEMPLATES.filter((t) => {
    const size = faceSize(t);
    return Math.abs(size.w - w) <= tolerance && Math.abs(size.h - h) <= tolerance && (faceCount === undefined || t.faces.length === faceCount);
  }).map((t) => structuredClone(t));
}

/** Résumé d'un gabarit pour l'interface : « 297 × 210 mm · 2 faces · 3 volets ». */
export function describeTemplate(t: DocumentFormat): string {
  const panels = Math.max(...t.faces.map((f) => f.panels.length));
  const faces = t.faces.length === 1 ? '1 face' : `${t.faces.length} faces`;
  return `${t.trim.w} × ${t.trim.h} mm · ${faces}${panels > 1 ? ` · ${panels} volets` : ''} · fond perdu ${t.bleed} mm`;
}

// Un gabarit faux se verrait à l'impression : on le refuse dès le chargement du module.
for (const t of TEMPLATES) {
  const errors = checkFormat(t);
  if (errors.length) throw new Error(`Gabarit ${t.id} incohérent : ${errors.join(' ; ')}`);
}
