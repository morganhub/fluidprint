// Texte chaîné (tâche 4.12) : modèle (coupures, liens, suppression) et coulée mesurée dans Chrome.
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../server/export';
import { reidentify, extractObjects, removeObjects } from '../src/store/commands';
import { createEditorStore } from '../src/store/documentStore';
import { breakPositions, chainFrames, chainHead, detachChains, isChained, linkFrames, linkRefusal, sliceStory, unlinkAfter } from '../src/model/threading';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, openEditor, press, readSavedDocument, saveNow, selection, settle, typeInField, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { renderedLines } from './helpers/lines';

const STORY =
  'Chaque session part de vos usages réels : on installe, on règle et on pratique ensemble, à votre rythme. ' +
  'Vous repartez avec des fiches claires, un contact direct et la certitude de savoir refaire seul. ' +
  'Nos formateurs viennent chez vous ou vous accueillent près de chez vous, en petits groupes de six personnes au plus, ' +
  'pour que chacun avance sans se sentir pressé. Les exercices suivent vos questions, pas un programme figé.';

/** Deux blocs texte sur la face extérieure : t1 (le texte), t2 (vide), non chaînés. */
function chainDoc(): LayoutDocument {
  const doc = minimalDoc();
  doc.id = 'chaine';
  const t1 = doc.objects.t1 as TextObject;
  Object.assign(t1, { x: 12, y: 20, w: 60, h: 24, paragraphs: [{ runs: [{ text: STORY }] }, { runs: [{ text: 'Second paragraphe, pour finir.' }] }] });
  // Même largeur que t1 : les lignes qui passent d'un bloc à l'autre gardent leurs coupures.
  doc.objects.t2 = { ...structuredClone(t1), id: 't2', x: 12, y: 60, w: 60, h: 60, paragraphs: [{ runs: [{ text: '' }] }] };
  doc.pages[0].children = ['r1', 't1', 't2'];
  (doc.objects.r1 as { y: number }).y = 150;
  return doc;
}

const plain = (s: string) => s.replace(/[⁠   \s]+/g, ' ').trim();

