// Puces et numéros des listes (paragraphes `list`, import Word).
//
// La puce ou le numéro n'est pas du texte : il se DESSINE dans le retrait suspendu du paragraphe (le rendu,
// l'éditeur de texte et la mesure du texte chaîné posent `data-list-marker`, voir styles/app.css). Les
// numéros se calculent ici, dans l'ordre de l'article : un paragraphe de liste prend le numéro suivant de son
// niveau, un niveau supérieur fait repartir les sous-niveaux (comme dans Word), un paragraphe hors liste
// n'interrompt pas la numérotation et `start` impose un numéro (liste qui repart à 1).
import type { ListNumberFormat, Paragraph, ParagraphList } from './types';

/** Puces par niveau (alternées) : deux caractères présents dans Open Sans. */
export const LIST_BULLETS = ['•', '–'] as const;

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

export function formatListNumber(n: number, format: ListNumberFormat = 'decimal'): string {
  switch (format) {
    case 'lower-alpha':
    case 'upper-alpha': {
      // Après z : aa, bb… (comme Word).
      const k = Math.max(1, n);
      const letter = String.fromCharCode(97 + ((k - 1) % 26)).repeat(Math.floor((k - 1) / 26) + 1);
      return format === 'upper-alpha' ? letter.toUpperCase() : letter;
    }
    case 'lower-roman':
    case 'upper-roman': {
      let rest = Math.max(1, Math.min(n, 3999));
      let out = '';
      for (const [value, digits] of ROMAN) {
        while (rest >= value) {
          out += digits;
          rest -= value;
        }
      }
      return format === 'upper-roman' ? out.toUpperCase() : out;
    }
    default:
      return String(n);
  }
}

/**
 * Numéro du paragraphe de liste suivant, d'après les compteurs de l'article (tableau par niveau, modifié en
 * place) ; null pour une puce. C'est LA règle de numérotation : le rendu et l'import Word la partagent.
 */
export function nextListNumber(counters: (number | undefined)[], list: ParagraphList): number | null {
  const level = list.level;
  // Les sous-niveaux repartent à chaque élément d'un niveau supérieur.
  counters.length = level + 1;
  if (list.kind === 'bullet') return null;
  const n = list.start ?? (counters[level] ?? 0) + 1;
  counters[level] = n;
  return n;
}

export function listMarker(list: ParagraphList, n: number | null): string {
  if (list.kind === 'bullet' || n === null) return LIST_BULLETS[list.level % LIST_BULLETS.length];
  return `${formatListNumber(n, list.format)}${list.suffix ?? '.'}`;
}

/** Puce ou numéro de chaque paragraphe d'un article (null hors liste). */
export function listMarkers(paragraphs: readonly Pick<Paragraph, 'list'>[]): (string | null)[] {
  const counters: (number | undefined)[] = [];
  return paragraphs.map((para) => (para.list ? listMarker(para.list, nextListNumber(counters, para.list)) : null));
}

/** Vrai si au moins un paragraphe est un élément de liste (évite un calcul inutile au rendu). */
export const hasLists = (paragraphs: readonly Pick<Paragraph, 'list'>[]): boolean => paragraphs.some((p) => !!p.list);
