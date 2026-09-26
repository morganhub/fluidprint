// Photos : résolution effective et alertes (3.6), panneau Images, photos provisoires tirées d'un PDF (3.7).
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeholderWarnings, exportPdf } from '../server/export';
import {
  assetUsages,
  leavesGap,
  framePpi,
  imagePpi,
  placeholderFrames,
  placeImage,
  ppiLevel,
  refitFrameImage,
  relinkImage,
  zoomImageAt,
} from '../src/model/images';
import type { Asset, FrameObject, LayoutDocument } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { EXAMPLE_FILE, copyExample, openEditor, readSavedDocument, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { docWithFrames, frame, makePhoto, makePhotosPdf, makeSyntheticPhoto, runExtract, writeAsset } from './helpers/images';

const PHOTO_FRAMES = ['ext-f1', 'ext-f2', 'int-f1', 'int-f2', 'int-f3'];

describe('résolution effective (3.6)', () => {
  it('une photo de 1 200 px dans un cadre de 103 mm : 296 ppi', () => {
    const asset = { id: 'a', width: 1200, height: 800 };
    const image = placeImage({ w: 103, h: 50 }, asset, 'fill');
    expect(image.w).toBeCloseTo(103, 6);
    expect(Math.round(imagePpi(image, asset))).toBe(296);
    // Recalculée au recadrage : zoomée deux fois, la photo n'a plus que la moitié de ses pixels par pouce.
    expect(Math.round(imagePpi(zoomImageAt(image, 2, { x: 0, y: 0 }), asset))).toBe(148);
  });

  it('seuils : orange sous 250 ppi, rouge sous 150 ppi', () => {
    expect(ppiLevel(300)).toBe('ok');
    expect(ppiLevel(250)).toBe('ok');
    expect(ppiLevel(249.9)).toBe('warn');
    expect(ppiLevel(150)).toBe('warn');
    expect(ppiLevel(149.9)).toBe('error');
  });

  it('usages, remplacement et placements Remplir / Ajuster / Centrer', () => {
    const a: Asset = { id: 'a', kind: 'image', name: 'a.jpg', original: 'assets/originals/a.jpg', width: 1200, height: 800 };
    const f = frame('f', 0, 0, 103, 50, { image: placeImage({ w: 103, h: 50 }, a) });
    const doc = docWithFrames([f], [a]);
    const usage = assetUsages(doc).get('a')!;
    expect(usage).toEqual([{ frameId: 'f', name: 'Cadre f', pageId: 'p-ext', pageName: 'Extérieur', ppi: expect.closeTo(295.92, 2), level: 'ok' }]);
    expect(framePpi(doc, f)?.level).toBe('ok');
    const fit = refitFrameImage(f, f.image!, a, 'fit');
    expect(fit.h).toBeCloseTo(50, 6);
    expect(fit.cover).toBeUndefined();
    const center = refitFrameImage(f, f.image!, a, 'center');
    expect(center.w).toBeCloseTo(101.6, 6);
    // Remplacée par une photo deux fois plus grande : même place, résolution doublée.
    const big = { id: 'b', width: 2400, height: 1600 };
    const relinked = relinkImage(f, f.image!, big);
    expect(relinked.assetId).toBe('b');
    expect(Math.round(imagePpi(relinked, big))).toBe(592);
  });
});

describe('photos provisoires tirées d’un PDF (3.7)', () => {
  it('les photos d’un PDF garnissent les 5 cadres dans l’ordre ; relançable ; une vraie photo reste ; l’export rvb avertit en nommant les cadres', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      // Un PDF de mise en page : cinq photos synthétiques (la troisième détourée, avec son masque) et, en
      // deuxième position, un décor trop petit pour être une photo.
      const sizes: [number, number, boolean][] = [
        [260, 180, false],
        [300, 380, false],
        [420, 210, true],
        [430, 215, false],
        [440, 220, false],
      ];
      const photos = await Promise.all(sizes.map(([w, h, alpha], i) => makeSyntheticPhoto(w, h, { hue: 40 * i, alpha, noise: true })));
      const decor = await makeSyntheticPhoto(80, 40, { hue: 300 });
      const pdf = path.join(dir, 'mise-en-page.pdf');
      await makePhotosPdf(pdf, [photos[0], decor, ...photos.slice(1)]);

      const out = runExtract(dir, id, pdf);
      expect(out).toMatch(/5 photo\(s\) provisoire\(s\) ajoutée\(s\)/);
      expect(out).toMatch(/5 cadre\(s\) garni\(s\)/);
      expect(out).toMatch(/ignorées \(trop petites pour être des photos\) : 80 × 40 px/);
      const doc = await readSavedDocument(dir, id);
      expect(validateDocument(doc)).toMatchObject({ ok: true });
      // Dans l'ordre : première photo du PDF dans le premier cadre (pages, puis ordre d'empilement), etc.
      for (const [i, fid] of PHOTO_FRAMES.entries()) {
        const f = doc.objects[fid] as FrameObject;
        const asset = doc.assets.find((a) => a.id === f.image?.assetId)!;
        expect(asset).toMatchObject({ id: `img-provisoire-${i + 1}`, original: `assets/originals/provisoire-${i + 1}.png`, width: sizes[i][0], height: sizes[i][1], placeholder: true });
        expect(f.image).toMatchObject({ fit: 'fill', cover: true });
        expect(leavesGap(f.image!, f.w, f.h)).toBe(false);
        expect((await stat(path.join(dir, id, asset.original))).size).toBeGreaterThan(10_000);
      }
      // La photo détourée garde son masque (canal alpha).
      const png = await readFile(path.join(dir, id, 'assets/originals/provisoire-3.png'));
      expect(png[25]).toBe(6); // type de couleur PNG 6 = RVBA
      // Les autres objets n'ont pas bougé.
      const original = JSON.parse(await readFile(EXAMPLE_FILE, 'utf8')) as LayoutDocument;
      for (const [oid, obj] of Object.entries(original.objects)) if (!PHOTO_FRAMES.includes(oid)) expect(doc.objects[oid]).toEqual(obj);

      // Relancé : même résultat ; un cadre qui a reçu une vraie photo la garde, les autres cadres prennent les
      // photos dans l'ordre (la cinquième reste disponible dans le panneau Images).
      const real = await writeAsset(dir, id, 'vraie.jpg', 3000, 2000);
      const edited = structuredClone(doc);
      edited.assets.push(real);
      (edited.objects['int-f2'] as FrameObject).image = placeImage(edited.objects['int-f2'] as FrameObject, real);
      await writeDocument(dir, edited);
      expect(runExtract(dir, id, pdf)).toMatch(/4 cadre\(s\) garni\(s\)/);
      const again = await readSavedDocument(dir, id);
      const photoOf = (d: LayoutDocument, fid: string) => (d.objects[fid] as FrameObject).image!.assetId;
      expect(photoOf(again, 'int-f2')).toBe(real.id);
      expect(['ext-f1', 'ext-f2', 'int-f1', 'int-f3'].map((fid) => photoOf(again, fid))).toEqual(['img-provisoire-1', 'img-provisoire-2', 'img-provisoire-3', 'img-provisoire-4']);
      expect(again.assets.filter((a) => a.placeholder).map((a) => a.id).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `img-provisoire-${n}`));
      expect(placeholderFrames(again).map((f) => f.id).sort()).toEqual(['ext-f1', 'ext-f2', 'int-f1', 'int-f3']);

      // Sans --fill : les photos entrent dans le document sans changer de cadre ; une photo réécrite est
      // recadrée en Remplir là où elle servait déjà (plus petite que la précédente, sans laisser de vide).
      const smaller = path.join(dir, 'petites.pdf');
      await makePhotosPdf(smaller, [await makeSyntheticPhoto(200, 150, { hue: 10, noise: true })]);
      expect(runExtract(dir, id, smaller, { fill: false })).not.toMatch(/garni/);
      const third = await readSavedDocument(dir, id);
      expect(third.assets.find((a) => a.id === 'img-provisoire-1')).toMatchObject({ width: 200, height: 150 });
      const f1 = third.objects['ext-f1'] as FrameObject;
      expect(f1.image!.assetId).toBe('img-provisoire-1');
      expect(leavesGap(f1.image!, f1.w, f1.h)).toBe(false);
      expect(photoOf(third, 'int-f3')).toBe('img-provisoire-4');

      // Avertissement de l'export : nomme chaque cadre concerné.
      const [warning] = placeholderWarnings(doc);
      expect(warning.frames).toHaveLength(5);
      for (const name of ['Photo de couverture (HD)', 'Visuel des ressources en ligne (HD)', 'Photo atelier cuisine (HD)', 'Photo atelier jardin (HD)', 'Photo atelier bois (HD)']) {
        expect(warning.message).toContain(`« ${name} »`);
      }
      await writeDocument(dir, doc);
      const result = await exportPdf({ docId: id, preset: 'rvb', documentsDir: dir });
      const placeholder = result.warnings.find((w) => w.kind === 'placeholder-image');
      expect(placeholder?.message).toMatch(/^5 photos provisoires à remplacer/);
      expect(result.pages).toBe(2);
    });
  }, 300_000);
});

