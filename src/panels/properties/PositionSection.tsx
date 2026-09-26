// Section Position et taille : X, Y, L, H en mm, saisis au 0,01 mm. X et Y se lisent depuis le coin du
// format fini (comme les règles, et comme InDesign) ; le document les stocke depuis le coin du fond perdu.
import { NumberField } from '../../components/ui/number-field';
import { setBox, setPosition } from '../../store/commands';
import { getEditor } from '../../store/documentStore';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { common, Section } from './common';

function PositionSection({ objects, doc }: PropertySectionProps) {
  const bleed = doc.format.bleed;
  const x = common(objects, (o) => Math.round((o.x - bleed) * 100) / 100);
  const y = common(objects, (o) => Math.round((o.y - bleed) * 100) / 100);
  const w = common(objects, (o) => Math.round(o.w * 100) / 100);
  const h = common(objects, (o) => Math.round(o.h * 100) / 100);
  const ids = objects.map((o) => o.id);
  const apply = (label: string, fn: (d: typeof doc, id: string) => void) => getEditor().apply(label, (d) => ids.forEach((id) => fn(d, id)));

  return (
    <Section title="Position et taille" testId="position">
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField prefix="X" ariaLabel="X (mm)" unit="mm" name="x" value={x} step={0.5} onCommit={(v) => apply('Position X', (d, id) => setPosition(d, id, v + bleed, undefined))} />
        <NumberField prefix="Y" ariaLabel="Y (mm)" unit="mm" name="y" value={y} step={0.5} onCommit={(v) => apply('Position Y', (d, id) => setPosition(d, id, undefined, v + bleed))} />
        <NumberField prefix="L" ariaLabel="Largeur (mm)" unit="mm" name="w" value={w} min={0} step={0.5} onCommit={(v) => apply('Largeur', (d, id) => setBox(d, id, { w: v }))} />
        <NumberField prefix="H" ariaLabel="Hauteur (mm)" unit="mm" name="h" value={h} min={0} step={0.5} onCommit={(v) => apply('Hauteur', (d, id) => setBox(d, id, { h: v }))} />
      </div>
      <p className="text-[11px] text-neutral-400">X et Y depuis le coin du format fini.</p>
    </Section>
  );
}

registerPropertySection({ id: 'position', title: 'Position et taille', order: 10, appliesTo: () => true, component: PositionSection });
