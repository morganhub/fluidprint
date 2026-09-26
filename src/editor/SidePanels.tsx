// Volet de droite : un onglet par panneau enregistré (registry/panels.ts). Les onglets sont des
// pictogrammes, avec le nom du panneau en infobulle (et pour les lecteurs d'écran) : écrits en toutes
// lettres, 4 des 7 onglets sortaient du volet et il fallait faire défiler la barre pour les atteindre.
// Le nom du panneau ouvert s'affiche sous la barre.
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Tooltip } from '../components/ui/tooltip';
import { panelRegistry } from './registry/api';
import { uiStore, useUi } from './uiStore';

export function SidePanels() {
  const panels = panelRegistry.use();
  const active = useUi((s) => s.activePanel);
  const current = panels.some((p) => p.id === active) ? active : panels[0]?.id;
  const title = panels.find((p) => p.id === current)?.title;
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-neutral-200 bg-white" aria-label="Panneaux" data-side-panels>
      <Tabs value={current} onValueChange={(v) => uiStore.getState().setActivePanel(v)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="justify-between" data-panel-tabs>
          {panels.map((p) => {
            const Icon = p.icon;
            return (
              // L'infobulle est posée sur le contenu de l'onglet, pas sur l'onglet : Radix Tooltip et
              // Radix Tabs écriraient tous deux data-state sur le même bouton (actif / inactif).
              <TabsTrigger key={p.id} value={p.id} data-panel-tab={p.id} aria-label={p.title} className="flex-1 justify-center p-0">
                <Tooltip content={p.title}>
                  <span className="flex w-full items-center justify-center px-2 py-2">{Icon ? <Icon aria-hidden /> : p.title}</span>
                </Tooltip>
              </TabsTrigger>
            );
          })}
        </TabsList>
        {title && (
          <h2 className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500" data-panel-title>
            {title}
          </h2>
        )}
        {panels.map((p) => (
          <TabsContent key={p.id} value={p.id} data-panel={p.id}>
            <p.component />
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  );
}
