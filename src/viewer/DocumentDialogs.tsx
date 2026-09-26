// Boîtes de la page d'accueil : « Nouveau document » (nom + gabarit) et « Dupliquer » (nom de la copie).
// Les deux ouvrent le document créé dans l'éditeur ; le serveur choisit l'identifiant (server/templates.ts).
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { cn } from '../lib/utils';
import { duplicateName, type TemplateSummary } from '../model/newDocument';
import { DEFAULT_TEMPLATE_ID } from '../model/templates';
import { serverFetch } from '../store/http';

/** Ouvre un document dans l'éditeur. */
export const openDocument = (id: string) => location.assign(`/doc/${encodeURIComponent(id)}`);

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await serverFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
  return data as T;
}

const mm = (v: number) => String(v).replace('.', ',');

function facesLabel(t: TemplateSummary): string {
  const panels = Math.max(...t.faces.map((f) => f.panels.length));
  const faces = t.faces.length === 1 ? '1 face' : `${t.faces.length} faces`;
  return panels > 1 ? `${faces} · ${panels} volets` : faces;
}

/** Schéma d'un gabarit à l'échelle : ses faces côte à côte, plis en pointillés. */
function TemplateDiagram({ template }: { template: TemplateSummary }) {
  const { w, h } = template.trim;
  const gap = Math.max(w, h) * 0.08;
  const total = template.faces.length * w + (template.faces.length - 1) * gap;
  const pad = Math.max(total, h) * 0.02;
  return (
    <svg viewBox={`${-pad} ${-pad} ${total + 2 * pad} ${h + 2 * pad}`} className="h-14 w-full text-neutral-400" aria-hidden="true">
      {template.faces.map((face, i) => {
        const x0 = i * (w + gap);
        let x = x0;
        const folds = face.panels.slice(0, -1).map((p) => (x += p.w));
        return (
          <g key={face.id} data-template-face={face.id}>
            <rect x={x0} y={0} width={w} height={h} fill="#ffffff" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {folds.map((fx) => (
              <line key={fx} data-template-fold={fx - x0} x1={fx} x2={fx} y1={0} y2={h} stroke="#0891b2" strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export function TemplateCard({ template, selected, onSelect }: { template: TemplateSummary; selected: boolean; onSelect(): void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-template-id={template.id}
      title={template.description}
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border bg-white p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
        selected ? 'border-neutral-900 ring-1 ring-neutral-900' : 'border-neutral-200 hover:border-neutral-400',
      )}
    >
      <div className="rounded-md bg-neutral-100 px-2 py-1.5">
        <TemplateDiagram template={template} />
      </div>
      <div className="text-[13px] font-medium leading-tight text-neutral-900">{template.name}</div>
      <div className="text-[11px] leading-tight text-neutral-500">
        {mm(template.trim.w)} × {mm(template.trim.h)} mm
        <br />
        {facesLabel(template)}
      </div>
    </button>
  );
}

/**
 * Gabarits (GET /api/templates) et gabarit choisi, chargés à la première ouverture d'une boîte : la liste
 * ne change pas en cours de session. Partagé par « Nouveau document » et « Nouveau document depuis Word ».
 */
export function useTemplateChoice(open: boolean) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  useEffect(() => {
    if (!open || templates) return;
    let cancelled = false;
    serverFetch('/api/templates')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Erreur ${res.status}`);
        return (await res.json()) as TemplateSummary[];
      })
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        setLoadError(null);
        setTemplateId((id) => (list.some((t) => t.id === id) ? id : (list[0]?.id ?? id)));
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [open, templates]);
  return { templates, loadError, templateId, setTemplateId };
}

/** Cartes des gabarits, dans une boîte de création. */
export function TemplatePicker({ choice }: { choice: ReturnType<typeof useTemplateChoice> }) {
  const { templates, loadError, templateId, setTemplateId } = choice;
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-neutral-500">Format</span>
      {loadError && <p className="text-[12px] text-red-700">Gabarits indisponibles : {loadError}</p>}
      {!templates && !loadError && <p className="text-[12px] text-neutral-500">Chargement des gabarits…</p>}
      {templates && (
        <div className="grid min-h-0 grid-cols-2 gap-2 overflow-y-auto p-0.5 sm:grid-cols-3" role="group" aria-label="Format du document" data-template-list>
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} selected={t.id === templateId} onSelect={() => setTemplateId(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** « Nouveau document » : nom, gabarit (cartes), Créer → ouvre le document dans l'éditeur. */
export function NewDocumentDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const choice = useTemplateChoice(open);
  const { templates, templateId } = choice;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const canCreate = !!name.trim() && !!templates?.some((t) => t.id === templateId) && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await postJson<{ id: string }>('/api/doc', { name: name.trim(), templateId });
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
      <DialogContent
        className="max-w-2xl"
        data-new-document-dialog
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameInput.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Nouveau document</DialogTitle>
          <DialogDescription>Choisissez un format : le document s’ouvre vide, avec ses repères de coupe et de plis, trois calques et un nuancier de départ.</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-document-name">Nom</Label>
            <Input
              ref={nameInput}
              id="new-document-name"
              name="document-name"
              autoComplete="off"
              placeholder="Ex. : Flyer portes ouvertes"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <TemplatePicker choice={choice} />
          {error && (
            <p className="text-[12px] text-red-700" role="alert" data-new-document-error>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={!canCreate} data-action="create-document">
              {busy && <Loader2 className="animate-spin" />}
              Créer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * « Dupliquer » : nom de la copie proposé (« Copie de … »), entièrement sélectionné pour être remplacé d'une
 * frappe. À monter avec `key={source.id}` : le nom proposé est posé au montage, avant la mise au point.
 */
export function DuplicateDocumentDialog({ source, onClose }: { source: { id: string; name: string }; onClose(): void }) {
  const [name, setName] = useState(() => duplicateName(source.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await postJson<{ id: string }>(`/api/doc/${encodeURIComponent(source.id)}/duplicate`, { name: name.trim() });
      openDocument(id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="max-w-md"
        data-duplicate-document-dialog
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameInput.current?.focus();
          nameInput.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>Dupliquer « {source.name} »</DialogTitle>
          <DialogDescription>La copie reprend les pages, le nuancier, les styles et les images. L’historique, les versions et les exports restent avec l’original.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="duplicate-document-name">Nom de la copie</Label>
            <Input ref={nameInput} id="duplicate-document-name" name="duplicate-name" autoComplete="off" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {error && (
            <p className="text-[12px] text-red-700" role="alert" data-duplicate-document-error>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={!name.trim() || busy} data-action="confirm-duplicate">
              {busy && <Loader2 className="animate-spin" />}
              Dupliquer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
