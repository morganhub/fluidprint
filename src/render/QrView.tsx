import { useMemo } from 'react';
import type { QrObject } from '../model/types';
import { boxStyle, objAttrs } from './box';
import { colorCss } from './color';
import { useRender } from './context';
import { qrGeometry } from './qr';

/** QR code vectoriel (contrat, point 9) : recalculé quand l'adresse change, modules nets. */
export function QrView({ obj }: { obj: QrObject }) {
  const { doc } = useRender();
  const { size, d } = useMemo(() => qrGeometry(obj.url, obj.ecc, obj.margin), [obj.url, obj.ecc, obj.margin]);
  const background = colorCss(doc, obj.background);
  return (
    <div {...objAttrs(obj)} style={boxStyle(obj)}>
      <svg style={{ display: 'block', width: '100%', height: '100%' }} viewBox={`0 0 ${size} ${size}`} preserveAspectRatio="none" aria-hidden>
        {background && <rect x={0} y={0} width={size} height={size} fill={background} />}
        <path d={d} fill={colorCss(doc, obj.color)} shapeRendering="crispEdges" />
      </svg>
    </div>
  );
}
