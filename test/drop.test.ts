// Déposer une photo depuis l'explorateur (tâche 3.2) : sur la goutte, elle y est découpée en moins de 2 s ;
// l'original est gardé tel quel dans assets/originals/ ; sur un hexagone (3.4) comme sur la goutte ; sur le
// vide, un cadre à la taille de la photo (300 ppi) ; un format refusé est signalé.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameBoxForAsset } from '../src/editor/dropImage';
import { leavesGap } from '../src/model/images';
import type { Asset, FrameObject } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { openEditor, pageToClient, readSavedDocument, saveNow, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { docWithFrames, dropFile, dropShape, frame, hexagonShape, makePhoto, readOriginal, sha256, waitFramePhoto } from './helpers/images';

describe('dépôt : cadre créé sur le vide (3.2)', () => {
  it('à la taille de la photo à 300 ppi, ramené à la face et centré sur le point de dépôt', () => {
    const doc = minimalDoc();
    // 1 200 × 900 px à 300 ppi : 101,6 × 76,2 mm.
    const box = frameBoxForAsset(doc, { width: 1200, height: 900 }, { x: 100, y: 100 });
    expect(box.w).toBeCloseTo(101.6, 6);
    expect(box.h).toBeCloseTo(76.2, 6);
    expect(box.x).toBeCloseTo(100 - 50.8, 6);
    // Photo immense : réduite à la face (303 × 216 mm), proportions gardées, jamais hors de la face.
    const big = frameBoxForAsset(doc, { width: 12000, height: 6000 }, { x: 290, y: 5 });
    expect(big.w).toBeCloseTo(303, 6);
    expect(big.h).toBeCloseTo(151.5, 6);
    expect(big.x).toBe(0);
    expect(big.y).toBe(0);
  });
});

describe('déposer une photo dans une forme (3.2, 3.4)', () => {
  it('goutte en moins de 2 s, original intact ; hexagone ; vide ; TIFF ; format refusé', async () => {
    await withTempDocuments(async (dir) => {
      const doc = docWithFrames([
        frame('goutte', 150, 30, 60, 78, { shape: dropShape(), fill: { swatch: 'bleu' } }),
        frame('hexa', 220, 30, 60, 69.28, { shape: hexagonShape(), fill: { swatch: 'bleu' } }),
      ]);
      await writeDocument(dir, doc);
      const jpeg = await makePhoto(2400, 1600, 'jpeg');
      const tiff = await makePhoto(900, 600, 'tiff');
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'essai');
          const center = (id: string) =>
            page.evaluate((i) => {
              const b = window.__editor!.objectClientBox(i);
              return { x: b.x + b.w / 2, y: b.y + b.h * 0.65 };
            }, id);
          const state = () => page.evaluate(() => window.__editor!.getState().doc!);

          // --- Sur la goutte : affichée découpée tout de suite (aperçu local, clipPath de la goutte), en moins
          // de 2 s même sur une machine chargée ; puis envoyée, placée en Remplir avec l'aperçu du serveur.
          await page.evaluate(() => {
            (window as unknown as { __previewAt: Promise<number> }).__previewAt = new Promise((resolve) => {
              const seen = async () => {
                const img = document.querySelector('[data-drop-preview="goutte"] image');
                if (!img) return false;
                observer.disconnect();
                const probe = new Image();
                probe.src = img.getAttribute('href')!;
                await probe.decode();
                resolve(performance.now());
                return true;
              };
              const observer = new MutationObserver(() => void seen());
              observer.observe(document.body, { childList: true, subtree: true });
            });
          });
          const t0 = await dropFile(page, await center('goutte'), { name: 'Équipe réunion.jpg', type: 'image/jpeg', data: jpeg });
          const shownAt = await page.evaluate(() => (window as unknown as { __previewAt: Promise<number> }).__previewAt);
          expect(shownAt - t0).toBeLessThan(2000);
          const t1 = await waitFramePhoto(page, 'goutte');
          expect(t1 - t0).toBeLessThan(10_000);
          // L'aperçu local disparaît une fois la vraie photo en place.
          await page.waitForFunction(() => !document.querySelector('[data-drop-preview]'));
          let d = await state();
          const g = d.objects.goutte as FrameObject;
          expect(g.image?.fit).toBe('fill');
          expect(g.image?.cover).toBe(true);
          expect(leavesGap(g.image!, g.w, g.h)).toBe(false);
          const asset = d.assets.find((a) => a.id === g.image!.assetId) as Asset;
          expect(asset).toMatchObject({ width: 2400, height: 1600 });
          expect(asset.original).toMatch(/^assets\/originals\/equipe-reunion\.jpg$/);
          expect(asset.placeholder).toBeUndefined();
          // Découpée par la forme de la goutte (clipPath vectoriel), sélectionnée, une seule étape.
          expect(await page.$eval('[data-page-id] [data-obj-id="goutte"] clipPath path', (el) => el.getAttribute('d'))).toContain('C');
          expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual(['goutte']);
          expect(await page.evaluate(() => window.__editor!.getState().history.undoLabel)).toBe('Placer une photo');
          // Original intact : même empreinte que le fichier déposé.
          expect(sha256(await readOriginal(dir, 'essai', asset))).toBe(sha256(jpeg));

          // --- Sur l'hexagone : même chose (toute forme est un cadre).
          await dropFile(page, await center('hexa'), { name: 'photo.tif', type: 'image/tiff', data: tiff });
          await waitFramePhoto(page, 'hexa');
          d = await state();
          const h = d.objects.hexa as FrameObject;
          expect(h.image?.fit).toBe('fill');
          expect(h.shape).toMatchObject({ kind: 'path', polygon: { sides: 6 } });
          const tifAsset = d.assets.find((a) => a.id === h.image!.assetId)!;
          expect(tifAsset.print).toMatch(/\.png$/);
          expect(sha256(await readOriginal(dir, 'essai', tifAsset))).toBe(sha256(tiff));
          expect(await page.$eval('[data-page-id] [data-obj-id="hexa"] clipPath path', (el) => el.getAttribute('d'))).toBe(h.shape.kind === 'path' ? h.shape.d : '');

          // --- Sur le vide : un cadre rectangulaire à la taille de la photo (300 ppi), sur la face visée.
          const empty = await pageToClient(page, 'p-int', 150, 100);
          const png = await makePhoto(600, 450, 'png');
          await dropFile(page, empty, { name: 'vide.png', type: 'image/png', data: png });
          await page.waitForFunction(() => window.__editor!.getState().doc!.pages[1].children.length === 1);
          d = await state();
          const created = d.objects[d.pages[1].children[0]] as FrameObject;
          expect(created.type).toBe('frame');
          expect(created.shape).toEqual({ kind: 'rect' });
          expect(created.w).toBeCloseTo((600 / 300) * 25.4, 3);
          expect(created.h).toBeCloseTo((450 / 300) * 25.4, 3);
          expect(created.x + created.w / 2).toBeCloseTo(150, 0);
          expect(created.image).toMatchObject({ fit: 'fill', x: 0, y: 0 });
          await waitFramePhoto(page, created.id);

          // --- Une photo du panneau Images glissée sur la goutte : placée sans nouvel envoi.
          const assetsBefore = (await state()).assets.length;
          await page.evaluate(
            (x, y, assetId) => {
              const dt = new DataTransfer();
              dt.setData('application/x-fluidprint-asset', assetId);
              const target = document.elementFromPoint(x, y)!;
              for (const kind of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
            },
            Math.round((await center('goutte')).x),
            Math.round((await center('goutte')).y),
            tifAsset.id,
          );
          await settle(page);
          d = await state();
          expect((d.objects.goutte as FrameObject).image?.assetId).toBe(tifAsset.id);
          expect(d.assets.length).toBe(assetsBefore);

          // --- Format refusé : message, rien d'ajouté.
          const count = (await state()).assets.length;
          await dropFile(page, await center('goutte'), { name: 'notes.txt', type: 'text/plain', data: Buffer.from('bonjour') });
          await page.waitForSelector('[data-drop-message="error"]');
          expect(await page.$eval('[data-drop-message="error"]', (el) => el.textContent)).toMatch(/JPG, PNG, TIFF ou WebP/);
          expect((await state()).assets.length).toBe(count);

          // Le document enregistré garde tout ; les originaux sont bien sur le disque.
          await saveNow(page);
          const saved = await readSavedDocument(dir, 'essai');
          expect(saved.assets).toHaveLength(3);
          const files = await readdir(path.join(dir, 'essai', 'assets', 'originals'));
          expect(files.sort()).toEqual(['equipe-reunion.jpg', 'photo.tif', 'vide.png']);
          await settle(page);
        },
        { documentsDir: dir },
      );
    });
  });
});