describe('texte chaîné : modèle', () => {
  it('coupures au mot, découpe d’un article, lien et rupture', () => {
    const paras = [{ runs: [{ text: 'Un mot ' }, { text: 'bleu-clair', color: { swatch: 'bleu' } }, { text: ' et\nfin' }] }, { runs: [{ text: 'Deux' }] }];
    const breaks = breakPositions(paras);
    expect(breaks).toEqual([
      { p: 0, offset: 0 },
      { p: 0, offset: 3 },
      { p: 0, offset: 7 },
      { p: 0, offset: 12 },
      { p: 0, offset: 18 },
      { p: 0, offset: 21 },
      { p: 1, offset: 0 },
      { p: 1, offset: 4 },
    ]);
    // Coupe au milieu d'un segment coloré : la mise en forme suit chaque morceau.
    const head = sliceStory(paras, { p: 0, offset: 0 }, { p: 0, offset: 12 });
    expect(head.continues).toBe(true);
    expect(head.paragraphs).toEqual([{ runs: [{ text: 'Un mot ' }, { text: 'bleu-', color: { swatch: 'bleu' } }] }]);
    const tail = sliceStory(paras, { p: 0, offset: 12 }, null);
    expect(tail.paragraphs[0].runs).toEqual([{ text: 'clair', color: { swatch: 'bleu' } }, { text: ' et\nfin' }]);
    expect(tail.paragraphs[1]).toEqual({ runs: [{ text: 'Deux' }] });
    // Coupe pile au début d'un paragraphe : il part entier.
    expect(sliceStory(paras, { p: 0, offset: 0 }, { p: 1, offset: 0 }).paragraphs).toHaveLength(1);

    const doc = chainDoc();
    (doc.objects.t2 as TextObject).paragraphs = [{ runs: [{ text: 'Texte du second bloc.' }] }];
    linkFrames(doc, 't1', 't2');
    const t1 = doc.objects.t1 as TextObject;
    expect(t1.nextId).toBe('t2');
    // Le texte du bloc relié rejoint la fin de l'article ; le bloc ne garde que sa boîte.
    expect(t1.paragraphs.at(-1)).toEqual({ runs: [{ text: 'Texte du second bloc.' }] });
    expect((doc.objects.t2 as TextObject).paragraphs).toEqual([{ runs: [{ text: '' }] }]);
    expect(chainFrames(doc, 't2')).toEqual(['t1', 't2']);
    expect(chainHead(doc, 't2')).toBe('t1');
    expect(validateDocument(doc).ok).toBe(true);
    expect(linkRefusal(doc, 't2', 't1')).toBe('cycle');
    expect(linkRefusal(doc, 't2', 'r1')).toBe('not-text');

    unlinkAfter(doc, 't1');
    expect(isChained(doc, 't1')).toBe(false);
    expect(t1.paragraphs.at(-1)!.runs[0].text).toBe('Texte du second bloc.');
  });

  it('validation : bloc suivant inconnu, deux prédécesseurs, boucle', () => {
    const doc = chainDoc();
    doc.objects.t3 = { ...structuredClone(doc.objects.t2 as TextObject), id: 't3' };
    doc.pages[0].children.push('t3');
    (doc.objects.t1 as TextObject).nextId = 'zz';
    expect(validateDocument(doc)).toMatchObject({ ok: false, errors: [{ path: 'objects.t1.nextId' }] });
    (doc.objects.t1 as TextObject).nextId = 't3';
    (doc.objects.t2 as TextObject).nextId = 't3';
    expect(validateDocument(doc).ok).toBe(false);
    delete (doc.objects.t1 as TextObject).nextId;
    (doc.objects.t3 as TextObject).nextId = 't2';
    const result = validateDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.message.includes('boucle'))).toBe(true);
  });

  it('supprimer un bloc chaîné recoud la chaîne ; copier ne crée pas de doublon de lien', () => {
    const doc = chainDoc();
    doc.objects.t3 = { ...structuredClone(doc.objects.t2 as TextObject), id: 't3', y: 130 };
    doc.pages[0].children.push('t3');
    linkFrames(doc, 't1', 't2');
    linkFrames(doc, 't2', 't3');
    // Le premier bloc disparaît : l'article passe au suivant.
    const story = (doc.objects.t1 as TextObject).paragraphs;
    removeObjects(doc, ['t1']);
    expect(chainFrames(doc, 't2')).toEqual(['t2', 't3']);
    expect((doc.objects.t2 as TextObject).paragraphs).toEqual(story);
    // Un bloc du milieu : ses voisins se rejoignent.
    const d2 = chainDoc();
    d2.objects.t3 = { ...structuredClone(d2.objects.t2 as TextObject), id: 't3', y: 130 };
    d2.pages[0].children.push('t3');
    linkFrames(d2, 't1', 't2');
    linkFrames(d2, 't2', 't3');
    detachChains(d2, new Set(['t2']));
    expect((d2.objects.t1 as TextObject).nextId).toBe('t3');
    // Copier t1 seul : la copie n'est chaînée à rien (t2 a déjà un prédécesseur).
    const copy = reidentify(d2, extractObjects(d2, ['t1']));
    expect((copy.objects[0] as TextObject).nextId).toBeUndefined();
    // Copier la chaîne entière : les copies restent chaînées entre elles.
    const both = reidentify(d2, extractObjects(d2, ['t1', 't3']));
    const [c1, c3] = both.objects as TextObject[];
    expect(c1.nextId).toBe(c3.id);
  });

  it('dans le store : chaîner, supprimer et annuler reviennent à l’état exact', () => {
    const store = createEditorStore();
    store.getState().load(chainDoc());
    store.getState().apply('Chaîner', (d) => linkFrames(d, 't1', 't2'));
    const linked = store.getState().doc!;
    store.getState().remove(['t1']);
    expect(isChained(store.getState().doc!, 't2')).toBe(false);
    expect((store.getState().doc!.objects.t2 as TextObject).paragraphs).toEqual((linked.objects.t1 as TextObject).paragraphs);
    store.getState().undo();
    expect(store.getState().doc).toEqual(linked);
  });
});

