// Sections des cadres (tâches 3.1 à 3.6) : « Forme » (forme de la découpe, réglages d'un polygone,
// édition des points, import SVG) et « Photo » (Remplir, Ajuster, Centrer, recadrer, placer, retirer,
// résolution effective).
import { Crop, ImagePlus, PenTool, Trash2 } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/input';
import { startCrop } from '../../editor/CropMode';
import { ACCEPT_ATTRIBUTE, placeAssetInFrame, uploadImage } from '../../editor/dropImage';
import { startPenEdit } from '../../editor/PenTool';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { PolygonFields, POLYGON_ID, shapeRefFor, SvgImportButton } from '../../editor/ShapeTool';
import { framePpi, PPI_ERROR, PPI_WARN, refitFrameImage } from '../../model/images';
import { clampPolygon, polygonPath, SHAPE_PRESETS, type PolygonOptions } from '../../model/shapes';
import type { DocObject, FrameObject, ImageFit, ShapeRef } from '../../model/types';
import { getEditor } from '../../store/documentStore';
import { common, Field, Section, Warning } from './common';

const isFrame = (o: DocObject): o is FrameObject => o.type === 'frame';

/** Clé de la liste « Forme » : rect, ellipse, une forme prête, polygone, une forme du document, ou libre. */
function shapeKey(shape: ShapeRef): string {
  if (shape.kind !== 'path') return shape.kind;
  if (shape.polygon && (!shape.preset || shape.preset === POLYGON_ID)) return POLYGON_ID;
  return shape.preset ?? 'libre';
}

