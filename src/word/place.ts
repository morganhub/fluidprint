// « Placer » un fichier Word dans le document, comme la commande Placer d'InDesign (import Word).
//
// - Sur un bloc texte (sélectionné, visé par le curseur chargé, ou sous le fichier déposé) : le texte du Word
//   remplace l'article du bloc (de toute sa chaîne s'il est chaîné).
// - Sur une zone vide : un bloc texte neuf au point visé, à la largeur de la zone de sécurité du volet,
//   jusqu'au bas de cette zone (en retrait de 1,5 mm en haut et 0,5 mm en bas : `frameZone`).
// - « Remplir automatiquement » : si le texte déborde, des blocs chaînés sont créés dans la zone de sécurité
//   des volets suivants, puis des faces suivantes, jusqu'à ce que tout tienne ou que le document soit plein ;
//   le texte restant est signalé. La coulée est MESURÉE comme au rendu (`fitStory`, render/textFlow.ts), et
//   seuls les blocs qui reçoivent du texte sont gardés.
//
// Tout se fait dans UN `apply` : photos ajoutées au document, styles créés, texte, blocs, chaînage — une
// seule étape d'annulation. La mesure est injectée (`measure`) : le navigateur passe `fitStory`, les tests
// sans navigateur une mesure simulée.
import { current } from 'immer';
import { panelBounds } from '../model/format';
import { findPageOrMaster } from '../model/masters';
import { safetyBoxes } from '../model/preflight';
import { chainFrames, chainHead } from '../model/threading';
import type { Id, LayoutDocument, Mm, Paragraph, TextObject } from '../model/types';
import type { StoryFit } from '../render/textFlow';
import { addObjects, newObjectId, removeObjects, round4 } from '../store/commands';
import { defaultLayerId, type EditorState } from '../store/documentStore';
import { pageIdOf, type Box } from '../store/tree';
import { buildWordStory, type WordLink, type WordStory } from './story';
import { plain } from './styles';
import type { WordImportResponse } from './types';

export interface PlaceWordOptions {
  /** Crée des blocs chaînés dans les volets et faces suivants tant que le texte déborde. */
  autoFill: boolean;
  /** Applique la typographie française au texte importé. */
  typography: boolean;
}

export const DEFAULT_PLACE_OPTIONS: PlaceWordOptions = { autoFill: false, typography: true };

export type PlaceTarget =
  /** Un bloc texte : son texte est remplacé. */
  | { kind: 'frame'; frameId: Id }
  /** Un point d'une face (mm) : bloc neuf à la largeur de la zone de sécurité du volet. */
  | { kind: 'point'; pageId: Id; x: Mm; y: Mm }
  /** Toute la zone de sécurité d'un volet (nouveau document depuis Word). */
  | { kind: 'panel'; pageId: Id; panel: number };

/** Coulée de l'article du premier bloc dans des blocs donnés, texte en excès compris. */
export type StoryMeasure = (doc: LayoutDocument, frameIds: Id[]) => StoryFit;

export interface WordPlacementReport {
  fileName: string;
  /** Blocs de l'article, du premier au dernier. */
  frameIds: Id[];
  /** Blocs créés par l'import (le bloc neuf et ceux du remplissage automatique). */
  createdFrames: number;
  paragraphs: number;
  /** Style du bloc (le plus employé). */
  blockStyle: string;
  stylesCreated: string[];
  stylesReused: string[];
  images: { name: string; assetId: string | null; after: string | null }[];
  links: WordLink[];
  warnings: string[];
  typographyFixes: number;
  autoFill: boolean;
  /** Texte qui ne tient pas dans les blocs : paragraphes restants, caractères, début. */
  overflow: { paragraphs: number; characters: number; excerpt: string } | null;
  /** Le remplissage automatique s'est arrêté faute de volet suivant. */
  documentFull: boolean;
}

/** Hauteur minimale d'un bloc neuf, en mm : un clic tout en bas d'un volet donne quand même quelques lignes. */
const MIN_FRAME_H = 10;

/**
 * Retrait des blocs neufs dans la zone de sécurité, en haut et en bas (mm). Le contrôle en amont compare à la
 * zone l'étendue des lignes (boîtes des glyphes, ascendantes et descendantes de la police comprises) : un grand
 * titre à interlignage serré en tête de bloc en dépasse d'environ 1 mm par le haut, et la coulée du texte
 * chaîné tolère 0,25 mm de trop par le bas. La largeur, elle, reste celle de la zone.
 */
export const FRAME_INSET_TOP = 1.5;
export const FRAME_INSET_BOTTOM = 0.5;

