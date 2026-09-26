// Ouverture et enregistrement automatique du document (tâche 2.2, décision S4).
// - Ouverture : GET /api/doc/:id?open=1, une seule fois (le serveur fait alors une copie d'historique).
// - Enregistrement : PUT 2 s après la dernière modification, ou tout de suite sur Ctrl+S. Un geste court
//   (glisser, redimensionner) n'enregistre qu'à sa fin : le compte à rebours repart de là. Un geste long
//   et modal (édition de texte, recadrage : `gesture.autosave`) enregistre son aperçu 2 s après la
//   dernière frappe, sans toucher à l'historique d'annulation (il reste une étape à la sortie).
// - `editedAt` est posé (puis rafraîchi) à chaque enregistrement : l'importeur refuse alors d'écraser
//   le document (tâche 1.8).
// - Conflit : chaque PUT envoie la révision du fichier lue à l'ouverture (ou au dernier enregistrement).
//   Si le fichier a changé depuis (autre onglet, script), le serveur répond 409 et rien n'est écrit :
//   l'éditeur propose de recharger le document du disque ou de l'écraser avec sa version.
// - Fermer l'onglet avec des changements non enregistrés déclenche l'alerte du navigateur.
import type { LayoutDocument } from '../model/types';
import type { EditorStore } from './documentStore';
import { serverFetch } from './http';

export const SAVE_DELAY_MS = 2000;
/** Nouvel essai automatique après une erreur d'enregistrement. */
const RETRY_DELAY_MS = 5000;

/** En-tête de réponse : révision du fichier sur le disque (empreinte de son contenu). */
export const REVISION_HEADER = 'x-doc-revision';
/** En-tête du PUT : révision sur laquelle repose la version envoyée. */
export const BASE_REVISION_HEADER = 'x-base-revision';

const docUrl = (docId: string, query = '') => `/api/doc/${encodeURIComponent(docId)}${query}`;

const openings = new Map<string, Promise<LayoutDocument>>();
// Dernière révision connue du fichier, par document : lue à l'ouverture, remplacée à chaque enregistrement.
const revisions = new Map<string, string>();

/** Retient la révision du fichier après une écriture faite par une autre voie (restauration d'une version). */
export function adoptRevision(docId: string, revision: string | null | undefined): void {
  if (revision) revisions.set(docId, revision);
  else revisions.delete(docId);
}

async function readJson(res: Response): Promise<{ error?: string; revision?: string; savedAt?: string } | null> {
  return res.json().catch(() => null);
}

/**
 * Ouvre un document : une seule requête `?open=1` par identifiant et par chargement de page, même si
 * React (StrictMode) monte deux fois l'éditeur.
 */
export function openDocument(docId: string): Promise<LayoutDocument> {
  let pending = openings.get(docId);
  if (!pending) {
    pending = serverFetch(docUrl(docId, '?open=1'), undefined, 'vérifiez que l’éditeur tourne (npm start), puis rechargez la page').then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
      adoptRevision(docId, res.headers.get(REVISION_HEADER));
      return body as LayoutDocument;
    });
    // Un échec ne doit pas empêcher de réessayer (recharger l'éditeur).
    pending.catch(() => openings.delete(docId));
    openings.set(docId, pending);
  }
  return pending;
}

export interface Persistence {
  /** Enregistre tout de suite (Ctrl+S) ; attend la fin d'un enregistrement déjà en cours. */
  saveNow(): Promise<void>;
  /** Vrai s'il reste des modifications non écrites sur le disque. */
  hasUnsavedChanges(): boolean;
  /** Conflit : abandonne les modifications locales et recharge le document du disque. */
  reload(): Promise<void>;
  /** Conflit : écrit la version de l'éditeur par-dessus celle du disque (gardée dans l'historique). */
  overwrite(): Promise<void>;
  dispose(): void;
}

let current: Persistence | null = null;

/** Persistance active (celle de l'éditeur ouvert), pour Ctrl+S et les tests. */
export const getPersistence = (): Persistence | null => current;