describe('badges, filigrane et panneau Images (3.6, 3.7)', () => {
  it('badge orange sous 250 ppi, rouge sous 150 ; 296 ppi affiché ; filigrane à l’écran seulement ; Remplacer', async () => {
    await withTempDocuments(async (dir) => {
      const a = await writeAsset(dir, 'essai', 'nette.jpg', 1200, 800);
      const b = await writeAsset(dir, 'essai', 'moyenne.jpg', 800, 800);
      const c = await writeAsset(dir, 'essai', 'provisoire.jpg', 400, 400, { placeholder: true });
      const doc = docWithFrames(
        [
          frame('nette', 20, 100, 103, 50, { image: placeImage({ w: 103, h: 50 }, a) }), // 296 ppi
          frame('moyenne', 140, 30, 90, 90, { image: placeImage({ w: 90, h: 90 }, b) }), // 226 ppi
          frame('floue', 240, 60, 80, 80, { image: placeImage({ w: 80, h: 80 }, c) }), // 127 ppi, photo provisoire
        ],
        [a, b, c],
      );
      await writeDocument(dir, doc);
      const id = await copyExample(dir);

      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'essai');
          const badges = await page.$$eval('[data-ppi-badge]', (els) => els.map((el) => [el.getAttribute('data-frame-id'), el.getAttribute('data-ppi-badge'), el.textContent]));
          expect(badges.sort()).toEqual([
            ['floue', 'error', '127 ppi'],
            ['moyenne', 'warn', '226 ppi'],
          ]);
          // Le badge est rouge / orange, lisible à l'écran.
          expect(await page.$eval('[data-ppi-badge="error"]', (el) => getComputedStyle(el).backgroundColor)).toBe('rgb(220, 38, 38)');
          expect(await page.$eval('[data-ppi-badge="warn"]', (el) => getComputedStyle(el).backgroundColor)).toBe('rgb(245, 158, 11)');

          // Propriétés : 296 ppi pour la photo de 1 200 px dans 103 mm.
          await page.evaluate(() => window.__editor!.getState().select(['nette']));
          await settle(page);
          expect(await page.$eval('[data-frame-ppi]', (el) => el.textContent)).toContain('296 ppi');
          expect(await page.$eval('[data-frame-ppi]', (el) => el.getAttribute('data-frame-ppi'))).toBe('ok');

          // Panneau Images : taille d'origine, ppi par cadre, où elle sert.
          await page.click('[data-panel-tab="images"]');
          await settle(page);
          const row = await page.$eval(`[data-asset-row="${a.id}"]`, (el) => el.textContent);
          expect(row).toContain('1200 × 800 px');
          expect(row).toContain('296 ppi');
          expect(await page.$eval(`[data-asset-row="${c.id}"] [data-asset-usage="floue"]`, (el) => el.getAttribute('data-ppi-level'))).toBe('error');
          expect(await page.$(`[data-asset-row="${c.id}"] [data-asset-placeholder]`)).not.toBeNull();

          // Filigrane « provisoire » sur le cadre de la photo provisoire, à l'écran seulement.
          expect(await page.$$eval('[data-page-id] [data-provisional]', (els) => els.map((el) => el.closest('[data-obj-id]')!.getAttribute('data-obj-id')))).toEqual(['floue']);

          // Remplacer : une photo deux fois plus grande, la résolution double partout où elle sert.
          const input = await page.$(`[data-file-input="replace-${b.id}"]`);
          const bigger = path.join(dir, 'moyenne-hd.jpg');
          await writeFile(bigger, await makePhoto(1600, 1600));
          await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(bigger);
          await page.waitForFunction(() => !document.querySelector('[data-ppi-badge="warn"]'));
          const s = await page.evaluate(() => window.__editor!.getState());
          const replaced = s.doc!.objects.moyenne as FrameObject;
          const newAsset = s.doc!.assets.find((x) => x.id === replaced.image!.assetId)!;
          expect(newAsset.width).toBe(1600);
          expect(s.doc!.assets.some((x) => x.id === b.id)).toBe(false);
          expect(Math.round(imagePpi(replaced.image!, newAsset))).toBe(452);
          expect(s.history.undoLabel).toBe('Remplacer une photo');

          // Route d'impression : aucun filigrane, aucun badge.
          const print = await browser.newPage();
          await print.goto(`${url}/print/essai`);
          await print.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
          expect(await print.$('[data-provisional]')).toBeNull();
          expect(await print.$('[data-ppi-badge]')).toBeNull();

          // Le dépliant d'exemple et ses photos provisoires (sous 150 ppi) : filigrane et badge rouge sur les 5 cadres.
          const example = await openEditor(browser, url, id);
          const marked = await example.$$eval('[data-page-id] [data-provisional]', (els) => els.map((el) => el.closest('[data-obj-id]')!.getAttribute('data-obj-id')).sort());
          expect(marked).toEqual(PHOTO_FRAMES);
          const red = await example.$$eval('[data-ppi-badge="error"]', (els) => els.map((el) => el.getAttribute('data-frame-id')).sort());
          expect(red).toEqual(PHOTO_FRAMES);
        },
        { documentsDir: dir },
      );
    });
  });
});
