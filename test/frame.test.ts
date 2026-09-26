import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { computeImagePlacement, refitImage } from '../src/model/frame';
import { SHAPE_PRESETS } from '../src/model/shapes';
import type { FrameImage, FrameObject, LayoutDocument } from '../src/model/types';
import { MM_PER_INCH } from '../src/model/units';
import { minimalDoc } from './fixtures/minimal-doc';
import { withApp, withTempDocuments } from './helpers/browser';

const ratio = (b: { w: number; h: number }) => b.w / b.h;

describe('placement de la photo dans un cadre', () => {
  // Photo 600 × 400 px (3:2) dans un cadre carré de 60 mm.
  it('Remplir couvre le cadre, centré', () => {
    const p = computeImagePlacement('fill', 60, 60, 600, 400);
    expect(p.h).toBeCloseTo(60, 10);
    expect(p.w).toBeCloseTo(90, 10);
    expect(p.x).toBeCloseTo(-15, 10);
    expect(p.y).toBeCloseTo(0, 10);
  });

  it('Ajuster fait tenir la photo entière, centrée', () => {
    const p = computeImagePlacement('fit', 60, 60, 600, 400);
    expect(p.w).toBeCloseTo(60, 10);
    expect(p.h).toBeCloseTo(40, 10);
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(10, 10);
  });

  it('Centrer pose la photo à 300 ppi, centrée', () => {
    const p = computeImagePlacement('center', 60, 60, 600, 400);
    expect(p.w).toBeCloseTo((600 / 300) * MM_PER_INCH, 10);
    expect(p.h).toBeCloseTo((400 / 300) * MM_PER_INCH, 10);
    expect(p.x).toBeCloseTo((60 - p.w) / 2, 10);
    expect(p.y).toBeCloseTo((60 - p.h) / 2, 10);
  });

  it('refuse des dimensions de photo nulles', () => {
    expect(() => computeImagePlacement('fill', 60, 60, 0, 400)).toThrow(/invalides/);
  });

  it('redimensionner le cadre ne déforme jamais la photo', () => {
    const sizes = [
      { w: 60, h: 40 },
      { w: 30, h: 80 },
      { w: 120, h: 20 },
      { w: 45, h: 45 },
    ];
    for (const fit of ['fill', 'fit', 'center'] as const) {
      let image: FrameImage = { assetId: 'a', fit, ...computeImagePlacement(fit, 60, 40, 600, 400) };
      for (let i = 1; i < sizes.length; i++) {
        image = refitImage(image, sizes[i - 1], sizes[i], 600, 400);
        expect(ratio(image)).toBeCloseTo(1.5, 10);
        if (fit === 'fill') {
          // Couvre toujours : aucun bord du cadre n'est découvert.
          expect(image.x).toBeLessThanOrEqual(1e-9);
          expect(image.y).toBeLessThanOrEqual(1e-9);
          expect(image.x + image.w).toBeGreaterThanOrEqual(sizes[i].w - 1e-9);
          expect(image.y + image.h).toBeGreaterThanOrEqual(sizes[i].h - 1e-9);
        }
      }
    }
  });

  it('un recadrage manuel suit le cadre sans déformation ni fond découvert', () => {
    // Photo agrandie et décalée à la main : on garde le même point au centre du cadre.
    const custom: FrameImage = { assetId: 'a', fit: 'custom', x: -30, y: -10, w: 120, h: 80 };
    const next = refitImage(custom, { w: 60, h: 40 }, { w: 90, h: 30 }, 600, 400);
    expect(ratio(next)).toBeCloseTo(1.5, 10);
    const centerBefore = { u: (30 - custom.x) / custom.w, v: (20 - custom.y) / custom.h };
    const centerAfter = { u: (45 - next.x) / next.w, v: (15 - next.y) / next.h };
    expect(centerAfter.u).toBeCloseTo(centerBefore.u, 10);
    expect(centerAfter.v).toBeCloseTo(centerBefore.v, 10);
    expect(next.w).toBeGreaterThanOrEqual(custom.w * 1.5 - 1e-9);
  });
});

