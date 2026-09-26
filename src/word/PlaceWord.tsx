// Interface de l'import Word dans l'éditeur, façon « Placer » d'InDesign :
// - action « Placer… » de la barre du haut : choix du .docx et des options, envoi au serveur, puis
//   placement dans le bloc texte sélectionné, ou curseur chargé : un clic sur un bloc texte en remplace le
//   texte, un clic sur une zone vide crée un bloc à la largeur de la zone de sécurité du volet (Échap annule) ;
// - glisser-déposer d'un .docx sur la page : même chose au point de dépôt, avec les dernières options ;
// - document créé depuis l'accueil (« Nouveau document depuis Word ») : remplissage automatique de toutes les
//   faces à l'ouverture ;
// - rapport à la fin : paragraphes, styles créés ou réutilisés, images, liens, avertissements, texte en excès.
import { AlertTriangle, CheckCircle2, FileText, Images, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Label } from '../components/ui/input';
import { pageBoxToScreen, screenToWorld, worldToPage } from '../editor/layout';
import { registerOverlay, registerTopbarAction } from '../editor/registry/api';
import { uiStore } from '../editor/uiStore';
import type { Id, LayoutDocument } from '../model/types';
import { loadDocumentFonts } from '../render/fonts';
import { fitStory } from '../render/textFlow';
import { getEditor, useEditor } from '../store/documentStore';
import { getPersistence } from '../store/persistence';
import { isSelectable, objectBounds, pageIdOf } from '../store/tree';
import { finishTextEdit, TEXT_EDIT_MODE } from '../text/TextEditor';
import { carriesOnlyWordFiles, DOCX_ACCEPT, isWordFile, loadWordFonts, takePendingWord, uploadWord } from './client';
import { DEFAULT_PLACE_OPTIONS, placeWord, type PlaceTarget, type PlaceWordOptions, type WordPlacementReport } from './place';
import type { WordImportResponse } from './types';

/** Mode du curseur chargé : le prochain clic sur la page place le fichier lu. */
export const PLACE_WORD_MODE = 'place-word';

interface WordUiState {
  /** Dernières options choisies (reprises par le glisser-déposer). */
  options: PlaceWordOptions;
  dialogOpen: boolean;
  /** Fichier lu, en attente d'un clic sur la page. */
  loaded: WordImportResponse | null;
  message: { kind: 'busy' | 'error'; text: string } | null;
  report: WordPlacementReport | null;
}

export const wordUi = createStore<WordUiState>()(() => ({ options: { ...DEFAULT_PLACE_OPTIONS }, dialogOpen: false, loaded: null, message: null, report: null }));
const useWordUi = <T,>(selector: (s: WordUiState) => T): T => useStore(wordUi, selector);

const showError = (text: string) => wordUi.setState({ message: { kind: 'error', text } });

/** Bloc texte sélectionné seul (cible directe de « Placer… »), ou null. */
function selectedTextFrame(): Id | null {
  const s = getEditor();
  if (!s.doc || s.selection.length !== 1) return null;
  return s.doc.objects[s.selection[0]]?.type === 'text' ? s.selection[0] : null;
}

/** Bloc texte sous un point client : le plus haut, même dans un groupe ; un bloc verrouillé ne compte pas. */
function textFrameAtPoint(root: HTMLElement, clientX: number, clientY: number, doc: LayoutDocument): Id | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!root.contains(el)) continue;
    const objEl = el.closest('[data-obj-id]');
    if (!objEl || !objEl.closest('[data-page-id]') || objEl.closest('[data-master-item]')) continue;
    const id = objEl.getAttribute('data-obj-id')!;
    if (doc.objects[id]?.type === 'text' && isSelectable(doc, id)) return id;
  }
  return null;
}

/** Cible d'un clic ou d'un dépôt : le bloc texte visé, sinon le point de la face (la plus proche). */
function targetAt(viewport: HTMLElement, clientX: number, clientY: number): PlaceTarget | null {
  const s = getEditor();
  if (!s.doc) return null;
  const frameId = textFrameAtPoint(viewport, clientX, clientY, s.doc);
  if (frameId) return { kind: 'frame', frameId };
  const r = viewport.getBoundingClientRect();
  const point = worldToPage(s.doc, screenToWorld({ x: clientX - r.left, y: clientY - r.top }, s.zoom, s.view), true);
  return point ? { kind: 'point', pageId: point.pageId, x: point.x, y: point.y } : null;
}

