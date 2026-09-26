import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  arcToCubics,
  clampPolygon,
  controlBounds,
  findShape,
  frameShapePath,
  normalizePath,
  parsePath,
  pathBounds,
  polygonPath,
  serializePath,
  SHAPE_PRESETS,
  shapeFromSvg,
} from '../src/model/shapes';
import type { FrameObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { openEditor, settle, typeInField, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { docWithFrames, dropFile, frame, hexagonShape, makePhoto, waitFramePhoto } from './helpers/images';

describe('tracés', () => {
  it('convertit H, V et les commandes relatives en absolu', () => {
    const cmds = parsePath('M0 0H100V43c-18 7 -36 -5 -54 0Z');
    expect(cmds[1]).toEqual({ c: 'L', p: [100, 0] });
    expect(cmds[2]).toEqual({ c: 'L', p: [100, 43] });
    expect(cmds[3]).toEqual({ c: 'C', p1: [82, 50], p2: [64, 38], p: [46, 43] });
  });

  it('normalise une vague du design (viewBox 100 × 50) dans la boîte 0..1', () => {
    const d = normalizePath('M0 0H100V43C82 50 64 38 46 43C28 48 14 47 0 41Z', { x: 0, y: 0, w: 100, h: 50 });
    const b = controlBounds(d);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.w).toBe(1);
    expect(b.h).toBeCloseTo(1, 5);
  });

  it('garde la goutte dans sa boîte de dessin 100 × 130', () => {
    const b = controlBounds(SHAPE_PRESETS.goutte.d);
    expect(b.x).toBeCloseTo(0.04, 5);
    expect(b.y).toBeCloseTo(2 / 130, 5);
    expect(SHAPE_PRESETS.goutte.aspect).toBeCloseTo(100 / 130, 5);
  });

  it('refuse les arcs avec un message clair', () => {
    expect(() => parsePath('M0 0A5 5 0 0 1 10 10')).toThrow(/arcs/);
  });
});

// ---------------------------------------------------------------- 3.3 à 3.5 : formes-masques

/** Logo fictif écrit comme un export d'Illustrator : douze tracés, prologue XML, métadonnées. */
const LOGO_FILE = path.resolve(import.meta.dirname, 'fixtures/logo-exemple.svg');

/** La goutte du design, écrite avec un arc (bas arrondi) dans un groupe transformé, comme un SVG d'Illustrator. */
const DROP_SVG_WITH_ARC = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
  <defs><clipPath id="c"><rect width="10" height="10"/></clipPath></defs>
  <rect x="0" y="0" width="300" height="300" fill="none" stroke="#000"/>
  <g transform="translate(10 20) scale(2)" fill="#2a5fa3">
    <path d="M50 2C61 30 96 56 96 86a46 42 0 0 1-92 0C4 56 39 30 50 2z"/>
  </g>
</svg>`;

const vertexCount = (d: string) => parsePath(d).filter((c) => c.c === 'M' || c.c === 'L').length;
const shapeD = (f: FrameObject) => (f.shape.kind === 'path' ? f.shape.d : '');

describe('arcs convertis en courbes (3.3)', () => {
  it('un demi-cercle devient deux quarts de Bézier qui passent par le cercle', () => {
    const cmds = parsePath('M0 50A50 50 0 0 1 100 50', { convertArcs: true });
    expect(cmds.filter((c) => c.c === 'C')).toHaveLength(2);
    const mid = cmds[1] as { p: [number, number] };
    expect(mid.p[0]).toBeCloseTo(50, 9);
    expect(mid.p[1]).toBeCloseTo(0, 9);
    expect(cmds[2]).toMatchObject({ c: 'C', p: [100, 50] });
    const b = pathBounds(serializePath(cmds));
    expect(b.y).toBeCloseTo(0, 3);
    expect(b.h).toBeCloseTo(50, 3);
  });

  it('lit les drapeaux collés d’un SVG compressé et agrandit un rayon trop petit', () => {
    const cmds = parsePath('M0 0a5 5 0 01 10 0', { convertArcs: true });
    expect(cmds.at(-1)).toMatchObject({ c: 'C', p: [10, 0] });
    // Rayon trop petit pour joindre les points : agrandi (SVG, annexe F.6.6), soit un demi-cercle.
    const small = arcToCubics([0, 0], 1, 1, 0, false, true, [10, 0]);
    expect(pathBounds(serializePath([{ c: 'M', p: [0, 0] }, ...small])).h).toBeCloseTo(5, 3);
  });

  it('sans l’option, un arc reste refusé : le document stocké n’en contient jamais', () => {
    expect(() => parsePath('M0 0A5 5 0 0 1 10 10')).toThrow(/arcs/);
  });
});

describe('forme depuis un SVG (3.3)', () => {
  it('le logo : ses 12 tracés réunis et normalisés dans la boîte 0..1', () => {
    const shape = shapeFromSvg(readFileSync(LOGO_FILE, 'utf8'));
    expect(shape.elements).toBe(12);
    const b = pathBounds(shape.d);
    expect(b.x).toBeCloseTo(0, 6);
    expect(b.y).toBeCloseTo(0, 6);
    expect(b.w).toBeCloseTo(1, 6);
    expect(b.h).toBeCloseTo(1, 6);
    expect(shape.aspect).toBeGreaterThan(5);
    // Le viewBox (420 × 80) laisse de la place sous les lettres : la boîte exacte est plus allongée.
    expect(shape.aspect).toBeLessThan(10);
    expect(parsePath(shape.d).filter((c) => c.c === 'M').length).toBeGreaterThanOrEqual(12);
  });

  it('une goutte avec un arc dans un groupe transformé : arc converti, transformation appliquée, cadre valide', () => {
    const shape = shapeFromSvg(DROP_SVG_WITH_ARC);
    expect(shape.elements).toBe(1);
    expect(shape.d).not.toMatch(/[aA]/);
    // Goutte de 92 × 126 unités ; l'échelle (× 2) ne change pas le rapport.
    expect(shape.aspect).toBeCloseTo(92 / 126, 2);
    const doc = docWithFrames([frame('g', 10, 10, 40, 40 / shape.aspect, { shape: { kind: 'path', d: shape.d, preset: 'svg-goutte' } })]);
    doc.shapes = [{ id: 'svg-goutte', name: 'Goutte', d: shape.d, aspect: shape.aspect }];
    expect(validateDocument(doc)).toMatchObject({ ok: true });
    expect(findShape(doc.shapes, 'svg-goutte')?.name).toBe('Goutte');
    expect(findShape(doc.shapes, 'goutte')?.name).toBe('Goutte');
  });

  it('une rotation de 90° échange largeur et hauteur ; un SVG sans forme remplie est refusé', () => {
    const rotated = shapeFromSvg('<svg><rect width="20" height="10" transform="rotate(90)"/></svg>');
    expect(rotated.aspect).toBeCloseTo(0.5, 6);
    const circle = shapeFromSvg('<svg><circle cx="5" cy="5" r="5"/><ellipse cx="20" cy="5" rx="5" ry="5" style="display:none"/></svg>');
    expect(circle.aspect).toBeCloseTo(1, 6);
    expect(() => shapeFromSvg('<svg><path d="M0 0L10 10" fill="none"/></svg>')).toThrow(/Aucun tracé/);
  });
});

describe('polygones et étoiles (3.4)', () => {
  it('hexagone, étoile, arrondi, bornes', () => {
    const hex = polygonPath({ sides: 6, inset: 0, rounding: 0 });
    expect(vertexCount(hex.d)).toBe(6);
    expect(hex.aspect).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    const star = polygonPath({ sides: 5, inset: 50, rounding: 0 });
    expect(vertexCount(star.d)).toBe(10);
    const round = polygonPath({ sides: 6, inset: 0, rounding: 40 });
    expect(parsePath(round.d).filter((c) => c.c === 'C')).toHaveLength(6);
    for (const d of [hex.d, star.d, round.d]) {
      const b = pathBounds(d);
      // Tracés écrits au 1/100 000 : la boîte relue est juste à cette précision.
      expect(b.w).toBeCloseTo(1, 4);
      expect(b.h).toBeCloseTo(1, 4);
    }
    expect(clampPolygon({ sides: 2, inset: 120, rounding: -5 })).toEqual({ sides: 3, inset: 99, rounding: 0 });
    expect(clampPolygon({ sides: 20, inset: 0, rounding: 0 }).sides).toBe(12);
    expect(SHAPE_PRESETS.hexagone.polygon).toEqual({ sides: 6, inset: 0, rounding: 0 });
  });

  it('contour d’un cadre en mm pour chaque forme', () => {
    expect(pathBounds(frameShapePath({ kind: 'ellipse' }, 40, 20))).toMatchObject({ x: 0, y: 0, w: 40, h: 20 });
    expect(pathBounds(frameShapePath({ kind: 'rect', radius: 3 }, 40, 20)).w).toBeCloseTo(40, 6);
    const b = pathBounds(frameShapePath({ kind: 'path', d: SHAPE_PRESETS.hexagone.d }, 52, 60));
    expect(b.w).toBeCloseTo(52, 4);
    expect(b.h).toBeCloseTo(60, 4);
  });
});

describe('formes dans l’éditeur (3.3, 3.4)', () => {
  it('« Forme depuis un SVG » donne un cadre utilisable ; un hexagone se règle et reçoit une photo', async () => {
    await withTempDocuments(async (dir) => {
      const hexa = frame('hexa', 200, 30, 60, 69.282, { shape: hexagonShape(), fill: { swatch: 'bleu' } });
      await writeDocument(dir, docWithFrames([hexa]));
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-svg-'));
      const dropSvgFile = path.join(tmp, 'goutte-arc.svg');
      await writeFile(dropSvgFile, DROP_SVG_WITH_ARC);
      try {
        await withApp(
          async ({ browser, url }) => {
            const page = await openEditor(browser, url, 'essai');
            const state = () => page.evaluate(() => window.__editor!.getState());
            const upload = async (selector: string, file: string) => {
              const input = await page.waitForSelector(selector);
              await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(file);
            };

            // Le logo, depuis les options de l'outil Forme.
            await page.keyboard.press('s');
            await settle(page);
            await upload('[data-file-input="svg-shape"]', LOGO_FILE);
            await page.waitForFunction(() => (window.__editor!.getState().doc!.shapes ?? []).length === 1);
            let s = await state();
            const logoFrame = s.doc!.objects[s.selection[0]] as FrameObject;
            expect(s.tool).toBe('select');
            expect(s.history.undoLabel).toBe('Forme depuis un SVG');
            expect(logoFrame.type).toBe('frame');
            expect(logoFrame.shape).toMatchObject({ kind: 'path', preset: s.doc!.shapes![0].id });
            expect(logoFrame.w / logoFrame.h).toBeCloseTo(s.doc!.shapes![0].aspect, 3);

            // Une photo déposée sur le logo : découpée par les lettres.
            const box = await page.evaluate((i) => window.__editor!.objectClientBox(i), logoFrame.id);
            await dropFile(page, { x: box.x + box.w * 0.08, y: box.y + box.h * 0.5 }, { name: 'logo-photo.jpg', type: 'image/jpeg', data: await makePhoto(1200, 400) });
            await waitFramePhoto(page, logoFrame.id);
            expect(((await state()).doc!.objects[logoFrame.id] as FrameObject).image?.fit).toBe('fill');

            // La goutte avec un arc, depuis la section Forme du panneau Propriétés.
            await page.evaluate(() => window.__editor!.getState().select(['hexa']));
            await settle(page);
            await upload('[data-section="frame-shape"] [data-file-input="svg-shape"]', dropSvgFile);
            await page.waitForFunction(() => (window.__editor!.getState().doc!.shapes ?? []).length === 2);
            s = await state();
            const dropFrame = s.doc!.objects[s.selection[0]] as FrameObject;
            expect(shapeD(dropFrame)).not.toMatch(/[aA]/);
            expect(validateDocument(s.doc)).toMatchObject({ ok: true });

            // Hexagone : 8 côtés depuis Propriétés, retour à 6, puis une photo déposée dedans.
            await page.evaluate(() => window.__editor!.getState().select(['hexa']));
            await settle(page);
            await typeInField(page, 'sides', '8');
            const octo = (await state()).doc!.objects.hexa as FrameObject;
            expect(octo.shape).toMatchObject({ kind: 'path', polygon: { sides: 8, inset: 0, rounding: 0 } });
            expect(vertexCount(shapeD(octo))).toBe(8);
            await typeInField(page, 'sides', '6');
            const hb = await page.evaluate(() => window.__editor!.objectClientBox('hexa'));
            await dropFile(page, { x: hb.x + hb.w / 2, y: hb.y + hb.h / 2 }, { name: 'hexa.jpg', type: 'image/jpeg', data: await makePhoto(900, 900) });
            await waitFramePhoto(page, 'hexa');
            const withPhoto = (await state()).doc!.objects.hexa as FrameObject;
            expect(withPhoto.image?.fit).toBe('fill');
            expect(vertexCount(shapeD(withPhoto))).toBe(6);
            expect(await page.$eval('[data-page-id] [data-obj-id="hexa"] clipPath path', (el) => el.getAttribute('d'))).toBe(shapeD(withPhoto));
          },
          { documentsDir: dir },
        );
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
