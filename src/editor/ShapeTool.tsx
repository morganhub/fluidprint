// Outil Forme enrichi (tâches 3.3 et 3.4) : il remplace la définition de base (même identifiant 'shape')
// pour proposer, en plus des formes prêtes, les polygones et étoiles paramétriques et la bibliothèque
// du document, avec le bouton « Forme depuis un SVG ». Toute forme est un cadre (décision I1).
import { Droplet, FileUp } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from '../components/ui/button';
import { NumberField } from '../components/ui/number-field';
import { faceSize } from '../model/format';
import { findShape, polygonPath, SHAPE_PRESETS, shapeFromSvg, type PolygonOptions } from '../model/shapes';
import type { FrameObject, Id, LayoutDocument, ShapeRef } from '../model/types';
import { addObjects } from '../store/commands';
import { defaultLayerId, getEditor, useEditor } from '../store/documentStore';
import { registerTool, type CreateContext } from './registry/api';
import { createOnPage } from './tools/builtinTools';
import { DEFAULT_SIZES, makeShape } from './tools/defaults';
import { shapeToolStore } from './tools/shapeToolStore';

/** Identifiant de la forme « Polygone » réglable de l'outil. */
export const POLYGON_ID = 'polygone';

/** Réglages du polygone posé par l'outil (côtés, creux, arrondi). */
export const polygonToolStore = createStore<PolygonOptions>(() => ({ sides: 6, inset: 0, rounding: 0 }));

/** Forme d'un cadre neuf, d'après son identifiant (forme prête, polygone réglable ou forme du document). */
export function shapeRefFor(doc: LayoutDocument, id: string, polygon: PolygonOptions = polygonToolStore.getState()): { shape: ShapeRef; name: string; aspect: number } {
  if (id === POLYGON_ID) {
    const { d, aspect } = polygonPath(polygon);
    return { shape: { kind: 'path', d, preset: POLYGON_ID, polygon: { ...polygon } }, name: polygon.inset > 0 ? 'Étoile' : 'Polygone', aspect };
  }
  const preset = findShape(doc.shapes, id) ?? SHAPE_PRESETS.goutte;
  return {
    shape: { kind: 'path', d: preset.d, preset: preset.id, ...(preset.polygon ? { polygon: { ...preset.polygon } } : {}) },
    name: preset.name,
    aspect: preset.aspect,
  };
}