/** Quatre cadres photo (rectangle à coins inégaux, ellipse, goutte, rectangle arrondi) et un cadre à fond seul. */
async function writeFrameDoc(dir: string): Promise<LayoutDocument> {
  const doc = minimalDoc();
  doc.swatches.push({ id: 'blanc', name: 'Blanc', rgb: '#ffffff' });
  const frame = (id: string, x: number, shape: FrameObject['shape'], w = 50, h = 50): FrameObject => ({
    id,
    type: 'frame',
    layerId: 'contenu',
    x,
    y: 40,
    w,
    h,
    shape,
    image: { assetId: 'img1', fit: 'fill', ...computeImagePlacement('fill', w, h, 600, 400) },
    stroke: { color: { swatch: 'bleu' }, width: 1 },
  });
  doc.objects.coins = frame('coins', 10, { kind: 'rect', radius: [0, 8, 0, 8] });
  doc.objects.rond = frame('rond', 70, { kind: 'ellipse' });
  doc.objects.goutte = frame('goutte', 130, { kind: 'path', d: SHAPE_PRESETS.goutte.d, preset: 'goutte' }, 40, 52);
  doc.objects.arrondi = frame('arrondi', 180, { kind: 'rect', radius: 4 });
  doc.objects.fond = { id: 'fond', type: 'frame', layerId: 'contenu', x: 240, y: 40, w: 30, h: 39, shape: { kind: 'path', d: SHAPE_PRESETS.goutte.d }, fill: { swatch: 'blanc' }, placeholder: 'Photo' };
  doc.pages[0].children.push('coins', 'rond', 'goutte', 'arrondi', 'fond');
  // Une photo sans couche alpha : un /SMask dans le PDF ne pourrait venir que de la découpe.
  doc.assets.push({ id: 'img1', kind: 'image', name: 'essai.png', original: 'assets/originals/essai.png', width: 600, height: 400 });

  const docDir = path.join(dir, doc.id);
  await mkdir(path.join(docDir, 'assets', 'originals'), { recursive: true });
  // Dégradé plutôt qu'aplat : Chrome pourrait remplacer une image unie par un simple remplissage.
  const pixels = Buffer.alloc(600 * 400 * 3);
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 600; x++) pixels.set([Math.round((x / 600) * 255), Math.round((y / 400) * 255), 160], (y * 600 + x) * 3);
  await sharp(pixels, { raw: { width: 600, height: 400, channels: 3 } })
    .png()
    .toFile(path.join(docDir, 'assets', 'originals', 'essai.png'));
  await writeFile(path.join(docDir, 'document.json'), JSON.stringify(doc, null, 2));
  return doc;
}

/** Flux décompressés d'un PDF (FlateDecode) ; les flux non compressés sont gardés tels quels. */
function pdfStreams(pdf: Buffer): string[] {
  const out: string[] = [];
  const text = pdf.toString('latin1');
  // Le lookbehind écarte la fin des mots-clés « endstream ».
  const re = /(?<!end)stream\r?\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    const raw = pdf.subarray(start, end);
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch {
      out.push(raw.toString('latin1'));
    }
    re.lastIndex = end + 'endstream'.length;
  }
  return out;
}

describe('cadre photo découpé', () => {
  it('découpe en clipPath vectoriel : aucun mask-image, « W n » dans le PDF et pas de /SMask', async () => {
    await withTempDocuments(async (dir) => {
      await writeFrameDoc(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          await page.setViewport({ width: 1300, height: 900 });

          // À l'écran d'abord : le placeholder du cadre vide y figure, les découpes sont des clipPath.
          await page.goto(`${url}/view/essai?zoom=1`);
          await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
          const screen = await page.evaluate(() => {
            const masked = [...document.querySelectorAll('*')].filter((el) => {
              const cs = getComputedStyle(el);
              return (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none');
            });
            const images = [...document.querySelectorAll<SVGImageElement>('[data-obj-type="frame"] image')].map((img) => {
              const b = img.getBoundingClientRect();
              return b.width / b.height;
            });
            return {
              masked: masked.length,
              maskElements: document.querySelectorAll('mask').length,
              clipPaths: [...document.querySelectorAll('clipPath')].map((c) => c.getAttribute('clipPathUnits')),
              images,
              placeholder: document.querySelector('[data-obj-id="fond"] .frame-placeholder')?.textContent,
            };
          });
          expect(screen.masked).toBe(0);
          expect(screen.maskElements).toBe(0);
          expect(screen.clipPaths).toHaveLength(5);
          expect(new Set(screen.clipPaths)).toEqual(new Set(['objectBoundingBox']));
          // Chaque photo garde le rapport 3:2 de ses pixels, quelle que soit la forme du cadre.
          expect(screen.images).toHaveLength(4);
          for (const r of screen.images) expect(r).toBeCloseTo(1.5, 2);
          expect(screen.placeholder).toBe('Photo');

          await page.goto(`${url}/print/essai`);
          await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
          const print = await page.evaluate(() => ({
            placeholders: document.querySelectorAll('.frame-placeholder').length,
            errors: window.__printErrors,
          }));
          expect(print.placeholders).toBe(0);
          expect(print.errors).toEqual([]);

          const pdf = Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
          const streams = pdfStreams(pdf);
          const all = pdf.toString('latin1') + streams.join('\n');
          expect(all).toMatch(/\/Subtype\s*\/Image/);
          // Découpe vectorielle : un tracé suivi de « W n » (clip non‑zéro, sans remplissage).
          const contents = streams.filter((s) => /\bW\*?\s+n\b/.test(s));
          expect(contents.length).toBeGreaterThan(0);
          // La photo reste une image posée (Do) sous la découpe, pas une page rastérisée.
          expect(contents.some((s) => /\bW\*?\s+n\b[\s\S]*\/\w+\s+Do\b/.test(s))).toBe(true);
          expect(all).not.toContain('/SMask');
          expect([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)]).toHaveLength(2);
        },
        { documentsDir: dir },
      );
    });
  });
});
