// Bouton « IA Agent » (barre du haut de l'éditeur, accueil) : le guide d'un agent IA de navigateur (Claude dans
// Chrome, Cowork) qui pilote la page par `window.fluidprint`, à copier dans sa conversation. Le bouton signale
// aussi, quelques secondes, la dernière action faite par l'agent.
import { Bot, Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { registerTopbarAction } from '../editor/registry/api';
import { agentActivity } from './api';
import { AGENT_GUIDE } from './guide';

/** Consigne courte à donner à l'agent : il lit ensuite le guide complet lui-même. */
export const AGENT_PROMPT =
  "Tu pilotes l'éditeur Fluidprint ouvert dans cet onglet. Ne déplace pas les blocs et ne tape pas dans la page à la souris : " +
  'exécute du JavaScript dans la page avec l’objet window.fluidprint. Commence par lire le guide complet avec ' +
  'window.fluidprint.help(), puis fluidprint.info() et fluidprint.objects(). Montre chaque résultat avec fluidprint.focus(id).';

const ACTIVITY_MS = 5000;

function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  };
  return (
    <Button variant="outline" size="sm" data-action={testId} onClick={() => void copy().catch(() => undefined)}>
      {done ? <Check /> : <Copy />}
      {done ? 'Copié' : label}
    </Button>
  );
}

/** Dernière action de l'agent, tant qu'elle date de moins de quelques secondes. */
function useRecentActivity(): string | null {
  const { label, at } = useStore(agentActivity);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!label) return;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), ACTIVITY_MS);
    return () => clearTimeout(timer);
  }, [label, at]);
  return label && now - at < ACTIVITY_MS ? label : null;
}

export function AgentButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const activity = useRecentActivity();
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-topbar-action="agent"
        aria-label="IA Agent : guide pour piloter Fluidprint par programme (window.fluidprint.help())"
        title="Piloter Fluidprint avec un agent IA du navigateur"
      >
        <Bot className={activity ? 'animate-pulse text-emerald-600' : undefined} />
        {/* La barre du haut de l'éditeur est pleine : libellé et activité seulement sur un écran large. */}
        <span className={compact ? 'hidden 2xl:inline' : undefined}>IA Agent</span>
        {activity && (
          <span className={`max-w-40 truncate text-[11px] font-normal text-emerald-700 ${compact ? 'hidden 2xl:inline' : ''}`} data-agent-activity>
            · {activity}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl" data-agent-guide-dialog>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="size-4" />
              Piloter Fluidprint avec un agent IA
            </DialogTitle>
            <DialogDescription>
              Un agent de navigateur (Claude dans Chrome, Cowork…) travaille dans cet onglet en exécutant <code>window.fluidprint</code> : vous voyez chaque
              modification, et Ctrl+Z l’annule. Donnez-lui la consigne ci-dessous ; il lira le guide complet lui-même.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-md bg-neutral-100 p-2 text-[12px] text-neutral-800" data-agent-prompt>
            {AGENT_PROMPT}
          </p>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={AGENT_PROMPT} label="Copier la consigne" testId="copy-agent-prompt" />
            <CopyButton text={AGENT_GUIDE} label="Copier le guide complet" testId="copy-agent-guide" />
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-800" data-agent-guide>
            {AGENT_GUIDE}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

registerTopbarAction({ id: 'agent', order: 0, label: 'IA Agent', icon: Bot, component: () => <AgentButton compact /> });
