// Contrôle en amont en direct (tâche 4.8) : les règles de model/preflight.ts, recalculées à chaque
// modification du document et à chaque nouvelle mesure du texte. Une pastille dans la barre d'état
// (verte, orange ou rouge) ouvre l'onglet « Contrôle » ; un clic sur un problème sélectionne l'objet en
// cause et le centre à l'écran (en ouvrant sa page type s'il le faut).
import { CircleAlert, CircleCheck, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { masterView } from '../editor/masterView';
import { registerPanel, registerStatusbarItem } from '../editor/registry/api';
import { uiStore } from '../editor/uiStore';
import { isMasterId } from '../model/masters';
import { preflightPageName, runPreflight, type PreflightIssue, type PreflightReport, type PreflightTextMeasure } from '../model/preflight';
import type { Id } from '../model/types';
import { subscribeTextMeasurements } from '../render/textMetrics';
import { editorStore, getEditor, useEditor } from '../store/documentStore';
import { pageIdOf } from '../store/tree';

// ---------------------------------------------------------------- état

const EMPTY: PreflightReport = { issues: [], errors: 0, warnings: 0, blocking: [], toConfirm: [] };

export const preflightStore = createStore<{ report: PreflightReport }>()(() => ({ report: EMPTY }));

/** Mesures du texte rendu à l'écran (étendue des lignes, hauteur) : la zone de sécurité et le texte en excès en dépendent. */
const textMeasures: Record<Id, PreflightTextMeasure> = {};

let scheduled = false;
/** Un recalcul attend la fin du geste en cours. */
let pending = false;

// Pendant un glisser ou un redimensionnement, recalculer le contrôle à chaque image coûtait environ 55 ms
// sur 20 images (audit B5) pour un résultat que personne ne lit en plein geste. Les gestes longs enregistrés
// en cours de route (texte en édition, recadrage) restent contrôlés en direct.
function inFastGesture(): boolean {
  const gesture = editorStore.getState().gesture;
  return !!gesture && !gesture.autosave;
}

function schedule() {
  if (inFastGesture()) {
    pending = true;
    return;
  }
  if (scheduled) return;
  scheduled = true;
  // Une fois par image au plus : un glisser modifie le document 60 fois par seconde.
  const run = () => {
    scheduled = false;
    recompute();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else queueMicrotask(run);
}

/** Relance toutes les règles sur le document ouvert. */
export function recompute(): PreflightReport {
  const doc = getEditor().doc;
  const report = doc ? runPreflight(doc, { texts: textMeasures }) : EMPTY;
  preflightStore.setState({ report });
  return report;
}

editorStore.subscribe((next, prev) => {
  if (next.docId !== prev.docId) for (const k of Object.keys(textMeasures)) delete textMeasures[k];
  if (next.doc !== prev.doc) schedule();
  if (prev.gesture && !next.gesture && pending) {
    pending = false;
    schedule();
  }
});

subscribeTextMeasurements((m) => {
  const prev = textMeasures[m.id];
  const ink = m.ink ?? null;
  const same = prev && Math.abs((prev.contentH ?? 0) - m.contentH) < 0.005 && JSON.stringify(prev.ink) === JSON.stringify(ink);
  if (same) return;
  textMeasures[m.id] = { contentH: m.contentH, ink };
  schedule();
});

// ---------------------------------------------------------------- sélection d'un problème

/** Sélectionne l'objet en cause et le centre à l'écran ; ouvre sa page type si l'objet en fait partie. */
export function revealIssue(issue: PreflightIssue): void {
  const s = getEditor();
  const doc = s.doc;
  if (!doc || !issue.objectId || !doc.objects[issue.objectId]) return;
  const pageId = pageIdOf(doc, issue.objectId);
  const editing = masterView.getState().editing;
  const wanted = pageId && isMasterId(doc, pageId) ? pageId : null;
  if (editing !== wanted) {
    s.clearSelection({ exitGroups: true });
    masterView.setState({ editing: wanted });
  }
  getEditor().select([issue.objectId]);
  getEditor().centerOn([issue.objectId]);
}

// ---------------------------------------------------------------- interface

const useReport = () => useStore(preflightStore, (s) => s.report);

type Status = 'ok' | 'warning' | 'error';
const statusOf = (r: PreflightReport): Status => (r.errors ? 'error' : r.warnings ? 'warning' : 'ok');

const DOT: Record<Status, string> = { ok: 'bg-emerald-500', warning: 'bg-amber-500', error: 'bg-red-600' };

/** Pastille de la barre d'état. */
function PreflightBadge() {
  const report = useReport();
  const hasDoc = useEditor((s) => !!s.doc);
  if (!hasDoc) return null;
  const status = statusOf(report);
  const label =
    status === 'ok'
      ? 'Contrôle : aucun problème'
      : [report.errors && `${report.errors} erreur${report.errors > 1 ? 's' : ''}`, report.warnings && `${report.warnings} alerte${report.warnings > 1 ? 's' : ''}`].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      data-preflight-status={status}
      title="Contrôle en amont : ouvrir la liste"
      className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-neutral-100"
      onClick={() => uiStore.getState().setActivePanel('preflight')}
    >
      <span className={`size-2.5 rounded-full ${DOT[status]}`} />
      <span className={status === 'error' ? 'text-red-700' : status === 'warning' ? 'text-amber-800' : undefined}>{label}</span>
    </button>
  );
}

function IssueRow({ issue, pageName }: { issue: PreflightIssue; pageName: string | null }) {
  const Icon = issue.severity === 'error' ? CircleAlert : TriangleAlert;
  const color = issue.severity === 'error' ? 'text-red-600' : 'text-amber-600';
  return (
    <li>
      <button
        type="button"
        data-preflight-issue={issue.key}
        data-severity={issue.severity}
        disabled={!issue.objectId}
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] leading-snug hover:bg-neutral-100 disabled:cursor-default disabled:hover:bg-transparent"
        onClick={() => revealIssue(issue)}
      >
        <Icon className={`mt-0.5 size-3.5 shrink-0 ${color}`} />
        <span className="min-w-0 flex-1">
          <span className="text-neutral-800">{issue.message}</span>
          {pageName && <span className="block text-[11px] text-neutral-500">{pageName}{issue.confirmable ? ' · export possible après confirmation' : ''}</span>}
        </span>
      </button>
    </li>
  );
}

