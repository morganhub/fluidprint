// Aligner et répartir (tâche 2.11) : six alignements, répartition des espacements horizontaux et
// verticaux, référence « sélection » ou « volet ». Répartir 4 cartes du dépliant d'exemple donne des espacements
// égaux à 0,1 mm près.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignObjects, distributeObjects, gapsBetween, panelAt, trimPanels } from '../src/editor/align';
import type { LayoutDocument } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { createEditorStore } from '../src/store/documentStore';
import { objectBounds } from '../src/store/tree';
import { EXAMPLE_FILE, copyExample, openEditor, readSavedDocument, saveNow, settle, withApp, withTempDocuments } from './helpers/editor';

// Scénario complet dans Chrome : large marge quand toute la suite tourne en parallèle.
const BROWSER_TIMEOUT_MS = 180_000;

const example = (): LayoutDocument => JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));

// Les 4 cartes de séances du volet intérieur gauche, empilées.
const CARDS = ['int-g4', 'int-g5', 'int-g6', 'int-g7'];
const TOLERANCE_MM = 0.1;

function storeWithScrambledCards() {
  const store = createEditorStore();
  store.getState().load(example());
  // Espacements rendus irréguliers : 10,2 mm de pas à l'origine.
  store.getState().move(['int-g5'], 0, 2.37);
  store.getState().move(['int-g6'], 0, -1.3);
  return store;
}

const spread = (gaps: number[]) => Math.max(...gaps) - Math.min(...gaps);

describe('aligner et répartir : commandes (2.11)', () => {
  it('répartir 4 cartes : espacements égaux à 0,1 mm près, cartes extrêmes immobiles, une étape', () => {
    const store = storeWithScrambledCards();
    const s = () => store.getState();
    expect(spread(gapsBetween(s().doc!, CARDS, 'y'))).toBeGreaterThan(1);
    const first = s().doc!.objects['int-g4'].y;
    const last = s().doc!.objects['int-g7'].y;
    const depth = s().history.depth;
    s().apply('Répartir', (d) => distributeObjects(d, CARDS, 'y', 'selection'));
    const gaps = gapsBetween(s().doc!, CARDS, 'y');
    expect(gaps).toHaveLength(3);
    expect(spread(gaps)).toBeLessThanOrEqual(TOLERANCE_MM);
    expect(spread(gaps)).toBeLessThan(0.001);
    expect(s().doc!.objects['int-g4'].y).toBe(first);
    expect(s().doc!.objects['int-g7'].y).toBeCloseTo(last, 4);
    expect(s().history.depth).toBe(depth + 1);
    // Les enfants des cartes (groupes) suivent : le document reste cohérent.
    expect(validateDocument(s().doc).ok).toBe(true);
  });

  it('répartir dans le volet : marges et intervalles égaux (n + 1 espaces)', () => {
    const store = storeWithScrambledCards();
    store.getState().apply('Répartir', (d) => distributeObjects(d, CARDS, 'y', 'panel'));
    const doc = store.getState().doc!;
    const panel = panelAt(doc, 'p-interieur', 50)!;
    const boxes = CARDS.map((id) => objectBounds(doc.objects[id])).sort((a, b) => a.y - b.y);
    const gaps = [boxes[0].y - panel.y, ...gapsBetween(doc, CARDS, 'y'), panel.y + panel.h - (boxes[3].y + boxes[3].h)];
    expect(gaps).toHaveLength(5);
    expect(spread(gaps)).toBeLessThanOrEqual(TOLERANCE_MM);
  });

  it('six alignements sur la sélection, et sur le volet', () => {
    const doc = example();
    const ids = ['int-g8', 'int-g9', 'int-g10'];
    const box = (id: string) => objectBounds(doc.objects[id]);
    alignObjects(doc, ids, 'top', 'selection');
    expect(spread(ids.map((id) => box(id).y))).toBeLessThan(0.001);
    alignObjects(doc, ids, 'left', 'selection');
    expect(spread(ids.map((id) => box(id).x))).toBeLessThan(0.001);
    alignObjects(doc, ids, 'right', 'selection');
    expect(spread(ids.map((id) => (box(id).x + box(id).w)))).toBeLessThan(0.001);
    alignObjects(doc, ids, 'bottom', 'selection');
    expect(spread(ids.map((id) => (box(id).y + box(id).h)))).toBeLessThan(0.001);
    alignObjects(doc, ids, 'hcenter', 'selection');
    expect(spread(ids.map((id) => (box(id).x + box(id).w / 2)))).toBeLessThan(0.001);
    alignObjects(doc, ids, 'vcenter', 'selection');
    expect(spread(ids.map((id) => (box(id).y + box(id).h / 2)))).toBeLessThan(0.001);

    // Volet : le volet central de la face intérieure (entre les deux plis), au format fini.
    const panels = trimPanels(doc, 'p-interieur');
    expect(panels).toHaveLength(3);
    alignObjects(doc, ['int-g12'], 'hcenter', 'panel');
    const b = box('int-g12');
    expect(b.x + b.w / 2).toBeCloseTo(panels[1].x + panels[1].w / 2, 3);
    alignObjects(doc, ['int-g12'], 'top', 'panel');
    expect(box('int-g12').y).toBeCloseTo(doc.format.bleed, 4);
    expect(validateDocument(doc).ok).toBe(true);
  });
});

describe('barre d’alignement dans Propriétés (navigateur)', () => {
  it('répartir 4 cartes sélectionnées, puis centrer sur le volet, depuis les boutons', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          await page.evaluate((cards) => {
            const s = window.__editor!.getState();
            s.move(['int-g5'], 0, 2.37);
            s.move(['int-g6'], 0, -1.3);
            s.select(cards);
          }, CARDS);
          await settle(page);
          await page.click('[data-panel-tab="properties"]');
          await page.waitForSelector('[data-section="align"]', { visible: true });
          await page.click('[data-align-reference="selection"]');
          await page.click('[data-distribute="y"]');
          await settle(page);
          const gaps = await page.evaluate((cards) => {
            const d = window.__editor!.getState().doc!;
            const boxes = cards.map((c) => d.objects[c]).sort((a, b) => a.y - b.y);
            return boxes.slice(1).map((b, i) => b.y - (boxes[i].y + boxes[i].h));
          }, CARDS);
          expect(gaps).toHaveLength(3);
          expect(spread(gaps)).toBeLessThanOrEqual(TOLERANCE_MM);

          // Deux objets : la répartition demande 3 objets ; un objet seul s'aligne sur son volet.
          await page.evaluate(() => window.__editor!.getState().select(['int-g8', 'int-g9']));
          await settle(page);
          expect(await page.$eval('[data-distribute="x"]', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
          await page.evaluate(() => window.__editor!.getState().select(['int-g12']));
          await settle(page);
          expect(await page.$eval('[data-align-reference="selection"]', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
          await page.click('[data-align="hcenter"]');
          await settle(page);
          const center = await page.evaluate(() => {
            const o = window.__editor!.getState().doc!.objects['int-g12'];
            return o.x + o.w / 2;
          });
          // Volet central de la face intérieure : entre les plis, au format fini.
          const doc = example();
          const mid = trimPanels(doc, 'p-interieur')[1];
          expect(center).toBeCloseTo(mid.x + mid.w / 2, 3);

          await saveNow(page);
          const saved = await readSavedDocument(dir, id);
          expect(spread(gapsBetween(saved, CARDS, 'y'))).toBeLessThanOrEqual(TOLERANCE_MM);
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);
});