function createShape(ctx: CreateContext): Id[] | undefined {
  const { shape, name, aspect } = shapeRefFor(ctx.doc, shapeToolStore.getState().preset);
  const size = DEFAULT_SIZES.shape;
  const box = ctx.isClick ? { x: ctx.box.x, y: ctx.box.y, w: size.w, h: size.w / aspect } : ctx.box;
  return createOnPage(
    ctx,
    'Ajouter une forme',
    (d, o) => {
      const frame = makeShape(d, o);
      frame.shape = shape;
      frame.name = name;
      return frame;
    },
    box,
  );
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.svg$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'forme';

/**
 * « Forme depuis un SVG » : la forme rejoint la bibliothèque du document, puis un cadre de cette forme
 * est posé au centre de la face active (60 mm de large, ramené à la face) et sélectionné. Une seule étape.
 */
export function importSvgShape(svg: string, fileName: string): Id | undefined {
  const s = getEditor();
  const doc = s.doc;
  if (!doc) return undefined;
  const imported = shapeFromSvg(svg);
  const name = fileName.replace(/\.svg$/i, '') || 'Forme importée';
  const layerId = defaultLayerId(doc, s.activeLayerId);
  const pageId = s.activePageId ?? doc.pages[0]?.id;
  if (!layerId || !pageId) return undefined;
  let shapeId = `svg-${slug(name)}`;
  for (let n = 2; doc.shapes?.some((x) => x.id === shapeId) || SHAPE_PRESETS[shapeId]; n++) shapeId = `svg-${slug(name)}-${n}`;
  const face = faceSize(doc.format);
  let w = 60;
  let h = w / imported.aspect;
  const k = Math.min(1, (face.w * 0.8) / w, (face.h * 0.8) / h);
  w *= k;
  h *= k;
  const box = { x: (face.w - w) / 2, y: (face.h - h) / 2, w, h };
  const id = s.apply(
    'Forme depuis un SVG',
    (d) => {
      (d.shapes ??= []).push({ id: shapeId, name, d: imported.d, aspect: imported.aspect });
      const frame: FrameObject = makeShape(d, { layerId, box });
      frame.shape = { kind: 'path', d: imported.d, preset: shapeId };
      frame.name = name;
      addObjects(d, [frame], [frame.id], { pageId });
      return frame.id;
    },
    { select: (created) => (created ? [created] : []) },
  );
  shapeToolStore.setState({ preset: shapeId });
  // Le cadre posé est sélectionné : on revient à l'outil Sélection pour le déplacer ou y déposer une photo.
  if (id) getEditor().setTool('select');
  return id;
}

/** Bouton « Forme depuis un SVG… » : lit le fichier choisi et l'importe. */
export function SvgImportButton({ onImported }: { onImported?: (id: Id) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setError(null);
      const id = importSvgShape(await file.text(), file.name);
      if (id) onImported?.(id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" className="justify-start" onClick={() => input.current?.click()} data-action="import-svg-shape">
        <FileUp />
        Forme depuis un SVG…
      </Button>
      <input ref={input} type="file" accept=".svg,image/svg+xml" className="hidden" onChange={onChange} data-file-input="svg-shape" />
      {error && (
        <p role="alert" className="text-[12px] text-red-700">
          {error}
        </p>
      )}
    </>
  );
}

function ShapeSwatch({ d }: { d: string }) {
  return (
    <svg viewBox="-0.05 -0.05 1.1 1.1" className="size-4" preserveAspectRatio="xMidYMid meet" aria-hidden>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/** Réglages d'un polygone : côtés (3 à 12), creux de l'étoile, arrondi des sommets. */
export function PolygonFields({ value, onChange, namePrefix = '' }: { value: PolygonOptions | null; onChange(patch: Partial<PolygonOptions>): void; namePrefix?: string }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <NumberField ariaLabel="Nombre de côtés" name={`${namePrefix}sides`} prefix="N" value={value?.sides ?? null} min={3} max={12} step={1} decimals={0} onCommit={(v) => onChange({ sides: v })} />
      <NumberField ariaLabel="Creux de l’étoile (%)" name={`${namePrefix}inset`} unit="%" value={value?.inset ?? null} min={0} max={99} step={5} decimals={0} onCommit={(v) => onChange({ inset: v })} />
      <NumberField ariaLabel="Arrondi des sommets (%)" name={`${namePrefix}rounding`} unit="%" value={value?.rounding ?? null} min={0} max={100} step={5} decimals={0} onCommit={(v) => onChange({ rounding: v })} />
    </div>
  );
}

function ShapeOptions() {
  const preset = useStore(shapeToolStore, (s) => s.preset);
  const polygon = useStore(polygonToolStore, (s) => s);
  const library = useEditor((s) => s.doc?.shapes);
  const choose = (id: string) => shapeToolStore.setState({ preset: id });
  const item = (id: string, name: string, d: string) => (
    <Button key={id} variant="toggle" size="sm" className="justify-start" aria-pressed={preset === id} onClick={() => choose(id)} data-shape-option={id}>
      <ShapeSwatch d={d} />
      <span className="truncate">{name}</span>
    </Button>
  );
  return (
    <div className="flex w-56 flex-col gap-1">
      <div className="px-1 text-[11px] font-medium text-neutral-500">Forme à poser</div>
      {Object.values(SHAPE_PRESETS).map((p) => item(p.id, p.name, p.d))}
      {item(POLYGON_ID, 'Polygone ou étoile réglable', polygonPath(polygon).d)}
      {preset === POLYGON_ID && (
        <div className="px-1 pb-1">
          <PolygonFields value={polygon} namePrefix="tool-" onChange={(patch) => polygonToolStore.setState(patch)} />
          <div className="mt-0.5 grid grid-cols-3 gap-1.5 text-[10px] text-neutral-500">
            <span>Côtés</span>
            <span>Creux</span>
            <span>Arrondi</span>
          </div>
        </div>
      )}
      {!!library?.length && <div className="mt-1 px-1 text-[11px] font-medium text-neutral-500">Formes du document</div>}
      {library?.map((s) => item(s.id, s.name, s.d))}
      <div className="mt-1 border-t border-neutral-200 pt-1.5">
        <SvgImportButton />
      </div>
    </div>
  );
}

registerTool({
  id: 'shape',
  label: 'Forme',
  icon: Droplet,
  order: 60,
  shortcut: 'S',
  cursor: 'crosshair',
  options: ShapeOptions,
  create: createShape,
});
