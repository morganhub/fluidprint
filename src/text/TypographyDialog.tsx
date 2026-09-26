// « Corriger tout le document » (tâche 2.15) : aperçu de chaque correction typographique, bloc par
// bloc, puis application en une seule étape d'annulation.
import { Quote } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { registerTopbarAction } from '../editor/registry/api';
import { objectLabel } from '../panels/PropertiesPanel';
import { getEditor, useEditor } from '../store/documentStore';
import { finishTextEdit, TEXT_EDIT_MODE } from './TextEditor';
import { applyTypographyToDocument, documentTypographyChanges, NBSP, NNBSP, TYPO_RULE_LABELS, type TypographyChange } from './typographyFr';

/** Rend visibles les espaces insécables d'un extrait (fond coloré), sinon l'aperçu ne montrerait rien. */
function Visible({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  [...text].forEach((c, i) => {
    if (c === NBSP) parts.push(<span key={i} title="Espace insécable" className="mx-px inline-block w-[0.5em] rounded-sm bg-sky-200 align-middle leading-none">&nbsp;</span>);
    else if (c === NNBSP) parts.push(<span key={i} title="Espace fine insécable" className="mx-px inline-block w-[0.3em] rounded-sm bg-violet-300 align-middle leading-none">&nbsp;</span>);
    else if (c === '\n') parts.push(<span key={i} className="text-neutral-400">↵</span>);
    else parts.push(c);
  });
  return <>{parts}</>;
}

function TypographyButton() {
  const [open, setOpen] = useState(false);
  const doc = useEditor((s) => s.doc);
  const changes = useMemo(() => (open && doc ? documentTypographyChanges(doc) : []), [open, doc]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const byObject = useMemo(() => {
    const map = new Map<string, TypographyChange[]>();
    for (const c of changes) map.set(c.objId, [...(map.get(c.objId) ?? []), c]);
    return map;
  }, [changes]);
  const included = [...byObject.keys()].filter((id) => !excluded.has(id));
  const count = included.reduce((n, id) => n + byObject.get(id)!.length, 0);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-topbar-action="typography"
        title="Corriger la typographie française de tout le document"
        onClick={() => {
          if (getEditor().mode?.id === TEXT_EDIT_MODE) finishTextEdit();
          setExcluded(new Set());
          setOpen(true);
        }}
      >
        <Quote />
        Typographie
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl" data-typography-dialog>
          <DialogHeader>
            <DialogTitle>Corriger la typographie du document</DialogTitle>
            <DialogDescription>
              Espace fine insécable avant ; ! ?, insécable avant : et dans les durées (1 h 30), apostrophes courbes, guillemets « ». Décochez un bloc pour
              le laisser tel quel.
            </DialogDescription>
          </DialogHeader>
          {byObject.size === 0 ? (
            <p className="py-4 text-neutral-600" data-typography-empty>
              Aucune correction à faire : la typographie du document est déjà conforme.
            </p>
          ) : (
            <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1" data-typography-changes>
              {[...byObject].map(([objId, list]) => {
                const obj = doc?.objects[objId];
                return (
                  <li key={objId} className="rounded-md border border-neutral-200 p-2" data-typography-object={objId}>
                    <label className="flex items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-neutral-900"
                        checked={!excluded.has(objId)}
                        onChange={(e) => {
                          const next = new Set(excluded);
                          if (e.target.checked) next.delete(objId);
                          else next.add(objId);
                          setExcluded(next);
                        }}
                      />
                      <span className="truncate">{obj ? objectLabel(obj) : objId}</span>
                      <span className="ml-auto shrink-0 text-[11px] font-normal text-neutral-500">
                        {list.length} correction{list.length > 1 ? 's' : ''}
                      </span>
                    </label>
                    <ul className="mt-1 flex flex-col gap-0.5 pl-6 text-[12px]">
                      {list.map((c, i) => (
                        <li key={i} className="grid grid-cols-[10rem_1fr] gap-2">
                          <span className="truncate text-neutral-500">{TYPO_RULE_LABELS[c.rule]}</span>
                          <span className="min-w-0 truncate">
                            <span className="text-neutral-500 line-through decoration-neutral-300">
                              <Visible text={c.before} />
                            </span>
                            <span className="mx-1.5 text-neutral-400">→</span>
                            <Visible text={c.after} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button
              data-action="apply-typography"
              disabled={!count}
              onClick={() => {
                getEditor().apply('Corriger la typographie', (d) => void applyTypographyToDocument(d, included));
                setOpen(false);
              }}
            >
              Appliquer {count} correction{count > 1 ? 's' : ''}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

registerTopbarAction({ id: 'typography', order: 40, label: 'Typographie', icon: Quote, component: TypographyButton });
