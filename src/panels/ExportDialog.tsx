// Boîte de dialogue Export (tâche 4.4, décision P2) : choix du préréglage (print/presets.json), résumé
// de ses réglages, progression, puis liens de téléchargement du PDF (et des aperçus PNG de l'e-mail).
// L'export imprimeur refuse de partir tant qu'une photo provisoire est en place (décision I3) ; une photo
// sous 150 ppi demande confirmation (décision I2), comme un calque imprimable masqué (audit B3).
import { AlertTriangle, CheckCircle2, Download, FileDown, Loader2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportJob, ExportResult } from '../../server/export';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { registerTopbarAction } from '../editor/registry/api';
import { cn } from '../lib/utils';
import { placeholderFrames } from '../model/images';
import { hiddenPrintableLayers } from '../model/preflight';
import { getEditor, useEditor } from '../store/documentStore';
import { getPersistence } from '../store/persistence';
import { usePresets, type PresetSummary, type PresetsResponse } from './printColors';

const POLL_MS = 400;

const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const downloadUrl = (docId: string, file: string) => `/api/doc/${encodeURIComponent(docId)}/exports/${encodeURIComponent(fileName(file))}`;

/** Résumé lisible d'un préréglage : une ligne par réglage qui compte pour l'imprimeur. */
export function presetSummary(preset: PresetSummary, presets: PresetsResponse): [string, string][] {
  const profile = preset.profile ? (presets.profiles[preset.profile]?.label ?? preset.profile) : null;
  const rows: [string, string][] = [
    ['Norme', preset.standard ?? 'PDF simple (sans norme d’impression)'],
    ['Couleurs', preset.colorMode === 'cmyk' ? 'CMJN : encres exactes du nuancier' : 'RVB, telles qu’à l’écran'],
  ];
  if (profile) rows.push(['Profil de sortie', profile]);
  if (preset.colorMode === 'cmyk') {
    const intent = preset.imageIntent === 'perceptual' ? 'perceptive' : (preset.imageIntent ?? 'perceptive');
    const resample =
      preset.downsamplePpi && preset.downsampleAbovePpi
        ? `réduites à ${preset.downsamplePpi} ppi au-delà de ${preset.downsampleAbovePpi} ppi`
        : 'sans rééchantillonnage';
    rows.push(['Photos', `converties au profil (intention ${intent}), ${resample} ; un original CMJN garde ses encres`]);
  } else if (preset.downsamplePpi) rows.push(['Photos', `réduites à ${preset.downsamplePpi} ppi`]);
  rows.push(['Fond perdu', preset.bleed ? `${String(preset.bleed).replace('.', ',')} mm` : 'aucun (coupé au format fini)']);
  rows.push(['Traits de coupe', preset.cropMarks ? `oui, avec repères de pli (page agrandie de ${preset.marksMargin ?? 10} mm)` : 'non']);
  if (preset.maxInk) rows.push(['Encrage maximal', `${preset.maxInk} %`]);
  if (preset.maxBytes) {
    rows.push(
      preset.colorMode === 'cmyk'
        ? ['Poids', `avertissement au-delà de ${Math.round(preset.maxBytes / 1e6)} Mo (limite courante des imprimeurs)`]
        : ['Poids visé', `moins de ${Math.round(preset.maxBytes / 1e6)} Mo`],
    );
  }
  if (preset.pngPpi) rows.push(['Aperçus', `une image PNG par face à ${preset.pngPpi} ppi`]);
  return rows;
}

