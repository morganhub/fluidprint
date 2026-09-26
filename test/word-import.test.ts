// Import Word, côté modèle (sans navigateur) : article construit depuis un .docx lu, correspondance des
// styles, listes, tableaux, liens, typographie ; placement dans le store (bloc sélectionné, zone vide,
// remplissage automatique) avec une coulée simulée ; une seule étape d'annulation.
import { describe, expect, it } from 'vitest';
import { readDocx } from '../server/docx/read';
import { listMarkers } from '../src/model/lists';
import { safetyBoxes } from '../src/model/preflight';
import { chainFrames } from '../src/model/threading';
import type { Asset, Id, LayoutDocument, Paragraph, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import type { StoryFit } from '../src/render/textFlow';
import { createEditorStore } from '../src/store/documentStore';
import { NBSP } from '../src/text/typographyFr';
import { frameBoxAtPoint, frameZone, nextSafetySlots, placeWord, type StoryMeasure } from '../src/word/place';
import { buildWordStory } from '../src/word/story';
import type { WordImportResponse } from '../src/word/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { longBody, makeDocx, p, pStyle, r } from './helpers/docx';

const ASSET: Asset = { id: 'img-essai', kind: 'image', name: 'guide · image1.png', original: 'assets/originals/guide-image1.png', preview: 'assets/previews/guide-image1.webp', width: 120, height: 80 };

function wordFile(body?: string, fileName = 'guide.docx'): WordImportResponse {
  const { document } = readDocx(makeDocx(body, Buffer.from('image')), { label: fileName });
  return { fileName, document, assets: document.images.length ? { img1: ASSET } : {} };
}

const textOf = (para: Paragraph) => para.runs.map((r) => r.text).join('');
const storyText = (paras: Paragraph[]) => paras.map(textOf);

/**
 * Coulée simulée : chaque bloc reçoit des paragraphes entiers tant que leurs caractères tiennent dans sa
 * surface (1 caractère pour 3 mm²) ; le reste est le texte en excès. Assez pour tester la logique du
 * remplissage sans navigateur (la vraie mesure est testée dans Chrome : word-editor.test.ts).
 */
const fakeMeasure: StoryMeasure = (doc, frameIds): StoryFit => {
  const head = doc.objects[frameIds[0]] as TextObject;
  const paras = head.paragraphs;
  let i = 0;
  const slices = frameIds.map((id) => {
    const frame = doc.objects[id] as TextObject;
    let room = (frame.w * frame.h) / 3;
    const first = i;
    const taken: Paragraph[] = [];
    while (i < paras.length && textOf(paras[i]).length <= room) {
      room -= textOf(paras[i]).length;
      taken.push(paras[i++]);
    }
    return { paragraphs: taken, continues: false, first };
  });
  return { slices, overflow: paras.slice(i).filter((p) => textOf(p).trim()) };
};

describe('import Word : article et styles', () => {
  it('styles Word → styles du document de même nom (créés sur l’échelle du corps, ou réutilisés), mise en forme, listes, tableau, liens, typographie', () => {
    const doc = minimalDoc();
    // Un style « Titre 1 » existe déjà : il est réutilisé tel quel. Le corps du document fait 10 pt.
    doc.styles.paragraph.push(
      { id: 'ps-corps', name: 'Corps', style: { ...(doc.objects.t1 as TextObject).style, fontSize: 10, lineHeight: 1.4 } },
      { id: 'ps-titre-1', name: 'Titre 1', style: { ...(doc.objects.t1 as TextObject).style, fontSize: 21, fontWeight: 800 } },
    );
    const word = wordFile();
    const story = buildWordStory(doc, word.document, word.assets, { typography: true });

    expect(story.stylesReused).toEqual(['Titre 1']);
    expect(story.stylesCreated).toEqual(['Titre', 'Normal', 'Titre 2', 'Paragraphe de liste', 'Citation']);
    const style = (name: string) => doc.styles.paragraph.find((s) => s.name === name)!;
    for (const name of story.stylesCreated) expect(style(name).origin).toBe('word');
    expect(style('Titre 1')).toMatchObject({ id: 'ps-titre-1', style: { fontSize: 21, fontWeight: 800 } });
    expect(style('Titre 1').origin).toBeUndefined();
    // Échelle fondée sur le corps du document (10 pt), Open Sans, nuances du nuancier seulement.
    expect(style('Normal').style).toMatchObject({ fontFamily: 'Open Sans', fontSize: 10, fontWeight: 400, color: { swatch: 'gris' } });
    expect(style('Titre').style).toMatchObject({ fontSize: 24, fontWeight: 800 });
    expect(style('Titre 2').style).toMatchObject({ fontSize: 15.5, fontWeight: 700 });
    expect(style('Citation').style).toMatchObject({ fontSize: 10, italic: true });
    expect(doc.styles.paragraph.every((s) => s.style.fontFamily === 'Open Sans' && doc.swatches.some((sw) => sw.id === s.style.color.swatch))).toBe(true);

    // Le bloc prend le style le plus employé ; les autres paragraphes portent leur style propre, valeurs écrites.
    expect(story.blockStyle.name).toBe('Normal');
    const paras = story.paragraphs;
    expect(storyText(paras).slice(0, 4)).toEqual(['Guide de l’atelier', 'Présentation', expect.stringContaining('Un texte avec du gras'), 'Première ligne\nseconde ligne']);
    expect(paras[0]).toMatchObject({ paragraphStyleId: style('Titre').id, fontSize: 24 });
    expect(paras[0].spaceBefore).toBeUndefined();
    expect(paras[0].runs[0]).toMatchObject({ fontWeight: 800, italic: false });
    expect(paras[1]).toMatchObject({ paragraphStyleId: 'ps-titre-1', fontSize: 21 });
    expect(paras[1].runs[0]).toMatchObject({ fontWeight: 800 });
    expect(paras[2].paragraphStyleId).toBeUndefined();

    // Gras, italique, souligné en segments ; typographie française (apostrophe courbe, fine insécable avant ;).
    const body = paras[2].runs;
    expect(body.find((r) => r.text === 'gras')).toMatchObject({ fontWeight: 700 });
    expect(body.find((r) => r.text.includes('italique'))).toMatchObject({ italic: true, text: ', de l’italique' });
    expect(body.find((r) => r.text === 'souligné')).toMatchObject({ underline: true });
    expect(body.find((r) => r.text === 'fort')).toMatchObject({ fontWeight: 700 });
    expect(textOf(paras[2])).toContain(' ; puis');
    expect(story.typographyFixes).toBeGreaterThan(2);

    // Listes : puces et numéros à retrait suspendu, numéros de Word gardés (la seconde liste repart à 1).
    const item = (text: string) => paras.find((x) => textOf(x) === text)!;
    expect(item('Scies')).toMatchObject({ list: { kind: 'bullet', level: 0 }, paragraphStyleId: style('Paragraphe de liste').id });
    expect(item('Scies').firstLineIndent).toBeLessThan(0);
    expect(item('Scies').leftIndent).toBeCloseTo(-item('Scies').firstLineIndent!, 5);
    expect(item('Scie à chantourner').leftIndent).toBeCloseTo(2 * item('Scies').leftIndent!, 5);
    expect(item('Mesurer').list).toEqual({ kind: 'number', level: 1, format: 'lower-alpha', suffix: ')' });
    expect(item('Nouvelle liste').list).toEqual({ kind: 'number', level: 0, start: 1 });
    const markers = listMarkers(paras).filter((m) => m);
    expect(markers).toEqual(['•', '–', '•', '1.', 'a)', 'b)', '2.', '1.']);

    // Citation (style Word centré), tableau mis à plat en tabulations, lien devenu du texte.
    expect(paras.find((x) => textOf(x).includes('patience'))).toMatchObject({ paragraphStyleId: style('Citation').id, align: 'center' });
    expect(storyText(paras)).toEqual(expect.arrayContaining(['Outil\tPrix\tNiveau', 'Scie\t25 €\tfacile'.replace(' ', ' ')]));
    expect(paras.find((x) => textOf(x).startsWith('Scie\t'))!.runs.find((r) => r.text === 'facile')).toMatchObject({ fontWeight: 700 });
    expect(story.links).toEqual([{ text: 'notre site', url: 'https://example.com/atelier?a=1&b=2' }]);
    expect(textOf(paras.find((x) => textOf(x).startsWith('Inscriptions'))!)).toBe('Inscriptions sur notre site.');

    // Image : non placée, sa position dans le texte rapportée.
    expect(story.images).toEqual([{ image: expect.objectContaining({ id: 'img1' }), asset: ASSET, paragraph: expect.any(Number), after: 'Inscriptions sur notre site.' }]);

    // Rapport : tableau, lien, polices et couleurs de Word ignorées.
    expect(story.warnings).toEqual([
      expect.stringMatching(/^Tableau 1 \(2 lignes × 3 colonnes\) mis à plat.*tabulations/),
      expect.stringMatching(/^Polices du document Word ignorées \(Arial, Calibri\).*Open Sans/),
      expect.stringMatching(/^Couleurs du texte Word ignorées \(.*#ff0000.*\).*nuancier/),
      expect.stringMatching(/^1 lien transformé en texte/),
    ]);
  });

  it('sans style de corps dans le document : échelle du texte par défaut (9 pt) ; sans typographie, texte intact', () => {
    const doc = minimalDoc();
    const word = wordFile(p(r('Titre')) + p(r("L'essai : oui"), '') + p(r('Sous-partie'), pStyle('Titre2')));
    const story = buildWordStory(doc, word.document, word.assets, { typography: false });
    const normal = doc.styles.paragraph.find((s) => s.name === 'Normal')!;
    expect(normal.style).toMatchObject({ fontSize: 9, lineHeight: 1.4 });
    expect(doc.styles.paragraph.find((s) => s.name === 'Titre 2')!.style.fontSize).toBe(14);
    expect(storyText(story.paragraphs)).toEqual(['Titre', "L'essai : oui", 'Sous-partie']);
    expect(story.typographyFixes).toBe(0);
    expect(textOf(story.paragraphs[1])).not.toContain(NBSP);
  });
});

describe('import Word : placement dans le store', () => {
  it('dans le bloc sélectionné : texte remplacé, photos ajoutées, styles créés ; une seule étape d’annulation', () => {
    const store = createEditorStore();
    const base = minimalDoc();
    (base.objects.t1 as TextObject).h = 8;
    store.getState().load(base);
    const before = store.getState().doc!;
    store.getState().select(['t1']);
    const report = placeWord(store.getState(), wordFile(), { kind: 'frame', frameId: 't1' }, { autoFill: false, typography: true }, fakeMeasure)!;

    const doc = store.getState().doc!;
    const t1 = doc.objects.t1 as TextObject;
    expect(textOf(t1.paragraphs[0])).toBe('Guide de l’atelier');
    expect(t1.paragraphStyleId).toBe(doc.styles.paragraph.find((s) => s.name === 'Normal')!.id);
    expect(doc.assets).toEqual([ASSET]);
    expect(report).toMatchObject({ fileName: 'guide.docx', frameIds: ['t1'], createdFrames: 0, blockStyle: 'Normal', stylesReused: [] });
    expect(report.paragraphs).toBe(t1.paragraphs.length);
    expect(report.images).toEqual([{ name: ASSET.name, assetId: ASSET.id, after: 'Inscriptions sur notre site.' }]);
    // t1 (80 × 8 mm) ne peut pas tout contenir : excès signalé.
    expect(report.overflow).toMatchObject({ paragraphs: expect.any(Number) });
    expect(validateDocument(doc)).toMatchObject({ ok: true });
    expect(store.getState().history).toMatchObject({ depth: 1, undoLabel: 'Placer un fichier Word' });
    expect(store.getState().selection).toEqual(['t1']);

    store.getState().undo();
    expect(store.getState().doc).toEqual(before);
    store.getState().redo();
    expect(store.getState().doc).toEqual(doc);
  });

  it('sur une zone vide : bloc neuf au point visé, à la largeur de la zone de sécurité du volet', () => {
    const store = createEditorStore();
    store.getState().load(minimalDoc());
    const doc0 = store.getState().doc!;
    const zones = safetyBoxes(doc0, 'exterieur').map(frameZone);
    // Zone d'un bloc neuf : la largeur de la zone de sécurité, un peu en retrait en haut et en bas.
    expect(zones[1]).toEqual({ ...safetyBoxes(doc0, 'exterieur')[1], y: safetyBoxes(doc0, 'exterieur')[1].y + 1.5, h: safetyBoxes(doc0, 'exterieur')[1].h - 2 });
    // Un clic dans le volet central, à 80 mm du haut.
    const x = zones[1].x + 20;
    const report = placeWord(store.getState(), wordFile(p(r('Court texte.'))), { kind: 'point', pageId: 'p-ext', x, y: 80 }, { autoFill: false, typography: true }, fakeMeasure)!;
    const doc = store.getState().doc!;
    const [id] = report.frameIds;
    const frame = doc.objects[id] as TextObject;
    expect(frame).toMatchObject({ type: 'text', layerId: 'contenu', x: zones[1].x, y: 80, w: zones[1].w, h: zones[1].y + zones[1].h - 80, name: 'Texte · guide' });
    expect(doc.pages[0].children.at(-1)).toBe(id);
    expect(report).toMatchObject({ createdFrames: 1, overflow: null, paragraphs: 1 });
    expect(store.getState().selection).toEqual([id]);
    // Un clic dans la marge ou tout en bas : ramené dans la zone de sécurité, quelques lignes au moins.
    expect(frameBoxAtPoint(doc0, 'p-ext', 1, 500)).toEqual({ x: zones[0].x, y: zones[0].y + zones[0].h - 10, w: zones[0].w, h: 10 });
    expect(frameBoxAtPoint(doc0, 'p-ext', zones[2].x + 5, 0)).toEqual(zones[2]);
    store.getState().undo();
    expect(store.getState().doc!.objects[id]).toBeUndefined();
  });

  it('remplir automatiquement : blocs chaînés dans les volets suivants puis la face suivante ; blocs inutiles retirés ; excès signalé quand le document est plein', () => {
    const store = createEditorStore();
    store.getState().load(minimalDoc());
    const doc0 = store.getState().doc!;
    // Depuis le premier volet de l'extérieur : volets 2 et 3, puis les trois volets de l'intérieur.
    const moved: LayoutDocument = structuredClone(doc0);
    Object.assign(moved.objects.t1, { x: 10, w: 20 });
    const slots = nextSafetySlots(moved, 't1');
    expect(slots.map((s) => s.pageId)).toEqual(['p-ext', 'p-ext', 'p-int', 'p-int', 'p-int']);

    // Texte moyen : deux blocs suffisent, les autres ne sont pas créés (ou sont retirés).
    const medium = wordFile(longBody(14));
    const zone = frameZone(safetyBoxes(doc0, 'exterieur')[0]);
    const report = placeWord(store.getState(), medium, { kind: 'panel', pageId: 'p-ext', panel: 0 }, { autoFill: true, typography: true }, fakeMeasure)!;
    let doc = store.getState().doc!;
    expect(report.overflow).toBeNull();
    expect(report.frameIds.length).toBeGreaterThan(1);
    expect(report.frameIds.length).toBeLessThan(6);
    expect(report.createdFrames).toBe(report.frameIds.length);
    expect(chainFrames(doc, report.frameIds[0])).toEqual(report.frameIds);
    expect(doc.objects[report.frameIds[0]]).toMatchObject({ x: zone.x, y: zone.y, w: zone.w, h: zone.h });
    // Chaque bloc de la chaîne reçoit du texte ; le dernier n'a pas de suivant.
    const fit = fakeMeasure(doc, report.frameIds);
    expect(fit.slices.every((s) => s.paragraphs.length > 0)).toBe(true);
    expect((doc.objects[report.frameIds.at(-1)!] as TextObject).nextId).toBeUndefined();
    expect(validateDocument(doc)).toMatchObject({ ok: true });
    expect(store.getState().history.depth).toBe(1);
    store.getState().undo();
    expect(store.getState().doc).toEqual(doc0);

    // Texte trop long : les six volets sont remplis, le reste est signalé.
    const huge = placeWord(store.getState(), wordFile(longBody(80)), { kind: 'panel', pageId: 'p-ext', panel: 0 }, { autoFill: true, typography: true }, fakeMeasure)!;
    doc = store.getState().doc!;
    expect(huge.frameIds).toHaveLength(6);
    expect(huge.frameIds.map((id) => doc.pages.find((pg) => pg.children.includes(id))!.id)).toEqual(['p-ext', 'p-ext', 'p-ext', 'p-int', 'p-int', 'p-int']);
    expect(huge).toMatchObject({ documentFull: true, overflow: { paragraphs: expect.any(Number), excerpt: expect.any(String) } });
    expect(huge.overflow!.paragraphs).toBeGreaterThan(0);
    expect(validateDocument(doc)).toMatchObject({ ok: true });
  });

  it('dans un bloc déjà chaîné : l’article de la chaîne est remplacé, le remplissage continue après le dernier bloc', () => {
    const store = createEditorStore();
    const base = minimalDoc();
    base.objects.t2 = { ...structuredClone(base.objects.t1 as TextObject), id: 't2', x: 12, y: 100, paragraphs: [{ runs: [{ text: '' }] }] };
    (base.objects.t1 as TextObject).nextId = 't2';
    base.pages[0].children.push('t2');
    store.getState().load(base);
    const report = placeWord(store.getState(), wordFile(longBody(30)), { kind: 'frame', frameId: 't2' }, { autoFill: true, typography: false }, fakeMeasure)!;
    const doc = store.getState().doc!;
    expect(report.frameIds.slice(0, 2)).toEqual(['t1', 't2']);
    expect(report.frameIds.length).toBeGreaterThan(2);
    expect(textOf((doc.objects.t1 as TextObject).paragraphs[0])).toBe('Chapitre 1');
    expect((doc.objects.t2 as TextObject).paragraphs).toEqual([{ runs: [{ text: '' }] }]);
    const ids: Id[] = report.frameIds.slice(2);
    // Les blocs du remplissage suivent le bloc t2 (volet 1 de l'extérieur) : volets 2, 3…
    const zones = safetyBoxes(doc, 'exterieur').map(frameZone);
    expect(doc.objects[ids[0]]).toMatchObject({ x: zones[1].x, y: zones[1].y, w: zones[1].w, h: zones[1].h });
    expect(validateDocument(doc)).toMatchObject({ ok: true });
  });
});