/** Partie d'une zone de sécurité où poser un bloc neuf. */
export function frameZone(zone: Box): Box {
  const top = Math.min(FRAME_INSET_TOP, zone.h / 4);
  const bottom = Math.min(FRAME_INSET_BOTTOM, zone.h / 4);
  return { x: zone.x, y: zone.y + top, w: zone.w, h: zone.h - top - bottom };
}

function faceIdOf(doc: LayoutDocument, pageId: Id): Id | null {
  return findPageOrMaster(doc, pageId)?.faceId ?? null;
}

/** Volet (rang) qui contient une abscisse de la face, plis compris ; le plus proche en dehors. */
function panelAt(doc: LayoutDocument, faceId: Id, x: Mm): number {
  const panels = panelBounds(doc.format, faceId);
  const inside = panels.findIndex((p) => x >= p.x0 && x < p.x1);
  if (inside >= 0) return inside;
  return x < (panels[0]?.x0 ?? 0) ? 0 : panels.length - 1;
}

/** Bloc neuf en un point : zone de sécurité du volet visé, du point (ramené dans la zone) jusqu'en bas. */
export function frameBoxAtPoint(doc: LayoutDocument, pageId: Id, x: Mm, y: Mm): Box | null {
  const faceId = faceIdOf(doc, pageId);
  if (!faceId) return null;
  const safety = safetyBoxes(doc, faceId)[panelAt(doc, faceId, x)];
  if (!safety || safety.w <= 0 || safety.h <= 0) return null;
  const zone = frameZone(safety);
  const top = Math.min(Math.max(y, zone.y), zone.y + zone.h - Math.min(MIN_FRAME_H, zone.h));
  return { x: zone.x, y: top, w: zone.w, h: zone.y + zone.h - top };
}

/** Zones de sécurité où continuer après un bloc : volets suivants de sa face, puis toutes les faces suivantes. */
export function nextSafetySlots(doc: LayoutDocument, frameId: Id): { pageId: Id; box: Box }[] {
  const obj = doc.objects[frameId];
  const pageId = obj ? pageIdOf(doc, frameId) : null;
  const pageIndex = doc.pages.findIndex((p) => p.id === pageId);
  // Un bloc d'une page type ne se prolonge pas dans les faces : rien à remplir.
  if (!obj || pageIndex < 0) return [];
  const page = doc.pages[pageIndex];
  // Le volet où finit le bloc (un bloc à cheval sur deux volets continue après le second).
  const panel = panelAt(doc, page.faceId, obj.x + obj.w - 0.5);
  const usable = (b: Box) => b.w > 0 && b.h > 0;
  const slots = safetyBoxes(doc, page.faceId)
    .slice(panel + 1)
    .filter(usable)
    .map((box) => ({ pageId: page.id, box: frameZone(box) }));
  for (const next of doc.pages.slice(pageIndex + 1)) {
    for (const box of safetyBoxes(doc, next.faceId).filter(usable)) slots.push({ pageId: next.id, box: frameZone(box) });
  }
  return slots;
}

const emptyParagraphs = (): Paragraph[] => [{ runs: [{ text: '' }] }];
const hasText = (p: Paragraph) => p.runs.some((r) => r.text.trim() !== '');

function newTextFrame(doc: LayoutDocument, layerId: Id, box: Box, story: WordStory, name: string): TextObject {
  return {
    id: newObjectId(doc, 'text'),
    type: 'text',
    name,
    layerId,
    x: round4(box.x),
    y: round4(box.y),
    w: round4(box.w),
    h: round4(box.h),
    style: plain(story.blockStyle.style),
    paragraphStyleId: story.blockStyle.id,
    paragraphs: emptyParagraphs(),
  };
}

function overflowSummary(paragraphs: Paragraph[]): WordPlacementReport['overflow'] {
  if (!paragraphs.length) return null;
  const text = paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ');
  const clean = text.replace(/\s+/g, ' ').trim();
  return { paragraphs: paragraphs.length, characters: clean.length, excerpt: clean.length > 60 ? `${clean.slice(0, 59)}…` : clean };
}

/**
 * Place un fichier Word lu par le serveur. Renvoie le rapport, ou null si rien n'a pu être placé (pas de
 * document, cible introuvable, aucun calque utilisable).
 */
