import type { CSSProperties, ReactNode, SVGAttributes } from 'react';
import { cornerRadii, roundedRectPath } from '../model/shapes';
import type { DocObject, EllipseObject, LineObject, PathObject, RectObject, Stroke } from '../model/types';
import { mmToPx, ptToMm, ptToPx, pxToMm } from '../model/units';
import { boxStyle, objAttrs } from './box';
import { colorCss } from './color';
import { useRender } from './context';

const overlay: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible' };

export type StrokeProps = Pick<SVGAttributes<SVGElement>, 'stroke' | 'strokeWidth' | 'strokeDasharray' | 'strokeLinecap' | 'vectorEffect'>;

/** Attributs de filet SVG ; `unit` convertit les mm des pointillés dans les unités du dessin. */
export function strokeAttrs(color: string | undefined, stroke: Stroke, width: number, unit: (mm: number) => number): StrokeProps {
  return {
    stroke: color,
    strokeWidth: width,
    strokeDasharray: stroke.dash?.length ? stroke.dash.map(unit).join(' ') : undefined,
    strokeLinecap: 'butt',
  };
}

/**
 * <svg> dont le contenu est dessiné en mm dans le repère de l'objet (0..w, 0..h).
 *
 * À l'impression, Chrome cale sur le pixel CSS entier (0,26 mm) les bords d'un <div> à fond de couleur
 * comme l'origine d'un <svg> : un filet de 0,25 pt sortait à 0,75 pt, un filet de 1 pt à 0,75 ou 1,5 pt
 * selon sa hauteur sur la page. On pose donc nous-mêmes la racine du <svg> sur le pixel entier qui
 * précède l'objet, à une taille entière, et le viewBox compense l'écart : ce qui est dessiné dedans
 * garde ses coordonnées exactes dans le PDF. L'objet est placé dans le repère de la face (les groupes
 * n'ajoutent pas de décalage) et chaque face commence sur un pixel entier de sa page.
 */
