import { useId, type ReactElement } from 'react';
import { cornerRadii, roundedRectPath, scalePath } from '../model/shapes';
import type { FrameObject, ShapeRef } from '../model/types';
import { ptToMm } from '../model/units';
import { boxStyle, cssId, objAttrs } from './box';
import { colorCss } from './color';
import { useRender } from './context';
import { strokeAttrs, type StrokeProps } from './ShapeView';

/** Rayon unique si les quatre coins sont égaux : il s'écrit alors en rx/ry d'un simple <rect>. */
function uniformRadius(radius: Extract<ShapeRef, { kind: 'rect' }>['radius'], w: number, h: number): number | null {
  const r = cornerRadii(radius, w, h);
  return r.every((v) => v === r[0]) ? r[0] : null;
}

/** Forme dans la boîte 0..1 (clipPathUnits="objectBoundingBox"). */
function clipShape(shape: ShapeRef, w: number, h: number): ReactElement {
  switch (shape.kind) {
    case 'ellipse':
      return <ellipse cx={0.5} cy={0.5} rx={0.5} ry={0.5} />;
    case 'path':
      return <path d={shape.d} />;
    case 'rect': {
      const r = uniformRadius(shape.radius, w, h);
      if (r !== null) return <rect x={0} y={0} width={1} height={1} rx={r ? r / w : undefined} ry={r ? r / h : undefined} />;
      return <path d={scalePath(roundedRectPath(0, 0, w, h, shape.radius), 1 / w, 1 / h)} />;
    }
  }
}

/** Même forme en mm (viewBox du cadre) : pour le filet, qui doit garder une épaisseur uniforme. */
function outlineShape(shape: ShapeRef, w: number, h: number, props: StrokeProps & { fill: string }): ReactElement {
  switch (shape.kind) {
    case 'ellipse':
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...props} />;
    case 'path':
      return <path d={scalePath(shape.d, w, h)} {...props} />;
    case 'rect':
      return <path d={roundedRectPath(0, 0, w, h, shape.radius)} {...props} />;
  }
}

/**
 * Cadre photo (contrat, point 6). La découpe est un clipPath vectoriel, appliqué par `clip-path` au
 * <svg> du cadre : sa boîte de référence est alors exactement celle du cadre, même quand la photo
 * déborde. Jamais de mask-image, qui deviendrait un masque de transparence (/SMask) dans le PDF.
 */
export function FrameView({ obj }: { obj: FrameObject }) {
  const { doc, mode, resolveImageUrl, onImageSettled } = useRender();
  const clipId = cssId('clip', obj.id, useId());
  const { w, h } = obj;
  const asset = obj.image ? doc.assets.find((a) => a.id === obj.image!.assetId) : undefined;
  const drawable = w > 0 && h > 0;
  const fill = colorCss(doc, obj.fill);
  const showPlaceholder = mode === 'screen' && !asset && !!obj.placeholder;
  // Photo provisoire (tirée du PDF Canva, décision I3) : filigrane à l'écran seulement, jamais imprimé.
  const provisional = mode === 'screen' && !!asset?.placeholder;

  return (
    <div {...objAttrs(obj)} style={boxStyle(obj)}>
      {drawable && (
        <svg
          style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block', clipPath: `url(#${clipId})` }}
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <clipPath id={clipId} clipPathUnits="objectBoundingBox">
              {clipShape(obj.shape, w, h)}
            </clipPath>
          </defs>
          {fill && <rect x={0} y={0} width={w} height={h} fill={fill} />}
          {asset && obj.image && (
            <image
              href={resolveImageUrl(asset)}
              data-asset-id={asset.id}
              x={obj.image.x}
              y={obj.image.y}
              width={obj.image.w}
              height={obj.image.h}
              // La boîte a déjà le rapport de la photo (model/frame.ts) : aucun recadrage implicite.
              preserveAspectRatio="none"
              onLoad={() => onImageSettled?.(asset.id, true)}
              onError={() => onImageSettled?.(asset.id, false)}
            />
          )}
          {obj.stroke &&
            // Filet d'épaisseur double découpé par la forme : seule sa moitié intérieure reste.
            outlineShape(obj.shape, w, h, {
              fill: 'none',
              ...strokeAttrs(colorCss(doc, obj.stroke.color), obj.stroke, 2 * ptToMm(obj.stroke.width), (v) => v),
            })}
        </svg>
      )}
      {showPlaceholder && (
        <div
          className="frame-placeholder"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: '1mm',
            fontFamily: "'Open Sans'",
            fontSize: '6pt',
            lineHeight: 1.2,
            color: 'rgba(0, 0, 0, 0.35)',
            pointerEvents: 'none',
          }}
        >
          {obj.placeholder}
        </div>
      )}
      {provisional && drawable && (
        <div
          data-provisional
          aria-label="Photo provisoire"
          style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', clipPath: `url(#${clipId})` }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%) rotate(-24deg)',
              whiteSpace: 'nowrap',
              fontFamily: "'Open Sans'",
              fontWeight: 700,
              fontSize: `${Math.max(2, Math.min(w, h) / 7)}mm`,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'rgba(255, 255, 255, 0.78)',
              textShadow: '0 0 0.6mm rgba(0, 0, 0, 0.45)',
            }}
          >
            Provisoire
          </div>
        </div>
      )}
    </div>
  );
}
