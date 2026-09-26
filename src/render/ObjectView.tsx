import { Component, memo, useContext, type ContextType, type ReactNode } from 'react';
import type { DocObject, GroupObject } from '../model/types';
import { boxStyle, objAttrs } from './box';
import { ObjectsContext, RenderContext } from './context';
import { FrameView } from './FrameView';
import { IconView, SvgView } from './IconView';
import { QrView } from './QrView';
import { EllipseView, LineView, PathView, RectView } from './ShapeView';
import { TextFrameView } from './TextFrameView';

/** Groupe (contrat, point 10) : un conteneur sans taille ; ses enfants gardent leurs coordonnées absolues. */
function GroupView({ obj }: { obj: GroupObject }) {
  const objects = useContext(ObjectsContext);
  if (!objects) throw new Error('Rendu hors de <PageView> : objets absents');
  return (
    <div {...objAttrs(obj)} style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, opacity: obj.opacity }}>
      {obj.children.map((id) => {
        const child = objects[id];
        return child ? <ObjectView key={id} obj={child} /> : null;
      })}
    </div>
  );
}

/**
 * Un objet qui ne se rend pas (tracé illisible, QR impossible…) ne démonte que lui-même, pas la face
 * entière : la route d'impression reste prête et l'export nomme l'objet fautif au lieu d'attendre
 * `__ready` jusqu'au délai. À l'écran, sa boîte reste visible, barrée de rouge.
 */
class ObjectBoundary extends Component<{ obj: DocObject; children: ReactNode }, { error: string | null }> {
  static contextType = RenderContext;
  declare context: ContextType<typeof RenderContext>;
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    this.context?.onRenderError?.(this.props.obj.id, error instanceof Error ? error.message : String(error));
  }

  render() {
    const { obj, children } = this.props;
    if (this.state.error === null) return children;
    if (this.context?.mode === 'print') return null;
    return (
      <div
        {...objAttrs(obj)}
        data-render-error={this.state.error}
        title={`Objet ${obj.id} impossible à afficher : ${this.state.error}`}
        style={{ ...boxStyle(obj), outline: '0.3mm dashed #e0245e', background: 'rgba(224, 36, 94, 0.08)' }}
      />
    );
  }
}

/** Mémoïsée : un objet inchangé (même référence, le document étant immuable) ne se re-rend pas. */
export const ObjectView = memo(function ObjectView({ obj }: { obj: DocObject }) {
  if (obj.hidden) return null;
  return (
    <ObjectBoundary obj={obj}>
      <ObjectContent obj={obj} />
    </ObjectBoundary>
  );
});

function ObjectContent({ obj }: { obj: DocObject }) {
  switch (obj.type) {
    case 'text':
      return <TextFrameView obj={obj} />;
    case 'rect':
      return <RectView obj={obj} />;
    case 'ellipse':
      return <EllipseView obj={obj} />;
    case 'line':
      return <LineView obj={obj} />;
    case 'path':
      return <PathView obj={obj} />;
    case 'frame':
      return <FrameView obj={obj} />;
    case 'icon':
      return <IconView obj={obj} />;
    case 'svg':
      return <SvgView obj={obj} />;
    case 'qr':
      return <QrView obj={obj} />;
    case 'group':
      return <GroupView obj={obj} />;
  }
}
