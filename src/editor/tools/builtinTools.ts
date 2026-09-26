// Outils de base de la barre de gauche (tâche 2.8) : sélection, main, et création par clic-glisser ou
// d'un clic (taille par défaut, coin haut-gauche au point cliqué).
import { Circle, Droplet, Hand, ImagePlus, MousePointer2, QrCode, Slash, Square, Star, Type } from 'lucide-react';
import { SHAPE_PRESETS } from '../../model/shapes';
import type { DocObject, Id, LayoutDocument } from '../../model/types';
import { defaultLayerId } from '../../store/documentStore';
import { addObjects } from '../../store/commands';
import type { Box } from '../../store/tree';
import { registerTool, type CreateContext } from '../registry/api';
import { DEFAULT_SIZES, makeEllipse, makeFrame, makeIcon, makeLine, makeQr, makeRect, makeShape, makeText, type NewObjectOptions } from './defaults';
import { ShapeToolOptions } from './ShapeToolOptions';
import { shapeToolStore } from './shapeToolStore';

/** Crée un objet sur la face visée, sur le calque actif, et le sélectionne. */
export function createOnPage(
  ctx: CreateContext,
  label: string,
  factory: (doc: LayoutDocument, options: NewObjectOptions) => DocObject,
  box: Box,
): Id[] | undefined {
  const layerId = defaultLayerId(ctx.doc, ctx.state.activeLayerId);
  if (!layerId) return undefined;
  return ctx.state.apply(
    label,
    (d) => {
      const obj = factory(d, { layerId, box });
      addObjects(d, [obj], [obj.id], { pageId: ctx.pageId });
      return [obj.id];
    },
    { select: (ids) => ids },
  );
}

/** Cadre tracé, ou taille par défaut au simple clic. */
const boxFor = (ctx: CreateContext, key: string, aspect?: number): Box => {
  if (!ctx.isClick) return ctx.box;
  const size = DEFAULT_SIZES[key];
  const h = aspect ? size.w / aspect : size.h;
  return { x: ctx.box.x, y: ctx.box.y, w: size.w, h };
};

registerTool({ id: 'select', label: 'Sélection', icon: MousePointer2, order: 0, shortcut: 'V' });
registerTool({ id: 'hand', label: 'Main (déplacer la vue)', icon: Hand, order: 5, shortcut: 'H', cursor: 'grab' });

registerTool({
  id: 'text',
  label: 'Texte',
  icon: Type,
  order: 10,
  shortcut: 'T',
  cursor: 'text',
  create: (ctx) => createOnPage(ctx, 'Ajouter un texte', makeText, boxFor(ctx, 'text')),
});

registerTool({
  id: 'rect',
  label: 'Rectangle',
  icon: Square,
  order: 20,
  shortcut: 'R',
  cursor: 'crosshair',
  create: (ctx) => createOnPage(ctx, 'Ajouter un rectangle', makeRect, boxFor(ctx, 'rect')),
});

registerTool({
  id: 'ellipse',
  label: 'Ellipse',
  icon: Circle,
  order: 30,
  shortcut: 'E',
  cursor: 'crosshair',
  create: (ctx) => createOnPage(ctx, 'Ajouter une ellipse', makeEllipse, boxFor(ctx, 'ellipse')),
});

registerTool({
  id: 'line',
  label: 'Ligne',
  icon: Slash,
  order: 40,
  shortcut: 'L',
  cursor: 'crosshair',
  create: (ctx) => {
    // Une ligne va d'un coin à l'autre de sa boîte : tracée vers le haut-droit, elle est « retournée ».
    const flip = !ctx.isClick && (ctx.end.x - ctx.start.x) * (ctx.end.y - ctx.start.y) < 0;
    return createOnPage(ctx, 'Ajouter une ligne', (d, o) => makeLine(d, o, flip), boxFor(ctx, 'line'));
  },
});

registerTool({
  id: 'frame',
  label: 'Cadre photo',
  icon: ImagePlus,
  order: 50,
  shortcut: 'F',
  cursor: 'crosshair',
  create: (ctx) => createOnPage(ctx, 'Ajouter un cadre photo', (d, o) => makeFrame(d, o), boxFor(ctx, 'frame')),
});

registerTool({
  id: 'shape',
  label: 'Forme',
  icon: Droplet,
  order: 60,
  shortcut: 'S',
  cursor: 'crosshair',
  options: ShapeToolOptions,
  create: (ctx) => {
    const preset = SHAPE_PRESETS[shapeToolStore.getState().preset] ?? SHAPE_PRESETS.goutte;
    return createOnPage(ctx, 'Ajouter une forme', (d, o) => makeShape(d, o, preset.id), boxFor(ctx, 'shape', preset.aspect));
  },
});

registerTool({
  id: 'icon',
  label: 'Icône',
  icon: Star,
  order: 70,
  shortcut: 'K',
  cursor: 'crosshair',
  create: (ctx) => createOnPage(ctx, 'Ajouter une icône', (d, o) => makeIcon(d, o), boxFor(ctx, 'icon', 1)),
});

registerTool({
  id: 'qr',
  label: 'QR code',
  icon: QrCode,
  order: 80,
  shortcut: 'Q',
  cursor: 'crosshair',
  create: (ctx) => createOnPage(ctx, 'Ajouter un QR code', (d, o) => makeQr(d, o), boxFor(ctx, 'qr', 1)),
});
