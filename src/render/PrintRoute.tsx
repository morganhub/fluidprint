import { useCallback, useEffect, useRef, useState } from 'react';
import { faceSize } from '../model/format';
import { withSourceColors } from '../model/swatches';
import type { LayoutDocument } from '../model/types';
import { defaultImageResolver } from './context';
import { loadDocumentFonts } from './fonts';
import { measureLineCounts } from './lineCount';
import { PageView } from './PageView';
import { refreshTextFlow } from './textFlow';
import { measureTextContentMm, measureTextInkMm } from './textMetrics';

export interface ImageStatus {
  assetId: string;
  ok: boolean;
}

declare global {
  interface Window {
    /** Posé à vrai quand polices et photos sont chargées et les lignes comptées : Puppeteer l'attend. */
    __ready?: boolean;
    /** Nombre de lignes rendues par bloc texte (contrat, point 12). */
    __lineCounts?: Record<string, number>;
    /** Photos de la page et leur chargement, une entrée par élément <image>. */
    __images?: ImageStatus[];
    /** Problèmes rencontrés (document illisible, photo introuvable) : l'export les remonte. */
    __printErrors?: string[];
    /** Mesures des blocs texte tels qu'imprimés : le contrôle en amont de l'export (4.8) s'en sert. */
    __textMeasures?: Record<string, PrintTextMeasure>;
  }
}

export interface PrintTextMeasure {
  /** Hauteur occupée par le texte (mm). */
  contentH: number;
  /** Étendue des lignes (mm, repère du bloc). */
  ink: { x: number; y: number; w: number; h: number } | null;
}

/** Hauteur et étendue du texte de chaque bloc imprimé (un bloc de page type n'est mesuré qu'une fois). */
function measureTextBlocks(): Record<string, PrintTextMeasure> {
  const out: Record<string, PrintTextMeasure> = {};
  for (const el of document.querySelectorAll<HTMLElement>('.print-face [data-obj-type="text"][data-obj-id]')) {
    const id = el.dataset.objId!;
    if (id in out) continue;
    const w = parseFloat(el.style.width);
    out[id] = { contentH: measureTextContentMm(el, el, w), ink: measureTextInkMm(el, w) };
  }
  return out;
}

/** Suit les chargements de photos dès le premier rendu : une image en cache peut finir avant nos effets. */
function createImageTracker() {
  const settled: ImageStatus[] = [];
  // Plusieurs attentes possibles : StrictMode lance deux fois les effets en développement.
  let waiters: (() => void)[] = [];
  return {
    settled,
    settle(assetId: string, ok: boolean) {
      settled.push({ assetId, ok });
      const wake = waiters;
      waiters = [];
      wake.forEach((fn) => fn());
    },
    async waitFor(count: number) {
      while (settled.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Message d'une photo qui n'a pas chargé. Le navigateur ne dit pas pourquoi : on redemande l'en-tête du
 * fichier pour distinguer un fichier absent d'un fichier présent mais que Chrome ne sait pas décoder.
 */
async function imageFailure(doc: LayoutDocument, assetId: string): Promise<string> {
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset) return `Photo introuvable : ${assetId}`;
  const res = await fetch(defaultImageResolver(doc.id, 'print')(asset), { method: 'HEAD' }).catch(() => null);
  return res?.ok ? `Photo illisible par le navigateur : ${assetId} (${asset.original})` : `Photo introuvable : ${assetId}`;
}

/**
 * Route d'impression /print/:docId (contrat, point 12) : les faces seules, à taille réelle, photos
 * d'origine, calques non imprimables exclus. `window.__ready` ne passe à vrai qu'une fois polices
 * et photos chargées et les lignes comptées.
 */
export function PrintRoute({ docId }: { docId: string }) {
  const [doc, setDoc] = useState<LayoutDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tracker = useRef(createImageTracker());
  const onImageSettled = useCallback((assetId: string, ok: boolean) => tracker.current.settle(assetId, ok), []);
  // Objets qui n'ont pas pu être rendus : signalés au premier rendu, avant que l'attente ne commence.
  const renderErrors = useRef(new Map<string, string>());
  const onRenderError = useCallback((objId: string, message: string) => void renderErrors.current.set(objId, message), []);

  useEffect(() => {
    window.__ready = false;
    let cancelled = false;
    fetch(`/api/doc/${encodeURIComponent(docId)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
        return body as LayoutDocument;
      })
      // ?colors=source : couleurs d'origine du design au lieu de la simulation CMJN (contrôle au pixel de l'import).
      .then((d) => !cancelled && setDoc(new URLSearchParams(location.search).get('colors') === 'source' ? withSourceColors(d) : d))
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        window.__printErrors = [e.message];
        window.__ready = true;
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      await loadDocumentFonts(doc);
      // Seules les photos des cadres préviennent le suivi : un <image> glissé dans un SVG importé ne
      // doit pas bloquer l'impression.
      const expected = document.querySelectorAll('.print-face image[data-asset-id]').length;
      await tracker.current.waitFor(expected);
      await document.fonts.ready;
      // Texte chaîné (4.12) : la coupe entre blocs est re-mesurée maintenant que les polices sont là.
      refreshTextFlow();
      await nextFrame();
      await nextFrame();
      if (cancelled) return;
      window.__lineCounts = measureLineCounts(document);
      window.__textMeasures = measureTextBlocks();
      window.__images = [...tracker.current.settled];
      const failed = await Promise.all(tracker.current.settled.filter((s) => !s.ok).map((s) => imageFailure(doc, s.assetId)));
      if (cancelled) return;
      const broken = [...renderErrors.current].map(([id, message]) => `Objet ${id} impossible à rendre : ${message}`);
      window.__printErrors = [...broken, ...failed];
      window.__ready = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  if (error) return <p style={{ padding: '10mm', fontFamily: 'sans-serif' }}>Impression impossible : {error}</p>;
  if (!doc) return null;

  const size = faceSize(doc.format);
  return (
    <>
      <style>{`
        @page { size: ${size.w}mm ${size.h}mm; margin: 0; }
        html, body { margin: 0; padding: 0; background: #ffffff; }
        .print-face { break-after: page; }
        .print-face:last-child { break-after: auto; }
      `}</style>
      <div className="print-root">
        {doc.pages.map((page) => (
          <PageView key={page.id} doc={doc} page={page} mode="print" className="print-face" onImageSettled={onImageSettled} onRenderError={onRenderError} />
        ))}
      </div>
    </>
  );
}
