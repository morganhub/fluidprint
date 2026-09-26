// Section Rotation (tâche 2.12) : angle en degrés (sens horaire), et quarts de tour. Chaque objet pivote
// autour de son propre centre ; un groupe fait pivoter ses objets autour du centre du groupe (il n'a pas
// d'angle propre : son angle affiché est celui de ses objets s'ils l'ont en commun, sinon « — »).
import { RotateCcw, RotateCw } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { NumberField } from '../../components/ui/number-field';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { angleOf, rotateObjects, setRotation } from '../../editor/rotation';
import { getEditor } from '../../store/documentStore';
import { Field, Section } from './common';

function RotationSection({ ids, doc }: PropertySectionProps) {
  const angles = ids.map((id) => angleOf(doc, id));
  const value = angles.every((a) => a !== null && Math.abs(a - angles[0]!) < 1e-6) ? Math.round(angles[0]! * 100) / 100 : null;
  const turn = (delta: number) => getEditor().apply(delta > 0 ? 'Quart de tour à droite' : 'Quart de tour à gauche', (d) => rotateObjects(d, ids, delta), { select: ids });
  return (
    <Section title="Rotation" testId="rotation">
      <Field label="Angle">
        <NumberField
          name="rotation"
          ariaLabel="Angle (degrés, sens horaire)"
          unit="°"
          value={value}
          step={1}
          min={-360}
          max={360}
          className="w-24"
          onCommit={(v) => getEditor().apply('Rotation', (d) => setRotation(d, ids, v), { select: ids })}
        />
        <Button variant="ghost" size="icon-sm" aria-label="Quart de tour à gauche" title="Quart de tour à gauche" data-action="rotate-left" onClick={() => turn(-90)}>
          <RotateCcw />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Quart de tour à droite" title="Quart de tour à droite" data-action="rotate-right" onClick={() => turn(90)}>
          <RotateCw />
        </Button>
      </Field>
    </Section>
  );
}

registerPropertySection({ id: 'rotation', title: 'Rotation', order: 11, appliesTo: () => true, component: RotationSection });