function MmSvg({ obj, children }: { obj: DocObject; children: ReactNode }) {
  const frac = (v: number) => v - Math.floor(v);
  const fx = frac(mmToPx(obj.x));
  const fy = frac(mmToPx(obj.y));
  // Jamais nul : un <svg> de largeur ou de hauteur nulle n'est pas rendu (filet horizontal ou vertical).
  const wPx = Math.max(1, Math.ceil(mmToPx(obj.w) + fx));
  const hPx = Math.max(1, Math.ceil(mmToPx(obj.h) + fy));
  return (
    <svg
      style={{ position: 'absolute', left: `${-fx}px`, top: `${-fy}px`, width: `${wPx}px`, height: `${hPx}px`, overflow: 'visible' }}
      viewBox={`${-pxToMm(fx)} ${-pxToMm(fy)} ${pxToMm(wPx)} ${pxToMm(hPx)}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Rayon unique si les quatre coins sont égaux : il s'écrit alors en rx/ry d'un simple <rect>. */
function uniformRadius(radius: RectObject['radius'], w: number, h: number): number | null {
  const r = cornerRadii(radius, w, h);
  return r.every((v) => v === r[0]) ? r[0] : null;
}

/** Aplat d'un rectangle aux coins arrondis, en mm. */
function RoundedRect({ w, h, radius, fill }: { w: number; h: number; radius: RectObject['radius']; fill: string }) {
  const r = uniformRadius(radius, w, h);
  if (r !== null) {
    // Sans arrondi, bords nets à l'écran comme les aplats CSS du design ; le PDF, vectoriel, n'en tient pas compte.
    return <rect x={0} y={0} width={w} height={h} rx={r || undefined} ry={r || undefined} shapeRendering={r ? undefined : 'crispEdges'} fill={fill} />;
  }
  return <path d={roundedRectPath(0, 0, w, h, radius)} fill={fill} />;
}

/** Filet intérieur d'un rectangle ou d'une ellipse : il reste dans la boîte, comme une bordure CSS. */
function insideStroke(kind: 'rect' | 'ellipse', obj: RectObject | EllipseObject, stroke: Stroke, color: string | undefined) {
  const sw = Math.min(ptToMm(stroke.width), obj.w, obj.h);
  if (!(obj.w > 0 && obj.h > 0) || sw <= 0) return null;
  const half = sw / 2;
  const attrs = { fill: 'none', ...strokeAttrs(color, stroke, sw, (v) => v) };
  if (kind === 'ellipse') return <ellipse cx={obj.w / 2} cy={obj.h / 2} rx={obj.w / 2 - half} ry={obj.h / 2 - half} {...attrs} />;
  const radii = cornerRadii((obj as RectObject).radius, obj.w, obj.h).map((r) => Math.max(0, r - half)) as [number, number, number, number];
  return <path d={roundedRectPath(half, half, obj.w - sw, obj.h - sw, radii)} {...attrs} />;
}

/** Rectangle (contrat, point 3) : aplat et filet intérieur en SVG, aux mm près dans le PDF. */
export function RectView({ obj }: { obj: RectObject }) {
  const { doc } = useRender();
  const fill = colorCss(doc, obj.fill);
  return (
    <div {...objAttrs(obj)} style={boxStyle(obj)}>
      <MmSvg obj={obj}>
        {fill && obj.w > 0 && obj.h > 0 && <RoundedRect w={obj.w} h={obj.h} radius={obj.radius} fill={fill} />}
        {obj.stroke && insideStroke('rect', obj, obj.stroke, colorCss(doc, obj.stroke.color))}
      </MmSvg>
    </div>
  );
}

export function EllipseView({ obj }: { obj: EllipseObject }) {
  const { doc } = useRender();
  const fill = colorCss(doc, obj.fill);
  return (
    <div {...objAttrs(obj)} style={boxStyle(obj)}>
      <MmSvg obj={obj}>
        {fill && obj.w > 0 && obj.h > 0 && <ellipse cx={obj.w / 2} cy={obj.h / 2} rx={obj.w / 2} ry={obj.h / 2} fill={fill} />}
        {obj.stroke && insideStroke('ellipse', obj, obj.stroke, colorCss(doc, obj.stroke.color))}
      </MmSvg>
    </div>
  );
}

/** Trait (contrat, point 4), en mm : épaisseur et position exactes dans le PDF. */
export function LineView({ obj }: { obj: LineObject }) {
  const { doc } = useRender();
  const color = colorCss(doc, obj.stroke.color);
  const sw = ptToMm(obj.stroke.width);
  if ((obj.w === 0 || obj.h === 0) && !obj.stroke.dash?.length) {
    // Filet horizontal ou vertical plein : un aplat de l'épaisseur du trait, centré sur le tracé, aux
    // bords nets à l'écran (calés sur les pixels comme les bordures CSS du design).
    const bar = obj.h === 0 ? { x: 0, y: -sw / 2, width: obj.w, height: sw } : { x: -sw / 2, y: 0, width: sw, height: obj.h };
    return (
      <div {...objAttrs(obj)} style={boxStyle(obj)}>
        <MmSvg obj={obj}>
          <rect {...bar} fill={color} shapeRendering="crispEdges" />
        </MmSvg>
      </div>
    );
  }
  const [y1, y2] = obj.flip ? [obj.h, 0] : [0, obj.h];
  return (
    <div {...objAttrs(obj)} style={boxStyle(obj)}>
      <MmSvg obj={obj}>
        <line x1={0} y1={y1} x2={obj.w} y2={y2} {...strokeAttrs(color, obj.stroke, sw, (v) => v)} />
      </MmSvg>
    </div>
  );
}

/** Tracé libre (contrat, point 5), étiré à la boîte. */
export function PathView({ obj }: { obj: PathObject }) {
  const { doc } = useRender();
  const stroke = obj.stroke;
  let strokeProps: StrokeProps = {};
  if (stroke) {
    const color = colorCss(doc, stroke.color);
    if (obj.nonScalingStroke) {
      strokeProps = { ...strokeAttrs(color, stroke, ptToPx(stroke.width), (v) => mmToPx(v)), vectorEffect: 'non-scaling-stroke' };
    } else {
      // Sans vector-effect, le filet vit dans la boîte 0..1 : on l'y ramène par la taille moyenne.
      const scale = (obj.w + obj.h) / 2 || 1;
      strokeProps = strokeAttrs(color, stroke, ptToMm(stroke.width) / scale, (v) => v / scale);
    }
  }
  return (
    <div {...objAttrs(obj)} style={boxStyle(obj)}>
      <svg style={overlay} viewBox="0 0 1 1" preserveAspectRatio="none" overflow="visible" aria-hidden>
        <path d={obj.d} fill={colorCss(doc, obj.fill) ?? 'none'} {...strokeProps} />
      </svg>
    </div>
  );
}
