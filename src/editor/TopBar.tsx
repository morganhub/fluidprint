// Barre du haut : nom du document, état d'enregistrement, actions enregistrées (Exporter…), annuler /
// rétablir, zoom.
import { AlertCircle, ArrowLeft, Check, Keyboard, Loader2, Maximize, Minus, Plus, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Tooltip } from '../components/ui/tooltip';
import { getEditor, useEditor } from '../store/documentStore';
import { getPersistence } from '../store/persistence';
import { formatCombo } from './keys';
import { topbarRegistry } from './registry/api';
import { uiStore } from './uiStore';

/**
 * Conflit d'enregistrement (le fichier a changé sur le disque depuis l'ouverture : autre onglet, script) :
 * rien n'a été écrit, l'utilisateur choisit. S'ouvre de lui-même ; « Plus tard » le ferme, l'indicateur
 * de la barre du haut le rouvre.
 */
function ConflictDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const message = useEditor((s) => s.save.message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: 'reload' | 'overwrite') => {
    const persistence = getPersistence();
    if (!persistence) return;
    setBusy(true);
    setError(null);
    try {
      await (action === 'reload' ? persistence.reload() : persistence.overwrite());
      if (getEditor().save.status !== 'conflict') onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-save-conflict-dialog>
        <DialogHeader>
          <DialogTitle>Document modifié ailleurs</DialogTitle>
          <DialogDescription>{message ?? 'Le document a été modifié ailleurs depuis son ouverture'} : vos dernières modifications n’ont pas été enregistrées.</DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-[12px] text-neutral-700">
          <li>
            <strong>Recharger</strong> : affiche le document du disque ; vos modifications non enregistrées sont abandonnées.
          </li>
          <li>
            <strong>Écraser</strong> : votre version remplace celle du disque (une copie de celle-ci est gardée dans l’historique du document).
          </li>
        </ul>
        {error && <p className="text-[12px] text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Plus tard
          </Button>
          <Button variant="outline" disabled={busy} data-action="conflict-reload" onClick={() => void run('reload')}>
            Recharger
          </Button>
          <Button disabled={busy} data-action="conflict-overwrite" onClick={() => void run('overwrite')}>
            Écraser
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Indicateur d'enregistrement : « Enregistré », « Modifications en cours », l'erreur ou le conflit. */
export function SaveIndicator() {
  const save = useEditor((s) => s.save);
  const dirty = save.status === 'dirty' || save.status === 'saving';
  const conflict = save.status === 'conflict';
  const [conflictOpen, setConflictOpen] = useState(false);
  // Chaque nouveau conflit rouvre la boîte (un Ctrl+S refusé, par exemple).
  useEffect(() => {
    if (conflict) setConflictOpen(true);
  }, [conflict, save.message]);
  if (conflict) {
    return (
      <>
        <button
          type="button"
          data-save-status="conflict"
          title={save.message ?? undefined}
          onClick={() => setConflictOpen(true)}
          className="flex max-w-80 items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
        >
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="truncate">Modifié ailleurs : non enregistré — choisir</span>
        </button>
        <ConflictDialog open={conflictOpen} onOpenChange={setConflictOpen} />
      </>
    );
  }
  if (save.status === 'error') {
    return (
      <button
        type="button"
        data-save-status="error"
        title={save.message ?? undefined}
        onClick={() => void getPersistence()?.saveNow()}
        className="flex max-w-80 items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50"
      >
        <AlertCircle className="size-3.5 shrink-0" />
        <span className="truncate">Erreur d’enregistrement : {save.message} — réessayer</span>
      </button>
    );
  }
  return (
    <span data-save-status={dirty ? 'dirty' : 'saved'} className="flex items-center gap-1 text-xs text-neutral-500" aria-live="polite">
      {dirty ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5 text-emerald-600" />}
      {dirty ? 'Modifications en cours' : 'Enregistré'}
    </span>
  );
}

function ZoomControl() {
  const zoom = useEditor((s) => s.zoom);
  const zoomMode = useEditor((s) => s.zoomMode);
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
      <Tooltip content="Zoom arrière" shortcut={formatCombo('Mod+-')}>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom arrière" onClick={() => getEditor().zoomStep(-1)}>
          <Minus />
        </Button>
      </Tooltip>
      <Tooltip content="Taille réelle" shortcut={formatCombo('Mod+1')}>
        <button type="button" data-testid="zoom-value" className="w-14 rounded px-1 py-1 text-center text-xs tabular-nums hover:bg-neutral-100" onClick={() => getEditor().setZoom(1)}>
          {Math.round(zoom * 100)} %
        </button>
      </Tooltip>
      <Tooltip content="Zoom avant" shortcut={formatCombo('Mod+=')}>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom avant" onClick={() => getEditor().zoomStep(1)}>
          <Plus />
        </Button>
      </Tooltip>
      <Tooltip content="Ajuster à l’écran" shortcut={formatCombo('Mod+0')}>
        <Button variant="toggle" size="sm" data-zoom-fit aria-pressed={zoomMode === 'fit'} onClick={() => getEditor().fit()}>
          <Maximize />
          Ajuster
        </Button>
      </Tooltip>
    </div>
  );
}

export function TopBar() {
  const name = useEditor((s) => s.doc?.name ?? s.docId ?? '');
  const history = useEditor((s) => s.history);
  const actions = topbarRegistry.use();
  const state = useEditor((s) => s);
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-2">
      <Tooltip content="Documents">
        <Button variant="ghost" size="icon-sm" asChild>
          <a href="/" aria-label="Retour aux documents">
            <ArrowLeft />
          </a>
        </Button>
      </Tooltip>
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="truncate text-[13px] font-semibold text-neutral-900" data-doc-name>
          {name}
        </h1>
        <SaveIndicator />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1" data-topbar-actions>
        {actions.map((a) => {
          if (a.component) return <a.component key={a.id} />;
          const Icon = a.icon;
          return (
            <Button
              key={a.id}
              variant={a.isActive?.(state) ? 'default' : 'outline'}
              size="sm"
              disabled={a.isDisabled?.(state)}
              onClick={() => a.run?.(getEditor())}
              data-topbar-action={a.id}
            >
              {Icon && <Icon />}
              {a.label}
            </Button>
          );
        })}
      </div>
      <div className="flex items-center gap-0.5">
        <Tooltip content={history.undoLabel ? `Annuler : ${history.undoLabel}` : 'Annuler'} shortcut={formatCombo('Mod+Z')}>
          <Button variant="ghost" size="icon-sm" aria-label="Annuler" disabled={!history.canUndo} onClick={() => getEditor().undo()}>
            <Undo2 />
          </Button>
        </Tooltip>
        <Tooltip content={history.redoLabel ? `Rétablir : ${history.redoLabel}` : 'Rétablir'} shortcut={formatCombo('Mod+Shift+Z')}>
          <Button variant="ghost" size="icon-sm" aria-label="Rétablir" disabled={!history.canRedo} onClick={() => getEditor().redo()}>
            <Redo2 />
          </Button>
        </Tooltip>
      </div>
      <span className="h-5 w-px bg-neutral-200" />
      <ZoomControl />
      <Tooltip content="Raccourcis clavier" shortcut={formatCombo('Mod+?')}>
        <Button variant="ghost" size="icon-sm" aria-label="Raccourcis clavier" onClick={() => uiStore.getState().setHelpOpen(true)}>
          <Keyboard />
        </Button>
      </Tooltip>
    </header>
  );
}
