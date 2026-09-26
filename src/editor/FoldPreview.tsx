// Aperçu plié en 3D (tâche 2.20), en CSS 3D : le dépliant replié (on voit la couverture), couverture
// ouverte (on voit le rabat), puis entièrement ouvert ; « Retourner » montre le dos.
// Modèle physique d'un pli roulé à 3 volets : la face intérieure vue de face, ses volets de gauche à
// droite sont les dos des volets extérieurs de droite à gauche (intérieur 1 ↔ extérieur 3…). Le volet
// central reste fixe ; le volet d'extrémité le plus étroit (le rabat) se replie d'abord, puis l'autre
// par-dessus. Chaque volet a deux faces (avant : intérieur, arrière : extérieur), découpées dans le
// rendu des faces (PageView), fond perdu exclu.
import { Box as BoxIcon } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import type { LayoutDocument, Page } from '../model/types';
import { PX_PER_MM } from '../model/units';
import { PageView } from '../render/PageView';
import { useEditor } from '../store/documentStore';
import { registerTopbarAction } from './registry/api';

export type FoldState = 'closed' | 'flap' | 'open';

/** Échelle de l'aperçu (1 = taille réelle). */
const SCALE = 0.55;
const px = (mm: number) => mm * PX_PER_MM * SCALE;

interface FoldPanel {
  /** Rang du volet sur la face intérieure (0 = gauche). */
  index: number;
  x: number;
  w: number;
  /** Nom du volet intérieur (avant) et du volet extérieur au dos. */
  frontName: string;
  backName: string;
  /** Début du volet au dos, en mm depuis le bord fini gauche de la face extérieure. */
  backX: number;
}

export interface FoldModel {
  outside: Page;
  inside: Page;
  panels: FoldPanel[];
  /** Volet replié en premier (le rabat), puis celui qui le recouvre (la couverture). */
  inner: number;
  outer: number;
}

/**
 * Modèle du pli roulé, ou null si le document n'en est pas un : il faut deux faces de trois volets, et un
 * volet d'extrémité plus étroit que le volet central (sans cela il ne rentre pas une fois replié). Trois
 * volets égaux font un pli accordéon (gabarit « Dépliant A4 pli accordéon »), que ce modèle ne sait pas plier.
 */
export function foldModel(doc: LayoutDocument): FoldModel | null {
  const [outFace, inFace] = doc.format.faces;
  if (!outFace || !inFace || outFace.panels.length !== 3 || inFace.panels.length !== 3) return null;
  const outside = doc.pages.find((p) => p.faceId === outFace.id);
  const inside = doc.pages.find((p) => p.faceId === inFace.id);
  if (!outside || !inside) return null;
  const starts = (ws: number[]) => ws.map((_, i) => ws.slice(0, i).reduce((a, b) => a + b, 0));
  const outX = starts(outFace.panels.map((p) => p.w));
  const inX = starts(inFace.panels.map((p) => p.w));
  const panels = inFace.panels.map((p, i) => {
    const j = outFace.panels.length - 1 - i;
    return { index: i, x: inX[i], w: p.w, frontName: p.name, backName: outFace.panels[j].name, backX: outX[j] };
  });
  // Le rabat est le volet d'extrémité le plus étroit (97 mm contre 100) : il se replie à l'intérieur.
  const inner = panels[2].w <= panels[0].w ? 2 : 0;
  if (panels[inner].w >= panels[1].w) return null;
  return { outside, inside, panels, inner, outer: 2 - inner };
}

