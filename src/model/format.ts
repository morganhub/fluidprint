import type { DocumentFormat, FaceFormat, Mm } from './types';

/** Taille d'une face, fond perdu compris. */
export function faceSize(format: DocumentFormat): { w: Mm; h: Mm } {
  return { w: format.trim.w + 2 * format.bleed, h: format.trim.h + 2 * format.bleed };
}

export function getFace(format: DocumentFormat, faceId: string): FaceFormat {
  const face = format.faces.find((f) => f.id === faceId);
  if (!face) throw new Error(`Face inconnue : ${faceId}`);
  return face;
}

/** Positions des plis, en mm depuis le bord du fond perdu (repère des objets). */
export function foldPositions(format: DocumentFormat, faceId: string): Mm[] {
  const panels = getFace(format, faceId).panels;
  const folds: Mm[] = [];
  let x = format.bleed;
  for (const panel of panels.slice(0, -1)) {
    x += panel.w;
    folds.push(x);
  }
  return folds;
}

/** Bornes de chaque volet (fond perdu inclus pour les volets de bord), en mm dans le repère de la face. */
export function panelBounds(format: DocumentFormat, faceId: string): { name: string; x0: Mm; x1: Mm }[] {
  const panels = getFace(format, faceId).panels;
  const folds = foldPositions(format, faceId);
  const { w } = faceSize(format);
  return panels.map((panel, i) => ({ name: panel.name, x0: i === 0 ? 0 : folds[i - 1], x1: i === panels.length - 1 ? w : folds[i] }));
}

/** Rectangle du format fini (trait de coupe) dans le repère de la face. */
export function trimBox(format: DocumentFormat): { x: Mm; y: Mm; w: Mm; h: Mm } {
  return { x: format.bleed, y: format.bleed, w: format.trim.w, h: format.trim.h };
}

/** Somme des volets = largeur finie ; une erreur de gabarit se voit ici plutôt qu'à l'impression. */
export function checkFormat(format: DocumentFormat): string[] {
  const errors: string[] = [];
  for (const face of format.faces) {
    const total = face.panels.reduce((s, p) => s + p.w, 0);
    if (Math.abs(total - format.trim.w) > 0.01) errors.push(`Face ${face.id} : volets ${total} mm ≠ format fini ${format.trim.w} mm`);
  }
  return errors;
}
