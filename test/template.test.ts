import { describe, expect, it } from 'vitest';
import template from '../src/model/templates/depliant-3-volets.json';
import { checkFormat, faceSize, foldPositions, panelBounds } from '../src/model/format';
import type { DocumentFormat } from '../src/model/types';

const format = template as DocumentFormat;

describe('gabarit Dépliant A4 pli roulé', () => {
  it('fait 303 × 216 mm par face, fond perdu compris', () => {
    expect(faceSize(format)).toEqual({ w: 303, h: 216 });
    expect(checkFormat(format)).toEqual([]);
  });

  it('place les plis comme les repères du design (100/200 mm, puis 103/203 mm)', () => {
    expect(foldPositions(format, 'exterieur')).toEqual([100, 200]);
    expect(foldPositions(format, 'interieur')).toEqual([103, 203]);
  });

  it('donne au volet qui se rabat 97 mm finis', () => {
    const ext = panelBounds(format, 'exterieur');
    expect(ext[0]).toEqual({ name: 'Rabat', x0: 0, x1: 100 }); // 3 mm de fond perdu + 97 mm
    const int = panelBounds(format, 'interieur');
    expect(int[2]).toEqual({ name: 'Intérieur droit', x0: 203, x1: 303 }); // 97 mm + 3 mm de fond perdu
  });
});
