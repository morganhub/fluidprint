import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { faceSize } from '../model/format';
import type { LayoutDocument } from '../model/types';
import { mmToPx } from '../model/units';
import { loadDocumentFonts } from '../render/fonts';
import { measureLineCounts } from '../render/lineCount';
import { PageView } from '../render/PageView';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Marge latérale autour des faces, en px (px-8 de chaque côté). */
const GUTTER_PX = 64;

type ZoomSetting = 'fit' | number;

/** Zoom de départ : `?zoom=0.25` (tests, liens directs), sinon ajusté à la largeur. */
function initialZoom(): ZoomSetting {
  const z = Number(new URLSearchParams(location.search).get('zoom'));
  return Number.isFinite(z) && z > 0 ? Math.min(MAX_ZOOM, Math.max(0.05, z)) : 'fit';
}

function useDocument(docId: string) {
  const [doc, setDoc] = useState<LayoutDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/doc/${encodeURIComponent(docId)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
        return body as LayoutDocument;
      })
      .then((d) => !cancelled && setDoc(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [docId]);
  return { doc, error };
}

/** Visionneuse en lecture seule (phase 1) : les faces l'une sous l'autre, zoom ajusté ou manuel. */
export function Viewer({ docId }: { docId: string }) {
  const { doc, error } = useDocument(docId);
  const [setting, setSetting] = useState<ZoomSetting>(initialZoom);
  const [fitZoom, setFitZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !doc) return;
    const faceW = mmToPx(faceSize(doc.format).w);
    const update = () => setFitZoom(Math.max(0.05, (el.clientWidth - GUTTER_PX) / faceW));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  const zoom = setting === 'fit' ? fitZoom : setting;

  // Même signal que la route d'impression : les tests mesurent une fois les polices chargées.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    window.__ready = false;
    (async () => {
      await loadDocumentFonts(doc);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (cancelled) return;
      window.__lineCounts = measureLineCounts(document);
      window.__ready = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, zoom]);

  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 1e-6) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6);
    setSetting(next ?? (dir > 0 ? MAX_ZOOM : MIN_ZOOM));
  };

  return (
    <div className="flex h-screen flex-col bg-neutral-200 text-neutral-900">
      <header className="flex items-center gap-4 border-b border-neutral-300 bg-white px-4 py-2 text-sm">
        <a href="/" className="text-neutral-500 hover:text-neutral-900">
          ← Documents
        </a>
        <h1 className="flex-1 truncate font-semibold">{doc?.name ?? docId}</h1>
        <span className="text-xs text-neutral-500">Lecture seule</span>
        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <button type="button" className="zoom-btn" onClick={() => step(-1)} disabled={zoom <= MIN_ZOOM + 1e-6} aria-label="Zoom arrière">
            −
          </button>
          <span className="w-14 text-center tabular-nums" data-testid="zoom-value">
            {Math.round(zoom * 100)} %
          </span>
          <button type="button" className="zoom-btn" onClick={() => step(1)} disabled={zoom >= MAX_ZOOM - 1e-6} aria-label="Zoom avant">
            +
          </button>
          <button
            type="button"
            className="zoom-btn px-2"
            onClick={() => setSetting('fit')}
            aria-pressed={setting === 'fit'}
            title="Ajuster à la largeur de la fenêtre"
          >
            Ajuster
          </button>
        </div>
      </header>
      <div ref={scroller} className="flex-1 overflow-auto">
        {error && <p className="p-8 text-red-700">Document illisible : {error}</p>}
        {!doc && !error && <p className="p-8 text-neutral-500">Chargement…</p>}
        {doc && (
          <div className="flex w-max min-w-full flex-col items-center gap-8 px-8 py-8">
            {doc.pages.map((page) => (
              <section key={page.id} className="flex flex-col gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{page.name}</h2>
                <PageView doc={doc} page={page} mode="screen" zoom={zoom} className="shadow-md" />
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
