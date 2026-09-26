// Styles CSS d'un bloc texte, partagés par le rendu (TextFrameView), l'éditeur de texte (TextEditor) et
// la mesure hors écran du texte chaîné (textFlow.ts) : les trois doivent couper les lignes à l'identique.
import type { CSSProperties } from 'react';
import type { LayoutDocument, Paragraph, TextObject, TextRun, TextStyle } from '../model/types';
import type { WrapFloat } from '../model/wrap';
import { mm } from './box';
import { colorCss } from './color';
import { NNBSP } from '../text/typographyFr';

const JUSTIFY: Record<NonNullable<TextObject['verticalAlign']>, CSSProperties['justifyContent']> = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
};

/**
 * Espace fine insécable (U+202F, typographie française) : Open Sans n'a pas ce glyphe et Chrome irait le
 * chercher dans une autre police (largeur imprévisible, police de plus dans le PDF). Elle est dessinée
 * par l'espace fine d'Open Sans (U+2009) encadrée de deux « gluons » (U+2060, sans chasse) qui
 * interdisent toute coupure. Le document garde U+202F.
 */
export const NNBSP_RENDER = '\u{2060}\u{2009}\u{2060}';

/** Texte d'un segment tel qu'il est dessiné : chaque U+202F devient NNBSP_RENDER (les autres espaces
 *  restent telles quelles, sinon toute espace ordinaire deviendrait insécable). */
export function renderNnbsp(text: string): string {
  return text.replaceAll(NNBSP, NNBSP_RENDER);
}

/** Style CSS de la boîte d'un bloc texte (hors position) : partagé avec l'éditeur de texte (TextEditor). */
export function textBlockCss(obj: Pick<TextObject, 'style' | 'verticalAlign'>, doc: Pick<LayoutDocument, 'swatches'>): CSSProperties {
  const s = obj.style;
  const valign = obj.verticalAlign ?? 'top';
  return {
    fontFamily: `'${s.fontFamily}'`,
    fontWeight: s.fontWeight,
    fontStyle: s.italic ? 'italic' : 'normal',
    fontSize: `${s.fontSize}pt`,
    lineHeight: s.lineHeight,
    letterSpacing: `${s.letterSpacing}em`,
    textTransform: s.transform,
    color: colorCss(doc, s.color),
    textAlign: s.align,
    textWrap: s.textWrap,
    padding: 0,
    overflow: 'visible',
    // Le flex ne sert qu'à l'alignement vertical ; en haut, on reste en bloc simple comme le design.
    ...(valign !== 'top' ? { display: 'flex', flexDirection: 'column', justifyContent: JUSTIFY[valign] } : null),
  };
}

/**
 * Style d'un paragraphe : ses surcharges, puis les espaces avant et après du style du bloc. `continues` :
 * dernier paragraphe d'un bloc chaîné qui se poursuit dans le bloc suivant (sa dernière ligne n'est pas
 * une fin de paragraphe : justifiée comme les autres).
 */
export function paragraphCss(
  para: Pick<Paragraph, 'fontSize' | 'lineHeight' | 'align' | 'spaceBefore'>,
  index: number,
  count: number,
  style: TextStyle,
  continues = false,
): CSSProperties {
  const before = para.spaceBefore ?? (index > 0 ? style.spaceBefore : undefined);
  const after = index < count - 1 ? style.spaceAfter : undefined;
  const lastContinues = continues && index === count - 1 && (para.align ?? style.align) === 'justify';
  return {
    fontSize: para.fontSize === undefined ? undefined : `${para.fontSize}pt`,
    lineHeight: para.lineHeight,
    textAlign: para.align,
    marginTop: before === undefined ? undefined : mm(before),
    marginBottom: after === undefined ? undefined : mm(after),
    // Coupé en fin de bloc, le paragraphe n'y finit pas : pas de « dernière ligne » à équilibrer (pretty),
    // ses lignes restent celles du paragraphe entier ; justifié, elle est justifiée comme les autres.
    ...(continues && index === count - 1 ? { textWrap: 'wrap' } : null),
    ...(lastContinues ? { textAlignLast: 'justify' } : null),
  };
}

export function runCss(run: Omit<TextRun, 'text'>, doc: Pick<LayoutDocument, 'swatches'>): CSSProperties {
  return {
    color: colorCss(doc, run.color),
    fontWeight: run.fontWeight,
    fontStyle: run.italic === undefined ? undefined : run.italic ? 'italic' : 'normal',
    fontSize: run.fontSize === undefined ? undefined : `${run.fontSize}pt`,
    letterSpacing: run.letterSpacing === undefined ? undefined : `${run.letterSpacing}em`,
    textTransform: run.transform,
  };
}

/** Flottant d'habillage (4.13) : sa forme repousse les lignes, sa boîte ne se voit pas. */
export function wrapFloatCss(f: WrapFloat): CSSProperties {
  return {
    float: f.side,
    width: mm(f.width),
    height: mm(f.height),
    shapeOutside: `polygon(${f.points.map(([x, y]) => `${x}mm ${y}mm`).join(', ')})`,
    pointerEvents: 'none',
  };
}
