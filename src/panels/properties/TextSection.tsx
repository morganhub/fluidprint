// Section Texte (socle) : police, graisse, corps, interlignage, interlettrage, alignement, casse et
// couleur du bloc. Ces réglages portent sur le style du bloc ; les retouches locales des segments
// (« pour vous. » en bleu, un chiffre en 14 pt) sont conservées.
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, CaseUpper } from 'lucide-react';
import { SwatchPicker } from '../../components/SwatchPicker';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/input';
import { NumberField } from '../../components/ui/number-field';
import type { DocObject, TextAlign, TextObject, TextStyle } from '../../model/types';
import { getEditor } from '../../store/documentStore';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { common, commonOrMixed, Field, Section } from './common';

/** Polices servies en local (public/fonts) : les seules que l'export sait incorporer. */
export const FONT_FAMILIES = ['Open Sans'];
export const FONT_WEIGHTS: { value: number; label: string }[] = [
  { value: 400, label: 'Normal' },
  { value: 600, label: 'Semi-gras' },
  { value: 700, label: 'Gras' },
  { value: 800, label: 'Extra-gras' },
];

const ALIGNS: { value: TextAlign; label: string; icon: typeof AlignLeft }[] = [
  { value: 'left', label: 'Aligner à gauche', icon: AlignLeft },
  { value: 'center', label: 'Centrer', icon: AlignCenter },
  { value: 'right', label: 'Aligner à droite', icon: AlignRight },
  { value: 'justify', label: 'Justifier', icon: AlignJustify },
];

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function TextSection({ objects, doc }: PropertySectionProps) {
  const texts = objects as TextObject[];
  const ids = texts.map((t) => t.id);
  const editStyle = (label: string, fn: (style: TextStyle, obj: TextObject) => void) =>
    getEditor().update<TextObject>(ids, (o) => fn(o.style, o), label);

  const style = (get: (s: TextStyle) => unknown) => common(texts as DocObject[], (o) => get((o as TextObject).style));
  const family = style((s) => s.fontFamily) as string | null;
  const weight = style((s) => s.fontWeight) as number | null;
  const size = style((s) => s.fontSize) as number | null;
  const leading = style((s) => round(s.lineHeight * s.fontSize)) as number | null;
  const tracking = style((s) => round(s.letterSpacing * 1000, 1)) as number | null;
  const align = style((s) => s.align) as TextAlign | null;
  const upper = style((s) => s.transform === 'uppercase') as boolean | null;
  const color = commonOrMixed(texts as DocObject[], (o) => (o as TextObject).style.color);
  const families = [...new Set([...FONT_FAMILIES, ...texts.map((t) => t.style.fontFamily)])];

  return (
    <Section title="Texte" testId="text">
      <Field label="Police">
        <NativeSelect aria-label="Police" value={family ?? ''} onChange={(e) => editStyle('Police', (s) => void (s.fontFamily = e.target.value))}>
          {family === null && <option value="">—</option>}
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Graisse">
        <NativeSelect aria-label="Graisse" value={weight ?? ''} onChange={(e) => editStyle('Graisse', (s) => void (s.fontWeight = Number(e.target.value)))}>
          {weight === null && <option value="">—</option>}
          {FONT_WEIGHTS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label} ({w.value})
            </option>
          ))}
          {weight !== null && !FONT_WEIGHTS.some((w) => w.value === weight) && <option value={weight}>{weight}</option>}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField
          ariaLabel="Corps (pt)"
          prefix="C"
          name="fontSize"
          unit="pt"
          value={size}
          min={1}
          step={0.5}
          onCommit={(v) => editStyle('Corps', (s) => void (s.fontSize = v))}
        />
        <NumberField
          ariaLabel="Interlignage (pt)"
          prefix="I"
          name="leading"
          unit="pt"
          value={leading}
          min={0.5}
          step={0.5}
          onCommit={(v) => editStyle('Interlignage', (s) => void (s.lineHeight = round(v / s.fontSize, 4)))}
        />
        <NumberField
          ariaLabel="Interlettrage (millièmes de cadratin)"
          prefix="IL"
          name="tracking"
          unit="‰ em"
          value={tracking}
          step={10}
          decimals={1}
          onCommit={(v) => editStyle('Interlettrage', (s) => void (s.letterSpacing = round(v / 1000, 4)))}
        />
      </div>
      <div className="flex items-center gap-0.5" role="group" aria-label="Alignement">
        {ALIGNS.map(({ value, label, icon: Icon }) => (
          <Button key={value} variant="toggle" size="icon-sm" aria-label={label} title={label} aria-pressed={align === value} onClick={() => editStyle('Alignement', (s) => void (s.align = value))}>
            <Icon />
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-neutral-200" />
        <Button
          variant="toggle"
          size="icon-sm"
          aria-label="Capitales"
          title="Capitales"
          aria-pressed={upper === true}
          onClick={() => editStyle('Casse', (s) => void (s.transform = upper ? 'none' : 'uppercase'))}
        >
          <CaseUpper />
        </Button>
      </div>
      <Field label="Couleur">
        <SwatchPicker doc={doc} ariaLabel="Couleur du texte" value={color} onChange={(ref) => ref && editStyle('Couleur du texte', (s) => void (s.color = ref))} />
      </Field>
    </Section>
  );
}

registerPropertySection({
  id: 'text',
  title: 'Texte',
  order: 30,
  appliesTo: (objects) => objects.every((o) => o.type === 'text'),
  component: TextSection,
});
