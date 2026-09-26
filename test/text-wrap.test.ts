// Habillage (tâche 4.13) : polygones `shape-outside` échantillonnés depuis la forme exacte (goutte
// comprise), et texte qui en suit le contour, identique à l'écran et à l'impression.
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../server/export';
import { DROP_PATH, DROP_VIEWBOX, parsePath } from '../src/model/shapes';
import type { FrameObject, LayoutDocument, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { objectOutline, wrapFloatsFor, wrapIndex, type WrapFloat } from '../src/model/wrap';
import { minimalDoc } from './fixtures/minimal-doc';
import { openEditor, readSavedDocument, saveNow, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';
import { dropShape } from './helpers/images';
import { renderedLines, type RenderedLine } from './helpers/lines';

const LOREM =
  'L’atelier accompagne chacun dans les gestes du quotidien : cuisine, jardin, petites réparations, ' +
  'bricolage et échanges entre voisins. Les séances ont lieu chez vous ou tout près, à votre rythme, avec ' +
  'des fiches claires pour refaire seul. Les associations et les écoles profitent du même soin, avec des ' +
  'parcours adaptés à leurs outils et à leurs équipes, sans jargon ni précipitation, pour que chacun gagne en autonomie.';

/** Goutte (cadre) à gauche d'un bloc texte qui la chevauche, et un second bloc posé dessus. */
function wrapDoc(): LayoutDocument {
  const doc = minimalDoc();
  doc.id = 'habillage';
  const t1 = doc.objects.t1 as TextObject;
  Object.assign(t1, { x: 20, y: 30, w: 110, h: 90, style: { ...t1.style, textWrap: 'wrap' }, paragraphs: [{ runs: [{ text: `${LOREM} ${LOREM}` }] }] });
  doc.objects.g1 = { id: 'g1', type: 'frame', layerId: 'contenu', x: 20, y: 34, w: 50, h: 65, shape: dropShape(), fill: { swatch: 'bleu' } } satisfies FrameObject;
  doc.objects.g2 = { id: 'g2', type: 'frame', layerId: 'contenu', x: 170, y: 40, w: 80, h: 104, shape: dropShape(), fill: { swatch: 'gris' }, wrap: { margin: 3, invert: true } } satisfies FrameObject;
  doc.objects.t2 = { ...structuredClone(t1), id: 't2', x: 170, y: 40, w: 80, h: 104, style: { ...t1.style, textWrap: 'wrap', align: 'center' } };
  doc.pages[0].children = ['g1', 't1', 'g2', 't2'];
  doc.pages[1].children = ['r1'];
  return doc;
}

/** Bord du polygone d'un flottant (mm, repère du bloc) : maximum (gauche) ou minimum (droite) sur une bande. */
function floatEdge(f: WrapFloat, y0: number, y1: number): number {
  const at = (y: number) => {
    const pts = f.points;
    let best = f.side === 'left' ? 0 : f.width;
    for (let i = 0; i < pts.length - 1; i++) {
      const [xa, ya] = pts[i];
      const [xb, yb] = pts[i + 1];
      if (ya === yb || y < Math.min(ya, yb) || y > Math.max(ya, yb)) continue;
      const x = xa + ((y - ya) / (yb - ya)) * (xb - xa);
      best = f.side === 'left' ? Math.max(best, x) : Math.min(best, x);
    }
    return best;
  };
  let edge = at(y0);
  for (let y = y0; y <= y1; y += 0.05) edge = f.side === 'left' ? Math.max(edge, at(y)) : Math.min(edge, at(y));
  return edge;
}

/** Contour exact de la goutte d'un cadre, échantillonné finement (mm, face). */
function dropPoints(frame: FrameObject): [number, number][] {
  const cmds = parsePath(DROP_PATH);
  const pts: [number, number][] = [];
  let cur: [number, number] = [0, 0];
  for (const c of cmds) {
    if (c.c === 'M' || c.c === 'L') pts.push((cur = c.p));
    else if (c.c === 'C') {
      for (let i = 1; i <= 400; i++) {
        const t = i / 400;
        const u = 1 - t;
        pts.push([u ** 3 * cur[0] + 3 * u * u * t * c.p1[0] + 3 * u * t * t * c.p2[0] + t ** 3 * c.p[0], u ** 3 * cur[1] + 3 * u * u * t * c.p1[1] + 3 * u * t * t * c.p2[1] + t ** 3 * c.p[1]]);
      }
      cur = c.p;
    }
  }
  // Le preset est normalisé par la boîte de dessin 100 × 130 (la goutte n'en touche pas les bords).
  const b = DROP_VIEWBOX;
  return pts.map(([x, yy]) => [frame.x + ((x - b.x) / b.w) * frame.w, frame.y + ((yy - b.y) / b.h) * frame.h] as [number, number]);
}

/** Étendue horizontale de la goutte à l'ordonnée y (mm, face). */
function dropSpan(frame: FrameObject, y: number): [number, number] | null {
  const face = dropPoints(frame);
  const near = face.filter(([, yy]) => Math.abs(yy - y) < 0.2);
  if (!near.length) return null;
  return [Math.min(...near.map((p) => p[0])), Math.max(...near.map((p) => p[0]))];
}

describe('habillage : polygones', () => {
  it('un rectangle repousse le texte de sa largeur plus la marge, sur sa hauteur plus la marge', () => {
    const text = { x: 10, y: 10, w: 100, h: 60 };
    const rect = { id: 'r', type: 'rect' as const, layerId: 'l', x: 10, y: 30, w: 30, h: 10 };
    const f = wrapFloatsFor(text, [{ obj: rect, margin: 2, invert: false }])!;
    expect(f.right).toBeUndefined();
    expect(f.left!.width).toBeCloseTo(32, 3);
    expect(floatEdge(f.left!, 5, 5)).toBe(0);
    expect(floatEdge(f.left!, 25, 25)).toBeCloseTo(32, 2);
    // Au coin, la marge est un arc de cercle (distance de 2 mm au coin du rectangle).
    expect(floatEdge(f.left!, 18.5, 18.5)).toBeCloseTo(30 + Math.sqrt(4 - 1.5 ** 2), 1);
    expect(floatEdge(f.left!, 17.5, 17.5)).toBe(0);
    expect(floatEdge(f.left!, 45, 45)).toBe(0);
    // À droite du bloc, l'obstacle pousse le texte vers la gauche.
    const g = wrapFloatsFor(text, [{ obj: { ...rect, x: 80 }, margin: 2, invert: false }])!;
    expect(g.left).toBeUndefined();
    expect(g.right!.width).toBeCloseTo(32, 3);
  });

  it('la goutte : le polygone suit son contour exact, marge comprise, dehors comme dedans', () => {
    const drop = wrapDoc().objects.g1 as FrameObject;
    const outline = objectOutline(drop);
    const ys = outline.flat().map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(drop.y + (2 / 130) * drop.h, 1);
    expect(Math.max(...ys)).toBeCloseTo(drop.y + (128 / 130) * drop.h, 1);
    const text = { x: 20, y: 30, w: 110, h: 90 };
    const f = wrapFloatsFor(text, [{ obj: drop, margin: 2, invert: false }])!.left!;
    const contour = dropPoints(drop);
    for (const y of [40, 50, 60, 70, 80, 90]) {
      const span = dropSpan(drop, y)!;
      const edge = floatEdge(f, y - text.y, y - text.y) + text.x;
      // Hors de la goutte, et à 2 mm exactement de son contour (distance au point le plus proche).
      expect(edge).toBeGreaterThan(span[1] + 2 - 0.05);
      const dist = Math.min(...contour.map(([x, yy]) => Math.hypot(x - edge, yy - y)));
      expect(dist).toBeGreaterThan(2 - 0.05);
      expect(dist).toBeLessThan(2 + 0.12);
    }
    // Le bord monte avec la goutte : étroite à la pointe, large en bas.
    expect(floatEdge(f, 12, 12)).toBeLessThan(floatEdge(f, 50, 50) - 10);

    const inside = wrapFloatsFor({ x: 20, y: 34, w: 50, h: 65 }, [{ obj: drop, margin: 3, invert: true }])!;
    const rightStart = 50 - inside.right!.width;
    for (const y of [55, 70, 85]) {
      const span = dropSpan(drop, y)!;
      const left = floatEdge(inside.left!, y - 34, y - 34) + 20;
      const right = floatEdge(inside.right!, y - 34, y - 34) + rightStart + 20;
      // Dans la goutte, à 3 mm de son contour de chaque côté.
      expect(left).toBeGreaterThan(span[0] + 3 - 0.05);
      expect(right).toBeLessThan(span[1] - 3 + 0.05);
      for (const x of [left, right]) {
        const dist = Math.min(...contour.map(([cx, cy]) => Math.hypot(cx - x, cy - y)));
        expect(dist).toBeGreaterThan(3 - 0.05);
        expect(dist).toBeLessThan(3 + 0.12);
      }
    }
    // Au-dessus de la pointe, plus aucune place : la ligne est entièrement exclue.
    expect(floatEdge(inside.left!, 0.5, 0.5)).toBeCloseTo(floatEdge(inside.right!, 0.5, 0.5) + rightStart, 3);
  });

  it('validation et index : `wrap` facultatif, seuls les blocs chevauchés sont habillés', () => {
    const doc = wrapDoc();
    (doc.objects.g1 as FrameObject).wrap = { margin: 2 };
    expect(validateDocument(doc).ok).toBe(true);
    const index = wrapIndex(doc, true);
    expect([...index.keys()].sort()).toEqual(['t1', 't2']);
    (doc.objects.g1 as FrameObject).wrap = { margin: -1 };
    expect(validateDocument(doc).ok).toBe(false);
  });
});

describe('habillage : rendu', () => {
  it('un texte posé sur la goutte en épouse le contour, identique à l’écran et à l’impression', async () => {
    await withTempDocuments(async (dir) => {
      await writeDocument(dir, wrapDoc());
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'habillage', { zoom: 1 });
          const before = await renderedLines(page, 't1');
          // Sans habillage, le texte passe sur la goutte, au bord gauche du bloc.
          expect(before.every((l) => Math.abs(l.left - 20) < 0.6)).toBe(true);

          // Panneau Propriétés : « Contourne la forme » sur la goutte (marge 2 mm par défaut).
          // La goutte est sous le texte : on la prend dans la liste (comme depuis le panneau Calques).
          await page.evaluate(() => window.__editor!.getState().select(['g1']));
          await settle(page);
          await page.click('[data-section="text-wrap"] input[name="wrapEnabled"]');
          await settle(page);
          await settle(page);
          const doc = await page.evaluate(() => window.__editor!.getState().doc!);
          expect(doc.objects.g1.wrap).toEqual({ margin: 2 });

          const floats = wrapFloatsFor(doc.objects.t1 as TextObject, [{ obj: doc.objects.g1, margin: 2, invert: false }])!;
          const lines = await renderedLines(page, 't1');
          const lh = (7.5 * 1.5 * 25.4) / 72;
          let wrapped = 0;
          for (const l of lines) {
            // Bande de la ligne (boîte de ligne, centrée sur les glyphes).
            const mid = (l.top + l.bottom) / 2 - 30;
            const edge = floatEdge(floats.left!, Math.max(0, mid - lh / 2), mid + lh / 2);
            expect(l.left - 20).toBeGreaterThanOrEqual(edge - 0.3);
            if (edge > 0) {
              wrapped++;
              // Le texte colle au contour : il commence à la marge près, pas plus loin qu'un espace.
              expect(l.left - 20).toBeLessThanOrEqual(edge + 1.2);
              // … et reste hors de la goutte, marge comprise.
              const span = dropSpan(doc.objects.g1 as FrameObject, (l.top + l.bottom) / 2);
              if (span) expect(l.left).toBeGreaterThan(span[1] + 1.7);
            }
          }
          expect(wrapped).toBeGreaterThan(10);
          const lefts = lines.filter((l) => l.left > 21).map((l) => l.left);
          expect(Math.max(...lefts) - Math.min(...lefts)).toBeGreaterThan(15);

          // Texte DANS la goutte (g2, « Texte dans la forme », marge 3 mm) : chaque ligne tient dans le contour.
          // Le texte qui ne tient pas dans la goutte déborde sous le bloc (« + » rouge) : seules comptent les lignes du bloc.
          const inside = (await renderedLines(page, 't2')).filter((l) => l.bottom <= 40 + 104);
          expect(inside.length).toBeGreaterThan(8);
          expect(await page.$('[data-overset-marker="t2"]')).not.toBeNull();
          for (const l of inside) {
            for (const y of [l.top + 0.3, l.bottom - 0.3]) {
              const span = dropSpan(doc.objects.g2 as FrameObject, y);
              expect(span).not.toBeNull();
              expect(l.left).toBeGreaterThanOrEqual(span![0] + 3 - 0.35);
              expect(l.right).toBeLessThanOrEqual(span![1] - 3 + 0.35);
            }
          }
          // Les lignes s'élargissent en descendant dans la goutte.
          const widths = inside.map((l) => l.right - l.left);
          expect(widths.at(-2)!).toBeGreaterThan(widths[0] + 10);

          // Route d'impression : exactement les mêmes lignes (le PDF est imprimé depuis cette page).
          await saveNow(page);
          const saved = await readSavedDocument(dir, 'habillage');
          const print = await browser.newPage();
          await print.goto(`${url}/print/habillage`);
          await print.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
          for (const id of ['t1', 't2']) {
            const screen = await renderedLines(page, id);
            const printed = await renderedLines(print, id);
            expect(printed.map((l) => l.text)).toEqual(screen.map((l) => l.text));
            printed.forEach((l: RenderedLine, i) => {
              expect(Math.abs(l.left - screen[i].left)).toBeLessThan(0.02);
              expect(Math.abs(l.top - screen[i].top)).toBeLessThan(0.02);
            });
            expect(await print.evaluate((i) => window.__lineCounts![i], id)).toBe((saved.objects[id] as TextObject).lines);
          }
          await print.close();
          const result = await exportPdf({ docId: 'habillage', preset: 'rvb', documentsDir: dir, baseUrl: url });
          expect(result.warnings.filter((w) => w.kind === 'line-break')).toEqual([]);
        },
        { documentsDir: dir },
      );
    });
  });
});
