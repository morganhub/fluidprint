import type { CSSProperties } from 'react';
import type { DocObject } from '../model/types';

/** Mm CSS exacts, jamais arrondis : 0,01 mm de moins sur une largeur de texte peut ajouter une ligne. */
export const mm = (v: number): string => `${v}mm`;

/** Élément racine d'un objet : position absolue en mm dans le repère de la face (contrat de rendu, point 1). */
export function boxStyle(obj: DocObject): CSSProperties {
  return {
    position: 'absolute',
    left: mm(obj.x),
    top: mm(obj.y),
    width: mm(obj.w),
    height: mm(obj.h),
    transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
    opacity: obj.opacity,
  };
}

/** Attributs communs de l'élément racine : les tests, la mesure des lignes et l'éditeur s'en servent. */
export const objAttrs = (obj: DocObject) => ({ 'data-obj-id': obj.id, 'data-obj-type': obj.type });

/** Identifiant utilisable dans `url(#…)` : useId() de React produit des caractères que CSS refuse. */
export const cssId = (...parts: string[]): string => parts.join('-').replace(/[^a-zA-Z0-9_-]/g, '_');
