// Coulée du texte (tâches 4.12 et 4.13) : ce qu'affiche chaque bloc texte quand il est chaîné ou habillé.
//
// - Habillage : les flottants `shape-outside` calculés par model/wrap.ts.
// - Chaînage : l'article (paragraphes du premier bloc) est découpé entre les blocs de la chaîne. La coupe
//   est MESURÉE par le navigateur, au mot près : pour chaque bloc, le plus long début de ce qui reste qui
//   tient dans sa hauteur (même tolérance que le « + » du texte en excès), cherché par dichotomie sur les
//   coupures possibles, dans un élément hors écran construit exactement comme TextFrameView. L'écran et
//   la route d'impression font le même calcul dans le même moteur : même coupe, mêmes lignes au PDF.
//
// Les vues d'objets sont mémoïsées par référence d'objet : réduire le premier bloc ne re-rendrait pas le
// second. Chaque PageView tient donc un petit magasin (TextFlowStore) qui publie, à chaque rendu, une
// signature par bloc (géométrie de l'habillage, article et boîtes de la chaîne, polices chargées) ; un
// bloc se re-rend quand SA signature change.
import { createContext, useContext, useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import { breakPositions, chainFrames, isChained, sliceStory, type StoryPos, type StorySlice } from '../model/threading';
import type { Id, LayoutDocument, Paragraph, TextObject, TextStyle } from '../model/types';
import { wrapIndex, type WrapFloats } from '../model/wrap';
import { useRender, type RenderMode } from './context';
import { paragraphCss, renderNnbsp, runCss, textBlockCss, wrapFloatCss } from './textCss';
import { measureTextContentMm } from './textMetrics';

/** Dépassement toléré dans un bloc chaîné (mm) : le même que celui du « + » (text/overset.tsx). */
export const CHAIN_FIT_TOLERANCE_MM = 0.25;

// ---------------------------------------------------------------- polices

// Une mesure faite avant le chargement des polices serait fausse : chaque chargement terminé invalide
// les coupes, et les magasins republient leurs signatures (les blocs chaînés se re-mesurent).
let fontsEpoch = 0;
const epochListeners = new Set<() => void>();
let fontsHooked = false;

function hookFonts() {
  if (fontsHooked || typeof document === 'undefined' || !document.fonts) return;
  fontsHooked = true;
  document.fonts.addEventListener('loadingdone', () => refreshTextFlow());
}

/** Oublie les coupes mesurées et fait re-mesurer les blocs chaînés (polices chargées entre-temps). */
export function refreshTextFlow(): void {
  fontsEpoch++;
  chainCache.clear();
  for (const l of [...epochListeners]) l();
}

// ---------------------------------------------------------------- mesure hors écran

function applyCss(el: HTMLElement, css: CSSProperties) {
  for (const [key, value] of Object.entries(css)) {
    if (value === undefined || value === null) continue;
    el.style.setProperty(key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), String(value));
  }
}

/** Même arbre DOM que TextFrameView : flottants d'habillage, paragraphes, segments, retours forcés. */
function fillTextDom(el: HTMLElement, paragraphs: Paragraph[], style: TextStyle, continues: boolean, floats: WrapFloats | null, doc: LayoutDocument) {
  el.replaceChildren();
  for (const f of [floats?.left, floats?.right]) {
    if (!f) continue;
    const div = document.createElement('div');
    div.dataset.wrapFloat = f.side;
    applyCss(div, wrapFloatCss(f));
    el.appendChild(div);
  }
  paragraphs.forEach((para, i) => {
    const p = document.createElement('div');
    applyCss(p, paragraphCss(para, i, paragraphs.length, style, continues));
    if (para.runs.some((r) => r.text !== '')) {
      for (const run of para.runs) {
        const span = document.createElement('span');
        applyCss(span, runCss(run, doc));
        run.text.split('\n').forEach((part, j) => {
          if (j > 0) span.appendChild(document.createElement('br'));
          span.appendChild(document.createTextNode(renderNnbsp(part)));
        });
        p.appendChild(span);
      }
    } else p.appendChild(document.createElement('br'));
    el.appendChild(p);
  });
}

