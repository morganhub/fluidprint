// Barre d'outils de gauche (tâche 2.8) : les outils enregistrés (registry/tools.ts), puis les actions sur
// la sélection : dupliquer, supprimer, grouper, dissocier, premier plan, arrière-plan. Les options de
// l'outil actif (Forme, Icône…) s'ouvrent dans une colonne à côté, hors du plan de travail.
import { BringToFront, Copy, Group, SendToBack, Trash2, Ungroup, X } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Tooltip } from '../components/ui/tooltip';
import { getEditor, useEditor } from '../store/documentStore';
import { formatCombo } from './keys';
import { toolRegistry, type ToolDefinition } from './registry/api';

function ToolButton({ tool, active }: { tool: ToolDefinition; active: boolean }) {
  const Icon = tool.icon;
  return (
    <Tooltip content={tool.label} shortcut={tool.shortcut} side="right">
      <Button variant="toggle" size="icon" aria-label={tool.label} aria-pressed={active} data-tool={tool.id} onClick={() => getEditor().setTool(tool.id)}>
        <Icon />
      </Button>
    </Tooltip>
  );
}

const backToSelect = () => getEditor().setTool('select');

/**
 * Options de l'outil actif, dans une colonne entre la barre d'outils et le plan de travail. En bulle
 * flottante, elles couvraient le volet gauche de la face extérieure : le clic de pose tombait dans le
 * champ de recherche, et la frappe suivante aussi. Échap (même depuis ce champ) ou « Fermer » reviennent
 * à l'outil Sélection ; un clic sur la page pose l'objet, et l'outil (non collant) revient de lui-même à
 * la sélection, ce qui ferme la colonne.
 */
function ToolOptionsPanel({ tool }: { tool: ToolDefinition }) {
  const Options = tool.options as ComponentType;
  return (
    <aside
      aria-label={`Options de l’outil ${tool.label}`}
      data-tool-options={tool.id}
      className="flex min-h-0 shrink-0 flex-col border-r border-neutral-200 bg-white"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        backToSelect();
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 py-1 pl-3 pr-1">
        <span className="text-[12px] font-medium text-neutral-700">{tool.label}</span>
        <Tooltip content="Fermer" shortcut="Échap">
          <Button variant="ghost" size="icon-sm" aria-label="Fermer les options de l’outil" data-action="close-tool-options" onClick={backToSelect}>
            <X />
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <Options />
      </div>
    </aside>
  );
}

function ActionButton({ label, shortcut, icon, disabled, onClick, action }: { label: string; shortcut?: string; icon: ReactNode; disabled: boolean; onClick(): void; action: string }) {
  return (
    <Tooltip content={label} shortcut={shortcut ? formatCombo(shortcut) : undefined} side="right">
      <Button variant="ghost" size="icon" aria-label={label} disabled={disabled} onClick={onClick} data-action={action}>
        {icon}
      </Button>
    </Tooltip>
  );
}

export function Toolbar() {
  const tools = toolRegistry.use();
  const active = useEditor((s) => s.tool);
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const canUngroup = useEditor((s) => !!s.doc && s.selection.some((id) => s.doc!.objects[id]?.type === 'group'));
  const e = getEditor;
  const current = tools.find((t) => t.id === active);
  return (
    <>
      <nav aria-label="Outils" className="flex w-12 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-neutral-200 bg-white py-2" data-toolbar>
        {tools.map((t) => (
          <ToolButton key={t.id} tool={t} active={t.id === active} />
        ))}
        <span className="my-2 h-px w-7 bg-neutral-200" />
        <ActionButton action="duplicate" label="Dupliquer" shortcut="Mod+D" icon={<Copy />} disabled={!hasSelection} onClick={() => e().duplicate()} />
        <ActionButton action="delete" label="Supprimer" shortcut="Delete" icon={<Trash2 />} disabled={!hasSelection} onClick={() => e().remove()} />
        <ActionButton action="group" label="Grouper" shortcut="Mod+G" icon={<Group />} disabled={!hasSelection} onClick={() => e().group()} />
        <ActionButton action="ungroup" label="Dissocier" shortcut="Mod+Shift+G" icon={<Ungroup />} disabled={!canUngroup} onClick={() => e().ungroup()} />
        <ActionButton action="front" label="Premier plan" shortcut="Mod+Shift+]" icon={<BringToFront />} disabled={!hasSelection} onClick={() => e().reorder('front')} />
        <ActionButton action="back" label="Arrière-plan" shortcut="Mod+Shift+[" icon={<SendToBack />} disabled={!hasSelection} onClick={() => e().reorder('back')} />
      </nav>
      {current?.options && <ToolOptionsPanel key={current.id} tool={current} />}
    </>
  );
}
