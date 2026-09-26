// « Nouveau document depuis Word » (page d'accueil) : un fichier .docx, un nom, un gabarit. Le serveur lit
// le fichier (refus clair d'un .doc, d'un fichier chiffré…), crée le document vierge et enregistre les images
// (POST /api/doc/from-word) ; l'éditeur, qui seul sait mesurer la coulée du texte, remplit ensuite toutes les
// faces à l'ouverture (remplissage automatique, word/PlaceWord.tsx) et affiche le rapport.
import { FileText, Loader2, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { createFromWord, DOCX_ACCEPT, stashPendingWord } from '../word/client';
import { openDocument, TemplatePicker, useTemplateChoice } from './DocumentDialogs';

/** Nom proposé d'après le fichier : « rapport_annuel.docx » → « rapport annuel ». */
const nameFromFile = (file: File | null) => (file ? file.name.replace(/\.docx$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() : '');

export function NewFromWordDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const choice = useTemplateChoice(open);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [typography, setTypography] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = !!file && !!choice.templates?.some((t) => t.id === choice.templateId) && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate || !file) return;
    setBusy(true);
    setError(null);
    try {
      const response = await createFromWord(file, { name: name.trim() || nameFromFile(file), templateId: choice.templateId });
      const { id, ...word } = response;
      stashPendingWord(id, { response: word, options: { autoFill: true, typography } });
      openDocument(id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="max-w-2xl" data-new-from-word-dialog>
        <DialogHeader>
          <DialogTitle>Nouveau document depuis Word</DialogTitle>
          <DialogDescription>
            Le texte du fichier remplit toutes les faces du gabarit choisi, volet par volet, dans des blocs chaînés ; les styles Word deviennent des styles de
            paragraphe, les images vont dans le panneau Images.
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-from-word-file">Fichier Word (.docx)</Label>
            <input
              id="new-from-word-file"
              name="word-file"
              type="file"
              accept={DOCX_ACCEPT}
              disabled={busy}
              className="text-[12px] text-neutral-700 file:mr-2 file:h-7 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-2 file:text-[12px] file:font-medium hover:file:bg-neutral-100"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-from-word-name">Nom du document</Label>
            <Input
              id="new-from-word-name"
              name="document-name"
              autoComplete="off"
              maxLength={120}
              disabled={busy}
              placeholder={nameFromFile(file) || 'Nom du fichier Word'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <TemplatePicker choice={choice} />
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" name="word-typography" checked={typography} disabled={busy} onChange={(e) => setTypography(e.target.checked)} />
            Typographie française (espaces insécables, apostrophes courbes, guillemets « »)
          </label>
          {error && (
            <div role="alert" className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900" data-new-from-word-error>
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={!canCreate} data-action="create-from-word">
              {busy ? <Loader2 className="animate-spin" /> : <FileText />}
              Créer et remplir
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
