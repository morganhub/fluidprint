// Bouton « Importer un design Claude Design » de la liste des documents : l'export HTML du design part au
// serveur (POST /api/import/claude-design), qui lance l'importeur ; la boîte de dialogue suit l'import puis
// résume le rapport (objets, avertissements, QR codes) avant d'ouvrir le document.
import { AlertTriangle, CheckCircle2, FileUp, Loader2, QrCode, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { ImportResponse } from '../../server/importDesign';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Label, NativeSelect } from '../components/ui/input';
import { describeTemplate, TEMPLATES } from '../model/templates';
import { serverFetch } from '../store/http';

export interface ImportDesignButtonProps {
  /** Appelé avec l'identifiant du document créé par l'import, quand l'utilisateur choisit de l'ouvrir. */
  onImported: (docId: string) => void;
}

/** Valeur « Détection automatique » du champ Gabarit (même valeur que AUTO_TEMPLATE côté serveur). */
const AUTO = 'auto';

type Step =
  | { kind: 'form' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'done'; result: ImportResponse }
  | { kind: 'error'; message: string };

const TYPE_LABELS: Record<string, [string, string]> = {
  text: ['texte', 'textes'],
  rect: ['rectangle', 'rectangles'],
  ellipse: ['ellipse', 'ellipses'],
  line: ['trait', 'traits'],
  path: ['tracé', 'tracés'],
  frame: ['cadre photo', 'cadres photo'],
  icon: ['icône', 'icônes'],
  svg: ['graphique', 'graphiques'],
  qr: ['QR code', 'QR codes'],
  group: ['groupe', 'groupes'],
};

const count = (n: number, [one, many]: [string, string]) => `${n} ${n > 1 ? many : one}`;

