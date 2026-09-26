// Recadrage de la photo dans sa forme (tâche 3.1) : double-clic, glisser, poignées, molette ; la photo
// ne laisse jamais de vide en Remplir ; tout le recadrage s'annule d'un seul Ctrl+Z.
import { describe, expect, it } from 'vitest';
import { constrainCover, leavesGap, zoomImageAt } from '../src/model/images';
import type { FrameObject } from '../src/model/types';
import { copyExample, dragFrom, openEditor, press, readSavedDocument, saveNow, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { docWithFrames, dropShape, frame, writeAsset } from './helpers/images';

describe('recadrage : calculs (3.1)', () => {
  it('une photo contrainte en Remplir couvre toujours le cadre', () => {
    const f = { w: 60, h: 40 };
    // Trop petite, décalée : agrandie autour de son centre puis recalée.
    const b = constrainCover({ x: 10, y: 5, w: 30, h: 15 }, f.w, f.h);
    expect(leavesGap(b, f.w, f.h)).toBe(false);
    expect(b.w / b.h).toBeCloseTo(2, 9);
    // Poussée trop loin à gauche : bord droit recalé sur le cadre.
    const c = constrainCover({ x: -50, y: 0, w: 80, h: 40 }, f.w, f.h);
    expect(c).toEqual({ x: -20, y: 0, w: 80, h: 40 });
    // Zoom autour d'un point : ce point reste fixe.
    const z = zoomImageAt({ x: -10, y: 0, w: 80, h: 40 }, 2, { x: 30, y: 20 });
    expect(z).toEqual({ x: -50, y: -20, w: 160, h: 80 });
  });
});

describe('recadrer la photo dans sa forme (3.1)', () => {
  it('double-clic, glisser, poignée, molette ; jamais de vide en Remplir ; un seul Ctrl+Z annule tout', async () => {
    await withTempDocuments(async (dir) => {
      const asset = await writeAsset(dir, 'essai', 'paysage.jpg', 1600, 800);
      // Photo 2:1 dans un cadre 3:2 en Remplir : 80 × 40 mm, 10 mm de débord à gauche et à droite.
      const goutte = frame('f1', 40, 40, 60, 40, { shape: dropShape(), image: { assetId: asset.id, fit: 'fill', x: -10, y: 0, w: 80, h: 40, cover: true } });
      await writeDocument(dir, docWithFrames([goutte], [asset]));
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'essai', { zoom: 1, centerOn: 'f1' });
          const image = () => page.evaluate(() => (window.__editor!.getState().doc!.objects.f1 as FrameObject).image!);
          const depth = () => page.evaluate(() => window.__editor!.getState().history.depth);
          const before = await image();
          const depth0 = await depth();
          const center = await page.evaluate(() => {
            const b = window.__editor!.objectClientBox('f1');
            return { x: b.x + b.w / 2, y: b.y + b.h * 0.7 };
          });

          // Double-clic : mode recadrage, photo entière en transparence autour de la forme.
          await page.mouse.click(Math.round(center.x), Math.round(center.y), { count: 2 });
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().mode?.id)).toBe('crop');
          expect(await page.$('[data-crop-overlay] image')).not.toBeNull();
          expect(await page.$$eval('.editor-crop-moveable .moveable-control[data-direction]', (els) => els.length)).toBeGreaterThanOrEqual(4);

          // Glisser de 30 mm vers la droite : la photo s'arrête au bord (x = 0), aucun vide.
          await dragFrom(page, center, 30, 0);
          let img = await image();
          expect(img.x).toBeCloseTo(0, 4);
          expect(img.fit).toBe('custom');
          expect(img.cover).toBe(true);
          expect(leavesGap(img, 60, 40)).toBe(false);

          // Glisser de 50 mm vers la gauche : bord droit calé, toujours pas de vide.
          await dragFrom(page, center, -50, 0);
          img = await image();
          expect(img.x).toBeCloseTo(-20, 4);
          expect(leavesGap(img, 60, 40)).toBe(false);

          // Molette : zoom avant autour du pointeur (la photo grandit, le point sous le pointeur reste fixe).
          const ppiBefore = await page.$eval('[data-crop-ppi]', (el) => el.textContent);
          await page.mouse.move(Math.round(center.x), Math.round(center.y));
          await page.mouse.wheel({ deltaY: -300 });
          await settle(page);
          img = await image();
          expect(img.w).toBeGreaterThan(80 * 1.3);
          expect(img.h / img.w).toBeCloseTo(0.5, 6);
          // Résolution effective recalculée au recadrage.
          expect(await page.$eval('[data-crop-ppi]', (el) => el.textContent)).not.toBe(ppiBefore);

          // Molette : zoom arrière poussé à l'extrême : bloqué à la taille qui couvre la forme.
          for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: 400 });
          await settle(page);
          img = await image();
          expect(img.h).toBeCloseTo(40, 3);
          expect(leavesGap(img, 60, 40)).toBe(false);

          // Poignée d'angle tirée vers l'intérieur : la photo ne peut pas devenir plus petite que la forme.
          const handle = await page.$eval('.editor-crop-moveable .moveable-control[data-direction="se"]', (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await dragFrom(page, handle, -25, -12);
          img = await image();
          expect(leavesGap(img, 60, 40)).toBe(false);
          // Poignée tirée vers l'extérieur : la photo grandit, proportions gardées.
          const handle2 = await page.$eval('.editor-crop-moveable .moveable-control[data-direction="se"]', (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await dragFrom(page, handle2, 20, 10);
          img = await image();
          expect(img.w).toBeGreaterThan(90);
          expect(img.h / img.w).toBeCloseTo(0.5, 3);
          expect(leavesGap(img, 60, 40)).toBe(false);

          // Aucune étape d'annulation pendant le recadrage : un seul geste.
          expect(await depth()).toBe(depth0);
          await press(page, 'Escape');
          expect(await page.evaluate(() => window.__editor!.getState().mode)).toBeNull();
          expect(await page.$('[data-crop-overlay]')).toBeNull();
          expect(await depth()).toBe(depth0 + 1);
          const cropped = await image();

          // Ctrl+Z : tout le recadrage disparaît d'un coup.
          await press(page, 'Control', 'z');
          expect(await image()).toEqual(before);
          await press(page, 'Control', 'y');
          expect(await image()).toEqual(cropped);

          // Second recadrage validé par un clic en dehors, puis enregistré.
          await page.mouse.click(Math.round(center.x), Math.round(center.y), { count: 2 });
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().mode?.id)).toBe('crop');
          await dragFrom(page, center, 0, 8);
          // Recadrage laissé en cours : son aperçu est sur le disque 2 s après la dernière retouche (un
          // onglet fermé à ce moment ne perd rien), sans étape d'annulation de plus.
          const inProgress = await image();
          const depthInProgress = await depth();
          await new Promise((r) => setTimeout(r, 2600));
          expect(await page.evaluate(() => window.__editor!.getState().mode?.id)).toBe('crop');
          expect(((await readSavedDocument(dir, 'essai')).objects.f1 as FrameObject).image).toEqual(inProgress);
          expect(await depth()).toBe(depthInProgress);
          const vp = await page.$eval('[data-workspace-viewport]', (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + 30, y: r.y + r.height - 30 };
          });
          await page.mouse.click(vp.x, vp.y);
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().mode)).toBeNull();
          await saveNow(page);
          const saved = (await readSavedDocument(dir, 'essai')).objects.f1 as FrameObject;
          expect(saved.image!.fit).toBe('custom');
          expect(leavesGap(saved.image!, 60, 40)).toBe(false);

          // Échap sans rien changer : aucune étape ajoutée.
          const d1 = await depth();
          await page.mouse.click(Math.round(center.x), Math.round(center.y), { count: 2 });
          await settle(page);
          await press(page, 'Escape');
          expect(await depth()).toBe(d1);

          // Ctrl+Z pendant le recadrage : abandon de ce recadrage seulement.
          await page.mouse.click(Math.round(center.x), Math.round(center.y), { count: 2 });
          await settle(page);
          const beforeCancel = await image();
          await dragFrom(page, center, 5, 0);
          await press(page, 'Control', 'z');
          expect(await page.evaluate(() => window.__editor!.getState().mode)).toBeNull();
          expect(await image()).toEqual(beforeCancel);
          expect(await depth()).toBe(d1);
        },
        { documentsDir: dir },
      );
    });
  });
});