function FrameShapeSection({ objects, doc }: PropertySectionProps) {
  const frames = objects.filter(isFrame);
  const ids = frames.map((f) => f.id);
  const key = common(frames, (f) => shapeKey((f as FrameObject).shape));
  const polygon = common(frames, (o) => {
    const shape = (o as FrameObject).shape;
    return shape.kind === 'path' ? (shape.polygon ?? null) : null;
  });
  const single = frames.length === 1 ? frames[0] : null;

  const setShape = (value: string) => {
    getEditor().update<FrameObject>(
      ids,
      (f) => {
        if (value === 'rect') f.shape = { kind: 'rect' };
        else if (value === 'ellipse') f.shape = { kind: 'ellipse' };
        else f.shape = shapeRefFor(doc, value).shape;
      },
      'Forme du cadre',
    );
  };

  const setPolygon = (patch: Partial<PolygonOptions>) => {
    getEditor().update<FrameObject>(
      ids,
      (f) => {
        if (f.shape.kind !== 'path' || !f.shape.polygon) return;
        const params = clampPolygon({ ...f.shape.polygon, ...patch });
        f.shape = { kind: 'path', d: polygonPath(params).d, preset: POLYGON_ID, polygon: params };
      },
      'Polygone',
    );
  };

  const known = key === null || key === 'rect' || key === 'ellipse' || key === POLYGON_ID || !!SHAPE_PRESETS[key] || !!doc.shapes?.some((s) => s.id === key);

  return (
    <Section title="Forme" testId="frame-shape">
      <Field label="Découpe">
        <NativeSelect name="frameShape" aria-label="Forme du cadre" value={key ?? ''} onChange={(e) => setShape(e.target.value)}>
          {key === null && <option value="">—</option>}
          <option value="rect">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          {Object.values(SHAPE_PRESETS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value={POLYGON_ID}>Polygone ou étoile réglable</option>
          {doc.shapes?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {!known && <option value={key!}>{key === 'plume' ? 'Tracé à la plume' : 'Tracé libre'}</option>}
        </NativeSelect>
      </Field>
      {polygon && (
        <Field label="Côtés, creux, arrondi">
          <PolygonFields value={polygon} onChange={setPolygon} />
        </Field>
      )}
      <div className="flex flex-wrap gap-1.5">
        {single && (
          <Button variant="outline" size="sm" onClick={() => startPenEdit(single.id)} data-action="edit-points">
            <PenTool />
            Modifier les points
          </Button>
        )}
        <SvgImportButton />
      </div>
    </Section>
  );
}

const FIT_LABELS: [Exclude<ImageFit, 'custom'>, string, string][] = [
  ['fill', 'Remplir', 'La photo couvre toute la forme'],
  ['fit', 'Ajuster', 'La photo entière tient dans la forme'],
  ['center', 'Centrer', 'Taille réelle à 300 ppi, centrée'],
];

function FrameImageSection({ objects, doc }: PropertySectionProps) {
  const frames = objects.filter(isFrame);
  const withImage = frames.filter((f) => f.image);
  const single = frames.length === 1 ? frames[0] : null;
  const fit = common(withImage, (f) => (f as FrameObject).image!.fit);
  const info = single ? framePpi(doc, single) : null;
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setFit = (mode: Exclude<ImageFit, 'custom'>) =>
    getEditor().update<FrameObject>(
      withImage.map((f) => f.id),
      (f) => {
        const asset = doc.assets.find((a) => a.id === f.image?.assetId);
        if (f.image && asset) f.image = refitFrameImage(f, f.image, asset, mode);
      },
      { fill: 'Remplir', fit: 'Ajuster', center: 'Centrer' }[mode],
    );

  const place = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !single) return;
    setBusy(true);
    setError(null);
    try {
      placeAssetInFrame(single.id, await uploadImage(getEditor().docId ?? doc.id, file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeImage = () =>
    getEditor().update<FrameObject>(
      withImage.map((f) => f.id),
      (f) => void delete f.image,
      'Retirer la photo',
    );

  return (
    <Section title="Photo" testId="frame-image">
      {info && (
        <div className="text-[12px] text-neutral-600" data-frame-ppi={info.level}>
          <span className="font-medium text-neutral-800">{info.asset.name}</span>
          <span className="text-neutral-400">
            {' '}
            · {info.asset.width} × {info.asset.height} px
          </span>
          <div>
            Résolution effective :{' '}
            <span className={info.level === 'error' ? 'font-semibold text-red-700' : info.level === 'warn' ? 'font-semibold text-amber-700' : 'font-semibold text-emerald-700'}>
              {Math.round(info.ppi)} ppi
            </span>
          </div>
        </div>
      )}
      {info && info.level !== 'ok' && (
        <Warning testId="ppi-warning">
          {info.level === 'error' ? `Sous ${PPI_ERROR} ppi : la photo sortira floue.` : `Sous ${PPI_WARN} ppi : risque de flou à l’impression.`}
          {info.asset.placeholder ? ' Photo provisoire, à remplacer par l’original.' : ''}
        </Warning>
      )}
      {withImage.length > 0 && (
        <div className="grid grid-cols-3 gap-1" role="group" aria-label="Placement de la photo">
          {FIT_LABELS.map(([mode, label, hint]) => (
            <Button key={mode} variant="toggle" size="sm" aria-pressed={fit === mode} title={hint} onClick={() => setFit(mode)} data-action={`fit-${mode}`}>
              {label}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {single?.image && (
          <Button variant="outline" size="sm" onClick={() => startCrop(single.id)} data-action="crop">
            <Crop />
            Recadrer
          </Button>
        )}
        {single && (
          <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy} data-action="place-image">
            <ImagePlus />
            {busy ? 'Envoi…' : single.image ? 'Remplacer…' : 'Placer une photo…'}
          </Button>
        )}
        {withImage.length > 0 && (
          <Button variant="ghost" size="sm" onClick={removeImage} data-action="remove-image">
            <Trash2 />
            Retirer
          </Button>
        )}
        <input ref={input} type="file" accept={ACCEPT_ATTRIBUTE} className="hidden" onChange={place} data-file-input="frame-image" />
      </div>
      {!withImage.length && <p className="text-[12px] text-neutral-500">Glissez une photo depuis l’explorateur sur la forme, ou choisissez-la ici.</p>}
      {error && (
        <p role="alert" className="text-[12px] text-red-700">
          {error}
        </p>
      )}
    </Section>
  );
}

const allFrames = (objects: DocObject[]) => objects.length > 0 && objects.every(isFrame);

registerPropertySection({ id: 'frame-shape', title: 'Forme', order: 45, appliesTo: allFrames, component: FrameShapeSection });
registerPropertySection({ id: 'frame-image', title: 'Photo', order: 50, appliesTo: allFrames, component: FrameImageSection });
