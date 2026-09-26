// Store du document et historique (tâche 2.1) : tests unitaires, sans navigateur.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GroupObject, LayoutDocument } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { createEditorStore } from '../src/store/documentStore';
import { HISTORY_LIMIT } from '../src/store/history';
import { descendantsOf, pageIdOf } from '../src/store/tree';
import { minimalDoc } from './fixtures/minimal-doc';
import { EXAMPLE_FILE } from './helpers/editor';

const example = (): LayoutDocument => JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));

function storeWith(doc: LayoutDocument) {
  const store = createEditorStore();
  store.getState().load(doc);
  return store;
}

const expectValid = (doc: LayoutDocument | null) => {
  const result = validateDocument(doc);
  if (!result.ok) throw new Error(JSON.stringify(result.errors.slice(0, 3)));
};

describe('store du document (2.1)', () => {
  it('déplacer un objet puis Ctrl+Z le remet au 0,01 mm près', () => {
    const store = storeWith(example());
    const before = store.getState().doc!.objects['ext-g9'];
    store.getState().move(['ext-g9'], 12.345, -3.21);
    const moved = store.getState().doc!.objects['ext-g9'];
    expect(moved.x - before.x).toBeCloseTo(12.345, 4);
    store.getState().undo();
    const after = store.getState().doc!.objects['ext-g9'];
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.01);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.01);
    // Au bit près, en fait : l'annulation rejoue les valeurs d'origine.
    expect(after).toEqual(before);
  });

  it('un geste continu (2 s, 120 images) ne crée qu’une étape d’annulation', () => {
    const store = storeWith(example());
    const s = () => store.getState();
    const x0 = s().doc!.objects['ext-g9'].x;
    s().beginGesture('Déplacer');
    for (let i = 0; i < 120; i++) s().move(['ext-g9'], 0.1, 0);
    expect(s().gesture).not.toBeNull();
    s().commitGesture();
    expect(s().history.depth).toBe(1);
    expect(s().doc!.objects['ext-g9'].x).toBeCloseTo(x0 + 12, 3);
    s().undo();
    expect(s().doc!.objects['ext-g9'].x).toBe(x0);
    expect(s().history.canUndo).toBe(false);
    s().redo();
    expect(s().doc!.objects['ext-g9'].x).toBeCloseTo(x0 + 12, 3);
  });

  it('previewGesture recalcule depuis le début du geste ; annuler le geste restaure le document', () => {
    const store = storeWith(minimalDoc());
    const s = () => store.getState();
    s().beginGesture('Redimensionner');
    for (const w of [31, 35, 40, 52]) s().previewGesture((d) => void (d.objects.r1.w = w));
    s().commitGesture();
    expect(s().doc!.objects.r1.w).toBe(52);
    expect(s().history.depth).toBe(1);
    s().beginGesture('Redimensionner');
    s().previewGesture((d) => void (d.objects.r1.w = 80));
    s().cancelGesture();
    expect(s().doc!.objects.r1.w).toBe(52);
    expect(s().history.depth).toBe(1);
  });

  it('un geste « autosave » (texte, recadrage) est marqué comme tel ; un glisser ne l’est pas', () => {
    const store = storeWith(minimalDoc());
    const s = () => store.getState();
    s().beginGesture('Modifier le texte', { autosave: true });
    expect(s().gesture).toMatchObject({ label: 'Modifier le texte', autosave: true });
    s().previewGesture((d) => void (d.objects.r1.w = 40));
    s().commitGesture();
    expect(s().history.depth).toBe(1);
    s().beginGesture('Déplacer');
    expect(s().gesture?.autosave).toBeUndefined();
    s().cancelGesture();
  });

  it('zoom manuel : le centre du plan de travail reste en place quand sa largeur change (colonne d’options)', () => {
    const store = storeWith(minimalDoc());
    const s = () => store.getState();
    s().setViewport({ w: 1200, h: 800 });
    s().setZoom(1);
    s().centerOn(['r1']);
    const before = s().view;
    // Une colonne de 346 px s'ouvre à gauche : la vue recule de la moitié, le centre ne bouge pas.
    s().setViewport({ w: 854, h: 800 });
    expect(s().view).toEqual({ x: before.x - 173, y: before.y });
    s().setViewport({ w: 1200, h: 800 });
    expect(s().view).toEqual(before);
    // En « Ajuster », la vue est recalculée comme avant.
    s().fit();
    const fitted = s().view;
    s().setViewport({ w: 854, h: 800 });
    expect(s().zoomMode).toBe('fit');
    expect(s().view).not.toEqual(fitted);
  });

  it('ne touche pas aux coordonnées des objets non modifiés', () => {
    const doc = example();
    const store = storeWith(doc);
    store.getState().move(['ext-g9'], 5, 5);
    const next = store.getState().doc!;
    const moved = new Set(['ext-g9', ...descendantsOf(next, 'ext-g9')]);
    for (const [id, obj] of Object.entries(doc.objects)) {
      if (moved.has(id)) continue;
      expect(next.objects[id]).toEqual(obj);
    }
    expectValid(next);
  });

  it('un groupe se déplace avec ses enfants, et un enfant seul met à jour la boîte du groupe', () => {
    const store = storeWith(example());
    const s = () => store.getState();
    const doc0 = s().doc!;
    const group0 = doc0.objects['ext-g9'] as GroupObject;
    s().move(['ext-g9'], 10, 0);
    for (const c of group0.children) expect(s().doc!.objects[c].x).toBeCloseTo(doc0.objects[c].x + 10, 4);
    s().undo();
    // L'enfant le plus à gauche déplacé seul de −3 mm : le groupe s'élargit à gauche.
    const left = [...group0.children].sort((a, b) => doc0.objects[a].x - doc0.objects[b].x)[0];
    s().move([left], -3, 0);
    expect(s().doc!.objects['ext-g9'].x).toBeCloseTo(doc0.objects[left].x - 3, 4);
  });

  it('les flèches maintenues ne forment qu’une étape ; 100 étapes au plus', () => {
    const store = storeWith(minimalDoc());
    const s = () => store.getState();
    s().select(['r1']);
    for (let i = 0; i < 10; i++) s().nudge(0.5, 0);
    expect(s().doc!.objects.r1.x).toBeCloseTo(15, 6);
    expect(s().history.depth).toBe(1);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) s().update(['r1'], { opacity: (i % 10) / 10 });
    expect(s().history.depth).toBe(HISTORY_LIMIT);
  });

  it('dupliquer une carte crée un groupe identique décalé de 5 mm, au-dessus de l’original', () => {
    const store = storeWith(example());
    const s = () => store.getState();
    const doc0 = s().doc!;
    s().select(['int-g4']);
    const [copy] = s().duplicate();
    const doc = s().doc!;
    const g = doc.objects[copy] as GroupObject;
    const src = doc0.objects['int-g4'] as GroupObject;
    expect(g.type).toBe('group');
    expect(g.children).toHaveLength(src.children.length);
    expect(g.x).toBeCloseTo(src.x + 5, 4);
    expect(g.y).toBeCloseTo(src.y + 5, 4);
    g.children.forEach((c, i) => {
      const a = doc.objects[c];
      const b = doc0.objects[src.children[i]];
      expect(a.type).toBe(b.type);
      expect(a.x).toBeCloseTo(b.x + 5, 4);
      expect(a.y).toBeCloseTo(b.y + 5, 4);
      expect({ ...a, id: '', x: 0, y: 0 }).toEqual({ ...b, id: '', x: 0, y: 0 });
    });
    const page = doc.pages.find((p) => p.id === pageIdOf(doc, 'int-g4'))!;
    expect(page.children.indexOf(copy)).toBe(page.children.indexOf('int-g4') + 1);
    expect(s().selection).toEqual([copy]);
    expectValid(doc);
  });

  it('Ctrl+Z annule la suppression d’un groupe entier', () => {
    const store = storeWith(example());
    const s = () => store.getState();
    const doc0 = s().doc!;
    const ids = ['int-g4', ...descendantsOf(doc0, 'int-g4')];
    s().select(['int-g4']);
    s().remove();
    for (const id of ids) expect(s().doc!.objects[id]).toBeUndefined();
    expectValid(s().doc);
    s().undo();
    expect(s().doc).toEqual(doc0);
    expect(s().selection).toEqual(['int-g4']);
  });

  it('grouper puis dissocier ; ordre d’empilement ; changer de calque', () => {
    const doc = minimalDoc();
    doc.layers.push({ id: 'dessus', name: 'Dessus', visible: true, locked: false, printable: true, color: '#000000' });
    const store = storeWith(doc);
    const s = () => store.getState();
    const g = s().group(['r1', 't1'])!;
    expect(s().doc!.pages[0].children).toEqual([g]);
    expect(s().doc!.objects[g]).toMatchObject({ type: 'group', x: 10, y: 20, children: ['r1', 't1'] });
    expectValid(s().doc);
    s().ungroup([g]);
    expect(s().doc!.pages[0].children).toEqual(['r1', 't1']);
    expect(s().selection).toEqual(['r1', 't1']);
    s().reorder('front', ['r1']);
    expect(s().doc!.pages[0].children).toEqual(['t1', 'r1']);
    s().reorder('back', ['r1']);
    expect(s().doc!.pages[0].children).toEqual(['r1', 't1']);
    s().setLayer('dessus', ['r1']);
    expect(s().doc!.objects.r1.layerId).toBe('dessus');
    expectValid(s().doc);
  });

  it('copier-coller d’une face à l’autre garde la position ; sur la même face, décale de 5 mm', () => {
    const store = storeWith(example());
    const s = () => store.getState();
    s().copy(['ext-g9']);
    const [other] = s().paste('p-interieur');
    const doc = s().doc!;
    expect(pageIdOf(doc, other)).toBe('p-interieur');
    expect(doc.objects[other].x).toBe(doc.objects['ext-g9'].x);
    const [same] = s().paste('p-exterieur');
    expect(s().doc!.objects[same].x).toBeCloseTo(doc.objects['ext-g9'].x + 5, 4);
    expectValid(s().doc);
  });

  it('redimensionner un groupe met ses enfants à l’échelle', () => {
    const store = storeWith(example());
    const s = () => store.getState();
    const g0 = s().doc!.objects['ext-g9'];
    s().setBox('ext-g9', { w: g0.w * 2 });
    const g = s().doc!.objects['ext-g9'] as GroupObject;
    expect(g.w).toBeCloseTo(g0.w * 2, 3);
    expect(g.x).toBeCloseTo(g0.x, 3);
    expectValid(s().doc);
  });
});