function PreflightPanel() {
  const report = useReport();
  const doc = useEditor((s) => s.doc);
  if (!doc) return null;
  const status = statusOf(report);
  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  return (
    <div className="flex flex-col" data-preflight-panel>
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2.5 text-[12px]">
        {status === 'ok' ? <CircleCheck className="size-4 text-emerald-600" /> : <CircleAlert className={`size-4 ${status === 'error' ? 'text-red-600' : 'text-amber-600'}`} />}
        <span className="flex-1 text-neutral-700">
          {status === 'ok'
            ? 'Aucun problème : le document peut partir chez l’imprimeur.'
            : status === 'error'
              ? 'Des erreurs rouges empêchent l’export imprimeur.'
              : 'Quelques points à vérifier, rien de bloquant.'}
        </span>
      </div>
      {[
        { title: 'Erreurs', list: errors },
        { title: 'Alertes', list: warnings },
      ].map(
        ({ title, list }) =>
          list.length > 0 && (
            <section key={title} className="border-b border-neutral-200 py-2">
              <h3 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                {title} · {list.length}
              </h3>
              <ul>
                {list.map((issue) => (
                  <IssueRow key={issue.key} issue={issue} pageName={preflightPageName(doc, issue.pageId)} />
                ))}
              </ul>
            </section>
          ),
      )}
      <p className="px-3 py-2 text-[11px] leading-snug text-neutral-500">
        Règles : zone de sécurité (coupe et plis), texte en excès, résolution des photos, photos provisoires, couleurs hors nuancier, encrage maximal,
        filets fins, petits textes à plus de deux encres (hors nuances d’accent), caractères absents des polices, calques imprimables masqués, QR codes.
      </p>
    </div>
  );
}

registerPanel({ id: 'preflight', title: 'Contrôle', icon: ShieldCheck, order: 60, component: PreflightPanel });
registerStatusbarItem({ id: 'preflight', order: 10, align: 'right', component: PreflightBadge });
