import { Fragment, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { TextObject } from '../model/types';
import { boxStyle, objAttrs } from './box';
import { useRender } from './context';
import { paragraphCss, renderNnbsp, runCss, textBlockCss, wrapFloatCss } from './textCss';
import { useTextFlow } from './textFlow';
import { hasTextMeasureListeners, measureTextElement, reportTextMeasurement } from './textMetrics';

// Les styles CSS du bloc vivent dans textCss.ts (partagés avec la mesure du texte chaîné) ; ils restent
// exportés d'ici, où l'éditeur de texte et les tests les ont toujours pris.
export { NNBSP_RENDER, paragraphCss, runCss, textBlockCss } from './textCss';

function RunText({ text }: { text: string }) {
  return text.split('\n').map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {renderNnbsp(part)}
    </Fragment>
  ));
}

/**
 * Bloc texte en HTML (contrat, point 2) : le moteur de Chrome fait les coupures, à l'écran comme au PDF.
 * Un bloc chaîné (4.12) affiche sa part de l'article, dans la mise en forme du premier bloc ; un bloc
 * habillé (4.13) commence par ses flottants `shape-outside`, et reste alors aligné en haut (un flottant
 * dans une boîte flexible ne flotte plus).
 */
export function TextFrameView({ obj }: { obj: TextObject }) {
  const { doc, mode } = useRender();
  const flow = useTextFlow(obj);
  const ref = useRef<HTMLDivElement>(null);
  const block = { style: flow.style, verticalAlign: flow.floats ? 'top' : obj.verticalAlign } as const;
  const style: CSSProperties = { ...boxStyle(obj), ...textBlockCss(block, doc), whiteSpace: 'normal' };

  // Mesure à l'écran (texte en excès, hauteur auto) : seulement si l'éditeur écoute, jamais à l'impression.
  useLayoutEffect(() => {
    const el = ref.current;
    if (mode !== 'screen' || !el || !hasTextMeasureListeners()) return;
    let cancelled = false;
    const measure = () => {
      if (!cancelled && el.isConnected) reportTextMeasurement(measureTextElement(obj.id, el, obj.w));
    };
    // Avant le chargement des polices, les coupures seraient fausses : on attend.
    if (document.fonts.status === 'loaded') measure();
    else void document.fonts.ready.then(measure);
    return () => {
      cancelled = true;
    };
  });

  const paragraphs = flow.paragraphs;
  const count = paragraphs.length;
  return (
    <div ref={ref} {...objAttrs(obj)} {...(flow.chained ? { 'data-chained': '' } : null)} style={style}>
      {[flow.floats?.left, flow.floats?.right].map((f) => f && <div key={f.side} data-wrap-float={f.side} style={wrapFloatCss(f)} />)}
      {paragraphs.map((para, i) => (
        <div key={i} style={paragraphCss(para, i, count, flow.style, flow.continues)}>
          {para.runs.some((r) => r.text !== '') ? (
            para.runs.map((run, j) => (
              <span key={j} style={runCss(run, doc)}>
                <RunText text={run.text} />
              </span>
            ))
          ) : (
            // Paragraphe vide : il garde la hauteur d'une ligne, comme dans un traitement de texte.
            <br />
          )}
        </div>
      ))}
    </div>
  );
}
