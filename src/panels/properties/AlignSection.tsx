// Section Alignement du panneau Propriétés (tâche 2.11) : six alignements, répartition des espacements
// horizontaux et verticaux, par rapport à la sélection ou au volet. Un objet seul s'aligne sur son volet.
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  type LucideIcon,
} from 'lucide-react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { alignObjects, distributeObjects, minForDistribute, type AlignMode, type AlignReference, type DistributeAxis } from '../../editor/align';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { getEditor } from '../../store/documentStore';
import { Section } from './common';

// Référence choisie : gardée d'une sélection à l'autre, comme dans InDesign.
const referenceStore = createStore<{ reference: AlignReference; set(r: AlignReference): void }>()((set) => ({
  reference: 'selection',
  set: (reference) => set({ reference }),
}));

const ALIGN_BUTTONS: { mode: AlignMode; label: string; icon: LucideIcon }[] = [
  { mode: 'left', label: 'Aligner à gauche', icon: AlignStartVertical },
  { mode: 'hcenter', label: 'Centrer horizontalement', icon: AlignCenterVertical },
  { mode: 'right', label: 'Aligner à droite', icon: AlignEndVertical },
  { mode: 'top', label: 'Aligner en haut', icon: AlignStartHorizontal },
  { mode: 'vcenter', label: 'Centrer verticalement', icon: AlignCenterHorizontal },
  { mode: 'bottom', label: 'Aligner en bas', icon: AlignEndHorizontal },
];

const DISTRIBUTE_BUTTONS: { axis: DistributeAxis; label: string; icon: LucideIcon }[] = [
  { axis: 'x', label: 'Répartir les espacements horizontaux', icon: AlignHorizontalSpaceBetween },
  { axis: 'y', label: 'Répartir les espacements verticaux', icon: AlignVerticalSpaceBetween },
];

function AlignSection({ ids }: PropertySectionProps) {
  const chosen = useStore(referenceStore, (s) => s.reference);
  const single = ids.length < 2;
  const reference: AlignReference = single ? 'panel' : chosen;
  const canDistribute = ids.length >= minForDistribute(reference);

  const align = (mode: AlignMode, label: string) => getEditor().apply(label, (d) => alignObjects(d, ids, mode, reference));
  const distribute = (axis: DistributeAxis, label: string) => getEditor().apply(label, (d) => distributeObjects(d, ids, axis, reference));

  return (
    <Section title="Alignement" testId="align">
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Aligner par rapport à">
        <span className="mr-1 text-[12px] text-neutral-600">Par rapport</span>
        {(
          [
            ['selection', 'à la sélection'],
            ['panel', 'au volet'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant="toggle"
            size="sm"
            role="radio"
            aria-checked={reference === value}
            aria-pressed={reference === value}
            disabled={single && value === 'selection'}
            data-align-reference={value}
            onClick={() => referenceStore.getState().set(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        {ALIGN_BUTTONS.map(({ mode, label, icon: Icon }) => (
          <Tooltip key={mode} content={label}>
            <Button variant="ghost" size="icon-sm" aria-label={label} data-align={mode} onClick={() => align(mode, label)}>
              <Icon />
            </Button>
          </Tooltip>
        ))}
        <span className="mx-1 h-5 w-px bg-neutral-200" />
        {DISTRIBUTE_BUTTONS.map(({ axis, label, icon: Icon }) => (
          <Tooltip key={axis} content={canDistribute ? label : `${label} (au moins 3 objets)`}>
            <span>
              <Button variant="ghost" size="icon-sm" aria-label={label} data-distribute={axis} disabled={!canDistribute} onClick={() => distribute(axis, label)}>
                <Icon />
              </Button>
            </span>
          </Tooltip>
        ))}
      </div>
    </Section>
  );
}

registerPropertySection({ id: 'align', title: 'Alignement', order: 15, appliesTo: (objects) => objects.length >= 1, component: AlignSection });
