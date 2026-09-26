// Bibliothèque d'icônes Lucide (tâche 2.14) : recherche (mots-clés français compris), insertion par
// l'outil Icône, remplacement de l'icône d'une carte qui garde sa taille, sa position, sa nuance et son
// épaisseur de trait.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ICON } from '../src/editor/tools/defaults';
import type { IconObject } from '../src/model/types';
import { FRENCH_KEYWORDS, iconSvg, loadIconLibrary, searchIcons } from '../src/panels/iconLibrary';
import { clickAt, copyExample, openEditor, readSavedDocument, saveNow, settle, withApp, withTempDocuments } from './helpers/editor';

// Scénario complet dans Chrome : large marge quand toute la suite tourne en parallèle.
const BROWSER_TIMEOUT_MS = 180_000;

describe('bibliothèque Lucide : recherche (2.14)', () => {
  it('trouve par nom, par mot-clé Lucide et par mot-clé français (accents et casse indifférents)', async () => {
    const lib = await loadIconLibrary();
    expect(lib.names.length).toBeGreaterThan(1500);
    // Tous les mots-clés français mènent à des icônes qui existent.
    for (const [word, names] of Object.entries(FRENCH_KEYWORDS)) for (const n of names) expect(lib.nodes[n], `${word} → ${n}`).toBeDefined();
    expect(searchIcons(lib, 'maison')[0]).toBe('house');
    expect(searchIcons(lib, 'Téléphone')[0]).toBe('phone');
    expect(searchIcons(lib, 'formation')[0]).toBe('graduation-cap');
    expect(searchIcons(lib, 'calendrier').slice(0, 3)).toContain('calendar');
    expect(searchIcons(lib, 'fusée')[0]).toBe('rocket');
    expect(searchIcons(lib, 'house')[0]).toBe('house');
    expect(searchIcons(lib, 'arrow right')).toContain('arrow-right');
    // Mot-clé Lucide (« tags.json ») : « wheelchair » trouve l'accessibilité.
    expect(searchIcons(lib, 'wheelchair')).toContain('accessibility');
    expect(searchIcons(lib, 'zzzzqx')).toEqual([]);
    // Sans requête : les icônes courantes.
    expect(searchIcons(lib, '').length).toBeGreaterThan(50);
  });

  it('produit le contenu SVG au format des icônes du document', async () => {
    const lib = await loadIconLibrary();
    const star = iconSvg(lib.nodes.star);
    const d = /d="([^"]+)"/.exec(DEFAULT_ICON.svg)![1];
    expect(star).toContain(`d="${d}"`);
    expect(iconSvg(lib.nodes.blocks)).toMatch(/^(<(path|rect) [^>]*><\/\2>)+$/);
  });
});

describe('bibliothèque Lucide : insertion et remplacement (navigateur)', () => {
  it('remplacer l’icône d’une carte garde taille, position, nuance et trait ; l’outil Icône pose l’icône choisie', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 2, centerOn: 'int-g5' });
          const before = (await page.evaluate(() => window.__editor!.getState().doc!.objects['int-ic5'])) as IconObject;
          expect(before.iconName).toBe('cherry');

          // L'icône d'une carte (dans son groupe) : la sélectionner entre dans la carte.
          await page.evaluate(() => window.__editor!.getState().select(['int-ic5']));
          await page.click('[data-panel-tab="properties"]');
          await page.waitForSelector('[data-section="icon"]', { visible: true });
          expect(await page.$eval('[data-icon-current]', (e) => e.textContent)).toBe('cherry');
          await page.click('[data-action="replace-icon"]');
          await page.waitForSelector('[data-icon-picker] input[name="iconSearch"]', { visible: true });
          await page.type('[data-icon-picker] input[name="iconSearch"]', 'maison');
          await page.waitForSelector('[data-icon-picker] [data-icon-name="house"]', { visible: true });
          // Le premier résultat d'un mot français est l'icône la plus parlante.
          expect(await page.$eval('[data-icon-picker] [role="option"]', (e) => e.getAttribute('data-icon-name'))).toBe('house');
          await page.click('[data-icon-picker] [data-icon-name="house"]');
          await settle(page);

          const after = (await page.evaluate(() => window.__editor!.getState().doc!.objects['int-ic5'])) as IconObject;
          expect(after.iconName).toBe('house');
          expect(after.svg).not.toBe(before.svg);
          expect(after.name).toBe('Icône · house');
          for (const key of ['x', 'y', 'w', 'h', 'color', 'strokeWidth', 'layerId', 'rotation', 'opacity'] as const) expect(after[key]).toEqual(before[key]);
          // L'écran suit : le dessin affiché est celui de la maison.
          const drawn = await page.$eval('[data-workspace-viewport] [data-obj-id="int-ic5"] svg', (svg) => svg.innerHTML);
          expect(drawn).toContain(/d="([^"]+)"/.exec(after.svg)![1]);
          // Une étape d'annulation.
          await page.evaluate(() => window.__editor!.getState().undo());
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects['int-ic5'])).toEqual(before);
          await page.evaluate(() => window.__editor!.getState().redo());

          // L'outil Icône : choisir « fusée » dans ses options, puis cliquer sur la page.
          await page.keyboard.press('Escape');
          await page.click('[data-tool="icon"]');
          await page.waitForSelector('[data-icon-picker] input[name="iconSearch"]', { visible: true });
          await page.type('[data-icon-picker] input[name="iconSearch"]', 'fusée');
          await page.waitForSelector('[data-icon-picker] [data-icon-name="rocket"]', { visible: true });
          await page.click('[data-icon-picker] [data-icon-name="rocket"]');
          await clickAt(page, 'p-interieur', 60, 110);
          const created = await page.evaluate(() => {
            const s = window.__editor!.getState();
            return s.selection.map((i) => s.doc!.objects[i]);
          });
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({ type: 'icon', iconName: 'rocket', w: 8, h: 8 });
          // Posée au point cliqué (la souris avance au pixel entier : 0,1 mm près à 200 %).
          expect(Math.abs(created[0].x - 60)).toBeLessThan(0.1);
          expect(Math.abs(created[0].y - 110)).toBeLessThan(0.1);

          await saveNow(page);
          const saved = await readSavedDocument(dir, id);
          expect((saved.objects['int-ic5'] as IconObject).iconName).toBe('house');
          expect(saved.objects['int-ic5'].x).toBe(before.x);
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);
});
