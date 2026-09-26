import { create } from 'qrcode';
import type { QrObject } from '../model/types';

export interface QrGeometry {
  /** Côté du code en modules, marge comprise (= viewBox). */
  size: number;
  /** Tous les modules sombres en un seul tracé (un rectangle par suite horizontale). */
  d: string;
}

/** Géométrie vectorielle d'un QR code : les modules voisins sont fusionnés, sans joint visible. */
export function qrGeometry(url: string, ecc: QrObject['ecc'], margin: number): QrGeometry {
  const { modules } = create(url, { errorCorrectionLevel: ecc });
  const n = modules.size;
  const parts: string[] = [];
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < n && modules.get(row, col)) col++;
      parts.push(`M${start + margin} ${row + margin}h${col - start}v1h${start - col}z`);
    }
  }
  return { size: n + 2 * margin, d: parts.join('') };
}
