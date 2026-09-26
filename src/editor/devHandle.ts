// Poignée de test : `window.__editor`, exposée en développement seulement (serveur Vite, donc aussi dans
// les tests Puppeteer). Lecture de l'état, actions du store, géométrie écran, enregistrement.
import type { Id, Mm } from '../model/types';
import { editorStore, type EditorState, type EditorStore } from '../store/documentStore';
import { getPersistence } from '../store/persistence';
import { objectBounds, pageIdOf, type Box } from '../store/tree';
import { pageBoxToScreen, pageToScreen } from './layout';
import { panelRegistry, propertySectionRegistry, shortcutRegistry, toolRegistry, overlayRegistry, topbarRegistry } from './registry/api';
import { rulerStats } from './Rulers';

export interface EditorHandle {
  /** Vrai quand le document est chargé, ses polices prêtes et la vue ajustée. */
  ready: boolean;
  store: EditorStore;
  getState(): EditorState;
  /** Point d'une face (mm, repère de la face) → coordonnées client (px CSS de la fenêtre). */
  pageToClient(pageId: Id, x: Mm, y: Mm): { x: number; y: number };
  /** Boîte d'un objet à l'écran (px CSS de la fenêtre), d'après le document. */
  objectClientBox(id: Id): Box;
  /** Enregistre tout de suite et attend la réponse du serveur. */
  saveNow(): Promise<void>;
  hasUnsavedChanges(): boolean;
  /** Identifiants enregistrés dans chaque registre (contrôle des points d'extension). */
  registries(): Record<string, string[]>;
  /** Nombre de calculs des graduations des règles (elles ne doivent pas suivre la souris ni les gestes). */
  rulerRenders(): number;
}

declare global {
  interface Window {
    __editor?: EditorHandle;
  }
}

function viewportOrigin(): { x: number; y: number } {
  const el = document.querySelector('[data-workspace-viewport]');
  if (!el) throw new Error('Plan de travail absent');
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

export function exposeEditorHandle(): EditorHandle {
  const handle: EditorHandle = {
    ready: false,
    store: editorStore,
    getState: () => editorStore.getState(),
    pageToClient(pageId, x, y) {
      const s = editorStore.getState();
      const p = pageToScreen(s.doc!, pageId, { x, y }, s.zoom, s.view);
      const o = viewportOrigin();
      return { x: o.x + p.x, y: o.y + p.y };
    },
    objectClientBox(id) {
      const s = editorStore.getState();
      const doc = s.doc!;
      const pageId = pageIdOf(doc, id);
      if (!pageId) throw new Error(`Objet absent des faces : ${id}`);
      const b = pageBoxToScreen(doc, pageId, objectBounds(doc.objects[id]), s.zoom, s.view);
      const o = viewportOrigin();
      return { x: o.x + b.x, y: o.y + b.y, w: b.w, h: b.h };
    },
    saveNow: async () => getPersistence()?.saveNow(),
    hasUnsavedChanges: () => getPersistence()?.hasUnsavedChanges() ?? false,
    registries: () => ({
      panels: panelRegistry.list().map((d) => d.id),
      propertySections: propertySectionRegistry.list().map((d) => d.id),
      shortcuts: shortcutRegistry.list().map((d) => d.id),
      tools: toolRegistry.list().map((d) => d.id),
      overlays: overlayRegistry.list().map((d) => d.id),
      topbar: topbarRegistry.list().map((d) => d.id),
    }),
    rulerRenders: () => rulerStats.tickRenders,
  };
  window.__editor = handle;
  return handle;
}
