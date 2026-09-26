// Sections du panneau Propriétés pour les blocs texte :
// - « Style de paragraphe » (tâche 2.21) : style du bloc, « + » quand le bloc s'en écarte, « Effacer
//   les écarts » et « Redéfinir le style » ;
// - « Bloc texte » (tâche 2.26) : hauteur automatique, texte en excès.
import { Eraser, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/input';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { applyParagraphStyle, clearOverrides, findParagraphStyle, redefineParagraphStyle, textOverrides } from '../../model/styles';
import type { DocObject, TextObject } from '../../model/types';
import { getEditor } from '../../store/documentStore';
import { setTextHeight } from '../../text/autoHeight';
import { measuredHeights, useOverset } from '../../text/overset';
import { common, Field, Section } from './common';

function ParagraphStyleSection({ objects, ids, doc }: PropertySectionProps) {
  const texts = objects as TextObject[];
  const styleId = common(objects, (o) => (o as TextObject).paragraphStyleId ?? '');
  const style = styleId ? findParagraphStyle(doc, styleId) : undefined;
  const overrides = style ? texts.flatMap((t) => textOverrides(doc, t)) : [];
  const single = texts.length === 1 ? texts[0] : null;

  return (
    <Section title="Style de paragraphe" testId="paragraph-style">
      <div className="flex items-center gap-1.5">
        <NativeSelect
          aria-label="Style de paragraphe"
          name="paragraphStyle"
          value={styleId ?? '__mixed'}
          onChange={(e) => {
            const value = e.target.value;
            if (value === '__mixed') return;
            getEditor().apply('Appliquer un style de paragraphe', (d) => applyParagraphStyle(d, ids, value || null));
          }}
        >
          {styleId === null && <option value="__mixed">—</option>}
          <option value="">[Aucun style]</option>
          {doc.styles.paragraph.map((ps) => (
            <option key={ps.id} value={ps.id}>
              {ps.name}
            </option>
          ))}
        </NativeSelect>
        {overrides.length > 0 && (
          <span
            data-style-override
            title={`Écarts par rapport au style :\n${[...new Set(overrides.map((o) => `• ${o.label}`))].join('\n')}`}
            className="flex h-7 min-w-7 items-center justify-center rounded-md border border-amber-300 bg-amber-50 px-1.5 text-[14px] font-bold leading-none text-amber-800"
            aria-label={`${overrides.length} écart(s) par rapport au style`}
          >
            +
          </span>
        )}
      </div>
      {style && overrides.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            data-action="clear-overrides"
            title="Le bloc reprend exactement son style (les styles de caractère restent)"
            onClick={() => getEditor().apply('Effacer les écarts', (d) => clearOverrides(d, ids))}
          >
            <Eraser />
            Effacer les écarts
          </Button>
          {single && (
            <Button
              variant="outline"
              size="sm"
              data-action="redefine-style"
              title={`« ${style.name} » prend la mise en forme de ce bloc ; les autres blocs du style suivent`}
              onClick={() => getEditor().apply('Redéfinir le style', (d) => redefineParagraphStyle(d, single.id))}
            >
              <RefreshCw />
              Redéfinir le style
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

function TextFrameSection({ objects, ids }: PropertySectionProps) {
  const texts = objects as TextObject[];
  const auto = common(objects, (o) => !!(o as TextObject).autoHeight);
  const excess = useOverset((e) => ids.map((id) => e[id]).filter((v): v is number => v !== undefined));
  const worst = excess.length ? Math.max(...excess) : 0;

  const fitHeights = (label: string, enable?: boolean) =>
    getEditor().apply(label, (d) => {
      for (const t of texts) {
        const obj = d.objects[t.id];
        if (obj?.type !== 'text') continue;
        if (enable === true) obj.autoHeight = true;
        if (enable === false) delete obj.autoHeight;
        const h = measuredHeights.get(t.id);
        if (enable !== false && h !== undefined) setTextHeight(d, t.id, h);
      }
    });

  return (
    <Section title="Bloc texte" testId="text-frame">
      <Field label="Hauteur">
        <label className="flex items-center gap-2 text-[12px] text-neutral-700">
          <input
            type="checkbox"
            name="autoHeight"
            className="size-3.5 accent-neutral-900"
            checked={auto === true}
            ref={(el) => {
              if (el) el.indeterminate = auto === null;
            }}
            onChange={(e) => fitHeights(e.target.checked ? 'Hauteur auto' : 'Hauteur fixe', e.target.checked)}
          />
          Hauteur auto (suit le texte)
        </label>
      </Field>
      {worst > 0 && (
        <div role="alert" data-testid="overset-warning" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[12px] text-red-800">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex-1">
            Texte en excès : {String(Math.round(worst * 10) / 10).replace('.', ',')} mm dépassent du bloc.
            <button type="button" data-action="fit-text-height" className="ml-1 font-medium underline underline-offset-2" onClick={() => fitHeights('Ajuster la hauteur au texte')}>
              Ajuster la hauteur
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

const allText = (objects: DocObject[]) => objects.every((o) => o.type === 'text');

registerPropertySection({ id: 'paragraph-style', title: 'Style de paragraphe', order: 35, appliesTo: allText, component: ParagraphStyleSection });
registerPropertySection({ id: 'text-frame', title: 'Bloc texte', order: 36, appliesTo: allText, component: TextFrameSection });
