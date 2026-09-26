import template from '../../src/model/templates/depliant-3-volets.json';
import type { DocumentFormat, LayoutDocument } from '../../src/model/types';

// Document minimal valide, réutilisé par les tests : une face, un calque, un rectangle et un texte.
export function minimalDoc(): LayoutDocument {
  return {
    version: 2,
    id: 'essai',
    name: 'Essai',
    createdAt: '2026-09-25T00:00:00.000Z',
    format: structuredClone(template) as DocumentFormat,
    pages: [
      { id: 'p-ext', faceId: 'exterieur', name: 'Extérieur', children: ['r1', 't1'] },
      { id: 'p-int', faceId: 'interieur', name: 'Intérieur', children: [] },
    ],
    layers: [{ id: 'contenu', name: 'Contenu', visible: true, locked: false, printable: true, color: '#2563eb' }],
    objects: {
      r1: { id: 'r1', type: 'rect', layerId: 'contenu', x: 10, y: 20, w: 30, h: 15, fill: { swatch: 'bleu' }, radius: 1.5 },
      t1: {
        id: 't1',
        type: 'text',
        layerId: 'contenu',
        x: 12,
        y: 60,
        w: 80,
        h: 20,
        style: {
          fontFamily: 'Open Sans',
          fontWeight: 400,
          fontSize: 7.5,
          lineHeight: 1.5,
          letterSpacing: 0,
          color: { swatch: 'gris' },
          align: 'left',
          transform: 'none',
          textWrap: 'pretty',
        },
        paragraphs: [{ runs: [{ text: 'Votre atelier, ' }, { text: 'pour vous.', color: { swatch: 'bleu' } }] }],
      },
    },
    swatches: [
      { id: 'bleu', name: 'Bleu', rgb: '#2a5fa3' },
      { id: 'gris', name: 'Gris texte', rgb: '#4b4d55' },
    ],
    styles: { paragraph: [], character: [] },
    assets: [],
  };
}
