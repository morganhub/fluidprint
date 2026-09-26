// Section Apparence : remplissage et filet (nuance du nuancier, épaisseur en pt), arrondi, opacité.
import { SwatchPicker } from '../../components/SwatchPicker';
import { NumberField } from '../../components/ui/number-field';
import type { ColorRef, DocObject, RectObject, Stroke } from '../../model/types';
import { getEditor } from '../../store/documentStore';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { commonOrMixed, common, Field, Section, Warning } from './common';

/** Sous cette épaisseur, un filet risque de ne pas sortir à l'impression (contrôle en amont, P4). */
export const MIN_STROKE_PT = 0.25;

type FillHolder = Extract<DocObject, { fill?: ColorRef }>;
type StrokeHolder = Extract<DocObject, { stroke?: Stroke }>;

const FILL_TYPES = new Set<DocObject['type']>(['rect', 'ellipse', 'path', 'frame']);
const COLOR_TYPES = new Set<DocObject['type']>(['icon', 'svg', 'qr']);
const STROKE_TYPES = new Set<DocObject['type']>(['rect', 'ellipse', 'path', 'frame', 'line']);

const hasFill = (o: DocObject): o is FillHolder => FILL_TYPES.has(o.type);
const hasColor = (o: DocObject): o is Extract<DocObject, { type: 'icon' | 'svg' | 'qr' }> => COLOR_TYPES.has(o.type);
const hasStroke = (o: DocObject): o is StrokeHolder => STROKE_TYPES.has(o.type);

/** Arrondi d'un rectangle ou d'un cadre rectangulaire (null si les coins diffèrent, undefined sans objet). */
function radiusOf(o: DocObject): number | null | undefined {
  let r: RectObject['radius'];
  if (o.type === 'rect') r = o.radius;
  else if (o.type === 'frame' && o.shape.kind === 'rect') r = o.shape.radius;
  else return undefined;
  if (r === undefined) return 0;
  if (Array.isArray(r)) return r.every((v) => v === r[0]) ? r[0] : null;
  return r;
}

function AppearanceSection({ objects, doc }: PropertySectionProps) {
  const ids = objects.map((o) => o.id);
  const edit = (label: string, fn: (o: DocObject) => void) => getEditor().update(ids, fn, label);

  const fillable = objects.every(hasFill);
  const colorable = objects.every(hasColor);
  const strokable = objects.every(hasStroke);
  const rounded = objects.every((o) => radiusOf(o) !== undefined);

  const fill = fillable ? commonOrMixed(objects, (o) => (o as FillHolder).fill) : undefined;
  const color = colorable ? commonOrMixed(objects, (o) => (o as { color?: ColorRef }).color) : undefined;
  const strokeColor = strokable ? commonOrMixed(objects, (o) => (o as StrokeHolder).stroke?.color) : undefined;
  const strokeWidth = strokable ? common(objects, (o) => (o as StrokeHolder).stroke?.width ?? null) : null;
  const anyStroke = strokable && objects.some((o) => (o as StrokeHolder).stroke);
  const thinStroke = strokable && objects.some((o) => {
    const s = (o as StrokeHolder).stroke;
    return !!s && s.width > 0 && s.width < MIN_STROKE_PT;
  });
  const lineOnly = objects.every((o) => o.type === 'line');
  const radius = rounded ? common(objects, (o) => radiusOf(o) ?? null) : null;
  const opacity = common(objects, (o) => Math.round((o.opacity ?? 1) * 100));

  const setStroke = (patch: Partial<Stroke>) =>
    edit('Filet', (o) => {
      const holder = o as StrokeHolder;
      if (!hasStroke(o)) return;
      const base: Stroke = holder.stroke ?? { color: patch.color ?? { swatch: doc.swatches[0]?.id ?? '' }, width: 0.5 };
      holder.stroke = { ...base, ...patch };
    });

  return (
    <Section title="Apparence" testId="appearance">
      {fillable && (
        <Field label="Remplissage">
          <SwatchPicker
            doc={doc}
            ariaLabel="Remplissage"
            allowNone
            value={fill}
            onChange={(ref) =>
              edit('Remplissage', (o) => {
                if (ref) (o as FillHolder).fill = ref;
                else delete (o as FillHolder).fill;
              })
            }
          />
        </Field>
      )}
      {colorable && (
        <Field label="Couleur">
          <SwatchPicker doc={doc} ariaLabel="Couleur" value={color} allowNone={objects.every((o) => o.type === 'svg')} onChange={(ref) =>
              edit('Couleur', (o) => {
                if (ref) (o as { color?: ColorRef }).color = ref;
                else delete (o as { color?: ColorRef }).color;
              })
            }
          />
        </Field>
      )}
      {strokable && (
        <>
          <Field label="Filet">
            <SwatchPicker
              doc={doc}
              ariaLabel="Couleur du filet"
              allowNone={!lineOnly}
              value={strokeColor}
              onChange={(ref) => {
                if (ref) setStroke({ color: ref });
                else edit('Filet', (o) => void (o.type !== 'line' && delete (o as StrokeHolder).stroke));
              }}
            />
          </Field>
          <Field label="Épaisseur">
            <NumberField
              ariaLabel="Épaisseur du filet (pt)"
              name="strokeWidth"
              unit="pt"
              value={anyStroke ? strokeWidth : null}
              disabled={!anyStroke}
              invalid={thinStroke}
              min={0}
              step={0.25}
              decimals={3}
              onCommit={(v) => setStroke({ width: v })}
            />
          </Field>
          {thinStroke && <Warning testId="stroke-warning">Filet de moins de 0,25 pt : il risque de ne pas sortir à l’impression.</Warning>}
        </>
      )}
      {rounded && (
        <Field label="Arrondi">
          <NumberField
            ariaLabel="Arrondi (mm)"
            name="radius"
            unit="mm"
            value={radius}
            min={0}
            step={0.5}
            onCommit={(v) =>
              edit('Arrondi', (o) => {
                if (o.type === 'rect') o.radius = v || undefined;
                else if (o.type === 'frame' && o.shape.kind === 'rect') o.shape = v ? { kind: 'rect', radius: v } : { kind: 'rect' };
                if (o.type === 'rect' && !o.radius) delete o.radius;
              })
            }
          />
        </Field>
      )}
      <Field label="Opacité">
        <NumberField
          ariaLabel="Opacité (%)"
          name="opacity"
          unit="%"
          value={opacity}
          min={0}
          max={100}
          step={5}
          decimals={0}
          onCommit={(v) =>
            edit('Opacité', (o) => {
              if (v >= 100) delete o.opacity;
              else o.opacity = v / 100;
            })
          }
        />
      </Field>
    </Section>
  );
}

registerPropertySection({ id: 'appearance', title: 'Apparence', order: 20, appliesTo: () => true, component: AppearanceSection });
