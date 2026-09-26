// Rotation des objets (tâche 2.12) : champ Angle, poignée de rotation (Maj : pas de 15°), un cadre photo
// tourne avec sa photo, un objet tourné se redimensionne selon ses propres côtés, un groupe fait pivoter
// ses objets autour de son centre, et un texte tourné de 90° s'exporte tourné et vectoriel.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Page as BrowserPage } from 'puppeteer-core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../server/export';
import { angleOf, normalizeAngle, rotateObjects } from '../src/editor/rotation';
import { computeImagePlacement } from '../src/model/frame';
import type { FrameObject, GroupObject, LayoutDocument } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, dragFrom, objectCenter, openEditor, readSavedDocument, saveNow, settle, typeInField, withApp, withTempDocuments, writeDocument } from './helpers/editor';

const PHOTO = { width: 600, height: 400 };

async function photoDoc(dir: string): Promise<LayoutDocument> {
  const doc = minimalDoc();
  doc.objects.photo = {
    id: 'photo',
    type: 'frame',
    layerId: 'contenu',
    x: 150,
    y: 40,
    w: 40,
    h: 20,
    shape: { kind: 'rect' },
    image: { assetId: 'img', fit: 'fill', ...computeImagePlacement('fill', 40, 20, PHOTO.width, PHOTO.height) },
  } satisfies FrameObject;
  doc.pages[0].children.push('photo');
  doc.assets.push({ id: 'img', kind: 'image', name: 'photo.png', original: 'assets/originals/photo.png', ...PHOTO });
  await writeDocument(dir, doc);
  const originals = path.join(dir, doc.id, 'assets', 'originals');
  await mkdir(originals, { recursive: true });
  await sharp({ create: { width: PHOTO.width, height: PHOTO.height, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .png()
    .toFile(path.join(originals, 'photo.png'));
  return doc;
}

const obj = (page: BrowserPage, id: string) => page.evaluate((i) => window.__editor!.getState().doc!.objects[i], id);
const depth = (page: BrowserPage) => page.evaluate(() => window.__editor!.getState().history.depth);

async function handleCenter(page: BrowserPage, selector: string) {
  const el = await page.waitForSelector(selector, { visible: true });
  const b = (await el!.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Tourne la poignée de rotation de `deg` degrés autour de `center` (px client), au pixel entier. */
async function turnHandle(page: BrowserPage, center: { x: number; y: number }, deg: number, hold: 'Shift' | null) {
  const knob = await handleCenter(page, '[data-rotation-handle]');
  const r = Math.hypot(knob.x - center.x, knob.y - center.y);
  const a0 = Math.atan2(knob.y - center.y, knob.x - center.x);
  if (hold) await page.keyboard.down(hold);
  await page.mouse.move(Math.round(knob.x), Math.round(knob.y));
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    const a = a0 + ((deg * Math.PI) / 180) * (i / 10);
    await page.mouse.move(Math.round(center.x + r * Math.cos(a)), Math.round(center.y + r * Math.sin(a)));
  }
  await page.mouse.up();
  if (hold) await page.keyboard.up(hold);
  await settle(page);
}

describe('rotation : commandes (unitaire)', () => {
  it('angle ramené dans ]-180, 180] ; un groupe fait pivoter ses objets autour de son centre', () => {
    expect(normalizeAngle(270)).toBe(-90);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(360)).toBe(0);
    const doc = minimalDoc();
    doc.objects.g = { id: 'g', type: 'group', layerId: 'contenu', x: 10, y: 20, w: 82, h: 60, children: ['r1', 't1'] } satisfies GroupObject;
    doc.pages[0].children = ['g'];
    const c = { x: 10 + 82 / 2, y: 20 + 60 / 2 };
    rotateObjects(doc, ['g'], 90);
    const r1 = doc.objects.r1;
    // Centre de r1 (25, 27,5) tourné de 90° autour de (51, 50) : (51 − (27,5 − 50), 50 + (25 − 51)) = (73,5, 24).
    expect(r1.x + r1.w / 2).toBeCloseTo(c.x - (27.5 - c.y), 6);
    expect(r1.y + r1.h / 2).toBeCloseTo(c.y + (25 - c.x), 6);
    expect(r1.rotation).toBe(90);
    expect(doc.objects.t1.rotation).toBe(90);
    expect(angleOf(doc, 'g')).toBe(90);
    // La boîte du groupe suit ses objets tournés (60 × 82 au lieu de 82 × 60).
    expect(doc.objects.g.w).toBeCloseTo(60, 4);
    expect(doc.objects.g.h).toBeCloseTo(82, 4);
    // Quatre quarts de tour : retour au point de départ, sans angle résiduel.
    for (let i = 0; i < 3; i++) rotateObjects(doc, ['g'], 90);
    expect(doc.objects.r1.rotation).toBeUndefined();
    expect(doc.objects.r1.x).toBeCloseTo(10, 4);
    expect(doc.objects.r1.y).toBeCloseTo(20, 4);
  });
});

describe('rotation dans l’éditeur (2.12)', () => {
  it('champ Angle, poignée (Maj : 15°), cadre photo tourné avec sa photo, redimensionnement d’un objet tourné, groupe', async () => {
    await withTempDocuments(async (dir) => {
      const doc = await photoDoc(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 'p-ext' });
          // Magnétisme coupé : les poignées se vérifient au pas de la souris.
          await page.click('[data-snapping-toggle]');

          // --- Cadre photo : 90° au champ Angle ; la photo tourne avec lui (elle reste dans son repère).
          await page.evaluate(() => window.__editor!.getState().select(['photo']));
          await settle(page);
          const imageRect = () =>
            page.evaluate(() => {
              const r = document.querySelector('[data-page-id] [data-obj-id="photo"] image')!.getBoundingClientRect();
              return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
            });
          const before = await imageRect();
          expect(before.w).toBeGreaterThan(before.h);
          const photoBefore = (await obj(page, 'photo')) as FrameObject;
          await typeInField(page, 'rotation', '90');
          const photo = (await obj(page, 'photo')) as FrameObject;
          expect(photo.rotation).toBe(90);
          expect({ x: photo.x, y: photo.y, w: photo.w, h: photo.h, image: photo.image }).toEqual({ x: 150, y: 40, w: 40, h: 20, image: photoBefore.image });
          const after = await imageRect();
          expect(after.w).toBeCloseTo(before.h, 0);
          expect(after.h).toBeCloseTo(before.w, 0);
          expect(Math.abs(after.cx - before.cx)).toBeLessThan(1);
          expect(Math.abs(after.cy - before.cy)).toBeLessThan(1);
          // Le cadre de sélection est tourné comme l'objet.
          expect(await page.evaluate(() => (document.querySelector('[data-selection-box]') as HTMLElement).style.transform)).toBe('rotate(90deg)');

          // --- Poignée de rotation : Maj cale l'angle sur 15° ; un geste = une étape.
          await clickAt(page, 'p-ext', 25, 27);
          const center = await objectCenter(page, 'r1');
          let d0 = await depth(page);
          await turnHandle(page, center, 50, 'Shift');
          expect((await obj(page, 'r1')).rotation).toBe(45);
          expect(await depth(page)).toBe(d0 + 1);
          const r45 = await obj(page, 'r1');
          expect(r45.x).toBe(10);
          expect(r45.y).toBe(20);
          await turnHandle(page, center, 20, null);
          const free = (await obj(page, 'r1')).rotation!;
          expect(Math.abs(free - 65)).toBeLessThan(1.5);
          expect(free % 15).not.toBe(0);
          await turnHandle(page, center, 17, 'Shift');
          expect((await obj(page, 'r1')).rotation).toBe(75);
          expect(await page.evaluate(() => document.querySelector('[data-rotation-label]'))).toBeNull();
          await page.keyboard.down('Control');
          for (let i = 0; i < 3; i++) await page.keyboard.press('z');
          await page.keyboard.up('Control');
          await settle(page);
          expect((await obj(page, 'r1')).rotation).toBeUndefined();

          // --- Objet tourné de 90° : sa poignée « droite » est en bas ; la tirer de 10 mm allonge l'objet
          // de 10 mm le long de son propre axe, le côté opposé restant fixe.
          await typeInField(page, 'rotation', '90');
          const r0 = await obj(page, 'r1');
          const e = await handleCenter(page, '.editor-moveable .moveable-control[data-direction="e"]');
          expect(e.y).toBeGreaterThan(center.y + 20);
          d0 = await depth(page);
          await dragFrom(page, e, 0, 10, { steps: 6 });
          const r1 = await obj(page, 'r1');
          expect(r1.w).toBeCloseTo(r0.w + 10, 4);
          expect(r1.h).toBeCloseTo(r0.h, 4);
          expect(r1.x + r1.w / 2).toBeCloseTo(r0.x + r0.w / 2, 4);
          expect(r1.y + r1.h / 2).toBeCloseTo(r0.y + r0.h / 2 + 5, 4);
          expect(r1.rotation).toBe(90);
          expect(await depth(page)).toBe(d0 + 1);

          // --- Groupe : chaque objet pivote autour du centre du groupe, rien n'est ignoré.
          await page.evaluate(() => window.__editor!.getState().update(['r1'], { rotation: undefined }));
          const groupId = await page.evaluate(() => window.__editor!.getState().group(['r1', 't1']));
          await settle(page);
          const g0 = (await obj(page, groupId!)) as GroupObject;
          const c = { x: g0.x + g0.w / 2, y: g0.y + g0.h / 2 };
          const t0 = await obj(page, 't1');
          const rr0 = await obj(page, 'r1');
          await typeInField(page, 'rotation', '90');
          const t1 = await obj(page, 't1');
          const rr1 = await obj(page, 'r1');
          expect(t1.rotation).toBe(90);
          expect(rr1.rotation).toBe(90);
          for (const [a, b] of [
            [t0, t1],
            [rr0, rr1],
          ]) {
            expect(b.x + b.w / 2).toBeCloseTo(c.x - (a.y + a.h / 2 - c.y), 3);
            expect(b.y + b.h / 2).toBeCloseTo(c.y + (a.x + a.w / 2 - c.x), 3);
          }
          expect(await page.$eval('[data-side-panels] input[name="rotation"]', (el) => (el as HTMLInputElement).value)).toBe('90');
          // Quart de tour à gauche : retour à 0 pour tout le groupe.
          await page.click('[data-side-panels] [data-action="rotate-left"]');
          await settle(page);
          expect((await obj(page, 't1')).rotation).toBeUndefined();
          expect((await obj(page, 't1')).x).toBeCloseTo(t0.x, 3);
        },
        { documentsDir: dir },
      );
    });
  });

  it('un texte tourné de 90° s’exporte tourné, toujours vectoriel', async () => {
    await withTempDocuments(async (dir) => {
      const doc = minimalDoc();
      // Une seule page utile, avec le texte seul : tout texte du PDF est le sien.
      doc.pages[0].children = ['t1'];
      delete doc.objects.r1;
      await writeDocument(dir, doc);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, doc.id, { zoom: 1, centerOn: 't1' });
          await clickAt(page, 'p-ext', 30, 65);
          expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual(['t1']);
          await typeInField(page, 'rotation', '90');
          await saveNow(page);
        },
        { documentsDir: dir },
      );
      const saved = await readSavedDocument(dir, doc.id);
      expect(saved.objects.t1.rotation).toBe(90);

      const result = await exportPdf({ docId: doc.id, preset: 'rvb', documentsDir: dir });
      const pdf = await readFile(result.file);
      const text = pdf.toString('latin1');
      // Vectoriel : police incorporée (contours des glyphes), aucune image dans le PDF.
      expect(text).toMatch(/\/FontFile2/);
      expect(text).not.toMatch(/\/Subtype\s*\/Image/);
      const shows = textDirections(pdf);
      expect(shows.length).toBeGreaterThan(0);
      // Chaque tracé de texte a sa ligne de base verticale : tourné d'un quart de tour.
      for (const angle of shows) expect(Math.abs(Math.abs(angle) - 90)).toBeLessThan(0.01);
    });
  });
});

