// Aide des raccourcis (Ctrl+?) : tous les raccourcis enregistrés, par rubrique.
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { formatCombo } from './keys';
import { shortcutRegistry, toolRegistry } from './registry/api';
import { allShortcuts } from './shortcuts';
import { uiStore, useUi } from './uiStore';

export function ShortcutsHelp() {
  const open = useUi((s) => s.helpOpen);
  shortcutRegistry.use();
  toolRegistry.use();
  const groups = new Map<string, { label: string; keys: string[] }[]>();
  for (const def of allShortcuts()) {
    if (def.hidden) continue;
    const group = def.group ?? 'Divers';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ label: def.label, keys: Array.isArray(def.keys) ? def.keys : [def.keys] });
  }
  return (
    <Dialog open={open} onOpenChange={(v) => uiStore.getState().setHelpOpen(v)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Raccourcis clavier</DialogTitle>
          <DialogDescription>Espace + glisser ou molette : déplacer la vue. Ctrl + molette : zoomer autour du pointeur. Alt + glisser : dupliquer.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-2 gap-x-6 gap-y-4 overflow-y-auto pr-1">
          {[...groups].map(([group, list]) => (
            <section key={group}>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{group}</h3>
              <ul className="flex flex-col gap-0.5">
                {list.map((s) => (
                  <li key={s.label + s.keys.join()} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="text-neutral-700">{s.label}</span>
                    <span className="flex gap-1">
                      {s.keys.map((k) => (
                        <kbd key={k} className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-sans text-[11px] text-neutral-600">
                          {formatCombo(k)}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
