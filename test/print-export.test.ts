// Chaîne d'impression (tâches 4.2 à 4.5, 4.7, 4.10) : export imprimeur CMJN PDF/X-4, traits de coupe,
// préréglage e-mail, refus des photos provisoires. Le détail du post-traitement est testé en Python
// (npm run test:print) ; ici, l'export complet depuis un document, comme le lance l'éditeur.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertDocumentSwatches } from '../scripts/print-swatches';
import { startServer } from '../server/app';
import { cmykToRgb, loadPresets, PRESETS_FILE, rgbToCmyk } from '../server/color';
import { exportPdf, type ExportResult } from '../server/export';
import { computeImagePlacement } from '../src/model/frame';
import { setSwatchCmyk } from '../src/model/swatches';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { mmToPt } from '../src/model/units';
import { minimalDoc } from './fixtures/minimal-doc';
import { copyExample, withTempDocuments } from './helpers/editor';
import { readPdfPages } from './helpers/pdf';

const PHOTO = { width: 1600, height: 1000 };
/** Original CMJN (photographe, agence) : doit partir avec ses encres, pas reconverti depuis le RVB de Chrome. */
const CMYK_PHOTO = { width: 600, height: 400 };
const latin1 = (pdf: Buffer) => pdf.toString('latin1');

/** Encres telles que check_pdfx les décrit (« C52 M0 J43 N85 »). */
const describeCmyk = (c: readonly number[]) => `C${c[0]} M${c[1]} J${c[2]} N${c[3]}`;

/** Document d'essai : nuances CMJN (le bleu en C86 M55), un texte de 7,5 pt, une photo JPEG, une photo CMJN. */
async function writePrintDoc(dir: string): Promise<LayoutDocument> {
  const doc = minimalDoc();
  const [blue, gray] = await cmykToRgb([
    [86, 55, 0, 0],
    [0, 0, 0, 80],
  ]);
  setSwatchCmyk(doc, 'bleu', [86, 55, 0, 0], blue, { sourceRgb: '#2a5fa3' });
  setSwatchCmyk(doc, 'gris', [0, 0, 0, 80], gray, { sourceRgb: '#4b4d55' });
  doc.objects.photo = {
    id: 'photo',
    type: 'frame',
    layerId: 'contenu',
    x: 20,
    y: 20,
    w: 160,
    h: 100,
    shape: { kind: 'ellipse' },
    image: { assetId: 'photo', fit: 'fill', ...computeImagePlacement('fill', 160, 100, PHOTO.width, PHOTO.height) },
  };
  doc.pages[1].children.push('photo');
  doc.assets.push({ id: 'photo', kind: 'image', name: 'photo.jpg', original: 'assets/originals/photo.jpg', ...PHOTO });
  doc.objects['photo-cmjn'] = {
    id: 'photo-cmjn',
    type: 'frame',
    layerId: 'contenu',
    x: 190,
    y: 120,
    w: 60,
    h: 40,
    shape: { kind: 'rect' },
    image: { assetId: 'photo-cmjn', fit: 'fill', ...computeImagePlacement('fill', 60, 40, CMYK_PHOTO.width, CMYK_PHOTO.height) },
  };
  doc.pages[1].children.push('photo-cmjn');
  doc.assets.push({ id: 'photo-cmjn', kind: 'image', name: 'cmjn.jpg', original: 'assets/originals/cmjn.jpg', ...CMYK_PHOTO });
  const docDir = path.join(dir, doc.id);
  await mkdir(path.join(docDir, 'assets', 'originals'), { recursive: true });
  const pixels = Buffer.alloc(PHOTO.width * PHOTO.height * 3);
  for (let y = 0; y < PHOTO.height; y++)
    for (let x = 0; x < PHOTO.width; x++) pixels.set([Math.round((x / PHOTO.width) * 255), 40 + ((x ^ y) & 0x3f), Math.round((y / PHOTO.height) * 200)], (y * PHOTO.width + x) * 3);
  await sharp(pixels, { raw: { ...PHOTO, channels: 3 } })
    .jpeg({ quality: 92 })
    .toFile(path.join(docDir, 'assets', 'originals', 'photo.jpg'));
  await sharp(pixels, { raw: { ...PHOTO, channels: 3 } })
    .resize(CMYK_PHOTO.width, CMYK_PHOTO.height)
    .toColourspace('cmyk')
    .jpeg({ quality: 92 })
    .toFile(path.join(docDir, 'assets', 'originals', 'cmjn.jpg'));
  await writeFile(path.join(docDir, 'document.json'), JSON.stringify(doc, null, 2));
  return doc;
}