// ---------------------------------------------------------------- lecture du texte dans le PDF

type Matrix = [number, number, number, number, number, number];
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/**
 * Direction (degrés) de la ligne de base de chaque opérateur de texte (Tj, TJ, ', ") des flux du PDF :
 * matrice de texte × matrice courante, formes XObject comprises (elles repartent de leur /Matrix).
 */
function textDirections(pdf: Buffer): number[] {
  const text = pdf.toString('latin1');
  const out: number[] = [];
  for (const m of text.matchAll(/<<((?:(?!endobj)[\s\S])*?)>>\s*stream\r?\n/g)) {
    if (!/\/FlateDecode/.test(m[1]) || /\/Length1|\/Subtype\s*\/(Image|Type1C|CIDFontType0C)/.test(m[1])) continue;
    const start = m.index! + m[0].length;
    const end = text.indexOf('endstream', start);
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    if (!/\bBT\b/.test(content)) continue;
    const matrix = /\/Matrix\s*\[([^\]]+)\]/.exec(m[1])?.[1].trim().split(/\s+/).map(Number) as Matrix | undefined;
    let ctm: Matrix = matrix ?? [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    let tm: Matrix = [1, 0, 0, 1, 0, 0];
    let args: number[] = [];
    const tokens = content.match(/\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|\/[^\s/<>[\](){}%]+|[-+]?(?:\d*\.\d+|\d+\.?)|[A-Za-z'"*]+|\[|\]/g) ?? [];
    for (const tok of tokens) {
      if (/^[-+.\d]/.test(tok)) {
        args.push(Number(tok));
        continue;
      }
      if (/^[(<[\]/]/.test(tok)) continue;
      switch (tok) {
        case 'q':
          stack.push(ctm);
          break;
        case 'Q':
          ctm = stack.pop() ?? ctm;
          break;
        case 'cm':
          ctm = mul(args.slice(-6) as Matrix, ctm);
          break;
        case 'BT':
          tm = [1, 0, 0, 1, 0, 0];
          break;
        case 'Tm':
          tm = args.slice(-6) as Matrix;
          break;
        case 'Tj':
        case 'TJ':
        case "'":
        case '"': {
          const full = mul(tm, ctm);
          out.push((Math.atan2(full[1], full[0]) * 180) / Math.PI);
          break;
        }
      }
      args = [];
    }
  }
  return out;
}
