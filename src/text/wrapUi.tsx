// Habillage (tâche 4.13), côté éditeur : section « Habillage » du panneau Propriétés, pour tout objet qui
// n'est pas un texte (cadre, forme, rectangle, image…). Les blocs texte qui le chevauchent contournent
// sa forme exacte (la goutte comprise), avec une marge en mm, ou restent à l'intérieur (« Texte dans la forme »).
import { NumberField } from '../components/ui/number-field';
import { registerPropertySection, type PropertySectionProps } from '../editor/registry/api';
import type { DocObject } from '../model/types';
import { commonOrMixed, Field, Section } from '../panels/properties/common';
import { getEditor } from '../store/documentStore';

/** Marge proposée à l'activation (mm). */
export const DEFAULT_WRAP_MARGIN = 2;

function WrapSection({ objects, ids }: PropertySectionProps) {
  const enabled = commonOrMixed(objects, (o) => !!o.wrap);
  const margin = commonOrMixed(objects, (o) => o.wrap?.margin ?? null);
  const invert = commonOrMixed(objects, (o) => !!o.wrap?.invert);
  const set = (label: string, fn: (o: DocObject) => void) => getEditor().update(ids, fn, label);
  return (
    <Section title="Habillage" testId="text-wrap">
      <Field label="Texte">
        <label className="flex items-center gap-2 text-[12px] text-neutral-700">
          <input
            type="checkbox"
            name="wrapEnabled"
            className="size-3.5 accent-neutral-900"
            checked={enabled === true}
            ref={(el) => {
              if (el) el.indeterminate = enabled === 'mixed';
            }}
            onChange={(e) =>
              set(e.target.checked ? 'Habillage' : 'Sans habillage', (o) => {
                if (e.target.checked) o.wrap = o.wrap ?? { margin: DEFAULT_WRAP_MARGIN };
                else delete o.wrap;
              })
            }
          />
          Contourne la forme
        </label>
      </Field>
      {enabled !== false && (
        <>
          <Field label="Marge">
            <NumberField
              name="wrapMargin"
              value={margin === 'mixed' ? null : margin}
              unit="mm"
              step={0.5}
              min={0}
              decimals={1}
              onCommit={(v) =>
                set('Marge d’habillage', (o) => {
                  o.wrap = { ...(o.wrap ?? {}), margin: Math.max(0, v) };
                })
              }
            />
          </Field>
          <Field label="Sens">
            <label className="flex items-center gap-2 text-[12px] text-neutral-700">
              <input
                type="checkbox"
                name="wrapInvert"
                className="size-3.5 accent-neutral-900"
                checked={invert === true}
                onChange={(e) =>
                  set('Sens de l’habillage', (o) => {
                    o.wrap = { margin: o.wrap?.margin ?? DEFAULT_WRAP_MARGIN, ...(e.target.checked ? { invert: true } : {}) };
                  })
                }
              />
              Texte dans la forme
            </label>
          </Field>
        </>
      )}
    </Section>
  );
}

registerPropertySection({
  id: 'text-wrap',
  title: 'Habillage',
  order: 47,
  appliesTo: (objects) => objects.every((o) => o.type !== 'text' && o.type !== 'group'),
  component: WrapSection,
});
