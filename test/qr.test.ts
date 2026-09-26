import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument, QrObject } from '../src/model/types';
import { PX_PER_INCH, PX_PER_MM } from '../src/model/units';
import { qrGeometry } from '../src/render/qr';
import { minimalDoc } from './fixtures/minimal-doc';
import { withApp, withTempDocuments } from './helpers/browser';

const URL_A = 'https://example.com/ateliers/cuisine';
const URL_B = 'https://example.org/stages?utm_source=depliant';
const QR_MM = 15;

function qrDoc(url: string): LayoutDocument {
  const doc = minimalDoc();
  doc.swatches.push({ id: 'noir', name: 'Noir', rgb: '#000000' }, { id: 'blanc', name: 'Blanc', rgb: '#ffffff' });
  const qr: QrObject = { id: 'qr1', type: 'qr', layerId: 'contenu', x: 150, y: 120, w: QR_MM, h: QR_MM, url, ecc: 'M', color: { swatch: 'noir' }, background: { swatch: 'blanc' }, margin: 4 };
  doc.objects.qr1 = qr;
  doc.pages[0].children.push('qr1');
  return doc;
}

async function writeDoc(dir: string, doc: LayoutDocument) {
  await mkdir(path.join(dir, doc.id), { recursive: true });
  await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc, null, 2));
}

/** Rend la route d'impression, mesure le QR et le décode depuis une capture à 300 ppi. */
async function renderQr(page: Page, url: string) {
  await page.goto(`${url}/print/essai`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
  const info = await page.$eval('[data-obj-id="qr1"]', (el) => {
    const b = el.getBoundingClientRect();
    const path = el.querySelector('path');
    return {
      w: b.width,
      h: b.height,
      d: path?.getAttribute('d') ?? '',
      paths: el.querySelectorAll('path').length,
      rendering: path ? getComputedStyle(path).shapeRendering : '',
      images: el.querySelectorAll('image, img, canvas').length,
    };
  });
  const el = await page.$('[data-obj-id="qr1"]');
  const shot = await el!.screenshot({ type: 'png' });
  const png = PNG.sync.read(Buffer.from(shot));
  const decoded = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height);
  return { ...info, pngWidth: png.width, text: decoded?.data ?? null };
}

describe('QR code', () => {
  it('redessine le code quand l’adresse change', () => {
    const a = qrGeometry(URL_A, 'M', 4);
    const b = qrGeometry(URL_B, 'M', 4);
    expect(a.d).not.toBe(b.d);
    // Marge comprise dans la boîte : 4 modules de chaque côté.
    expect(a.size).toBe(QRCode.create(URL_A, { errorCorrectionLevel: 'M' }).modules.size + 8);
    expect(qrGeometry(URL_A, 'M', 4)).toEqual(a);
    expect(qrGeometry(URL_A, 'H', 4).d).not.toBe(a.d);
  });

  it('un code de 15 mm capturé à 300 ppi se relit, et suit le changement d’adresse', async () => {
    await withTempDocuments(async (dir) => {
      await writeDoc(dir, qrDoc(URL_A));
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          // 300 ppi : chaque pixel CSS (1/96 po) devient 300/96 pixels de capture.
          await page.setViewport({ width: 1300, height: 900, deviceScaleFactor: 300 / PX_PER_INCH });

          const a = await renderQr(page, url);
          expect(a.w / PX_PER_MM).toBeCloseTo(QR_MM, 2);
          expect(a.h / PX_PER_MM).toBeCloseTo(QR_MM, 2);
          expect(a.paths).toBe(1);
          expect(a.images).toBe(0);
          expect(a.rendering.toLowerCase()).toBe('crispedges');
          expect(a.pngWidth).toBeGreaterThanOrEqual(Math.floor((QR_MM / 25.4) * 300) - 1);
          expect(a.text).toBe(URL_A);

          await writeDoc(dir, qrDoc(URL_B));
          const b = await renderQr(page, url);
          expect(b.d).not.toBe(a.d);
          expect(b.text).toBe(URL_B);
        },
        { documentsDir: dir },
      );
    });
  });
});
