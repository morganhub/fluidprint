// Plan de travail (tâche 2.3) et critère 1.10 : taille réelle à 100 %, zoom autour du pointeur, vue,
// sélection au clic, Maj+clic, lasso, entrée dans un groupe, objets verrouillés transparents au clic.
import { describe, expect, it } from 'vitest';
import { foldPositions } from '../src/model/format';
import type { LayoutDocument } from '../src/model/types';
import { PX_PER_MM } from '../src/model/units';
import {
  clickAt,
  copyExample,
  openEditor,
  pageToClient,
  press,
  readSavedDocument,
  selection,
  settle,
  withApp,
  withTempDocuments,
} from './helpers/editor';

/** Boîte écran (client) d'un élément de face. */
const faceRect = (id: string) => {
  const r = document.querySelector(`[data-page-id="${id}"]`)!.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

describe('plan de travail (2.3)', () => {
  it('à 100 %, la face mesure sa taille réelle en px CSS et le rabat 97 mm', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      const doc = await readSavedDocument(dir, id);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'p-exterieur' });
          const face = await page.evaluate(faceRect, 'p-exterieur');
          expect(face.width / PX_PER_MM).toBeCloseTo(303, 1);
          expect(face.height / PX_PER_MM).toBeCloseTo(216, 1);
          // Le premier pli de la face extérieure (repère du calque « Repères et notes ») : 97 mm après
          // le trait de coupe, soit 97 × 96 / 25,4 px à l'écran.
          const fold = await page.evaluate(() => document.querySelector('[data-obj-id="ext-rep2"]')!.getBoundingClientRect().left);
          const trimLeft = face.left + doc.format.bleed * PX_PER_MM;
          expect(foldPositions(doc.format, 'exterieur')[0] - doc.format.bleed).toBe(97);
          expect(Math.abs((fold - trimLeft) / PX_PER_MM - 97)).toBeLessThan(0.3);
          expect(await page.$eval('[data-testid="zoom-value"]', (el) => el.textContent)).toBe('100 %');
          // Points d'extension chargés : panneau, sections, outils et raccourcis de base.
          const registries = await page.evaluate(() => window.__editor!.registries());
          // Les fonctions branchées ensuite (Calques, Nuancier, sections…) s'ajoutent : on vérifie le socle.
          expect(registries.panels[0]).toBe('properties');
          expect(registries.propertySections).toEqual(expect.arrayContaining(['position', 'appearance', 'text']));
          expect(registries.tools).toEqual(expect.arrayContaining(['select', 'hand', 'text', 'rect', 'ellipse', 'line', 'frame', 'shape', 'icon', 'qr']));
          expect(registries.shortcuts).toEqual(expect.arrayContaining(['undo', 'redo', 'duplicate', 'group', 'ungroup', 'save', 'help']));

          // Volet de droite, fenêtre de 1600 px : les 7 onglets tiennent dans le volet, sans défilement.
          const tabs = await page.evaluate(() => {
            const list = document.querySelector('[data-panel-tabs]')!;
            const aside = document.querySelector('[data-side-panels]')!.getBoundingClientRect();
            return {
              overflow: list.scrollWidth - list.clientWidth,
              tabs: [...list.querySelectorAll('[data-panel-tab]')].map((el) => {
                const r = el.getBoundingClientRect();
                return { id: el.getAttribute('data-panel-tab'), label: el.getAttribute('aria-label'), inside: r.left >= aside.left - 0.5 && r.right <= Math.min(aside.right, window.innerWidth) + 0.5 };
              }),
            };
          });
          expect(tabs.overflow).toBeLessThanOrEqual(0);
          expect(tabs.tabs.map((t) => t.id)).toEqual(['properties', 'layers', 'swatches', 'styles', 'images', 'preflight', 'versions']);
          expect(tabs.tabs.filter((t) => !t.inside)).toEqual([]);
          expect(tabs.tabs.map((t) => t.label)).toEqual(['Propriétés', 'Calques', 'Nuancier', 'Styles', 'Images', 'Contrôle', 'Versions']);
          // Le nom de l'onglet s'affiche au survol, et en tête du panneau ouvert.
          await page.hover('[data-panel-tab="versions"]');
          await page.waitForFunction(() => [...document.querySelectorAll('[role="tooltip"]')].some((el) => el.textContent === 'Versions'));
          await page.click('[data-panel-tab="versions"]');
          await page.waitForSelector('[data-panel="versions"][data-state="active"]');
          expect(await page.$eval('[data-panel-tab="versions"]', (el) => el.getAttribute('data-state'))).toBe('active');
          expect(await page.$eval('[data-panel-title]', (el) => el.textContent)).toBe('Versions');
        },
        { documentsDir: dir },
      );
    });
  });

  it('zoome autour du pointeur (Ctrl+molette), ajuste à l’écran, déplace la vue (espace + glisser, molette)', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          const anchor = await pageToClient(page, 'p-interieur', 150, 100);
          const at = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
          const worldUnder = () =>
            page.evaluate((p) => {
              const s = window.__editor!.getState();
              const vp = document.querySelector('[data-workspace-viewport]')!.getBoundingClientRect();
              const k = (96 / 25.4) * s.zoom;
              return { x: (p.x - vp.left - s.view.x) / k, y: (p.y - vp.top - s.view.y) / k, zoom: s.zoom };
            }, at);
          const before = await worldUnder();
          await page.mouse.move(at.x, at.y);
          await page.keyboard.down('Control');
          await page.mouse.wheel({ deltaY: -300 });
          await page.keyboard.up('Control');
          await settle(page);
          const after = await worldUnder();
          expect(after.zoom).toBeGreaterThan(before.zoom * 1.5);
          expect(Math.abs(after.x - before.x)).toBeLessThan(0.1);
          expect(Math.abs(after.y - before.y)).toBeLessThan(0.1);

          // Espace + glisser : la vue suit la souris, au pixel près.
          const view0 = await page.evaluate(() => window.__editor!.getState().view);
          await page.keyboard.down('Space');
          await page.mouse.move(700, 500);
          await page.mouse.down();
          await page.mouse.move(760, 540, { steps: 5 });
          await page.mouse.up();
          await page.keyboard.up('Space');
          const view1 = await page.evaluate(() => window.__editor!.getState().view);
          expect(view1.x - view0.x).toBeCloseTo(60, 5);
          expect(view1.y - view0.y).toBeCloseTo(40, 5);
          expect(await selection(page)).toEqual([]);

          // Molette seule : défilement vertical.
          await page.mouse.wheel({ deltaY: 120 });
          await settle(page);
          const view2 = await page.evaluate(() => window.__editor!.getState().view);
          expect(view2.y).toBeCloseTo(view1.y - 120, 5);

          // « Ajuster » : les deux faces tiennent dans le plan de travail.
          await page.click('[data-zoom-fit]');
          await settle(page);
          const fit = await page.evaluate(() => {
            const vp = document.querySelector('[data-workspace-viewport]')!.getBoundingClientRect();
            return [...document.querySelectorAll('[data-page-id]')].map((el) => {
              const r = el.getBoundingClientRect();
              return r.left >= vp.left && r.right <= vp.right && r.top >= vp.top && r.bottom <= vp.bottom;
            });
          });
          expect(fit).toEqual([true, true]);
          expect(await page.evaluate(() => window.__editor!.getState().zoomMode)).toBe('fit');
        },
        { documentsDir: dir },
      );
    });
  });

  it('sélectionne au clic, au Maj+clic, entre dans un groupe au double-clic et en sort avec Échap', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'int-g5' });
          // Un clic sur un élément d'une carte attrape la carte entière (le groupe).
          await clickAt(page, 'p-interieur', 20, 127.5);
          expect(await selection(page)).toEqual(['int-g4']);
          await clickAt(page, 'p-interieur', 20, 137.8, { shift: true });
          expect(await selection(page)).toEqual(['int-g4', 'int-g5']);
          await clickAt(page, 'p-interieur', 20, 137.8, { shift: true });
          expect(await selection(page)).toEqual(['int-g4']);

          // Double-clic : on entre dans la carte, l'élément cliqué est sélectionné seul.
          const p = await pageToClient(page, 'p-interieur', 60, 127.5);
          await page.mouse.click(Math.round(p.x), Math.round(p.y), { count: 2 });
          await settle(page);
          const inside = await page.evaluate(() => ({ entered: window.__editor!.getState().enteredGroup, sel: window.__editor!.getState().selection }));
          expect(inside.entered).toBe('int-g4');
          expect(inside.sel).toHaveLength(1);
          const child = inside.sel[0];
          const doc = await page.evaluate(() => window.__editor!.getState().doc!);
          expect((doc.objects['int-g4'] as { children: string[] }).children).toContain(child);
          expect(await page.$eval('[data-statusbar]', (el) => el.textContent)).toContain('Dans le groupe');

          await press(page, 'Escape');
          expect(await page.evaluate(() => window.__editor!.getState().enteredGroup)).toBeNull();
          expect(await selection(page)).toEqual(['int-g4']);
          await press(page, 'Escape');
          expect(await selection(page)).toEqual([]);
        },
        { documentsDir: dir },
      );
    });
  });

  it('deux glissers rapprochés donnent deux déplacements : seul un clic sans bouger ouvre un double-clic', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'int-g4' });
          // Pas de magnétisme : on vérifie le pas exact de la souris (4 px à 100 % = 1 mm).
          await page.click('[data-snapping-toggle]');
          await clickAt(page, 'p-interieur', 20, 127.5);
          expect(await selection(page)).toEqual(['int-g4']);
          const x = () => page.evaluate(() => window.__editor!.getState().doc!.objects['int-g4'].x);
          const x0 = await x();
          const depth0 = await page.evaluate(() => window.__editor!.getState().history.depth);
          const p = await pageToClient(page, 'p-interieur', 60, 127.5);
          const drag = async (fromX: number) => {
            await page.mouse.move(fromX, Math.round(p.y));
            await page.mouse.down();
            await page.mouse.move(fromX + 2, Math.round(p.y));
            await page.mouse.move(fromX + 4, Math.round(p.y));
            await page.mouse.up();
          };
          // Ajustement fin : 4 px, 150 ms de pause, puis 4 px encore, saisi 3 px plus loin.
          await drag(Math.round(p.x));
          await new Promise((r) => setTimeout(r, 150));
          await drag(Math.round(p.x) + 3);
          await settle(page);
          const after = await page.evaluate(() => ({ entered: window.__editor!.getState().enteredGroup, sel: window.__editor!.getState().selection, depth: window.__editor!.getState().history.depth }));
          expect(after).toEqual({ entered: null, sel: ['int-g4'], depth: depth0 + 2 });
          expect((await x()) - x0).toBeCloseTo(2, 6);

          // Un vrai double-clic (deux appuis relâchés sans bouger) entre toujours dans la carte.
          await new Promise((r) => setTimeout(r, 450));
          await page.mouse.click(Math.round(p.x) + 10, Math.round(p.y), { count: 2 });
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().enteredGroup)).toBe('int-g4');
        },
        { documentsDir: dir },
      );
    });
  });

  it('le lasso sélectionne les objets entièrement couverts, pas ceux qu’il ne fait que toucher', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'int-g5' });
          // Du vide à gauche de la face intérieure jusqu'au milieu de la 3e carte : les deux premières
          // cartes sont entièrement couvertes, la troisième à moitié.
          const from = await pageToClient(page, 'p-interieur', -10, 122.5);
          const to = await pageToClient(page, 'p-interieur', 98, 148);
          await page.mouse.move(Math.round(from.x), Math.round(from.y));
          await page.mouse.down();
          await page.mouse.move(Math.round(to.x), Math.round(to.y), { steps: 12 });
          await page.mouse.up();
          await settle(page);
          const sel = await selection(page);
          expect(sel).toContain('int-g4');
          expect(sel).toContain('int-g5');
          expect(sel).not.toContain('int-g6');
          // Rien d'autre qu'entièrement couvert : chaque objet sélectionné tient dans le lasso.
          const doc: LayoutDocument = await page.evaluate(() => window.__editor!.getState().doc!);
          for (const objId of sel) {
            const o = doc.objects[objId];
            expect(o.x).toBeGreaterThanOrEqual(-10);
            expect(o.x + o.w).toBeLessThanOrEqual(98.01);
            expect(o.y).toBeGreaterThanOrEqual(122.5);
            expect(o.y + o.h).toBeLessThanOrEqual(148.01);
          }
        },
        { documentsDir: dir },
      );
    });
  });

  it('critère 1.10 : un bandeau du calque Fonds (verrouillé) ne se sélectionne ni au clic ni au lasso', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'ext-r6' });
          // Le bandeau « Aplat · Rabat (bas) » est bien sous le pointeur…
          const p = await pageToClient(page, 'p-exterieur', 4, 200);
          const under = await page.evaluate((x, y) => document.elementsFromPoint(x, y).map((el) => el.closest('[data-obj-id]')?.getAttribute('data-obj-id')), p.x, p.y);
          expect(under).toContain('ext-r6');
          // … mais un vrai clic ne le sélectionne pas.
          await clickAt(page, 'p-exterieur', 4, 200);
          expect(await selection(page)).toEqual([]);

          // Un lasso qui l'englobe entièrement ne prend que le contenu posé dessus.
          const from = await pageToClient(page, 'p-exterieur', -8, 183);
          const to = await pageToClient(page, 'p-exterieur', 101, 219);
          await page.mouse.move(Math.round(from.x), Math.round(from.y));
          await page.mouse.down();
          await page.mouse.move(Math.round(to.x), Math.round(to.y), { steps: 10 });
          await page.mouse.up();
          await settle(page);
          const sel = await selection(page);
          expect(sel).not.toContain('ext-r6');
          expect(sel).toContain('ext-g11');

          // Un objet verrouillé lui-même (hors calque verrouillé) est tout aussi transparent.
          await page.evaluate(() => window.__editor!.getState().update(['ext-g11'], { locked: true }));
          await press(page, 'Escape');
          await clickAt(page, 'p-exterieur', 50, 200);
          expect(await selection(page)).toEqual([]);
        },
        { documentsDir: dir },
      );
    });
  });
});