export function startPersistence(store: EditorStore, options: { delayMs?: number } = {}): Persistence {
  const delay = options.delayMs ?? SAVE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let savedRevision = store.getState().revision;
  let disposed = false;
  // Conflit signalé par le serveur : plus aucun enregistrement automatique avant la décision de l'utilisateur.
  let conflict = false;
  // Rechargement en cours : le document remplacé n'est pas une modification à enregistrer.
  let muted = false;

  const state = () => store.getState();
  const dirty = () => state().revision !== savedRevision;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms = delay) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void save();
    }, ms);
  };

  async function save(): Promise<void> {
    if (disposed) return;
    if (inFlight) {
      await inFlight;
      if (dirty()) return save();
      return;
    }
    const { doc, docId, gesture } = state();
    if (!doc || !docId || !dirty()) return;
    // Pendant un geste court, rien ne part : la fin du geste relance le compte à rebours. Un geste long
    // (texte, recadrage) enregistre son aperçu : c'est l'état que l'utilisateur voit.
    if (gesture && !gesture.autosave) return;
    const revision = state().revision;
    const editedAt = new Date().toISOString();
    const payload: LayoutDocument = { ...doc, editedAt };
    const base = revisions.get(docId);
    state().setSaveState({ status: 'saving', message: null });
    inFlight = (async () => {
      try {
        const res = await serverFetch(
          docUrl(docId),
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...(base ? { [BASE_REVISION_HEADER]: base } : null) },
            body: JSON.stringify(payload),
          },
          `nouvel essai automatique dans ${RETRY_DELAY_MS / 1000} s`,
        );
        const body = await readJson(res);
        if (res.status === 409) {
          conflict = true;
          clearTimer();
          state().setSaveState({ status: 'conflict', message: body?.error ?? 'Le document a été modifié ailleurs depuis son ouverture.' });
          return;
        }
        if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
        conflict = false;
        adoptRevision(docId, body?.revision ?? res.headers.get(REVISION_HEADER));
        savedRevision = revision;
        state().patchSilently((d) => void (d.editedAt = editedAt));
        state().setSaveState(dirty() ? { status: 'dirty' } : { status: 'saved', message: null, savedAt: body?.savedAt ?? editedAt });
        const g = state().gesture;
        if (dirty() && (!g || g.autosave)) schedule();
      } catch (error) {
        state().setSaveState({ status: 'error', message: (error as Error).message });
        schedule(RETRY_DELAY_MS);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const unsubscribe = store.subscribe((next, prev) => {
    if (muted) return;
    if (next.revision !== prev.revision && next.docId === prev.docId && !conflict) {
      if (next.save.status !== 'dirty' && next.save.status !== 'saving') state().setSaveState({ status: 'dirty' });
      if (!next.gesture || next.gesture.autosave) schedule();
    }
    // Fin d'un geste : le compte à rebours part de là.
    if (prev.gesture && !next.gesture && dirty() && !conflict) {
      if (state().save.status !== 'saving') state().setSaveState({ status: 'dirty' });
      schedule();
    }
    // Pendant un geste court, un enregistrement programmé est suspendu.
    if (!prev.gesture && next.gesture && !next.gesture.autosave) clearTimer();
  });

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!dirty() && !inFlight) return;
    e.preventDefault();
    // Chrome exige encore returnValue pour afficher l'alerte.
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  /** Lit le document du disque (et sa révision) ; `open` : fait aussi une copie d'historique. */
  async function fetchDisk(docId: string, open: boolean): Promise<LayoutDocument> {
    const res = await serverFetch(docUrl(docId, open ? '?open=1' : ''), undefined, 'réessayez dans un instant');
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
    adoptRevision(docId, res.headers.get(REVISION_HEADER));
    return body as LayoutDocument;
  }

  const persistence: Persistence = {
    async saveNow() {
      clearTimer();
      if (inFlight) await inFlight;
      await save();
    },
    hasUnsavedChanges: () => dirty() || !!inFlight,
    async reload() {
      const docId = state().docId;
      if (!docId) return;
      clearTimer();
      if (inFlight) await inFlight;
      const doc = await fetchDisk(docId, false);
      muted = true;
      try {
        state().load(doc, docId);
      } finally {
        muted = false;
      }
      conflict = false;
      savedRevision = state().revision;
      clearTimer();
      state().setSaveState({ status: 'saved', message: null, savedAt: doc.editedAt ?? null });
    },
    async overwrite() {
      const docId = state().docId;
      if (!docId) return;
      clearTimer();
      if (inFlight) await inFlight;
      // `?open=1` garde une copie d'historique de la version du disque avant qu'elle soit écrasée, et
      // donne sa révision : l'écriture ne passe que si personne d'autre n'écrit entre-temps.
      await fetchDisk(docId, true);
      conflict = false;
      await save();
    },
    dispose() {
      disposed = true;
      clearTimer();
      unsubscribe();
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (current === persistence) current = null;
    },
  };
  current = persistence;
  return persistence;
}