/** Découpe l'article entre les blocs de la chaîne (voir en tête de fichier). */
function measureChain(doc: LayoutDocument, frames: TextObject[], head: TextObject, wraps: Map<Id, WrapFloats>): Map<Id, StorySlice> {
  const out = new Map<Id, StorySlice>();
  const paras = head.paragraphs;
  const breaks = breakPositions(paras);
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  try {
    let from: StoryPos = { p: 0, offset: 0 };
    let bi = 0;
    let done = false;
    frames.forEach((frame, fi) => {
      if (done) {
        out.set(frame.id, { paragraphs: [], continues: false });
        return;
      }
      if (fi === frames.length - 1) {
        out.set(frame.id, sliceStory(paras, from, null));
        return;
      }
      const floats = wraps.get(frame.id) ?? null;
      // Habillé, un bloc reste aligné en haut (voir TextFrameView) : la mesure fait de même.
      const css = textBlockCss({ style: head.style, verticalAlign: floats ? 'top' : frame.verticalAlign }, doc);
      el.removeAttribute('style');
      applyCss(el, { ...css, whiteSpace: 'normal', position: 'absolute', left: '-10000mm', top: '0', width: `${frame.w}mm`, visibility: 'hidden' });
      const fits = (to: number) => {
        if (to <= bi) return true;
        const slice = sliceStory(paras, from, to === breaks.length - 1 ? null : breaks[to]);
        fillTextDom(el, slice.paragraphs, head.style, slice.continues, floats, doc);
        return measureTextContentMm(el, el, frame.w) <= frame.h + CHAIN_FIT_TOLERANCE_MM;
      };
      if (fits(breaks.length - 1)) {
        out.set(frame.id, sliceStory(paras, from, null));
        done = true;
        return;
      }
      // Dichotomie : `lo` tient toujours, `hi` jamais.
      let lo = bi;
      let hi = breaks.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      out.set(frame.id, lo === bi ? { paragraphs: [], continues: false } : sliceStory(paras, from, breaks[lo]));
      from = breaks[lo];
      bi = lo;
    });
  } finally {
    el.remove();
  }
  return out;
}

// Coupes mesurées, par signature de chaîne. Quelques dizaines d'entrées suffisent (une par état récent).
const chainCache = new Map<string, Map<Id, StorySlice>>();
const CHAIN_CACHE_MAX = 64;

function chainSignature(doc: LayoutDocument, frames: Id[], wraps: Map<Id, WrapFloats>, mode: RenderMode): string {
  const head = doc.objects[frames[0]] as TextObject;
  return JSON.stringify([
    fontsEpoch,
    mode,
    head.paragraphs,
    head.style,
    frames.map((f) => {
      const o = doc.objects[f] as TextObject;
      return [f, o.w, o.h, o.verticalAlign ?? 'top', wraps.get(f)?.key ?? ''];
    }),
  ]);
}

function chainLayout(doc: LayoutDocument, frames: Id[], wraps: Map<Id, WrapFloats>, mode: RenderMode): Map<Id, StorySlice> {
  const sig = chainSignature(doc, frames, wraps, mode);
  let layout = chainCache.get(sig);
  if (!layout) {
    const objs = frames.map((f) => doc.objects[f] as TextObject);
    layout = measureChain(doc, objs, objs[0], wraps);
    if (chainCache.size >= CHAIN_CACHE_MAX) chainCache.delete(chainCache.keys().next().value!);
    chainCache.set(sig, layout);
  }
  return layout;
}

// ---------------------------------------------------------------- magasin par PageView

export interface TextFlowStore {
  /** Document et mode rendus par la PageView (appelé après chaque rendu). */
  publish(doc: LayoutDocument, mode: RenderMode): void;
  subscribe(id: Id): (onChange: () => void) => () => void;
  key(id: Id): string;
  wraps(doc: LayoutDocument, printing: boolean): Map<Id, WrapFloats>;
  /** Suit les chargements de polices ; renvoie de quoi arrêter (démontage de la PageView). */
  attach(): () => void;
}

