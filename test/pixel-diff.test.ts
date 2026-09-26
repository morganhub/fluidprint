// Contrôle au pixel de l'import (tâche 1.16), sur un import jetable du dépliant d'exemple.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../scripts/import/importer';
import { designFileOf, runPixelDiff } from '../scripts/pixel-diff';
import type { FrameObject, LayoutDocument, QrObject, TextObject } from '../src/model/types';
import { PROJECT_ROOT } from '../server/paths';
import { EXAMPLE_DESIGN, EXAMPLE_ID } from './helpers/editor';

const PX_PER_MM = 300 / 25.4;
let dir: string;
let docFile: string;
let reportDir: string;
let imported: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-pixel-'));
  const outcome = await runImport({ designFile: EXAMPLE_DESIGN, documentsDir: dir });
  docFile = outcome.documentFile;
  reportDir = path.join(path.dirname(docFile), 'import-report');
  imported = await readFile(docFile, 'utf8');
}, 120_000);

/** Le document tel qu'importé, retouché par `change` puis écrit : chaque test part de l'import intact. */
async function writeVariant(change: (doc: LayoutDocument) => void): Promise<LayoutDocument> {
  const doc = JSON.parse(imported) as LayoutDocument;
  change(doc);
  await writeFile(docFile, JSON.stringify(doc, null, 2));
  return doc;
}

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function redPixelsIn(file: string, box: { x: number; y: number; w: number; h: number }): Promise<number> {
  const png = PNG.sync.read(await readFile(file));
  let n = 0;
  const [x0, y0] = [Math.floor(box.x * PX_PER_MM), Math.floor(box.y * PX_PER_MM)];
  const [x1, y1] = [Math.ceil((box.x + box.w) * PX_PER_MM), Math.ceil((box.y + box.h) * PX_PER_MM)];
  for (let y = y0; y < Math.min(y1, png.height); y++) {
    for (let x = x0; x < Math.min(x1, png.width); x++) {
      const o = (y * png.width + x) * 4;
      if (png.data[o] === 255 && png.data[o + 1] === 0 && png.data[o + 2] === 0) n++;
    }
  }
  return n;
}

