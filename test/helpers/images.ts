// Aides des tests de photos (recadrage, dépôt, plume, images) : photos de test, documents avec cadres,
// dépôt d'un fichier « depuis l'explorateur » simulé par un vrai DragEvent dans la page ; photos synthétiques
// et PDF de photos pour l'extraction des photos provisoires.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import sharp from 'sharp';
import { launchBrowser } from '../../server/chrome';
import { SHAPE_PRESETS } from '../../src/model/shapes';
import type { Asset, FrameObject, LayoutDocument } from '../../src/model/types';
import { minimalDoc } from '../fixtures/minimal-doc';

/** Photo de test : bruit coloré (comme une vraie photo, elle se compresse mal), au format voulu. */
export async function makePhoto(width: number, height: number, format: 'jpeg' | 'png' | 'tiff' | 'webp' = 'jpeg'): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } });
  return base[format]().toBuffer();
}

export const sha256 = (data: Buffer | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Écrit une photo dans assets/originals/ d'un document et renvoie son Asset (comme le serveur l'aurait fait). */
export async function writeAsset(dir: string, docId: string, name: string, width: number, height: number, extra: Partial<Asset> = {}): Promise<Asset> {
  const folder = path.join(dir, docId, 'assets', 'originals');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, name), await makePhoto(width, height, name.endsWith('.png') ? 'png' : 'jpeg'));
  return { id: `img-${name.replace(/\W+/g, '-')}`, kind: 'image', name, original: `assets/originals/${name}`, width, height, ...extra };
}

export function frame(id: string, x: number, y: number, w: number, h: number, extra: Partial<FrameObject> = {}): FrameObject {
  return { id, type: 'frame', name: `Cadre ${id}`, layerId: 'contenu', x, y, w, h, shape: { kind: 'rect' }, ...extra };
}

export const dropShape = (): FrameObject['shape'] => ({ kind: 'path', d: SHAPE_PRESETS.goutte.d, preset: 'goutte' });
export const hexagonShape = (): FrameObject['shape'] => ({ kind: 'path', d: SHAPE_PRESETS.hexagone.d, preset: 'hexagone', polygon: { sides: 6, inset: 0, rounding: 0 } });

/** Document minimal + cadres posés sur la face extérieure (au-dessus du reste). */
export function docWithFrames(frames: FrameObject[], assets: Asset[] = []): LayoutDocument {
  const doc = minimalDoc();
  for (const f of frames) {
    doc.objects[f.id] = f;
    doc.pages[0].children.push(f.id);
  }
  doc.assets.push(...assets);
  return doc;
}

export async function readOriginal(dir: string, docId: string, asset: Asset): Promise<Buffer> {
  return readFile(path.join(dir, docId, asset.original));
}

/**
 * Lâche un fichier en un point client, comme depuis l'explorateur : dragenter, dragover puis drop, avec un
 * DataTransfer qui porte un vrai File. Renvoie l'heure de la page (performance.now) au moment du drop.
 */
export async function dropFile(page: Page, at: { x: number; y: number }, file: { name: string; type: string; data: Buffer }): Promise<number> {
  return page.evaluate(
    (x, y, name, type, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      const target = document.elementFromPoint(x, y)!;
      const fire = (kind: string) => target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      fire('dragenter');
      fire('dragover');
      const t0 = performance.now();
      fire('drop');
      return t0;
    },
    Math.round(at.x),
    Math.round(at.y),
    file.name,
    file.type,
    file.data.toString('base64'),
  );
}

/** Attend que la photo d'un cadre soit chargée à l'écran ; renvoie l'heure de la page à cet instant. */
export async function waitFramePhoto(page: Page, frameId: string, timeout = 10_000): Promise<number> {
  await page.waitForFunction((id) => !!document.querySelector(`[data-page-id] [data-obj-id="${id}"] image[data-asset-id]`), { timeout }, frameId);
  return page.evaluate(async (id) => {
    const el = document.querySelector(`[data-page-id] [data-obj-id="${id}"] image[data-asset-id]`)!;
    const img = new Image();
    img.src = el.getAttribute('href')!;
    await img.decode();
    return performance.now();
  }, frameId);
}

/**
 * Photo synthétique « paysage » (ciel en dégradé, soleil, deux collines), dessinée par sharp : légère, sans
 * aucune image réelle. `hue` varie la palette d'une photo à l'autre ; `alpha` détoure la photo en ovale
 * (canal alpha), comme un sujet découpé ; `noise` y ajoute du grain (une vraie photo se compresse mal).
 */
export async function makeSyntheticPhoto(width: number, height: number, options: { hue?: number; alpha?: boolean; noise?: boolean } = {}): Promise<Buffer> {
  const hue = options.hue ?? 30;
  const hill = (y: number, amp: number) => `M0 ${height} L0 ${y} C${width * 0.3} ${y - amp} ${width * 0.6} ${y + amp} ${width} ${y - amp / 2} L${width} ${height} Z`;
  const clip = options.alpha ? `<clipPath id="c"><ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.48}" ry="${height * 0.48}"/></clipPath>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${clip}<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue + 180},55%,78%)"/><stop offset="1" stop-color="hsl(${hue},70%,86%)"/></linearGradient></defs>
<g${options.alpha ? ' clip-path="url(#c)"' : ''}><rect width="${width}" height="${height}" fill="url(#s)"/><circle cx="${width * 0.7}" cy="${height * 0.38}" r="${Math.min(width, height) * 0.12}" fill="hsl(${hue + 20},90%,62%)"/>
<path d="${hill(height * 0.62, height * 0.12)}" fill="hsl(${hue + 90},35%,45%)"/><path d="${hill(height * 0.78, height * 0.08)}" fill="hsl(${hue + 110},40%,30%)"/></g></svg>`;
  const drawn = await sharp(Buffer.from(svg)).png().toBuffer();
  if (!options.noise) return drawn;
  const grain = await sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 18 } } })
    .png()
    .toBuffer();
  const noisy = await sharp(drawn).composite([{ input: grain, blend: 'soft-light' }]).removeAlpha().png().toBuffer();
  if (!options.alpha) return noisy;
  // Le grain rend l'image opaque : on lui rend le détourage d'origine (canal alpha du dessin).
  const alpha = await sharp(drawn).extractChannel(3).toBuffer();
  return sharp(noisy).joinChannel(alpha).png().toBuffer();
}

/**
 * PDF de photos (PNG), une par page, peint par Chrome comme un PDF de mise en page : chaque image y garde
 * ses pixels, et une photo détourée y porte son masque (/SMask). Source de `npm run extract-pdf-images`.
 */
export async function makePhotosPdf(file: string, photos: Buffer[]): Promise<void> {
  const pages = photos
    .map((png) => `<div style="height:297mm;page-break-after:always;display:flex;align-items:center;justify-content:center"><img style="width:120mm" src="data:image/png;base64,${png.toString('base64')}"></div>`)
    .join('');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0">${pages}</body></html>`, { waitUntil: 'load' });
    await writeFile(file, await page.pdf({ width: '210mm', height: '297mm', printBackground: true }));
  } finally {
    await browser.close();
  }
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

/** Lance `npm run extract-pdf-images` (Python de print/.venv) sur un dossier de documents temporaire. */
export function runExtract(documentsDir: string, docId: string, pdf: string, options: { fill?: boolean } = {}): string {
  const args = ['scripts/run-print-python.mjs', 'scripts/extract-pdf-images.py', '--documents', documentsDir, '--doc', docId, '--pdf', pdf, ...(options.fill === false ? [] : ['--fill'])];
  const result = spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`extract-pdf-images a échoué (${result.status}) :\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
