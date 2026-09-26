// QR codes du design : on relit l'adresse en décodant l'image du code (le design ne la contient pas),
// puis on vérifie que le code régénéré par le paquet `qrcode` a les mêmes modules que l'original.
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode, { type QRCodeMaskPattern } from 'qrcode';
import type { Page } from 'puppeteer-core';
import { parsePath } from '../../src/model/shapes';

export interface DecodedQr {
  imp: number;
  url: string | null;
  /** Raison de l'échec du décodage. */
  error?: string;
}

// Zone blanche ajoutée autour de la capture : le design n'a que 2 modules de marge, jsQR en lit mieux 4.
const PAD_PX = 48;

interface Rgba {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

function padWhite(png: Rgba, pad: number): { data: Uint8ClampedArray; width: number; height: number } {
  const width = png.width + 2 * pad;
  const height = png.height + 2 * pad;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const src = (y * png.width + x) * 4;
      const dst = ((y + pad) * width + x + pad) * 4;
      // Les pixels transparents deviennent blancs : c'est le papier.
      const a = png.data[src + 3] / 255;
      for (let c = 0; c < 3; c++) data[dst + c] = Math.round(png.data[src + c] * a + 255 * (1 - a));
      data[dst + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Adresse lue dans une image RVBA (un QR et sa marge), ou null si jsQR n'y trouve aucun code. */
export function decodeQrImage(image: Rgba): string | null {
  const padded = padWhite(image, PAD_PX);
  return jsQR(padded.data, padded.width, padded.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/**
 * Capture chaque QR (repéré par son attribut `data-imp`, posé par la mesure) à `scale` pixels par
 * pixel CSS et le décode. La page garde la mise en page de la mesure : seul le facteur d'échelle change.
 */
export async function decodeQrCodes(page: Page, imps: number[], scale = 8): Promise<DecodedQr[]> {
  if (!imps.length) return [];
  const viewport = page.viewport() ?? { width: 1146, height: 900 };
  await page.setViewport({ ...viewport, deviceScaleFactor: scale });
  const out: DecodedQr[] = [];
  try {
    for (const imp of imps) {
      const handle = await page.$(`[data-imp="${imp}"]`);
      if (!handle) {
        out.push({ imp, url: null, error: 'élément introuvable dans la page' });
        continue;
      }
      try {
        const shot = await handle.screenshot({ type: 'png' });
        const url = decodeQrImage(PNG.sync.read(Buffer.from(shot)));
        out.push(url ? { imp, url } : { imp, url: null, error: 'jsQR ne trouve aucun code lisible' });
      } catch (error) {
        out.push({ imp, url: null, error: (error as Error).message });
      } finally {
        await handle.dispose();
      }
    }
  } finally {
    await page.setViewport({ ...viewport, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 });
  }
  return out;
}

/** Matrice des modules d'un tracé de QR fait de rectangles (`M0 0h7v1h-7z…`), une ligne par rangée. */
export function modulesFromPath(d: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  let xs: number[] = [];
  let ys: number[] = [];
  const flush = () => {
    if (!xs.length) return;
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) if (grid[y]?.[x] !== undefined) grid[y][x] = true;
    xs = [];
    ys = [];
  };
  for (const cmd of parsePath(d)) {
    if (cmd.c === 'Z') {
      flush();
      continue;
    }
    if (cmd.c === 'M') flush();
    xs.push(cmd.p[0]);
    ys.push(cmd.p[1]);
  }
  flush();
  return grid;
}

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrSettings {
  ecc: EccLevel;
  mask: number;
}

/**
 * Réglages (niveau de correction, masque) pour lesquels `qrcode` redonne exactement les modules du
 * design ; `defaultMask` est le masque que `qrcode` choisit seul à ce niveau.
 */
export function matchingQrSettings(url: string, designModules: boolean[][]): { matches: QrSettings[]; defaultMask: Partial<Record<EccLevel, number>> } {
  const levels: EccLevel[] = ['L', 'M', 'Q', 'H'];
  const matches: QrSettings[] = [];
  const defaultMask: Partial<Record<EccLevel, number>> = {};
  for (const ecc of levels) {
    defaultMask[ecc] = QRCode.create(url, { errorCorrectionLevel: ecc }).maskPattern;
    for (let mask = 0; mask < 8; mask++) {
      const { modules } = QRCode.create(url, { errorCorrectionLevel: ecc, maskPattern: mask as QRCodeMaskPattern });
      if (modules.size !== designModules.length) break;
      let same = true;
      for (let y = 0; y < modules.size && same; y++) for (let x = 0; x < modules.size; x++) if (!!modules.get(y, x) !== designModules[y][x]) {
        same = false;
        break;
      }
      if (same) matches.push({ ecc, mask });
    }
  }
  return { matches, defaultMask };
}