/** Une partie d'une face (volet), sans fond perdu, à l'échelle de l'aperçu. */
function PanelFace({ doc, page, x, name, back }: { doc: LayoutDocument; page: Page; x: number; name: string; back?: boolean }) {
  const bleed = doc.format.bleed;
  const style: CSSProperties = {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    backfaceVisibility: 'hidden',
    background: '#fff',
    transform: back ? 'rotateY(180deg)' : undefined,
  };
  return (
    <div style={style} data-fold-face={`${page.faceId}:${name}`} data-fold-face-name={name}>
      <div style={{ position: 'absolute', left: -px(bleed + x), top: -px(bleed), pointerEvents: 'none' }}>
        <PageView doc={doc} page={page} mode="screen" zoom={SCALE} />
      </div>
      <div className="pointer-events-none absolute inset-0" style={{ boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.12)' }} />
    </div>
  );
}

/** Angle de chaque volet mobile pour un état : 180° = replié sur le volet central. */
function anglesFor(state: FoldState): { inner: number; outer: number } {
  if (state === 'closed') return { inner: 180, outer: 180 };
  if (state === 'flap') return { inner: 180, outer: 0 };
  return { inner: 0, outer: 0 };
}

export function FoldScene({ doc: source, state, flipped }: { doc: LayoutDocument; state: FoldState; flipped: boolean }) {
  // Comme à l'impression : les calques non imprimables (repères du design, notes) n'apparaissent pas.
  const doc = useMemo(() => ({ ...source, layers: source.layers.filter((l) => l.printable) }), [source]);
  const model = foldModel(doc);
  if (!model) return <p className="text-neutral-500">L’aperçu plié n’est disponible que pour un dépliant pli roulé (deux faces de trois volets).</p>;
  const angles = anglesFor(state);
  const h = doc.format.trim.h;
  const total = model.panels.reduce((s, p) => s + p.w, 0);
  const transition = 'transform 600ms cubic-bezier(0.4, 0, 0.2, 1)';
  return (
    <div className="flex items-center justify-center" style={{ perspective: '2200px', height: px(h) + 60 }}>
      <div
        data-fold-assembly
        data-fold-state={state}
        data-fold-flipped={flipped ? 'true' : undefined}
        style={{ position: 'relative', width: px(total), height: px(h), transformStyle: 'preserve-3d', transform: `rotateX(8deg) rotateY(${flipped ? 180 : 0}deg)`, transition }}
      >
        {/* Ordre du DOM = ordre d'empilement une fois replié (volet central, rabat, couverture) : le
            test de pointage de Chrome, qui ne trie pas toujours les plans 3D très proches, s'y fie. */}
        {(flipped ? [model.outer, model.inner, 1] : [1, model.inner, model.outer]).map((i) => model.panels[i]).map((p) => {
          // Le volet central est fixe ; les deux autres pivotent autour de leur pli, vers le spectateur.
          // Un léger décalage en profondeur, proportionnel au pliage, tient lieu d'épaisseur du papier.
          let transform = 'none';
          let origin = 'center';
          if (p.index !== 1) {
            const isInner = p.index === model.inner;
            const angle = isInner ? angles.inner : angles.outer;
            const lift = (isInner ? 1 : 2) * (angle / 180);
            const sign = p.index === 0 ? 1 : -1;
            origin = p.index === 0 ? 'right center' : 'left center';
            transform = `translateZ(${lift}px) rotateY(${sign * angle}deg)`;
          }
          return (
            <div
              key={p.index}
              data-fold-panel={p.index}
              style={{ position: 'absolute', left: px(p.x), top: 0, width: px(p.w), height: px(h), transformStyle: 'preserve-3d', transformOrigin: origin, transform, transition }}
            >
              <PanelFace doc={doc} page={model.inside} x={p.x} name={p.frontName} />
              <PanelFace doc={doc} page={model.outside} x={p.backX} name={p.backName} back />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FoldPreviewButton() {
  const doc = useEditor((s) => s.doc);
  // Flyer, carte, affiche, pli accordéon : rien à replier, le bouton n'aurait rien à montrer.
  const foldable = useEditor((s) => !!s.doc && foldModel(s.doc) !== null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FoldState>('closed');
  const [flipped, setFlipped] = useState(false);
  const steps: { id: FoldState; label: string }[] = [
    { id: 'closed', label: 'Replié' },
    { id: 'flap', label: 'Couverture ouverte' },
    { id: 'open', label: 'Ouvert' },
  ];
  if (!foldable) return null;
  return (
    <>
      <Button variant="outline" size="sm" data-topbar-action="fold-preview" disabled={!doc} onClick={() => setOpen(true)}>
        <BoxIcon />
        Aperçu plié
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setState('closed');
            setFlipped(false);
          }
        }}
      >
        <DialogContent className="max-w-5xl bg-neutral-100" data-fold-preview>
          <DialogHeader>
            <DialogTitle>Aperçu plié</DialogTitle>
            <DialogDescription>Le dépliant tel qu’il sortira du pli roulé : repliez-le, ouvrez la couverture, puis le rabat.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-1" role="group" aria-label="État du pliage">
            {steps.map((s) => (
              <Button key={s.id} variant="toggle" size="sm" aria-pressed={state === s.id} data-fold-step={s.id} onClick={() => setState(s.id)}>
                {s.label}
              </Button>
            ))}
            <span className="mx-1 h-5 w-px bg-neutral-300" />
            <Button variant="toggle" size="sm" aria-pressed={flipped} data-fold-flip onClick={() => setFlipped((f) => !f)}>
              Retourner
            </Button>
          </div>
          {doc && open && <FoldScene doc={doc} state={state} flipped={flipped} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

registerTopbarAction({ id: 'fold-preview', order: 50, label: 'Aperçu plié', component: FoldPreviewButton });