function ResultView({ docId, result }: { docId: string; result: ExportResult }) {
  const check = result.check;
  return (
    <div className="flex flex-col gap-2" data-export-result>
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">
        <CheckCircle2 className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {fileName(result.file)} · {result.pages} pages · {(result.bytes / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo
        </span>
        <Button size="sm" asChild>
          <a href={downloadUrl(docId, result.file)} download={fileName(result.file)} data-export-download>
            <Download />
            Télécharger
          </a>
        </Button>
      </div>
      {result.pngs.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[12px]" data-export-pngs>
          {result.pngs.map((png) => (
            <a key={png} className="text-sky-700 hover:underline" href={downloadUrl(docId, png)} download={fileName(png)} data-export-png>
              {fileName(png)}
            </a>
          ))}
        </div>
      )}
      {check && (
        <p className={cn('text-[12px]', check.ok ? 'text-neutral-600' : 'text-red-700')} data-export-check={check.ok ? 'ok' : 'erreur'}>
          Contrôle {result.standard} : {check.ok ? 'conforme' : 'non conforme'} · {check.stats.outputCondition} · encrage maximal {check.stats.maxInkVector} % (aplats),{' '}
          {check.stats.maxInkImages} % (photos). À confirmer par Acrobat Pro ou le contrôle en ligne de l’imprimeur.
        </p>
      )}
      {result.warnings.length > 0 && (
        <details className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-950" data-export-warnings open={result.warnings.length <= 3}>
          <summary className="cursor-pointer select-none font-medium">
            {result.warnings.length} avertissement{result.warnings.length > 1 ? 's' : ''}
          </summary>
          <ul className="mt-1 flex max-h-40 list-disc flex-col gap-0.5 overflow-y-auto pl-4">
            {result.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const presets = usePresets();
  const doc = useEditor((s) => s.doc);
  const docId = useEditor((s) => s.docId);
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (presets && !selected) setSelected(presets.defaultPreset);
  }, [presets, selected]);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const placeholders = useMemo(() => (doc ? placeholderFrames(doc) : []), [doc]);
  // Calques imprimables masqués : leurs objets manqueraient au PDF sans que rien ne le dise (audit B3).
  const hiddenLayers = useMemo(() => (doc ? hiddenPrintableLayers(doc) : []), [doc]);
  const [acceptHidden, setAcceptHidden] = useState(false);
  const preset = presets && selected ? presets.presets[selected] : null;
  const blocked = !!preset?.refusePlaceholders && placeholders.length > 0;
  // L'export imprimeur n'accepte un calque masqué qu'une fois la case cochée.
  const needsHiddenConfirm = !!preset?.refusePlaceholders && hiddenLayers.length > 0 && !acceptHidden;
  const running = job?.state === 'running';
  // Refus que l'utilisateur peut lever d'un clic (photos sous 150 ppi, calque masqué), sans erreur rouge restante.
  const pendingConfirm = job?.state === 'error' && Array.isArray(job.details?.confirm) ? (job.details.confirm as string[]) : [];

  const poll = (id: string) => {
    timer.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/export-jobs/${id}`);
        const next = (await res.json()) as ExportJob;
        setJob(next);
        if (next.state === 'running') poll(id);
      } catch (e) {
        setError((e as Error).message);
      }
    }, POLL_MS);
  };

  /** `confirm` : confirmations données en réponse à un refus (« Exporter quand même »). */
  const start = async (confirm: string[] = []) => {
    if (!docId || !selected) return;
    setError(null);
    setJob(null);
    if (getEditor().gesture) {
      setError('Terminez d’abord la modification en cours (texte, recadrage…).');
      return;
    }
    try {
      // L'export lit le document sur le disque : on enregistre d'abord ce qui est à l'écran.
      await getPersistence()?.saveNow();
      const query = new URLSearchParams({ preset: selected });
      if (confirm.includes('low-resolution')) query.set('confirmLowResolution', '1');
      if (confirm.includes('hidden-layers') || acceptHidden) query.set('confirmHiddenLayers', '1');
      const res = await fetch(`/api/doc/${encodeURIComponent(docId)}/export-jobs?${query}`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      setJob(body as ExportJob);
      poll((body as ExportJob).id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent className="max-w-2xl" data-export-dialog>
        <DialogHeader>
          <DialogTitle>Exporter en PDF</DialogTitle>
          <DialogDescription>Le document est enregistré, puis rendu par Chrome et préparé selon le préréglage choisi.</DialogDescription>
        </DialogHeader>
        {!presets ? (
          <p className="flex items-center gap-2 text-neutral-500">
            <Loader2 className="size-4 animate-spin" /> Chargement des préréglages…
          </p>
        ) : (
          <div className="grid min-h-0 grid-cols-[minmax(0,15rem)_1fr] gap-4 overflow-y-auto">
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Préréglage d’export">
              {Object.values(presets.presets).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={selected === p.id}
                  disabled={running}
                  data-export-preset={p.id}
                  onClick={() => {
                    setSelected(p.id);
                    setJob(null);
                    setError(null);
                  }}
                  className={cn(
                    'flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors',
                    selected === p.id ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:bg-neutral-50',
                  )}
                >
                  <span className="text-[13px] font-medium">{p.label}</span>
                  <span className="text-[11px] leading-snug text-neutral-500">{p.description}</span>
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              {preset && (
                <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1 text-[12px]" data-export-summary={preset.id}>
                  {presetSummary(preset, presets).map(([label, value], i) => (
                    <div key={i} className="contents">
                      <dt className="text-neutral-500">{label}</dt>
                      <dd className="text-neutral-900">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {blocked && (
                <div role="alert" className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900" data-export-blocked>
                  <XCircle className="mt-0.5 size-4 shrink-0" />
                  <div>
                    Export imprimeur impossible : {placeholders.length} cadre{placeholders.length > 1 ? 's portent' : ' porte'} une photo provisoire (tirée du PDF Canva),
                    à remplacer par l’original :
                    <ul className="mt-1 list-disc pl-4">
                      {placeholders.map((f) => (
                        <li key={f.id}>
                          {f.name}
                          {f.page ? ` (${f.page})` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {hiddenLayers.length > 0 && (
                <div role="alert" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-950" data-export-hidden-layers>
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div className="flex flex-col gap-1">
                    <span>
                      {hiddenLayers.length > 1 ? 'Calques imprimables masqués' : 'Calque imprimable masqué'} : leurs objets ne seront pas dans le PDF.
                    </span>
                    <ul className="list-disc pl-4">
                      {hiddenLayers.map((l) => (
                        <li key={l.id}>
                          « {l.name} » : {l.objects} objet{l.objects > 1 ? 's' : ''}
                        </li>
                      ))}
                    </ul>
                    {preset?.refusePlaceholders && (
                      <label className="flex items-center gap-1.5 font-medium">
                        <input type="checkbox" name="confirmHiddenLayers" checked={acceptHidden} disabled={running} onChange={(e) => setAcceptHidden(e.target.checked)} />
                        Exporter pour l’imprimeur sans ces objets
                      </label>
                    )}
                  </div>
                </div>
              )}
              {job && job.state !== 'error' && (
                <div className="flex flex-col gap-1" data-export-progress={Math.round(job.progress.progress * 100)}>
                  <div className="flex items-center justify-between text-[12px] text-neutral-600">
                    <span className="flex items-center gap-1.5">
                      {job.state === 'running' && <Loader2 className="size-3.5 animate-spin" />}
                      {job.progress.label}
                    </span>
                    <span className="tabular-nums">{Math.round(job.progress.progress * 100)} %</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200">
                    <div className="h-full rounded-full bg-neutral-900 transition-[width] duration-300" style={{ width: `${Math.round(job.progress.progress * 100)}%` }} />
                  </div>
                </div>
              )}
              {job?.state === 'done' && job.result && docId && <ResultView docId={docId} result={job.result} />}
              {(error || job?.state === 'error') && (
                <div role="alert" className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900" data-export-error>
                  <span className="flex gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {error ?? job?.error}
                  </span>
                  {pendingConfirm.length > 0 && (
                    <div>
                      <Button variant="destructive" size="sm" data-action="export-confirm" data-confirm={pendingConfirm.join(' ')} onClick={() => void start(pendingConfirm)}>
                        Exporter quand même
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-auto flex justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={running} onClick={() => onOpenChange(false)}>
                  Fermer
                </Button>
                <Button size="sm" disabled={!preset || blocked || needsHiddenConfirm || running} data-action="start-export" onClick={() => void start()}>
                  {running ? <Loader2 className="animate-spin" /> : <FileDown />}
                  Exporter
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExportButton() {
  const [open, setOpen] = useState(false);
  const ready = useEditor((s) => !!s.doc);
  return (
    <>
      <Button size="sm" disabled={!ready} data-topbar-action="export" onClick={() => setOpen(true)}>
        <FileDown />
        Exporter
      </Button>
      {open && <ExportDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

registerTopbarAction({ id: 'export', order: 10, label: 'Exporter', icon: FileDown, component: ExportButton });
