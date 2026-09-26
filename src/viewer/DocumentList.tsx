import { Copy, FilePlus2, FileText, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { DuplicateDocumentDialog, NewDocumentDialog, openDocument } from './DocumentDialogs';
import { ImportDesignButton } from './ImportDesignButton';
import { NewFromWordDialog } from './NewFromWordDialog';

interface DocumentSummary {
  id: string;
  name: string;
  editedAt?: string;
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Page d'accueil : les documents du dossier documents/ (éditeur, visionneuse, impression, duplication), et la
 * création d'un document vierge d'après un gabarit, rempli d'un fichier Word, ou par import d'un design
 * Claude Design.
 */
export function DocumentList() {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fromWord, setFromWord] = useState(false);
  const [duplicating, setDuplicating] = useState<DocumentSummary | null>(null);

  useEffect(() => {
    fetch('/api/doc')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Erreur ${res.status}`);
        return (await res.json()) as DocumentSummary[];
      })
      .then(setDocs)
      .catch((e: Error) => setError(e.message));
  }, []);

  const empty = docs?.length === 0;
  const newButton = (
    <Button onClick={() => setCreating(true)} data-action="new-document">
      <Plus />
      Nouveau document
    </Button>
  );
  const wordButton = (
    <Button variant="outline" onClick={() => setFromWord(true)} data-action="new-from-word">
      <FileText />
      Nouveau document depuis Word
    </Button>
  );
  // Rendu une seule fois (en-tête, ou invitation de la liste vide) : il porte sa propre boîte de dialogue.
  const importButton = <ImportDesignButton onImported={openDocument} />;

  return (
    <main className="mx-auto max-w-3xl p-8 text-neutral-900">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Fluidprint</h1>
        {!empty && (
          <div className="flex flex-wrap items-center gap-2">
            {importButton}
            {wordButton}
            {newButton}
          </div>
        )}
      </header>
      {error && <p className="text-red-700">Liste des documents indisponible : {error}</p>}
      {!docs && !error && <p className="text-neutral-500">Chargement…</p>}
      {empty && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-neutral-300 px-6 py-10 text-center" data-empty-documents>
          <FilePlus2 className="size-8 text-neutral-400" aria-hidden="true" />
          <p className="font-semibold">Aucun document</p>
          <p className="max-w-md text-sm text-neutral-500">
            Créez un document à partir d’un format (dépliant, flyer, carte de visite, affiche…), remplissez-le d’un fichier Word, ou importez un design réalisé dans Claude Design.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            {newButton}
            {wordButton}
            {importButton}
          </div>
        </div>
      )}
      {docs && docs.length > 0 && (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-4 px-4 py-3" data-doc-id={d.id}>
              <div className="min-w-0 flex-1">
                <a href={`/doc/${d.id}`} className="font-semibold hover:underline">
                  {d.name}
                </a>
                <div className="text-xs text-neutral-500">
                  {d.id}
                  {d.editedAt && ` · modifié le ${dateFormat.format(new Date(d.editedAt))}`}
                </div>
              </div>
              <a href={`/view/${d.id}`} className="text-sm text-neutral-500 hover:text-neutral-900">
                Lecture seule
              </a>
              <a href={`/print/${d.id}`} className="text-sm text-neutral-500 hover:text-neutral-900" target="_blank" rel="noreferrer">
                Aperçu d'impression
              </a>
              <Button variant="ghost" size="sm" data-action="duplicate-document" onClick={() => setDuplicating(d)}>
                <Copy />
                Dupliquer
              </Button>
            </li>
          ))}
        </ul>
      )}
      <NewDocumentDialog open={creating} onOpenChange={setCreating} />
      <NewFromWordDialog open={fromWord} onOpenChange={setFromWord} />
      {duplicating && <DuplicateDocumentDialog key={duplicating.id} source={duplicating} onClose={() => setDuplicating(null)} />}
    </main>
  );
}
