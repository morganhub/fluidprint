// « Aperçu impression » (tâche 4.9, décision P4) : épreuvage écran au profil du préréglage imprimeur.
// Les nuances s'affichent déjà depuis leurs encres (simulation du profil, tâche 4.1) ; l'aperçu y ajoute
// les photos converties RVB → CMJN → RVB (print/proof.py, en cache) et masque repères et calques non
// imprimables, comme la touche W. Le document n'est pas modifié.
import { Printer } from 'lucide-react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from '../components/ui/button';
import { Tooltip } from '../components/ui/tooltip';
import { fetchPresets, referencePreset } from '../panels/printColors';
import { setProofVariant } from '../render/imageVariant';
import { useEditor } from '../store/documentStore';
import { guidesView } from './PageGuides';
import { registerOverlay, registerTopbarAction } from './registry/api';

interface PrintPreviewState {
  enabled: boolean;
  /** Profil simulé (libellé), pour le bandeau. */
  profileLabel: string | null;
  /** Repères affichés avant l'aperçu, rétablis à la sortie. */
  guidesBefore: boolean;
  setEnabled(enabled: boolean): Promise<void>;
}

export const printPreview = createStore<PrintPreviewState>()((set, get) => ({
  enabled: false,
  profileLabel: null,
  guidesBefore: true,
  async setEnabled(enabled) {
    if (enabled === get().enabled) return;
    if (!enabled) {
      setProofVariant(null);
      guidesView.getState().setVisible(get().guidesBefore);
      set({ enabled: false });
      return;
    }
    const presets = await fetchPresets();
    const preset = referencePreset(presets);
    if (!preset?.profile) return;
    setProofVariant({ profile: preset.profile, intent: preset.imageIntent ?? 'perceptual', maxInk: preset.maxInk });
    const guidesBefore = guidesView.getState().visible;
    guidesView.getState().setVisible(false);
    set({ enabled: true, guidesBefore, profileLabel: presets.profiles[preset.profile]?.label ?? preset.profile });
  },
}));

function PrintPreviewButton() {
  const enabled = useStore(printPreview, (s) => s.enabled);
  const ready = useEditor((s) => !!s.doc);
  return (
    <Tooltip content="Couleurs et photos telles que les imprimera le profil de sortie">
      <Button
        variant={enabled ? 'default' : 'outline'}
        size="sm"
        disabled={!ready}
        aria-pressed={enabled}
        data-topbar-action="print-preview"
        onClick={() => void printPreview.getState().setEnabled(!enabled)}
      >
        <Printer />
        Aperçu impression
      </Button>
    </Tooltip>
  );
}

function PrintPreviewBanner() {
  const { enabled, profileLabel } = useStore(printPreview);
  if (!enabled) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-8 z-20 -translate-x-1/2 rounded-full bg-neutral-900/85 px-3 py-1 text-[12px] text-white shadow" data-print-preview-banner>
      Aperçu impression · {profileLabel}
    </div>
  );
}

registerTopbarAction({ id: 'print-preview', order: 20, label: 'Aperçu impression', icon: Printer, component: PrintPreviewButton });
registerOverlay({ id: 'print-preview-banner', space: 'viewport', component: PrintPreviewBanner });