export function placeWord(
  state: Pick<EditorState, 'apply' | 'doc' | 'activeLayerId'>,
  input: WordImportResponse,
  target: PlaceTarget,
  options: PlaceWordOptions,
  measure: StoryMeasure,
): WordPlacementReport | null {
  const doc = state.doc;
  if (!doc) return null;
  const targetObj = target.kind === 'frame' ? doc.objects[target.frameId] : undefined;
  if (target.kind === 'frame' && targetObj?.type !== 'text') return null;
  const layerId = targetObj?.layerId ?? defaultLayerId(doc, state.activeLayerId);
  if (!layerId) return null;
  let where: { pageId: Id; box: Box } | null = null;
  if (target.kind === 'point') {
    const box = frameBoxAtPoint(doc, target.pageId, target.x, target.y);
    where = box && { pageId: target.pageId, box };
  } else if (target.kind === 'panel') {
    const faceId = faceIdOf(doc, target.pageId);
    const box = faceId ? safetyBoxes(doc, faceId)[target.panel] : undefined;
    where = box && box.w > 0 && box.h > 0 ? { pageId: target.pageId, box: frameZone(box) } : null;
  }
  if (target.kind !== 'frame' && !where) return null;

  const stem = input.fileName.replace(/\.docx$/i, '');
  let report: WordPlacementReport | null = null;
  state.apply(
    'Placer un fichier Word',
    (d) => {
      // Les photos du fichier, déjà enregistrées par le serveur : dans le document, non placées.
      for (const asset of Object.values(input.assets)) if (!d.assets.some((a) => a.id === asset.id)) d.assets.push(structuredClone(asset));

      const existing = target.kind === 'frame' ? (d.objects[chainHead(d, target.frameId)] as TextObject) : undefined;
      const story = buildWordStory(d, input.document, input.assets, { typography: options.typography, targetStyle: existing?.style });
      const created: Id[] = [];
      let headId: Id;
      if (existing) headId = existing.id;
      else {
        const frame = newTextFrame(d, layerId, where!.box, story, `Texte · ${stem}`);
        addObjects(d, [frame], [frame.id], { pageId: where!.pageId });
        headId = frame.id;
        created.push(frame.id);
      }
      // L'article est porté par le premier bloc (texte chaîné) ; il prend le style du bloc.
      const head = d.objects[headId] as TextObject;
      head.paragraphs = story.paragraphs;
      head.style = plain(story.blockStyle.style);
      head.paragraphStyleId = story.blockStyle.id;

      let chain = chainFrames(d, headId);
      let fit = measure(current(d) as LayoutDocument, chain);
      let documentFull = false;
      if (options.autoFill && fit.overflow.length) {
        // Tous les volets suivants reçoivent un bloc chaîné, la coulée est mesurée une fois, et les blocs
        // restés vides (après la fin du texte) repartent aussitôt.
        const slots = nextSafetySlots(d, chain[chain.length - 1]);
        const added: Id[] = [];
        let previous = d.objects[chain[chain.length - 1]] as TextObject;
        slots.forEach((slot, i) => {
          const frame = newTextFrame(d, previous.layerId, slot.box, story, `Texte · ${stem} (suite ${i + 1})`);
          addObjects(d, [frame], [frame.id], { pageId: slot.pageId });
          previous.nextId = frame.id;
          previous = d.objects[frame.id] as TextObject;
          added.push(frame.id);
        });
        if (added.length) {
          chain = chainFrames(d, headId);
          fit = measure(current(d) as LayoutDocument, chain);
          let lastUsed = -1;
          fit.slices.forEach((slice, i) => {
            if (slice.paragraphs.some(hasText)) lastUsed = i;
          });
          const kept = new Set(chain.slice(0, Math.max(lastUsed + 1, chain.length - added.length)));
          const unused = added.filter((id) => !kept.has(id));
          if (unused.length) removeObjects(d, unused);
          created.push(...added.filter((id) => kept.has(id)));
          chain = chainFrames(d, headId);
        }
        documentFull = fit.overflow.length > 0;
      }

      report = {
        fileName: input.fileName,
        frameIds: chain,
        createdFrames: created.length,
        paragraphs: story.paragraphs.filter(hasText).length,
        blockStyle: story.blockStyle.name,
        stylesCreated: story.stylesCreated,
        stylesReused: story.stylesReused,
        images: story.images.map((i) => ({ name: i.asset?.name ?? i.image.name, assetId: i.asset?.id ?? null, after: i.after })),
        links: story.links,
        warnings: story.warnings,
        typographyFixes: story.typographyFixes,
        autoFill: options.autoFill,
        overflow: overflowSummary(fit.overflow),
        documentFull,
      };
      return headId;
    },
    { select: (id) => (id ? [id] : []) },
  );
  return report;
}