/** Nom que le serveur donnera faute de mieux : le `<title>` du design, sinon le nom du fichier. */
async function suggestedName(file: File): Promise<string> {
  const fromFile = file.name.replace(/\.html?$/i, '').replace(/\.dc$/i, '').replace(/_+/g, ' ').trim();
  try {
    const text = await file.text();
    const head = text.slice(0, Math.max(0, text.search(/<doc-page\b/i)) || text.length);
    const raw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
    const title = raw ? new DOMParser().parseFromString(raw, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() : '';
    return title || fromFile;
  } catch {
    return fromFile;
  }
}

function Summary({ result }: { result: ImportResponse }) {
  const { report } = result;
  const types = Object.entries(report.objects.byType).sort((a, b) => b[1] - a[1]);
  const decoded = report.qrCodes.filter((q) => q.decoded).length;
  return (
    <div className="flex flex-col gap-2" data-import-result={result.id}>
      <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{report.name}</div>
          <div className="text-[12px]" data-import-format={report.format.id}>
            {report.format.origin === 'custom'
              ? // Le nom d'un format sur mesure dit déjà sa taille (« Format sur mesure 100 × 100 mm »).
                [report.format.name, ...report.format.description.split(' · ').slice(1)].join(' · ')
              : `${report.format.name} (${report.format.originLabel}) · ${report.format.description}`}
          </div>
          <div className="text-[12px]">
            Pages : {report.pages.map((p) => p.name).join(', ')} · import en {(report.durationMs / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s
          </div>
        </div>
      </div>
      <p className="text-[12px]" data-import-objects={report.objects.total}>
        <span className="font-semibold">{report.objects.total} objets</span>
        {types.length > 0 && ` : ${types.map(([t, n]) => (TYPE_LABELS[t] ? count(n, TYPE_LABELS[t]) : `${n} ${t}`)).join(', ')}`}
        {report.skipped > 0 && ` · ${report.skipped} élément${report.skipped > 1 ? 's' : ''} ignoré${report.skipped > 1 ? 's' : ''} (voir le rapport)`}
      </p>
      {report.qrCodes.length > 0 && (
        <div className="flex flex-col gap-1 text-[12px]" data-import-qr={decoded}>
          <div className="flex items-center gap-1.5 font-medium">
            <QrCode className="size-3.5" />
            {decoded} QR code{decoded > 1 ? 's' : ''} décodé{decoded > 1 ? 's' : ''} sur {report.qrCodes.length}
          </div>
          <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto pl-5">
            {report.qrCodes.map((q) => (
              <li key={q.id} className={q.decoded ? 'text-neutral-700' : 'text-red-700'}>
                {q.decoded ? q.url : `${q.url} : illisible, adresse provisoire à corriger`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.warnings.length > 0 ? (
        <details className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-950" data-import-warnings={report.warnings.length} open={report.warnings.length <= 4}>
          <summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5" />
            {report.warnings.length} avertissement{report.warnings.length > 1 ? 's' : ''} à vérifier
          </summary>
          <ul className="mt-1 flex max-h-40 list-disc flex-col gap-0.5 overflow-y-auto pl-4">
            {report.warnings.map((w, i) => (
              <li key={i}>
                {w.faceId !== 'document' && <span className="text-amber-800">{w.faceId} · </span>}
                {w.what} : {w.why}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="text-[12px] text-neutral-500" data-import-warnings={0}>
          Aucun avertissement.
        </p>
      )}
      <p className="text-[11px] text-neutral-500">Rapport complet : documents/{result.id}/import-report.md</p>
    </div>
  );
}

export function ImportDesignButton({ onImported }: ImportDesignButtonProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [placeholder, setPlaceholder] = useState('');
  const [template, setTemplate] = useState(AUTO);
  const [elapsed, setElapsed] = useState(0);
  const running = step.kind === 'running';

  useEffect(() => {
    if (step.kind !== 'running') return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - step.startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [step]);

  const reset = () => {
    setStep({ kind: 'form' });
    setFile(null);
    setName('');
    setPlaceholder('');
    setTemplate(AUTO);
  };

  const chooseFile = async (chosen: File | null) => {
    setFile(chosen);
    setPlaceholder(chosen ? await suggestedName(chosen) : '');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || running) return;
    const form = new FormData();
    // Champs avant le fichier : le serveur les a en main dès qu'il lit le fichier.
    if (name.trim()) form.append('name', name.trim());
    form.append('template', template);
    form.append('file', file, file.name);
    setElapsed(0);
    setStep({ kind: 'running', startedAt: Date.now() });
    try {
      const res = await serverFetch('/api/import/claude-design', { method: 'POST', body: form }, 'import non lancé');
      const body = (await res.json().catch(() => null)) as (ImportResponse & { error?: string }) | null;
      if (!res.ok || !body?.id) throw new Error(body?.error ?? `Erreur ${res.status}`);
      setStep({ kind: 'done', result: body });
    } catch (error) {
      setStep({ kind: 'error', message: (error as Error).message });
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-import-design>
        <FileUp />
        Importer un design Claude Design
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Pendant l'import, la boîte reste ouverte : son résultat (l'identifiant du document) serait perdu.
          if (running) return;
          setOpen(next);
          if (!next && step.kind !== 'form') reset();
        }}
      >
        <DialogContent className="max-w-xl" data-import-dialog>
          <DialogHeader>
            <DialogTitle>Importer un design Claude Design</DialogTitle>
            <DialogDescription>
              Export HTML d'un design Claude Design mis en pages (une section par face). Le format est déduit du design : le gabarit dont
              les faces ont la même taille, sinon un format sur mesure (fond perdu et plis lus dans les repères du design).
            </DialogDescription>
          </DialogHeader>

          {(step.kind === 'form' || step.kind === 'error' || running) && (
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex flex-col gap-1">
                <Label htmlFor="import-design-file">Fichier du design (.html)</Label>
                <input
                  id="import-design-file"
                  name="design-file"
                  type="file"
                  accept=".html,.htm,text/html"
                  disabled={running}
                  className="text-[12px] text-neutral-700 file:mr-2 file:h-7 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-2 file:text-[12px] file:font-medium hover:file:bg-neutral-100"
                  onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="import-design-name">Nom du document</Label>
                <Input
                  id="import-design-name"
                  name="design-name"
                  value={name}
                  maxLength={120}
                  disabled={running}
                  placeholder={placeholder || 'Titre du design, sinon nom du fichier'}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="import-design-template">Gabarit</Label>
                <NativeSelect id="import-design-template" name="design-template" value={template} disabled={running} onChange={(e) => setTemplate(e.target.value)}>
                  <option value={AUTO}>Détection automatique</option>
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {describeTemplate(t)}
                    </option>
                  ))}
                </NativeSelect>
              </div>

              {running && (
                <div className="flex flex-col gap-1.5" role="status" data-import-progress>
                  <div className="flex items-center gap-2 text-[12px] text-neutral-700">
                    <Loader2 className="size-3.5 animate-spin" />
                    Import en cours ({elapsed} s) : mesure du design dans Chrome, décodage des QR codes, création des objets…
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                    <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-500" />
                  </div>
                </div>
              )}
              {step.kind === 'error' && (
                <div role="alert" className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900" data-import-error>
                  <XCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{step.message}</span>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={running} onClick={() => setOpen(false)}>
                  Annuler
                </Button>
                <Button type="submit" disabled={!file || running} data-import-submit>
                  {running ? <Loader2 className="animate-spin" /> : <FileUp />}
                  Importer
                </Button>
              </div>
            </form>
          )}

          {step.kind === 'done' && (
            <>
              <Summary result={step.result} />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={reset}>
                  Importer un autre design
                </Button>
                <Button
                  data-import-open
                  onClick={() => {
                    setOpen(false);
                    onImported(step.result.id);
                    reset();
                  }}
                >
                  Ouvrir le document
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
