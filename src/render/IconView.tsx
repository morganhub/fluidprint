import type { CSSProperties } from 'react';
import type { IconObject, SvgObject } from '../model/types';
import { boxStyle, objAttrs } from './box';
import { colorCss } from './color';
import { useRender } from './context';

// overflow hidden, comme tout <svg> dans du HTML : un trait qui déborde du viewBox (la goutte au
// contour épais du design, par exemple) y est coupé, et l'import doit le rester.
const full: CSSProperties = { display: 'block', width: '100%', height: '100%', overflow: 'hidden' };

/** Icône Lucide (contrat, point 7). Le contenu vient du document local : il est injecté tel quel. */
export function IconView({ obj }: { obj: IconObject }) {
  const { doc } = useRender();
  return (
    <div {...objAttrs(obj)} style={{ ...boxStyle(obj), color: colorCss(doc, obj.color) }}>
      <svg
        style={full}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={obj.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        dangerouslySetInnerHTML={{ __html: obj.svg }}
      />
    </div>
  );
}

/** Graphique importé tel quel, logo ou gouttes (contrat, point 8). */
export function SvgView({ obj }: { obj: SvgObject }) {
  const { doc } = useRender();
  return (
    <div {...objAttrs(obj)} style={{ ...boxStyle(obj), color: colorCss(doc, obj.color) }}>
      <svg
        style={full}
        viewBox={obj.viewBox}
        preserveAspectRatio={obj.preserveAspectRatio ?? 'xMidYMid meet'}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: obj.content }}
      />
    </div>
  );
}
