// Outil plume (tâche 3.5) : tracer point par point (clic = sommet, clic-glisser = courbe), fermer sur le
// premier point, éditer points et poignées ; la forme dessinée reçoit une photo comme la goutte.
import { describe, expect, it } from 'vitest';
import { contoursToPath, pathToContours, parsePath } from '../src/model/shapes';
import type { FrameObject } from '../src/model/types';
import { dragFrom, openEditor, pageToClient, press, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { docWithFrames, dropFile, makePhoto, waitFramePhoto } from './helpers/images';

describe('plume : contours (3.5)', () => {
  it('un tracé se découpe en points et poignées puis se reconstruit à l’identique', () => {
    const d = 'M0 0L10 0C15 0 20 5 20 10L20 20Q10 25 0 20Z';
    const contours = pathToContours(d);
    expect(contours).toHaveLength(1);
    expect(contours[0].closed).toBe(true);
    expect(contours[0].nodes.map((n) => n.p)).toEqual([[0, 0], [10, 0], [20, 10], [20, 20], [0, 20]]);
    expect(contours[0].nodes[1].out).toEqual([15, 0]);
    // La quadratique devient une cubique équivalente.
    const back = parsePath(contoursToPath(contours));
    expect(back.filter((c) => c.c === 'C')).toHaveLength(2);
    expect(back.at(-1)).toEqual({ c: 'Z' });
  });
});

describe('outil plume (3.5)', () => {
  it('tracer, fermer, y déposer une photo, puis éditer un point en une seule étape', async () => {
    await withTempDocuments(async (dir) => {
      await writeDocument(dir, docWithFrames([]));
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'essai', { zoom: 1, centerOn: 'p-int' });
          const P = (x: number, y: number) => pageToClient(page, 'p-int', x, y);
          const click = async (x: number, y: number) => {
            const p = await P(x, y);
            await page.mouse.click(Math.round(p.x), Math.round(p.y));
            await settle(page);
          };
          const state = () => page.evaluate(() => window.__editor!.getState());

          await press(page, 'p');
          expect((await state()).tool).toBe('pen');

          // Moins de 3 points puis Échap : rien n'est créé.
          await click(20, 20);
          await click(40, 20);
          await press(page, 'Escape');
          expect((await state()).doc!.pages[1].children).toHaveLength(0);

          // Tracé : sommet, point lisse (clic-glisser), deux sommets, puis clic sur le premier point.
          await press(page, 'p');
          await click(100, 50);
          await dragFrom(page, await P(150, 50), 10, 10, { steps: 6 });
          await click(150, 110);
          await click(100, 110);
          expect(await page.$$eval('[data-pen-preview] [data-pen-anchor]', (els) => els.length)).toBe(4);
          await click(100, 50);

          let s = await state();
          expect(s.tool).toBe('select');
          expect(s.doc!.pages[1].children).toHaveLength(1);
          const id = s.doc!.pages[1].children[0];
          const shape = s.doc!.objects[id] as FrameObject;
          expect(s.selection).toEqual([id]);
          expect(s.history.undoLabel).toBe('Tracer une forme');
          expect(shape.type).toBe('frame');
          expect(shape.shape).toMatchObject({ kind: 'path', preset: 'plume' });
          expect(shape.shape.kind === 'path' && shape.shape.d).toMatch(/C/);
          // Boîte = contour exact : de 100 mm à 150 mm + la bosse de la courbe (qui monte aussi un peu
          // au-dessus de 50 mm, la poignée d'entrée du point lisse pointant vers le haut-gauche), jusqu'à 110 mm.
          expect(shape.x).toBeCloseTo(100, 1);
          expect(shape.y).toBeLessThan(50);
          expect(shape.y).toBeGreaterThan(40);
          expect(shape.y + shape.h).toBeCloseTo(110, 0);
          expect(shape.x + shape.w).toBeGreaterThan(150);

          // Elle reçoit une photo comme la goutte.
          const box = await page.evaluate((i) => window.__editor!.objectClientBox(i), id);
          await dropFile(page, { x: box.x + box.w * 0.4, y: box.y + box.h / 2 }, { name: 'plume.jpg', type: 'image/jpeg', data: await makePhoto(1200, 900) });
          await waitFramePhoto(page, id);
          s = await state();
          const withPhoto = s.doc!.objects[id] as FrameObject;
          expect(withPhoto.image?.fit).toBe('fill');
          expect(await page.$eval(`[data-page-id] [data-obj-id="${id}"] clipPath path`, (el) => el.getAttribute('d'))).toBe(withPhoto.shape.kind === 'path' ? withPhoto.shape.d : '');
          const photoOnPage = { x: withPhoto.x + withPhoto.image!.x, y: withPhoto.y + withPhoto.image!.y };

          // Édition des points : « Modifier les points », glisser le premier point de 10 mm vers la gauche.
          const depth = s.history.depth;
          await page.click('[data-action="edit-points"]');
          await settle(page);
          expect((await state()).mode?.id).toBe('pen-edit');
          const anchor = await page.$eval('[data-pen-edit] [data-pen-anchor="0"]', (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await dragFrom(page, anchor, -10, 0, { steps: 5 });
          // Une poignée du point lisse, tirée : la courbe change.
          const handle = await page.$eval('[data-pen-edit] [data-pen-handle="1-out"]', (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await dragFrom(page, handle, 5, 5, { steps: 5 });
          await press(page, 'Escape');
          s = await state();
          expect(s.mode).toBeNull();
          expect(s.history.depth).toBe(depth + 1);
          const edited = s.doc!.objects[id] as FrameObject;
          expect(edited.x).toBeCloseTo(90, 0);
          // La photo n'a pas bougé sur la page : seule la découpe change.
          expect(edited.x + edited.image!.x).toBeCloseTo(photoOnPage.x, 3);
          expect(edited.y + edited.image!.y).toBeCloseTo(photoOnPage.y, 3);

          // Un seul Ctrl+Z défait toute l'édition.
          await press(page, 'Control', 'z');
          expect((await state()).doc!.objects[id]).toEqual(withPhoto);

          // Entrée ferme un tracé ; Retour arrière retire le dernier point.
          await press(page, 'p');
          await click(200, 50);
          await click(250, 50);
          await click(250, 100);
          await click(300, 200);
          await press(page, 'Backspace');
          await press(page, 'Enter');
          s = await state();
          expect(s.doc!.pages[1].children).toHaveLength(2);
          const tri = s.doc!.objects[s.doc!.pages[1].children[1]] as FrameObject;
          expect(tri.x).toBeCloseTo(200, 0);
          expect(tri.w).toBeCloseTo(50, 0);
          expect(tri.h).toBeCloseTo(50, 0);
        },
        { documentsDir: dir },
      );
    });
  });
});