/** Place un fichier lu (une étape d'annulation), enregistre et ouvre le rapport. */
export async function runPlacement(response: WordImportResponse, target: PlaceTarget, options: PlaceWordOptions): Promise<WordPlacementReport | null> {
  if (getEditor().mode?.id === TEXT_EDIT_MODE) finishTextEdit();
  // La coulée se mesure avec les vraies polices : titres en 700 ou 800, citations en italique…
  await loadWordFonts();
  let report: WordPlacementReport | null;
  try {
    report = placeWord(getEditor(), response, target, options, fitStory);
  } catch (error) {
    // Rien n'a changé : l'étape n'est enregistrée qu'à la fin de la recette.
    showError(`Fichier Word non placé : ${(error as Error).message}`);
    return null;
  }
  if (!report) {
    showError('Fichier Word non placé : aucune zone de la page ni aucun bloc texte utilisable à cet endroit.');
    return null;
  }
  wordUi.setState({ report, message: null });
  void getPersistence()?.saveNow();
  return report;
}

function cancelLoaded() {
  wordUi.setState({ loaded: null });
  if (getEditor().mode?.id === PLACE_WORD_MODE) getEditor().setMode(null);
}

// ---------------------------------------------------------------- boîte « Placer un fichier Word »

function PlaceWordDialog() {
  const open = useWordUi((s) => s.dialogOpen);
  const options = useWordUi((s) => s.options);
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameId = doc && selection.length === 1 && doc.objects[selection[0]]?.type === 'text' ? selection[0] : null;
  const frameName = frameId ? (doc!.objects[frameId].name ?? frameId) : null;

  const close = (next: boolean) => {
    if (busy) return;
    wordUi.setState({ dialogOpen: next });
    if (!next) {
      setFile(null);
      setError(null);
    }
  };

  const setOption = (key: keyof PlaceWordOptions, value: boolean) => wordUi.setState({ options: { ...wordUi.getState().options, [key]: value } });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const s = getEditor();
    if (!file || busy || !s.doc) return;
    setBusy(true);
    setError(null);
    try {
      const response = await uploadWord(s.docId ?? s.doc.id, file);
      const target = selectedTextFrame();
      setBusy(false);
      wordUi.setState({ dialogOpen: false });
      setFile(null);
      if (target) await runPlacement(response, { kind: 'frame', frameId: target }, wordUi.getState().options);
      else {
        // Curseur chargé : le prochain clic sur la page décide de la cible.
        if (getEditor().mode?.id === TEXT_EDIT_MODE) finishTextEdit();
        wordUi.setState({ loaded: response });
        getEditor().setMode({ id: PLACE_WORD_MODE });
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg" data-place-word-dialog>
        <DialogHeader>
          <DialogTitle>Placer un fichier Word</DialogTitle>
          <DialogDescription>
            Texte, titres, listes, gras, italique et souligné repris ; chaque style Word devient le style de paragraphe du document de même nom (créé s’il manque). Les
            images vont dans le panneau Images.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="place-word-file">Fichier Word (.docx)</Label>
            <input
              id="place-word-file"
              name="word-file"
              type="file"
              accept={DOCX_ACCEPT}
              disabled={busy}
              className="text-[12px] text-neutral-700 file:mr-2 file:h-7 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-2 file:text-[12px] file:font-medium hover:file:bg-neutral-100"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <label className="flex items-start gap-2 text-[12px]">
            <input type="checkbox" name="word-autofill" className="mt-0.5" checked={options.autoFill} disabled={busy} onChange={(e) => setOption('autoFill', e.target.checked)} />
            <span>
              <span className="font-medium">Remplir automatiquement</span>
              <span className="block text-neutral-500">Si le texte déborde, des blocs chaînés sont créés dans la zone de sécurité des volets suivants, puis des faces suivantes.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-[12px]">
            <input type="checkbox" name="word-typography" className="mt-0.5" checked={options.typography} disabled={busy} onChange={(e) => setOption('typography', e.target.checked)} />
            <span>
              <span className="font-medium">Typographie française</span>
              <span className="block text-neutral-500">Espaces insécables avant ; : ! ?, apostrophes courbes, guillemets « ».</span>
            </span>
          </label>
          <p className="rounded-md bg-neutral-50 px-3 py-2 text-[12px] text-neutral-600" data-place-word-target={frameId ?? 'cursor'}>
            {frameId
              ? `Le texte remplacera celui du bloc sélectionné « ${frameName} ».`
              : 'Ensuite, cliquez sur un bloc texte pour en remplacer le texte, ou sur une zone vide de la page pour créer un bloc à la largeur du volet. Un fichier .docx peut aussi être glissé sur la page.'}
          </p>
          {error && (
            <div role="alert" className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900" data-place-word-error>
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => close(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={!file || busy} data-action="place-word-submit">
              {busy ? <Loader2 className="animate-spin" /> : <FileText />}
              Placer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PlaceWordButton() {
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-topbar-action="place-word"
        title="Placer un fichier Word… (texte, styles, listes, images)"
        aria-label="Placer un fichier Word…"
        onClick={() => {
          if (getEditor().mode?.id === TEXT_EDIT_MODE) finishTextEdit();
          wordUi.setState({ dialogOpen: true });
        }}
      >
        <FileText />
        Placer…
      </Button>
      <PlaceWordDialog />
    </>
  );
}

// ---------------------------------------------------------------- rapport

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function ReportDialog() {
  const report = useWordUi((s) => s.report);
  if (!report) return null;
  const placedImages = report.images.filter((i) => i.assetId);
  return (
    <Dialog open onOpenChange={(open) => !open && wordUi.setState({ report: null })}>
      <DialogContent
        className="max-w-xl"
        data-word-report={report.fileName}
        data-word-paragraphs={report.paragraphs}
        data-word-frames={report.frameIds.length}
        data-word-overflow={report.overflow ? report.overflow.paragraphs : 0}
      >
        <DialogHeader>
          <DialogTitle>« {report.fileName} » placé</DialogTitle>
          <DialogDescription>Une seule étape d’annulation (Ctrl+Z) retire tout : texte, blocs, styles et images ajoutés.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-[12px]">
          <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-semibold">
                {plural(report.paragraphs, 'paragraphe', 'paragraphes')} dans {plural(report.frameIds.length, 'bloc texte', 'blocs texte')}
                {report.createdFrames > 0 && ` (${plural(report.createdFrames, 'créé', 'créés')})`}
                {report.frameIds.length > 1 && ', chaînés'}
              </div>
              <div>Style du bloc : {report.blockStyle}</div>
              {report.typographyFixes > 0 && <div>{plural(report.typographyFixes, 'correction typographique', 'corrections typographiques')}</div>}
            </div>
          </div>
          {report.overflow && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-900" data-word-overflow-message>
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <div>
                <div className="font-semibold">
                  Texte en excès : {plural(report.overflow.paragraphs, 'paragraphe', 'paragraphes')} ({plural(report.overflow.characters, 'caractère', 'caractères')}) ne tiennent pas
                </div>
                <div>
                  {report.autoFill
                    ? report.documentFull
                      ? 'Le document est plein : plus aucun volet libre après le dernier bloc.'
                      : 'Agrandissez les blocs ou chaînez-en d’autres.'
                    : 'Agrandissez le bloc, chaînez-en un autre, ou placez de nouveau avec « Remplir automatiquement ».'}{' '}
                  Début : « {report.overflow.excerpt} »
                </div>
              </div>
            </div>
          )}
          <p data-word-styles-created={report.stylesCreated.join('|')} data-word-styles-reused={report.stylesReused.join('|')}>
            {report.stylesCreated.length > 0 && (
              <>
                <span className="font-medium">Styles créés</span> (marqués « Word » dans le panneau Styles) : {report.stylesCreated.join(', ')}.{' '}
              </>
            )}
            {report.stylesReused.length > 0 && (
              <>
                <span className="font-medium">Styles du document réutilisés</span> : {report.stylesReused.join(', ')}.
              </>
            )}
          </p>
          {report.images.length > 0 && (
            <div data-word-images={placedImages.length}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {plural(placedImages.length, 'image ajoutée', 'images ajoutées')} au panneau Images, non placée{placedImages.length > 1 ? 's : glissez-les' : ' : glissez-la'} sur un cadre.
                </span>
                <Button variant="outline" size="sm" data-action="word-open-images" onClick={() => uiStore.getState().setActivePanel('images')}>
                  <Images />
                  Images
                </Button>
              </div>
              <ul className="mt-1 list-disc pl-5 text-neutral-600">
                {report.images.map((img, i) => (
                  <li key={i} className={img.assetId ? undefined : 'text-red-700'}>
                    {img.name}
                    {img.after ? ` — après « ${img.after} »` : ' — en tête du texte'}
                    {!img.assetId && ' (non importée)'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.links.length > 0 && (
            <div data-word-links={report.links.length}>
              <span className="font-medium">Liens devenus du texte</span>
              <ul className="mt-1 list-disc pl-5 text-neutral-600">
                {report.links.map((l, i) => (
                  <li key={i}>
                    {l.text ? `« ${l.text} » : ` : ''}
                    <span className="break-all">{l.url}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.warnings.length > 0 ? (
            <details className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-amber-950" data-word-warnings={report.warnings.length} open={report.warnings.length <= 5}>
              <summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" />
                {plural(report.warnings.length, 'avertissement', 'avertissements')}
              </summary>
              <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                {report.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="text-neutral-500" data-word-warnings={0}>
              Aucun avertissement.
            </p>
          )}
        </div>
        <div className="flex justify-end">
          <Button data-action="word-report-close" onClick={() => wordUi.setState({ report: null })}>
            Fermer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- curseur chargé, dépôt, remplissage d'un document neuf

/** Documents déjà remplis depuis l'accueil : le double montage de StrictMode ne place pas deux fois. */
const pendingDone = new Set<string>();

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function TargetHighlight({ frameId }: { frameId: Id }) {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const view = useEditor((s) => s.view);
  const obj = doc?.objects[frameId];
  const pageId = doc && obj ? pageIdOf(doc, frameId) : null;
  if (!doc || !obj || !pageId) return null;
  const b = pageBoxToScreen(doc, pageId, objectBounds(obj), zoom, view);
  return <div data-word-target={frameId} className="pointer-events-none absolute border-2 border-sky-600 bg-sky-500/10" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />;
}

function WordPlaceOverlay() {
  const anchor = useRef<HTMLDivElement>(null);
  const mode = useEditor((s) => s.mode);
  const docId = useEditor((s) => s.docId);
  const loaded = useWordUi((s) => s.loaded);
  const message = useWordUi((s) => s.message);
  const [hover, setHover] = useState<Id | null>(null);
  const cursorActive = mode?.id === PLACE_WORD_MODE && !!loaded;

  // Document créé depuis l'accueil : le fichier lu attend l'éditeur, qui remplit toutes les faces.
  useEffect(() => {
    const s = getEditor();
    if (!docId || !s.doc || pendingDone.has(docId)) return;
    const pending = takePendingWord(docId);
    if (!pending) return;
    pendingDone.add(docId);
    void (async () => {
      wordUi.setState({ message: { kind: 'busy', text: `Placement de ${pending.response.fileName}…` } });
      await loadDocumentFonts(getEditor().doc!);
      await nextFrame();
      await nextFrame();
      const doc = getEditor().doc;
      if (!doc?.pages.length) return;
      await runPlacement(pending.response, { kind: 'panel', pageId: doc.pages[0].id, panel: 0 }, { ...pending.options, autoFill: true });
    })();
  }, [docId]);

  // Glisser-déposer d'un .docx : bloc texte visé, sinon bloc neuf au point de dépôt (les photos : DropImageOverlay).
  useEffect(() => {
    const viewport = anchor.current?.closest<HTMLElement>('[data-workspace-viewport]');
    if (!viewport) return;
    const over = (e: DragEvent) => {
      if (!carriesOnlyWordFiles(e.dataTransfer)) return;
      e.preventDefault();
      const s = getEditor();
      if (!s.doc || s.mode) {
        e.dataTransfer!.dropEffect = 'none';
        return;
      }
      e.dataTransfer!.dropEffect = 'copy';
      const id = textFrameAtPoint(viewport, e.clientX, e.clientY, s.doc);
      setHover((prev) => (prev === id ? prev : id));
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget || !viewport.contains(e.relatedTarget as Node)) setHover(null);
    };
    const drop = async (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter(isWordFile);
      if (!files.length) return;
      e.preventDefault();
      setHover(null);
      const s = getEditor();
      if (!s.doc || s.mode) return;
      const target = targetAt(viewport, e.clientX, e.clientY);
      if (!target) return;
      const file = files[0];
      wordUi.setState({ message: { kind: 'busy', text: `Lecture de ${file.name}…` } });
      try {
        const response = await uploadWord(s.docId ?? s.doc.id, file);
        await runPlacement(response, target, wordUi.getState().options);
      } catch (error) {
        showError(`Fichier Word non placé : ${(error as Error).message}`);
      }
    };
    viewport.addEventListener('dragover', over);
    viewport.addEventListener('dragleave', leave);
    viewport.addEventListener('drop', drop);
    return () => {
      viewport.removeEventListener('dragover', over);
      viewport.removeEventListener('dragleave', leave);
      viewport.removeEventListener('drop', drop);
    };
  }, []);

  // Échap annule le curseur chargé (les raccourcis sont coupés pendant un mode).
  useEffect(() => {
    if (!cursorActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancelLoaded();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cursorActive]);

  // Un mode posé ailleurs (édition de texte…) abandonne le fichier chargé.
  useEffect(() => {
    if (loaded && mode?.id !== PLACE_WORD_MODE) wordUi.setState({ loaded: null });
  }, [loaded, mode]);

  // Une erreur s'efface d'elle-même.
  useEffect(() => {
    if (message?.kind !== 'error') return;
    const timer = window.setTimeout(() => wordUi.setState({ message: null }), 8000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const viewportOf = () => anchor.current?.closest<HTMLElement>('[data-workspace-viewport]') ?? null;

  return (
    <div ref={anchor} className="pointer-events-none absolute inset-0" data-word-layer>
      {cursorActive && (
        <div
          data-word-place-layer
          className="pointer-events-auto absolute inset-0"
          style={{ cursor: 'copy' }}
          onPointerMove={(e) => {
            const viewport = viewportOf();
            const doc = getEditor().doc;
            if (!viewport || !doc) return;
            const id = textFrameAtPoint(viewport, e.clientX, e.clientY, doc);
            setHover((prev) => (prev === id ? prev : id));
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const viewport = viewportOf();
            const response = wordUi.getState().loaded;
            if (!viewport || !response) return;
            const target = targetAt(viewport, e.clientX, e.clientY);
            if (!target) return;
            setHover(null);
            cancelLoaded();
            void runPlacement(response, target, wordUi.getState().options);
          }}
        />
      )}
      {hover && <TargetHighlight frameId={hover} />}
      {cursorActive && (
        <div
          data-word-loaded={loaded!.fileName}
          className="pointer-events-auto absolute left-1/2 top-3 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-md bg-neutral-900/90 px-3 py-1.5 text-[12px] text-white shadow"
        >
          <FileText className="size-4 shrink-0" />
          <span>
            Placer « {loaded!.fileName} » : cliquez sur un bloc texte pour en remplacer le texte, ou sur une zone vide pour créer un bloc.
          </span>
          <button type="button" className="rounded px-1.5 py-0.5 text-white/80 hover:bg-white/10 hover:text-white" data-action="word-cancel" onClick={cancelLoaded}>
            Annuler (Échap)
          </button>
        </div>
      )}
      {message && (
        <div
          data-word-message={message.kind}
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={
            'pointer-events-auto absolute bottom-12 left-1/2 flex max-w-[70%] -translate-x-1/2 items-center gap-2 rounded-md px-3 py-1.5 text-[12px] shadow ' +
            (message.kind === 'error' ? 'border border-red-300 bg-red-50 text-red-900' : 'bg-neutral-900/90 text-white')
          }
          onClick={() => wordUi.setState({ message: null })}
        >
          {message.kind === 'busy' && <Loader2 className="size-3.5 animate-spin" />}
          {message.text}
        </div>
      )}
      <ReportDialog />
    </div>
  );
}

registerTopbarAction({ id: 'place-word', order: 5, label: 'Placer un fichier Word…', icon: FileText, component: PlaceWordButton });
registerOverlay({ id: 'place-word', space: 'viewport', order: 35, component: WordPlaceOverlay });
