import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument } from '../src/model/types';
import { PX_PER_MM } from '../src/model/units';
import { minimalDoc } from './fixtures/minimal-doc';
import { withApp, withTempDocuments } from './helpers/browser';

/** Document de test à deux faces : photo dans un cadre, texte, et une note sur un calque non imprimable. */
async function writePrintDoc(dir: string): Promise<LayoutDocument> {
  const doc = minimalDoc();
  doc.layers.push({ id: 'reperes', name: 'Repères et notes', visible: true, locked: false, printable: false, color: '#ff00aa' });
  doc.objects.note = {
    id: 'note',
    type: 'text',
    layerId: 'reperes',
    x: 20,
    y: 150,
    w: 60,
    h: 10,
    style: { ...(doc.objects.t1 as Extract<typeof doc.objects.t1, { type: 'text' }>).style },
    paragraphs: [{ runs: [{ text: 'Note de travail, jamais imprimée' }] }],
  };
  doc.objects.photo = {
    id: 'photo',
    type: 'frame',
    layerId: 'contenu',
    x: 110,
    y: 30,
    w: 60,
    h: 40,
    shape: { kind: 'rect', radius: 3 },
    image: { assetId: 'img1', fit: 'fill', x: 0, y: 0, w: 60, h: 40 },
    placeholder: 'Photo',
  };
  doc.objects.vide = { id: 'vide', type: 'frame', layerId: 'contenu', x: 110, y: 90, w: 30, h: 30, shape: { kind: 'ellipse' }, placeholder: 'Photo à venir' };
  doc.pages[0].children.push('note', 'photo');
  doc.pages[1].children.push('vide');
  doc.assets.push({ id: 'img1', kind: 'image', name: 'essai.png', original: 'assets/originals/essai.png', width: 600, height: 400 });

  const docDir = path.join(dir, doc.id);
  await mkdir(path.join(docDir, 'assets', 'originals'), { recursive: true });
  await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 40, g: 120, b: 190 } } })
    .png()
    .toFile(path.join(docDir, 'assets', 'originals', 'essai.png'));
  await writeFile(path.join(docDir, 'document.json'), JSON.stringify(doc, null, 2));
  return doc;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("route d'impression", () => {
  it('rend 2 faces de 303 × 216 mm et ne se déclare prête qu’après polices et photos', async () => {
    await withTempDocuments(async (dir) => {
      await writePrintDoc(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          await page.setViewport({ width: 1300, height: 900 });
          // La photo et la police grasse sont retenues : __ready ne doit pas passer à vrai avant elles.
          const held: (() => void)[] = [];
          let released = false;
          await page.setRequestInterception(true);
          page.on('request', (req) => {
            const u = req.url();
            if (!released && (u.includes('/assets/originals/essai.png') || u.includes('/fonts/OpenSans-Regular.ttf'))) {
              held.push(() => void req.continue());
            } else void req.continue();
          });

          await page.goto(`${url}/print/essai`);
          await page.waitForFunction((n) => document.querySelectorAll('.print-face').length === n, {}, 2);
          await delay(1500);
          expect(held.length).toBe(2);
          expect(await page.evaluate(() => window.__ready)).toBe(false);

          released = true;
          held.forEach((go) => go());
          await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });

          const r = await page.evaluate(() => ({
            faces: [...document.querySelectorAll<HTMLElement>('.print-face')].map((el) => {
              const b = el.getBoundingClientRect();
              return { id: el.dataset.pageId, face: el.dataset.faceId, w: b.width, h: b.height };
            }),
            fonts: document.fonts.status,
            regularLoaded: [...document.fonts].some((f) => f.weight === '400' && f.style === 'normal' && f.status === 'loaded'),
            images: window.__images,
            imageCount: document.querySelectorAll('.print-face image').length,
            lineCounts: window.__lineCounts,
            note: !!document.querySelector('[data-obj-id="note"]'),
            placeholders: document.querySelectorAll('.frame-placeholder').length,
            pageRule: [...document.styleSheets].flatMap((s) => [...s.cssRules]).find((rule) => rule instanceof CSSPageRule)?.cssText ?? '',
            errors: window.__printErrors,
          }));

          expect(r.faces.map((f) => [f.id, f.face])).toEqual([
            ['p-ext', 'exterieur'],
            ['p-int', 'interieur'],
          ]);
          for (const f of r.faces) {
            expect(f.w / PX_PER_MM).toBeCloseTo(303, 2);
            expect(f.h / PX_PER_MM).toBeCloseTo(216, 2);
          }
          expect(r.fonts).toBe('loaded');
          expect(r.regularLoaded).toBe(true);
          expect(r.imageCount).toBe(1);
          expect(r.images).toEqual([{ assetId: 'img1', ok: true }]);
          expect(r.errors).toEqual([]);
          expect(r.lineCounts?.t1).toBe(1);
          expect(r.lineCounts).not.toHaveProperty('note');
          expect(r.note).toBe(false);
          expect(r.placeholders).toBe(0);
          expect(r.pageRule).toMatch(/size:\s*303mm 216mm/);
          expect(r.pageRule).toMatch(/margin:\s*0/);

          // L'original est servi, pas un aperçu.
          const href = await page.$eval('.print-face image', (el) => el.getAttribute('href'));
          expect(href).toBe('/api/assets/essai/assets/originals/essai.png');
        },
        { documentsDir: dir },
      );
    });
  });

  it('un objet qui ne se rend pas est signalé, sans bloquer __ready ni les autres objets', async () => {
    await withTempDocuments(async (dir) => {
      const doc = await writePrintDoc(dir);
      // Tracé en arc : la validation le refuse désormais, mais un document servi autrement (import SVG à
      // venir, ancien fichier) ne doit jamais bloquer la route d'impression jusqu'au délai de l'export.
      const broken = structuredClone(doc);
      broken.objects.vide = {
        ...(broken.objects.vide as Extract<LayoutDocument['objects'][string], { type: 'frame' }>),
        shape: { kind: 'path', d: 'M0 0.5A0.5 0.5 0 0 1 1 0.5L1 1L0 1Z' },
        stroke: { color: { swatch: 'bleu' }, width: 1 },
      };
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          await page.setRequestInterception(true);
          page.on('request', (req) => {
            if (new URL(req.url()).pathname === '/api/doc/essai') {
              void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(broken) });
            } else void req.continue();
          });
          await page.goto(`${url}/print/essai`);
          await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
          const r = await page.evaluate(() => ({
            errors: window.__printErrors,
            faces: document.querySelectorAll('.print-face').length,
            vide: !!document.querySelector('[data-obj-id="vide"]'),
            photo: !!document.querySelector('[data-obj-id="photo"] image'),
            text: !!document.querySelector('[data-obj-id="t1"]'),
          }));
          expect(r.errors).toEqual([expect.stringMatching(/^Objet vide impossible à rendre : Les arcs/)]);
          expect(r.faces).toBe(2);
          expect(r.vide).toBe(false);
          expect(r.photo).toBe(true);
          expect(r.text).toBe(true);
        },
        { documentsDir: dir },
      );
    });
  });
});
