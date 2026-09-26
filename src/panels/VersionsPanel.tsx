// Versions nommées (tâche 2.17) : bouton « Enregistrer une version » (barre du haut et panneau), copie
// dans documents/<id>/versions/ ; panneau Versions avec vignettes des deux faces pour comparer et
// restaurer. Restaurer enregistre d'abord l'état courant comme version automatique (serveur), puis
// remplace le document en UNE étape d'annulation (Ctrl+Z revient à l'état d'avant).
import { ArrowLeftRight, History, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { faceSize } from '../model/format';
import type { LayoutDocument } from '../model/types';
import { PX_PER_MM } from '../model/units';
import { PageView } from '../render/PageView';
import { getEditor, useEditor } from '../store/documentStore';
import { adoptRevision, getPersistence } from '../store/persistence';
import { serverFetch } from '../store/http';
import { registerPanel, registerTopbarAction } from '../editor/registry/api';

export interface VersionMeta {
  id: string;
  name: string;
  createdAt: string;
  kind: 'manual' | 'auto';
  docName?: string;
}

interface VersionFile {
  version: VersionMeta;
  document: LayoutDocument;
}

const api = (docId: string, rest = '') => `/api/doc/${encodeURIComponent(docId)}/versions${rest}`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await serverFetch(url, init, 'réessayez dans un instant');
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const formatVersionDate = (iso: string): string =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export const defaultVersionName = (date = new Date()): string => `Version du ${formatVersionDate(date.toISOString())}`;

// ---------------------------------------------------------------- état partagé (liste des versions)

interface VersionsState {
  docId: string | null;
  list: VersionMeta[];
  loading: boolean;
  error: string | null;
  /** Message après une action (version enregistrée, restaurée). */
  notice: string | null;
  reload(docId: string): Promise<void>;
  setNotice(notice: string | null): void;
}

export const versionsStore = createStore<VersionsState>()((set) => ({
  docId: null,
  list: [],
  loading: false,
  error: null,
  notice: null,
  async reload(docId) {
    set({ docId, loading: true, error: null });
    try {
      set({ list: await request<VersionMeta[]>(api(docId)), loading: false });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
    }
  },
  setNotice: (notice) => set({ notice }),
}));

const useVersions = <T,>(selector: (s: VersionsState) => T): T => useStore(versionsStore, selector);

// Une version ne change jamais : son contenu se garde en mémoire une fois chargé.
const versionCache = new Map<string, Promise<VersionFile>>();
function fetchVersion(docId: string, vid: string): Promise<VersionFile> {
  const key = `${docId}/${vid}`;
  let pending = versionCache.get(key);
  if (!pending) {
    pending = request<VersionFile>(api(docId, `/${encodeURIComponent(vid)}`));
    pending.catch(() => versionCache.delete(key));
    versionCache.set(key, pending);
  }
  return pending;
}

// ---------------------------------------------------------------- actions

/** Enregistre l'état à l'écran comme version nommée. */
export async function saveVersion(name: string): Promise<VersionMeta> {
  const s = getEditor();
  if (!s.doc || !s.docId) throw new Error('Aucun document ouvert');
  // Le document du disque suit aussi : la version et le fichier courant racontent la même chose.
  await getPersistence()?.saveNow();
  const version = await request<VersionMeta>(api(s.docId), json('POST', { name, document: getEditor().doc }));
  await versionsStore.getState().reload(s.docId);
  versionsStore.getState().setNotice(`Version « ${version.name} » enregistrée.`);
  return version;
}

/**
 * Restaure une version : le serveur garde d'abord une copie de l'état courant (celui de l'éditeur), puis
 * le document est remplacé en une étape d'annulation.
 */
export async function restoreVersion(version: VersionMeta): Promise<VersionMeta> {
  const s = getEditor();
  if (!s.doc || !s.docId) throw new Error('Aucun document ouvert');
  await getPersistence()?.saveNow();
  const result = await request<{ document: LayoutDocument; backup: VersionMeta; revision?: string }>(
    api(s.docId, `/${encodeURIComponent(version.id)}/restore`),
    json('POST', { current: getEditor().doc }),
  );
  // Le serveur vient de réécrire le fichier : l'enregistrement suivant repose sur cette révision, sinon
  // il serait pris pour un conflit.
  adoptRevision(s.docId, result.revision);
  getEditor().apply(
    `Restaurer la version « ${version.name} »`,
    (draft) => {
      const target = draft as unknown as Record<string, unknown>;
      const source = result.document as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
      for (const [key, value] of Object.entries(source)) target[key] = structuredClone(value);
    },
    { select: [] },
  );
  await versionsStore.getState().reload(s.docId);
  versionsStore.getState().setNotice(`Version « ${version.name} » restaurée. L’état précédent est gardé : « ${result.backup.name} ».`);
  return result.backup;
}

export async function deleteVersion(version: VersionMeta): Promise<void> {
  const docId = getEditor().docId;
  if (!docId) return;
  await request(api(docId, `/${encodeURIComponent(version.id)}`), { method: 'DELETE' });
  await versionsStore.getState().reload(docId);
}

// ---------------------------------------------------------------- vignettes

/** Les faces d'un document, côte à côte, à une largeur donnée (px). */
export function FacesPreview({ doc, width, gap = 6, testId }: { doc: LayoutDocument; width: number; gap?: number; testId?: string }) {
  const size = faceSize(doc.format);
  const n = doc.pages.length;
  const zoom = (width - gap * (n - 1)) / n / (size.w * PX_PER_MM);
  return (
    <div className="flex items-start" style={{ gap }} data-faces-preview={testId}>
      {doc.pages.map((page) => (
        <div key={page.id} className="pointer-events-none shrink-0 overflow-hidden rounded-sm shadow-[0_0_0_1px_rgba(0,0,0,0.12)]">
          <PageView doc={doc} page={page} mode="screen" zoom={zoom} />
        </div>
      ))}
    </div>
  );
}

function VersionThumbnail({ docId, vid, width }: { docId: string; vid: string; width: number }) {
  const [file, setFile] = useState<VersionFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchVersion(docId, vid).then(
      (f) => alive && setFile(f),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [docId, vid]);
  if (error) return <p className="text-[11px] text-red-700">Vignette impossible : {error}</p>;
  if (!file) return <div className="animate-pulse rounded bg-neutral-100" style={{ width, height: width * 0.36 }} />;
  return <FacesPreview doc={file.document} width={width} testId={vid} />;
}

// ---------------------------------------------------------------- dialogues

/**
 * Formulaire de la boîte « Enregistrer une version », monté à chaque ouverture : le nom proposé (la date)
 * est dans le champ dès le premier rendu, et entièrement sélectionné quand le champ prend le focus. Taper
 * un nom le remplace au lieu de s'y ajouter.
 */
function SaveVersionForm({ onClose }: { onClose(): void }) {
  const [name, setName] = useState(defaultVersionName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await saveVersion(name.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Input
        name="versionName"
        aria-label="Nom de la version"
        value={name}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
      />
      {error && <p className="text-[12px] text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy || !name.trim()} data-action="confirm-save-version">
          <Save />
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

function SaveVersionDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-save-version-dialog>
        <DialogHeader>
          <DialogTitle>Enregistrer une version</DialogTitle>
          <DialogDescription>Une copie nommée et datée du document, à comparer ou restaurer plus tard (panneau Versions).</DialogDescription>
        </DialogHeader>
        {open && <SaveVersionForm onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function CompareDialog({ version, onClose, onRestore }: { version: VersionMeta | null; onClose(): void; onRestore(v: VersionMeta): void }) {
  const doc = useEditor((s) => s.doc);
  const docId = useEditor((s) => s.docId);
  const width = 460;
  return (
    <Dialog open={!!version} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[1000px]" data-compare-dialog>
        {version && doc && docId && (
          <>
            <DialogHeader>
              <DialogTitle>Comparer avec « {version.name} »</DialogTitle>
              <DialogDescription>À gauche la version du {formatVersionDate(version.createdAt)}, à droite l’état actuel du document.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-6 overflow-y-auto">
              <figure className="flex flex-col gap-1.5">
                <figcaption className="text-[12px] font-medium text-neutral-700">{version.name}</figcaption>
                <VersionThumbnail docId={docId} vid={version.id} width={width} />
              </figure>
              <figure className="flex flex-col gap-1.5">
                <figcaption className="text-[12px] font-medium text-neutral-700">État actuel</figcaption>
                <FacesPreview doc={doc} width={width} testId="current" />
              </figure>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Fermer
              </Button>
              <Button onClick={() => onRestore(version)}>
                <RotateCcw />
                Restaurer cette version
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RestoreDialog({ version, onClose }: { version: VersionMeta | null; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [version]);
  return (
    <Dialog open={!!version} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-restore-dialog>
        {version && (
          <>
            <DialogHeader>
              <DialogTitle>Restaurer « {version.name} » ?</DialogTitle>
              <DialogDescription>
                L’état actuel sera d’abord enregistré comme version « Avant restauration de « {version.name} » » : rien n’est perdu. Ctrl+Z annule aussi la restauration.
              </DialogDescription>
            </DialogHeader>
            {error && <p className="text-[12px] text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Annuler
              </Button>
              <Button
                disabled={busy}
                data-action="confirm-restore-version"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await restoreVersion(version);
                    onClose();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RotateCcw />
                Restaurer
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- barre du haut et panneau

function SaveVersionButton() {
  const [open, setOpen] = useState(false);
  const hasDoc = useEditor((s) => !!s.doc);
  return (
    <>
      <Button variant="outline" size="sm" disabled={!hasDoc} onClick={() => setOpen(true)} data-action="save-version">
        <Save />
        Enregistrer une version
      </Button>
      <SaveVersionDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function VersionsPanel() {
  const docId = useEditor((s) => s.docId);
  const list = useVersions((s) => s.list);
  const loading = useVersions((s) => s.loading);
  const error = useVersions((s) => s.error);
  const notice = useVersions((s) => s.notice);
  const [saveOpen, setSaveOpen] = useState(false);
  const [compare, setCompare] = useState<VersionMeta | null>(null);
  const [restore, setRestore] = useState<VersionMeta | null>(null);

  useEffect(() => {
    if (docId) void versionsStore.getState().reload(docId);
  }, [docId]);

  if (!docId) return null;
  return (
    <div className="flex flex-col" data-versions-panel>
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
        <Button size="sm" className="flex-1" onClick={() => setSaveOpen(true)} data-action="panel-save-version">
          <Save />
          Enregistrer une version
        </Button>
      </div>
      {notice && (
        <p className="mx-3 mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[12px] text-emerald-900" role="status" data-versions-notice>
          {notice}
        </p>
      )}
      {error && <p className="mx-3 mt-2 text-[12px] text-red-700">{error}</p>}
      {!loading && !list.length && !error && (
        <p className="px-3 py-4 text-[12px] text-neutral-500">
          Aucune version pour l’instant. Enregistrez une version avant une grosse retouche : vous pourrez comparer et revenir en arrière.
        </p>
      )}
      <ul className="flex flex-col">
        {list.map((v) => (
          <li key={v.id} className="border-b border-neutral-100 px-3 py-2.5" data-version-row={v.id}>
            <VersionThumbnail docId={docId} vid={v.id} width={258} />
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" data-version-name>
                {v.name}
              </span>
              {v.kind === 'auto' && <span className="shrink-0 rounded bg-neutral-100 px-1 text-[10px] text-neutral-600">copie auto</span>}
            </div>
            <div className="text-[11px] text-neutral-500">{formatVersionDate(v.createdAt)}</div>
            <div className="mt-1.5 flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setCompare(v)} data-action="compare-version">
                <ArrowLeftRight />
                Comparer
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRestore(v)} data-action="restore-version">
                <RotateCcw />
                Restaurer
              </Button>
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Supprimer la version"
                title="Supprimer la version"
                data-action="delete-version"
                onClick={() => {
                  if (window.confirm(`Supprimer la version « ${v.name} » ?`)) void deleteVersion(v);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <SaveVersionDialog open={saveOpen} onOpenChange={setSaveOpen} />
      <CompareDialog
        version={compare}
        onClose={() => setCompare(null)}
        onRestore={(v) => {
          setCompare(null);
          setRestore(v);
        }}
      />
      <RestoreDialog version={restore} onClose={() => setRestore(null)} />
    </div>
  );
}

registerPanel({ id: 'versions', title: 'Versions', icon: History, order: 70, component: VersionsPanel });
registerTopbarAction({ id: 'save-version', order: 30, label: 'Enregistrer une version', component: SaveVersionButton });
