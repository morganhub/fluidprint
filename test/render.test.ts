import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { PX_PER_MM } from '../src/model/units';
import { minimalDoc } from './fixtures/minimal-doc';
import { withApp, withTempDocuments } from './helpers/browser';

async function writeDoc(dir: string, doc: LayoutDocument) {
  await mkdir(path.join(dir, doc.id), { recursive: true });
  await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc, null, 2));
}

/** Document de test : le rectangle et le texte de la fixture, un texte long en 7,5 pt, deux calques qui se chevauchent. */
function renderDoc(): LayoutDocument {
  const doc = minimalDoc();
  const t1 = doc.objects.t1 as TextObject;
  t1.paragraphs = [
    {
      runs: [
        {
          text: 'Une formation pensée pour vous, au rythme de votre équipe : des ateliers courts, concrets et suivis, qui partent de vos outils et de vos usages réels pour gagner du temps chaque semaine.',
        },
      ],
    },
    { runs: [{ text: 'Deuxième paragraphe, ' }, { text: 'avec un segment en gras.', fontWeight: 700 }], spaceBefore: 1.5 },
  ];
  t1.w = 61.3;
  doc.layers = [
    { id: 'fonds', name: 'Fonds', visible: true, locked: true, printable: true, color: '#999999' },
    { id: 'contenu', name: 'Contenu', visible: true, locked: false, printable: true, color: '#2563eb' },
    { id: 'cache', name: 'Caché', visible: false, locked: false, printable: true, color: '#ff0000' },
  ];
  // « haut » est listé AVANT « bas » dans la page mais vit sur le calque du dessus : il doit couvrir « bas ».
  doc.objects.haut = { id: 'haut', type: 'rect', layerId: 'contenu', x: 150, y: 100, w: 20, h: 20, fill: { swatch: 'gris' } };
  doc.objects.bas = { id: 'bas', type: 'rect', layerId: 'fonds', x: 150, y: 100, w: 20, h: 20, fill: { swatch: 'bleu' } };
  doc.objects.invisible = { id: 'invisible', type: 'rect', layerId: 'cache', x: 150, y: 100, w: 20, h: 20, fill: { swatch: 'bleu' } };
  // Groupe : ses enfants prennent sa place dans l'empilement, dans leur ordre.
  doc.objects.g1 = { id: 'g1', type: 'group', layerId: 'contenu', x: 200, y: 100, w: 25, h: 20, children: ['g1a', 'g1b'] };
  doc.objects.g1a = { id: 'g1a', type: 'rect', layerId: 'contenu', x: 200, y: 100, w: 20, h: 20, fill: { swatch: 'bleu' } };
  doc.objects.g1b = { id: 'g1b', type: 'rect', layerId: 'contenu', x: 205, y: 100, w: 20, h: 20, fill: { swatch: 'gris' } };
  doc.objects.dessus = { id: 'dessus', type: 'rect', layerId: 'contenu', x: 215, y: 100, w: 20, h: 20, fill: { swatch: 'bleu' } };
  doc.pages[0].children = ['r1', 't1', 'haut', 'bas', 'invisible', 'g1', 'dessus'];
  return doc;
}

async function openViewer(page: Page, url: string, zoom: number) {
  await page.goto(`${url}/view/essai?zoom=${zoom}`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
}

describe('rendu des faces au millimètre', () => {
  it('place les objets au mm près et garde les coupures de ligne à tous les zooms', async () => {
    await withTempDocuments(async (dir) => {
      await writeDoc(dir, renderDoc());
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          await page.setViewport({ width: 1400, height: 900 });
          const lines: number[] = [];
          for (const zoom of [0.25, 1, 4]) {
            await openViewer(page, url, zoom);
            const m = await page.evaluate(() => {
              const face = document.querySelector('[data-page-id="p-ext"]')!.getBoundingClientRect();
              const rect = document.querySelector('[data-obj-id="r1"]')!.getBoundingClientRect();
              return { faceW: face.width, left: rect.left - face.left, top: rect.top - face.top, width: rect.width, lines: window.__lineCounts!.t1 };
            });
            const scale = PX_PER_MM * zoom;
            expect(m.faceW / scale).toBeCloseTo(303, 2);
            expect(Math.abs(m.left / scale - 10)).toBeLessThan(0.01);
            expect(Math.abs(m.top / scale - 20)).toBeLessThan(0.01);
            expect(Math.abs(m.width / scale - 30)).toBeLessThan(0.01);
            lines.push(m.lines);
          }
          expect(lines[0]).toBeGreaterThan(2);
          expect(new Set(lines).size).toBe(1);
        },
        { documentsDir: dir },
      );
    });
  });

  it('empile les objets calque par calque, groupes à la place du groupe, calque invisible absent', async () => {
    await withTempDocuments(async (dir) => {
      await writeDoc(dir, renderDoc());
      await withApp(
        async ({ browser, url }) => {
          const page = await browser.newPage();
          await page.setViewport({ width: 1400, height: 900 });
          await openViewer(page, url, 1);
          const r = await page.evaluate(() => {
            const face = document.querySelector('[data-page-id="p-ext"]')!;
            const box = face.getBoundingClientRect();
            const mm = 96 / 25.4;
            const at = (x: number, y: number) => document.elementFromPoint(box.left + x * mm, box.top + y * mm)?.closest('[data-obj-id]')?.getAttribute('data-obj-id');
            const order = [...face.querySelectorAll('[data-obj-id]')].map((el) => el.getAttribute('data-obj-id'));
            return { top: at(160, 110), overlapGroup: at(207, 110), overlapAfter: at(222, 110), order, invisible: !!face.querySelector('[data-obj-id="invisible"]') };
          });
          expect(r.top).toBe('haut');
          expect(r.overlapGroup).toBe('g1b');
          expect(r.overlapAfter).toBe('dessus');
          expect(r.invisible).toBe(false);
          // Calque « fonds » d'abord, puis « contenu » dans l'ordre de la page.
          expect(r.order).toEqual(['bas', 'r1', 't1', 'haut', 'g1', 'g1a', 'g1b', 'dessus']);
        },
        { documentsDir: dir },
      );
    });
  });
});
