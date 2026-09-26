// L'éditeur (route /doc/:id) : barre du haut, outils à gauche, plan de travail au centre, panneaux à
// droite, barre d'état en bas.
import { useEffect, useState } from 'react';
import { TooltipProvider } from '../components/ui/tooltip';
import { loadDocumentFonts } from '../render/fonts';
import { editorStore, useEditor } from '../store/documentStore';
import { openDocument, startPersistence, type Persistence } from '../store/persistence';
import { exposeEditorHandle } from './devHandle';
import './registry';
import { installShortcuts } from './shortcuts';
import { ShortcutsHelp } from './ShortcutsHelp';
import { SidePanels } from './SidePanels';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { TopBar } from './TopBar';
import { Workspace } from './Workspace';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export function EditorApp({ docId }: { docId: string }) {
  const [error, setError] = useState<string | null>(null);
  const loaded = useEditor((s) => s.docId === docId && !!s.doc);
  const name = useEditor((s) => s.doc?.name);

  useEffect(() => {
    const handle = import.meta.env.DEV ? exposeEditorHandle() : null;
    let cancelled = false;
    let persistence: Persistence | null = null;
    openDocument(docId)
      .then(async (doc) => {
        if (cancelled) return;
        const state = editorStore.getState();
        // Deuxième montage (StrictMode) : le document est déjà chargé, on ne repart pas de zéro.
        if (state.docId !== docId || !state.doc) state.load(doc, docId);
        persistence = startPersistence(editorStore);
        await loadDocumentFonts(doc);
        await nextFrame();
        await nextFrame();
        if (!cancelled && handle) handle.ready = true;
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      persistence?.dispose();
    };
  }, [docId]);

  useEffect(() => installShortcuts(), []);

  useEffect(() => {
    document.title = name ? `${name} · Fluidprint` : 'Fluidprint';
  }, [name]);

  if (error) {
    return (
      <main className="p-8 text-[13px] text-neutral-800">
        <p className="font-semibold text-red-700">Document impossible à ouvrir : {error}</p>
        <a href="/" className="mt-2 inline-block text-neutral-500 hover:text-neutral-900">
          ← Documents
        </a>
      </main>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-neutral-100 text-neutral-900" data-editor>
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Toolbar />
          {loaded ? <Workspace /> : <div className="flex flex-1 items-center justify-center text-[13px] text-neutral-500">Ouverture du document…</div>}
          <SidePanels />
        </div>
        <StatusBar />
      </div>
      <ShortcutsHelp />
    </TooltipProvider>
  );
}
