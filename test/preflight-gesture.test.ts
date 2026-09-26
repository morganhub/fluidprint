import { describe, expect, it } from 'vitest';
import { preflightStore } from '../src/panels/PreflightPanel';
import { editorStore } from '../src/store/documentStore';
import { minimalDoc } from './fixtures/minimal-doc';

// Sans navigateur, le contrôle se recalcule en microtâche : on laisse passer les tâches en attente.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('contrôle en amont pendant un geste (audit B5)', () => {
  it('un glisser ne recalcule pas le contrôle à chaque image : un seul calcul, à la fin du geste', async () => {
    let runs = 0;
    const unsubscribe = preflightStore.subscribe(() => runs++);
    try {
      const store = editorStore.getState();
      store.load(minimalDoc(), 'essai');
      await flush();
      const afterLoad = runs;
      expect(afterLoad).toBeGreaterThan(0);

      // Rectangle poussé à 1 mm du bord : erreur de zone de sécurité, mais seulement une fois lâché.
      editorStore.getState().beginGesture('Déplacer');
      for (let step = 1; step <= 10; step++) {
        editorStore.getState().previewGesture((draft) => {
          draft.objects.t1.x = 12 - step;
        });
        await flush();
      }
      expect(runs).toBe(afterLoad);

      editorStore.getState().commitGesture();
      await flush();
      expect(runs).toBe(afterLoad + 1);
      expect(preflightStore.getState().report.issues.some((i) => i.objectId === 't1')).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('un texte en édition (geste enregistré en cours de route) reste contrôlé en direct', async () => {
    let runs = 0;
    const unsubscribe = preflightStore.subscribe(() => runs++);
    try {
      editorStore.getState().load(minimalDoc(), 'essai');
      await flush();
      const before = runs;
      editorStore.getState().beginGesture('Modifier le texte', { autosave: true });
      editorStore.getState().previewGesture((draft) => {
        draft.objects.t1.x = 1;
      });
      await flush();
      expect(runs).toBe(before + 1);
      editorStore.getState().commitGesture();
    } finally {
      unsubscribe();
    }
  });
});