describe('npm run diff:import', () => {
  it('le document importé recouvre le design : moins de 0,1 % par face à 300 ppi', async () => {
    const summary = await runPixelDiff({ docId: EXAMPLE_ID, documentsDir: dir });
    expect(summary.faces.map((f) => f.faceId)).toEqual(['exterieur', 'interieur']);
    for (const face of summary.faces) {
      expect(face.width).toBeGreaterThan(3500);
      expect(face.diffPercent, face.faceId).toBeLessThan(0.1);
      // 5 cadres et 6 QR retirés du pourcentage de la face ; chacun a son propre contrôle.
      for (const z of face.excluded.filter((e) => e.type === 'frame')) {
        expect(z.diffPercent, z.id).toBeLessThan(0.5);
        expect(z.passed, z.id).toBe(true);
      }
    }
    const qrs = summary.faces.flatMap((f) => f.excluded).filter((z) => z.type === 'qr');
    expect(qrs).toHaveLength(6);
    // Chaque QR régénéré se lit, et donne l'adresse du QR du design.
    for (const z of qrs) {
      expect(z.urls?.design, z.id).toMatch(/^https:\/\/example\.com\//);
      expect(z.urls?.imported, z.id).toBe(z.urls?.design);
      expect(z.passed, z.id).toBe(true);
    }
    expect(summary.passed).toBe(true);
    expect(summary.lineMismatches).toEqual([]);
    for (const face of ['exterieur', 'interieur']) {
      for (const kind of ['design', 'import', 'diff']) expect(existsSync(path.join(reportDir, `${face}-${kind}.png`))).toBe(true);
    }
    const onDisk = JSON.parse(await readFile(path.join(reportDir, 'summary.json'), 'utf8'));
    expect(onDisk.faces[0].diffPercent).toBe(summary.faces[0].diffPercent);
  }, 180_000);

  it('montre en rouge un texte déplacé', async () => {
    let before = { x: 0, y: 0, w: 0, h: 0 };
    await writeVariant((doc) => {
      const text = Object.values(doc.objects).find((o): o is TextObject => o.type === 'text' && o.id.startsWith('ext-') && o.w > 30)!;
      before = { x: text.x, y: text.y, w: text.w, h: text.h };
      text.y += 1;
    });

    const summary = await runPixelDiff({ docId: EXAMPLE_ID, documentsDir: dir, maxPercent: 0 });
    const ext = summary.faces.find((f) => f.faceId === 'exterieur')!;
    const int = summary.faces.find((f) => f.faceId === 'interieur')!;
    expect(ext.diffPixels).toBeGreaterThan(0);
    expect(ext.passed).toBe(false);
    expect(summary.passed).toBe(false);
    expect(int.diffPercent).toBeLessThan(0.1);
    const moved = { x: before.x, y: before.y, w: before.w, h: before.h + 1 };
    const red = await redPixelsIn(path.join(reportDir, 'exterieur-diff.png'), moved);
    expect(red).toBeGreaterThan(50);
    expect(ext.diffPixels).toBeLessThan(red + 200);
  }, 180_000);

  it('fait échouer un QR qui mène à une autre adresse, et le montre en rouge', async () => {
    let qr: QrObject | undefined;
    await writeVariant((doc) => {
      qr = Object.values(doc.objects).find((o): o is QrObject => o.type === 'qr' && o.id.startsWith('ext-'))!;
      qr.url = 'https://example.org/une-tout-autre-adresse-bien-plus-longue';
    });
    const summary = await runPixelDiff({ docId: EXAMPLE_ID, documentsDir: dir });
    const ext = summary.faces.find((f) => f.faceId === 'exterieur')!;
    const zone = ext.excluded.find((z) => z.id === qr!.id)!;
    expect(zone.urls).toEqual({ design: expect.stringMatching(/^https:\/\/example\.com\//), imported: qr!.url });
    expect(zone.passed).toBe(false);
    expect(ext.diffPercent).toBeLessThan(0.1);
    expect(ext.passed).toBe(false);
    expect(summary.passed).toBe(false);
    expect(await redPixelsIn(path.join(reportDir, 'exterieur-diff.png'), qr!)).toBeGreaterThan(1000);
  }, 180_000);

  it('fait échouer une goutte repeinte (cadre sans photo) et des fonds pâles passés au blanc', async () => {
    await writeVariant((doc) => {
      const drop = Object.values(doc.objects).find((o): o is FrameObject => o.type === 'frame' && o.id.startsWith('ext-') && o.shape.kind === 'path')!;
      drop.fill = { swatch: 'gris-tres-fonce' };
      // Fond vert très pâle (#edf4ef) passé au blanc : un écart de luminance d'une dizaine d'unités, invisible
      // au seuil de couleur de 0,1, qui laissait tout passer. Le contrôle rend les couleurs d'origine du design
      // (sourceRgb, nuancier CMJN 4.1) : c'est elle qu'on repeint.
      const pale = doc.swatches.find((sw) => sw.id === 'vert-tres-clair')!;
      pale.rgb = '#ffffff';
      if (pale.sourceRgb) pale.sourceRgb = '#ffffff';
    });
    const summary = await runPixelDiff({ docId: EXAMPLE_ID, documentsDir: dir });
    const ext = summary.faces.find((f) => f.faceId === 'exterieur')!;
    const drop = ext.excluded.find((z) => z.type === 'frame' && z.diffPercent! > 1);
    expect(drop, JSON.stringify(ext.excluded.map((z) => [z.id, z.diffPercent]))).toBeDefined();
    expect(drop!.passed).toBe(false);
    expect(ext.diffPercent).toBeGreaterThan(0.5);
    expect(ext.passed).toBe(false);
    expect(summary.passed).toBe(false);
  }, 180_000);
});

describe('design de référence du contrôle au pixel', () => {
  it('la copie gardée à l’import, sinon source.path ; --design l’emporte ; introuvable : message clair', async () => {
    const doc = JSON.parse(imported) as LayoutDocument;
    const docDir = path.join(dir, 'reference');
    await mkdir(docDir, { recursive: true });
    // Pas de copie : source.path (relatif au projet), c'est-à-dire le design d'exemple.
    expect(path.resolve(designFileOf(doc, docDir))).toBe(path.resolve(PROJECT_ROOT, doc.source!.path));
    // La copie gardée par l'import (ligne de commande, route) suit le document : elle passe avant source.path.
    await copyFile(EXAMPLE_DESIGN, path.join(docDir, 'design.dc.html'));
    expect(designFileOf(doc, docDir)).toBe(path.join(docDir, 'design.dc.html'));
    expect(designFileOf(doc, docDir, EXAMPLE_DESIGN)).toBe(path.resolve(EXAMPLE_DESIGN));
    expect(() => designFileOf(doc, docDir, path.join(dir, 'absent.dc.html'))).toThrow(/Design introuvable/);
    await rm(path.join(docDir, 'design.dc.html'));
    expect(() => designFileOf({ ...doc, source: { ...doc.source!, path: 'nulle-part.dc.html' } }, docDir)).toThrow(/--design/);
  });
});