describe('recadrer dans le dépliant d’exemple (3.1)', () => {
  it('double-clic sur une photo de bandeau, sous son trait de vague, et sur la goutte de couverture : recadrage', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1.5, centerOn: 'int-f1' });
          // Le dépliant d'exemple porte ses photos provisoires : le bandeau et la goutte ont chacun la leur.
          const photos = await page.evaluate(() => ['int-f1', 'ext-f2'].map((f) => (window.__editor!.getState().doc!.objects[f] as FrameObject).image?.assetId));
          expect(photos.every(Boolean)).toBe(true);
          for (const [frameId, fy] of [
            ['int-f1', 0.35],
            ['ext-f2', 0.7],
          ] as const) {
            await page.evaluate((f) => window.__editor!.getState().centerOn([f]), frameId);
            await settle(page);
            const b = await page.evaluate((f) => window.__editor!.objectClientBox(f), frameId);
            await page.mouse.click(Math.round(b.x + b.w / 2), Math.round(b.y + b.h * fy), { count: 2 });
            await settle(page);
            expect(await page.evaluate(() => window.__editor!.getState().mode)).toEqual({ id: 'crop', target: frameId });
            expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual([frameId]);
            await press(page, 'Escape');
          }
        },
        { documentsDir: dir },
      );
    });
  });
});