describe('texte chaîné : coulée dans le navigateur', () => {
  it('le texte en excès continue dans le second bloc ; réduire le premier y fait passer des lignes ; impression et export cohérents', async () => {
    await withTempDocuments(async (dir) => {
      await writeDocument(dir, chainDoc());
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'chaine', { zoom: 1.5, centerOn: 't1' });
          const alone = await renderedLines(page, 't1');
          expect(alone.length).toBeGreaterThan(8);

          // Sélection t1 puis Maj+clic t2 : la section « Chaînage » propose de les chaîner.
          await clickAt(page, 'p-ext', 30, 22);
          await clickAt(page, 'p-ext', 30, 90, { shift: true });
          expect(await selection(page)).toEqual(['t1', 't2']);
          await page.click('[data-section="text-chain"] [data-action="chain-link"]');
          await settle(page);
          await settle(page);
          const doc = await page.evaluate(() => window.__editor!.getState().doc!);
          expect((doc.objects.t1 as TextObject).nextId).toBe('t2');

          const first = await renderedLines(page, 't1');
          const second = await renderedLines(page, 't2');
          // t1 (24 mm) garde ce qui tient : 6 lignes de 7,5 pt × 1,5 (3,97 mm) ; le reste passe dans t2.
          expect(first.length).toBe(6);
          expect(first.at(-1)!.bottom).toBeLessThanOrEqual(20 + 24 + 0.25);
          expect(second.length).toBeGreaterThan(0);
          expect(second[0].top).toBeGreaterThanOrEqual(60 - 0.5);
          // Aucune perte, aucun doublon, coupe au mot : l'article se relit d'un bloc à l'autre.
          const fullText = plain(`${STORY} Second paragraphe, pour finir.`).replace(/ /g, '');
          const flowed = [...first, ...second].map((l) => l.text).join('');
          expect(flowed).toBe(fullText);
          // Le premier bloc s'arrête sur un mot entier : sa dernière ligne est une ligne pleine de l'article.
          expect(first.map((l) => l.text)).toEqual(alone.slice(0, 6).map((l) => l.text));
          // Aucun « + » : t1 se déverse, t2 a de la place.
          expect(await page.$$('[data-overset-marker]')).toHaveLength(0);

          // Réduire le premier bloc (champ H du panneau Propriétés) : deux lignes passent dans le second.
          await clickAt(page, 'p-ext', 30, 22);
          expect(await selection(page)).toEqual(['t1']);
          await typeInField(page, 'h', '16');
          await settle(page);
          const firstSmall = await renderedLines(page, 't1');
          const secondMore = await renderedLines(page, 't2');
          expect(firstSmall.length).toBe(4);
          expect(secondMore.length).toBe(second.length + 2);
          expect([...firstSmall, ...secondMore].map((l) => l.text).join('')).toBe(fullText);
          // L'annulation remet les lignes en place (le champ H garde le focus : on le quitte d'abord).
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await press(page, 'Control', 'z');
          await settle(page);
          expect((await renderedLines(page, 't1')).length).toBe(6);
          expect((await renderedLines(page, 't2')).length).toBe(second.length);
          await press(page, 'Control', 'y');
          await settle(page);

          // Double-clic sur le second bloc : l'article s'édite dans le premier.
          const box = await page.evaluate(() => window.__editor!.objectClientBox('t2'));
          await page.mouse.click(Math.round(box.x + box.w / 3), Math.round(box.y + 5), { count: 2 });
          await page.waitForSelector('[data-text-editor="t1"]');
          expect(await page.evaluate(() => window.__editor!.getState().mode)).toMatchObject({ id: 'text-edit', target: 't1' });
          await press(page, 'Escape');

          // Enregistré : `lines` de chaque bloc = lignes rendues à l'impression = lignes du PDF (pas d'alerte de coupure).
          await settle(page);
          await saveNow(page);
          const saved = await readSavedDocument(dir, 'chaine');
          const s1 = saved.objects.t1 as TextObject;
          const s2 = saved.objects.t2 as TextObject;
          expect(s1.h).toBe(16);
          expect(s1.lines).toBe(4);
          expect(s2.lines).toBe(secondMore.length);
          const print = await browser.newPage();
          await print.goto(`${url}/print/chaine`);
          await print.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
          const counts = await print.evaluate(() => window.__lineCounts!);
          expect(counts.t1).toBe(s1.lines);
          expect(counts.t2).toBe(s2.lines);
          const printed = [...(await renderedLines(print, 't1')), ...(await renderedLines(print, 't2'))];
          expect(printed.map((l) => l.text).join('')).toBe(fullText);
          await print.close();
          const result = await exportPdf({ docId: 'chaine', preset: 'rvb', documentsDir: dir, baseUrl: url });
          expect(result.warnings.filter((w) => w.kind === 'line-break')).toEqual([]);
        },
        { documentsDir: dir },
      );
    });
  });
});