export function createTextFlowStore(): TextFlowStore {
  let lastDoc: LayoutDocument | null = null;
  let lastMode: RenderMode = 'screen';
  let wrapsCache: { doc: LayoutDocument; printing: boolean; map: Map<Id, WrapFloats> } | null = null;
  let keys = new Map<Id, string>();
  const subs = new Map<Id, Set<() => void>>();

  const wraps = (doc: LayoutDocument, printing: boolean) => {
    if (wrapsCache?.doc !== doc || wrapsCache.printing !== printing) wrapsCache = { doc, printing, map: wrapIndex(doc, printing) };
    return wrapsCache.map;
  };

  const recompute = () => {
    const doc = lastDoc;
    if (!doc) return;
    const w = wraps(doc, lastMode === 'print');
    const next = new Map<Id, string>();
    const chainKeys = new Map<Id, string>();
    for (const obj of Object.values(doc.objects)) {
      if (obj.type !== 'text') continue;
      const parts: string[] = [];
      const f = w.get(obj.id);
      if (f) parts.push(f.key);
      if (isChained(doc, obj.id)) {
        const frames = chainFrames(doc, obj.id);
        let k = chainKeys.get(frames[0]);
        if (k === undefined) chainKeys.set(frames[0], (k = chainSignature(doc, frames, w, lastMode)));
        parts.push(k);
      }
      if (parts.length) next.set(obj.id, parts.join('|'));
    }
    const changed = [...new Set([...keys.keys(), ...next.keys()])].filter((id) => keys.get(id) !== next.get(id));
    keys = next;
    for (const id of changed) subs.get(id)?.forEach((cb) => cb());
  };

  return {
    publish(doc, mode) {
      lastDoc = doc;
      lastMode = mode;
      recompute();
    },
    subscribe: (id) => (cb) => {
      let set = subs.get(id);
      if (!set) subs.set(id, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (!set!.size) subs.delete(id);
      };
    },
    key: (id) => keys.get(id) ?? '',
    wraps,
    attach() {
      hookFonts();
      epochListeners.add(recompute);
      // Des polices ont pu finir de charger entre le rendu et ce branchement.
      recompute();
      return () => void epochListeners.delete(recompute);
    },
  };
}

export const TextFlowContext = createContext<TextFlowStore | null>(null);

// ---------------------------------------------------------------- ce qu'affiche un bloc

export interface TextFlow {
  paragraphs: Paragraph[];
  /** Mise en forme du bloc : celle du premier bloc de la chaîne (l'article), sinon la sienne. */
  style: TextStyle;
  floats: WrapFloats | null;
  /** Le dernier paragraphe continue dans le bloc suivant. */
  continues: boolean;
  chained: boolean;
}

/** Contenu d'un bloc texte dans un document (sans React : route d'impression, tests, éditeur). */
export function textFlowFor(doc: LayoutDocument, obj: TextObject, mode: RenderMode, store?: TextFlowStore | null): TextFlow {
  const wraps = store ? store.wraps(doc, mode === 'print') : wrapIndex(doc, mode === 'print');
  const floats = wraps.get(obj.id) ?? null;
  if (!isChained(doc, obj.id) || typeof document === 'undefined') {
    return { paragraphs: obj.paragraphs, style: obj.style, floats, continues: false, chained: false };
  }
  const frames = chainFrames(doc, obj.id);
  const head = doc.objects[frames[0]] as TextObject;
  const slice = chainLayout(doc, frames, wraps, mode).get(obj.id) ?? { paragraphs: [], continues: false };
  return { paragraphs: slice.paragraphs, style: head.style, floats, continues: slice.continues, chained: true };
}

const noSubscribe = () => () => {};

/** Contenu d'un bloc texte rendu ; re-rend le bloc quand sa chaîne ou son habillage change. */
export function useTextFlow(obj: TextObject): TextFlow {
  const store = useContext(TextFlowContext);
  const subscribe = useMemo(() => (store ? store.subscribe(obj.id) : noSubscribe), [store, obj.id]);
  useSyncExternalStore(subscribe, () => store?.key(obj.id) ?? '');
  const { doc, mode } = useRender();
  return textFlowFor(doc, obj, mode, store);
}