/** Un seul serveur de rendu pour tous les exports d'un scénario : Vite ne démarre qu'une fois. */
async function withServer<T>(dir: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startServer({ dev: true, hmr: false, port: 0, documentsDir: dir });
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const sizeMm = (box: number[]) => [(box[2] - box[0]) / mmToPt(1), (box[3] - box[1]) / mmToPt(1)];

describe('export imprimeur (PDF/X-4, FOGRA39)', () => {
  it('CMJN exact, photos converties sans perte de pixels, PDF/X-4 conforme ; le préréglage change norme et profil', async () => {
    await withTempDocuments(async (dir) => withServer(dir, async (baseUrl) => {
      await writePrintDoc(dir);
      const printer = await exportPdf({ docId: 'essai', preset: 'imprimeur', documentsDir: dir, baseUrl });
      const pdf = await readFile(printer.file);
      expect(path.basename(printer.file)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-imprimeur\.pdf$/);
      expect(latin1(pdf).slice(0, 8)).toBe('%PDF-1.6');
      expect(printer.check?.ok, printer.check?.errors.join(' ; ')).toBe(true);
      expect(printer.check?.stats.outputCondition).toBe('FOGRA39');
      // Plus aucun RVB : ni opérateur, ni photo (le contrôle Python les refuse, et la photo est bien en CMJN).
      expect(printer.check?.stats.images).toContainEqual(expect.objectContaining({ width: PHOTO.width, height: PHOTO.height, colorSpace: 'cmyk' }));
      expect(printer.check!.stats.maxInkImages!).toBeLessThanOrEqual(300);
      const pages = readPdfPages(pdf);
      const fills = pages.flatMap((p) => p.fills.map((f) => f.color.join(' ')));
      // Le bleu (C86 M55) sort exactement avec les valeurs de sa nuance.
      expect(fills).toContain('0.86 0.55 0 0');
      expect(fills.every((c) => c.split(' ').length !== 3)).toBe(true);
      // Format fini 297 × 210 mm exactement, fond perdu de 3 mm (BleedBox = MediaBox).
      for (const page of pages) {
        const [w, h] = sizeMm(page.trimBox!);
        expect(near(w, 297) && near(h, 210)).toBe(true);
        expect(page.bleedBox).toEqual(page.mediaBox);
        expect(near((page.trimBox![0] - page.mediaBox![0]) / mmToPt(1), 3)).toBe(true);
      }
      expect(latin1(pdf)).toMatch(/\/GTS_PDFXVersion\s*\(PDF\/X-4\)/);
      expect(latin1(pdf)).toMatch(/\/OutputConditionIdentifier\s*\(FOGRA39\)/);
      expect(latin1(pdf)).toMatch(/\/Trapped\s*\/False/);
      // Petit texte gris : noir seul.
      expect(printer.check?.stats.smallText).toContainEqual(expect.objectContaining({ color: 'C0 M0 J0 N80', inks: 1 }));
      // C4 : l'original CMJN est retrouvé dans le PDF et y part avec ses encres (pixels comparés dans test_pdf_cmyk.py).
      const report = printer.report as { cmykOriginals: unknown[]; images: { from: string; width: number }[] };
      expect(report.cmykOriginals).toEqual([{ name: 'cmjn.jpg', asset: 'photo-cmjn', matched: 1 }]);
      expect(report.images.find((i) => i.width === CMYK_PHOTO.width)?.from).toMatch(/^original CMJN « cmjn\.jpg »/);
      expect(printer.warnings.filter((w) => w.kind === 'cmyk-original')).toEqual([]);
      // Polices : seulement les faces d'Open Sans fournies, aucune Type 3.
      expect(printer.check?.stats.type3Fonts).toBe(0);
      expect(printer.check?.stats.fonts?.every((f) => f.startsWith('OpenSans-'))).toBe(true);

      // Changer de préréglage change la norme et le profil du PDF produit.
      const rgb = await exportPdf({ docId: 'essai', preset: 'rvb', documentsDir: dir, baseUrl });
      const rgbPdf = latin1(await readFile(rgb.file));
      expect(rgb.standard).toBeNull();
      expect(rgbPdf).not.toContain('GTS_PDFX');
      expect(rgbPdf).toMatch(/ rg\b|\/DeviceRGB|ICCBased/);
      const custom = path.join(dir, 'presets.json');
      const presets = JSON.parse(await readFile(PRESETS_FILE, 'utf8'));
      // B4 : seuils abaissés pour l'essai (la photo est à 254 ppi) et poids indicatif minuscule.
      presets.presets['imprimeur-gracol'] = {
        ...presets.presets.imprimeur,
        label: 'Imprimeur américain',
        profile: 'GRACoL2006',
        downsamplePpi: 150,
        downsampleAbovePpi: 200,
        maxBytes: 1000,
      };
      await writeFile(custom, JSON.stringify(presets));
      const gracol = await exportPdf({ docId: 'essai', preset: 'imprimeur-gracol', documentsDir: dir, presetsFile: custom, baseUrl });
      expect(gracol.check?.ok).toBe(true);
      expect(gracol.check?.stats.outputCondition).toBe('CGATS TR 006');
      const resampled = (gracol.report as { images: { resampledFrom?: number[]; width: number; ppi?: number }[] }).images.find((i) => i.resampledFrom?.[0] === PHOTO.width)!;
      expect(resampled.ppi).toBeGreaterThan(200);
      expect(Math.abs(resampled.width - Math.round((PHOTO.width * 150) / resampled.ppi!))).toBeLessThanOrEqual(1);
      expect(gracol.check?.stats.images).toContainEqual(expect.objectContaining({ width: resampled.width, colorSpace: 'cmyk' }));
      expect(gracol.warnings).toContainEqual(expect.objectContaining({ kind: 'file-size', message: expect.stringMatching(/au-delà des 0 Mo qu'acceptent bien des imprimeurs/) }));
      // Le préréglage imprimeur livré : réduction au-delà de 450 ppi, poids indicatif de 100 Mo ; la photo à 254 ppi reste entière.
      expect(presets.presets.imprimeur).toMatchObject({ downsamplePpi: 300, downsampleAbovePpi: 450, maxBytes: 100_000_000 });
      expect(printer.check?.stats.images).toContainEqual(expect.objectContaining({ width: PHOTO.width, height: PHOTO.height }));
      expect(latin1(await readFile(gracol.file))).toMatch(/\/OutputConditionIdentifier\s*\(CGATS TR 006\)/);
      expect(printer.profile).toBe('FOGRA39');
      expect(gracol.profile).toBe('GRACoL2006');

      // Traits de coupe : page agrandie de 10 mm de chaque côté, format fini et fond perdu inchangés.
      const marks = await exportPdf({ docId: 'essai', preset: 'traits-de-coupe', documentsDir: dir, baseUrl });
      expect(marks.check?.ok, marks.check?.errors.join(' ; ')).toBe(true);
      for (const page of readPdfPages(await readFile(marks.file))) {
        const [mw, mh] = sizeMm(page.mediaBox!);
        expect(near(mw, 303 + 20) && near(mh, 216 + 20)).toBe(true);
        const [w, h] = sizeMm(page.trimBox!);
        expect(near(w, 297) && near(h, 210)).toBe(true);
        expect(near((page.trimBox![0] - page.bleedBox![0]) / mmToPt(1), 3)).toBe(true);
        expect(near((page.bleedBox![0] - page.mediaBox![0]) / mmToPt(1), 10)).toBe(true);
      }
    }));
  }, 300_000);
});

describe('le dépliant d’exemple', () => {
  it('l’export imprimeur refuse les photos provisoires en nommant les cadres ; « rvb » et « email » avertissent seulement', async () => {
    await withTempDocuments(async (dir) => withServer(dir, async (baseUrl) => {
      const id = await copyExample(dir);
      await expect(exportPdf({ docId: id, preset: 'imprimeur', documentsDir: dir, baseUrl })).rejects.toThrow(
        /Export imprimeur refusé : 5 cadres portent une photo provisoire.*Photo de couverture \(HD\)/,
      );
      await expect(exportPdf({ docId: id, preset: 'traits-de-coupe', documentsDir: dir, baseUrl })).rejects.toThrow(/photo provisoire/);

      // E-mail : PDF RVB sans fond perdu, sous 5 Mo, et une image PNG de chaque face à 150 ppi.
      const email: ExportResult = await exportPdf({ docId: id, preset: 'email', documentsDir: dir, baseUrl });
      expect(email.warnings.some((w) => w.kind === 'placeholder-image')).toBe(true);
      expect(email.bytes).toBeLessThan(5_000_000);
      for (const page of readPdfPages(await readFile(email.file))) {
        expect(page.mediaBox).toEqual(page.trimBox);
        const [w, h] = sizeMm(page.mediaBox!);
        expect(near(w, 297) && near(h, 210)).toBe(true);
      }
      expect(email.pngs).toHaveLength(2);
      for (const png of email.pngs) {
        const img = PNG.sync.read(await readFile(png));
        expect(Math.abs(img.width - Math.round((297 / 25.4) * 150))).toBeLessThanOrEqual(1);
        expect(Math.abs(img.height - Math.round((210 / 25.4) * 150))).toBeLessThanOrEqual(1);
      }
    }));
  }, 300_000);

  it('4.7 : dans le PDF imprimeur, petits textes gris en noir seul, couleurs en encres réduites (trois encres = exception), accent déclaré ; QR en N 100', async () => {
    await withTempDocuments(async (dir) => withServer(dir, async (baseUrl) => {
      const id = await copyExample(dir);
      // Photos provisoires tenues pour définitives, le temps de ce test seulement.
      const file = path.join(dir, id, 'document.json');
      const doc = JSON.parse(await readFile(file, 'utf8')) as LayoutDocument;
      for (const asset of doc.assets) delete asset.placeholder;
      // Le nuancier du dépliant d'exemple a été posé par le script d'impression (--keep rose) : relancé, il ne
      // change plus rien (test/print-colors.test.ts en vérifie le détail).
      const before = JSON.stringify(doc.swatches);
      await convertDocumentSwatches(doc, { smallText: { keep: ['rose'] } });
      expect(JSON.stringify(doc.swatches)).toBe(before);
      await writeFile(file, JSON.stringify(doc));
      await expect(exportPdf({ docId: id, preset: 'imprimeur', documentsDir: dir, baseUrl })).rejects.toThrow(/Photo à \d+ ppi/);
      const result = await exportPdf({ docId: id, preset: 'imprimeur', documentsDir: dir, confirmLowResolution: true, baseUrl });
      expect(result.check?.ok, result.check?.errors.join(' ; ')).toBe(true);
      const small = result.check!.stats.smallText!;
      const colorOf = (swatchId: string) => describeCmyk(doc.swatches.find((sw) => sw.id === swatchId)!.cmyk!);
      // (a) Gris neutre du texte courant : une encre (noir seul). Titres (vert très foncé) : trois encres,
      // variante « petit texte » marquée d'exception. Ni l'un ni l'autre dans ses quatre encres d'origine.
      const gray = colorOf('texte-principal-petit-texte');
      const titles = colorOf('titres-petit-texte');
      expect(gray).toMatch(/^C0 M0 J0 N\d+$/);
      expect(small).toContainEqual(expect.objectContaining({ color: gray, inks: 1 }));
      expect(small).toContainEqual(expect.objectContaining({ color: titles, inks: 3, exception: true }));
      for (const source of ['texte-principal', 'titres', 'vert', 'orange', 'brun', 'gris']) expect(small.find((s) => s.color === colorOf(source)), source).toBeUndefined();
      // (b) L'accent laissé tel quel (« Rose », quatre encres) passe comme exception déclarée.
      expect(small).toContainEqual(expect.objectContaining({ color: colorOf('rose'), inks: 4, exception: true }));
      // (c) Toute autre couleur de petit texte est le papier, deux encres au plus, ou une exception du nuancier
      // (variante à trois encres, accent) que le contrôle a reconnue comme telle.
      const exceptions = new Set(doc.swatches.filter((sw) => sw.smallTextException).map((sw) => colorOf(sw.id)));
      for (const entry of small) {
        if (entry.color === 'C0 M0 J0 N0') continue;
        expect(entry.inks! <= 2 || (entry.exception && exceptions.has(entry.color)), `${entry.color} (${entry.count} passages)`).toBe(true);
      }
      expect(small.filter((e) => e.exception).length).toBeGreaterThanOrEqual(5);
      // Les QR codes : modules en N 100 seul (aplats noirs dans le PDF), jamais le noir du design en quatre encres.
      const fills = readPdfPages(await readFile(result.file)).flatMap((p) => p.fills.map((f) => f.color.join(' ')));
      expect(fills.filter((c) => c === '0 0 0 1').length).toBeGreaterThanOrEqual(6);
      const [richBlack] = await rgbToCmyk(['#1a1a1a'], 'FOGRA39', { maxInk: 300 });
      expect(richBlack.filter((v) => v > 0).length).toBe(4);
      expect(fills).not.toContain(richBlack.map((v) => v / 100).join(' '));
    }));
  }, 300_000);
});

describe('contrôles de l’export imprimeur', () => {
  it('petit texte dans une nuance sans encres (convertie à 3 ou 4 encres) : le contrôle PDF/X fait échouer l’export, sauf nuance d’accent', async () => {
    await withTempDocuments(async (dir) => withServer(dir, async (baseUrl) => {
      const doc = await writePrintDoc(dir);
      // Nuance prise à la pipette, jamais définie en encres : le contrôle en amont ne peut pas compter ses
      // encres, c'est le contrôle du PDF qui les voit.
      doc.swatches.push({ id: 'rouge', name: 'Rouge pipette', rgb: '#c0392b' });
      (doc.objects.t1 as TextObject).style.color = { swatch: 'rouge' };
      const file = path.join(dir, doc.id, 'document.json');
      await writeFile(file, JSON.stringify(doc));
      await expect(exportPdf({ docId: doc.id, preset: 'imprimeur', documentsDir: dir, baseUrl })).rejects.toThrow(
        /ne passe pas le contrôle PDF\/X : Texte de moins de 9 pt en [34] encres \(au plus 2 hors nuances d'accent\)/,
      );
      doc.swatches.find((sw) => sw.id === 'rouge')!.smallTextException = true;
      await writeFile(file, JSON.stringify(doc));
      const accepted = await exportPdf({ docId: doc.id, preset: 'imprimeur', documentsDir: dir, baseUrl });
      expect(accepted.check?.ok, accepted.check?.errors.join(' ; ')).toBe(true);
      expect(accepted.check?.stats.smallText).toContainEqual(expect.objectContaining({ exception: true }));
    }));
  }, 300_000);

  it('calque imprimable masqué : l’export imprimeur demande confirmation, et chaque export le signale (B3)', async () => {
    await withTempDocuments(async (dir) => withServer(dir, async (baseUrl) => {
      const doc = await writePrintDoc(dir);
      doc.layers.push({ id: 'photos', name: 'Photos', visible: false, locked: false, printable: true, color: '#999999' });
      doc.objects.photo.layerId = 'photos';
      doc.objects['photo-cmjn'].layerId = 'photos';
      await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc));
      const refused = await exportPdf({ docId: doc.id, preset: 'imprimeur', documentsDir: dir, baseUrl }).catch((e) => e);
      expect(refused.message).toMatch(/Calque imprimable « Photos » masqué : 2 objets ne seront pas imprimés/);
      expect(refused.details).toMatchObject({ reason: 'hidden-layers', confirm: ['hidden-layers'] });
      const confirmed = await exportPdf({ docId: doc.id, preset: 'imprimeur', documentsDir: dir, confirmHiddenLayers: true, baseUrl });
      expect(confirmed.check?.ok).toBe(true);
      expect(confirmed.warnings).toContainEqual({ kind: 'hidden-layers', message: 'Calque imprimable « Photos » masqué : 2 objets absents du PDF' });
      expect(confirmed.check?.stats.images).toEqual([]);
      const rgb = await exportPdf({ docId: doc.id, preset: 'rvb', documentsDir: dir, baseUrl });
      expect(rgb.warnings.map((w) => w.kind)).toContain('hidden-layers');
    }));
  }, 300_000);

  it('les exports RVB et e-mail reprennent en avertissement les erreurs rouges du contrôle en amont (B9)', async () => {
    await withTempDocuments(async (dir) => withServer(dir, async (baseUrl) => {
      const doc = minimalDoc();
      doc.id = 'exces';
      // Titre en excès : sa dernière ligne déborde sur le texte voisin dans le PDF.
      doc.objects.t1.h = 2;
      await mkdir(path.join(dir, doc.id), { recursive: true });
      await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc));
      for (const preset of ['rvb', 'email']) {
        const result = await exportPdf({ docId: doc.id, preset, documentsDir: dir, baseUrl });
        expect(result.warnings, preset).toContainEqual(expect.objectContaining({ kind: 'preflight', message: expect.stringMatching(/^Contrôle en amont : Texte en excès : « Votre atelier, pour vous\. » dépasse de/) }));
      }
      await expect(exportPdf({ docId: doc.id, preset: 'imprimeur', documentsDir: dir, baseUrl })).rejects.toThrow(/Texte en excès/);
    }));
  }, 300_000);
});

describe('préréglages', () => {
  it('une norme autre que PDF/X-4 est refusée au chargement, avec un message clair (A6)', async () => {
    await withTempDocuments(async (dir) => {
      const presets = JSON.parse(await readFile(PRESETS_FILE, 'utf8'));
      presets.presets.imprimeur.standard = 'PDF/X-1a:2001';
      const file = path.join(dir, 'presets.json');
      await writeFile(file, JSON.stringify(presets));
      expect(() => loadPresets(file)).toThrow(/Préréglage « imprimeur » \(presets\.json\) : norme « PDF\/X-1a:2001 » non prise en charge\. Seule PDF\/X-4 est produite/);
      expect(loadPresets().presets.imprimeur.standard).toBe('PDF/X-4');
    });
  });
});
