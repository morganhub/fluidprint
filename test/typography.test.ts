// Typographie française automatique (tâche 2.15) : règles, application aux segments, « Corriger tout le
// document » sur une copie du dépliant d'exemple, coupures de ligne réellement rendues, correction à la saisie.
import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { LayoutDocument, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { NNBSP_RENDER, renderNnbsp } from '../src/render/textCss';
import { applyEditsToRuns, applyTypographyToDocument, documentTypographyChanges, fixTypography, NBSP, NNBSP, runsText, typographyEdits } from '../src/text/typographyFr';
import { EXAMPLE_FILE, copyExample, openEditor, readSavedDocument, saveNow, settle, withApp, withTempDocuments } from './helpers/editor';
import { openTextEditor } from './helpers/text';

const example = (): LayoutDocument => JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));
const allText = (doc: LayoutDocument) =>
  Object.values(doc.objects)
    .filter((o): o is TextObject => o.type === 'text')
    .map((t) => t.paragraphs.map((p) => runsText(p.runs)).join('\n'))
    .join('\n');
const count = (text: string, c: string) => text.split(c).length - 1;

describe('règles typographiques', () => {
  it('insécables avant : ; ! ?, durées, apostrophes, guillemets', () => {
    expect(fixTypography('Jeunes curieux : un premier meuble')).toBe(`Jeunes curieux${NBSP}: un premier meuble`);
    expect(fixTypography('1 h à 1 h 30')).toBe(`1${NBSP}h à 1${NBSP}h${NBSP}30`);
    expect(fixTypography('Réponse sous 48 h, séances de 10 min à 3 h (8 h max)')).toBe(`Réponse sous 48${NBSP}h, séances de 10${NBSP}min à 3${NBSP}h (8${NBSP}h max)`);
    expect(fixTypography("Des vidéos en accès libre, c'est gratuit !")).toBe(`Des vidéos en accès libre, c’est gratuit${NNBSP}!`);
    expect(fixTypography('Pour quels formats ? Oui ; non')).toBe(`Pour quels formats${NNBSP}? Oui${NNBSP}; non`);
    expect(fixTypography('Il a dit "bonjour" puis « au revoir »')).toBe(`Il a dit «${NBSP}bonjour${NBSP}» puis «${NBSP}au revoir${NBSP}»`);
    expect(fixTypography('«ok»')).toBe(`«${NBSP}ok${NBSP}»`);
    // Ce qui ne doit pas bouger.
    for (const same of ['https://example.com/?q=1', '10:30', '1 heure', 'hello!?', '15 à 45 minutes', 'A4/A5']) expect(fixTypography(same)).toBe(same);
    // Idempotent.
    const once = fixTypography(`Titre : "citation" l'atelier 1 h 30 !`);
    expect(fixTypography(once)).toBe(once);
    expect(typographyEdits(once)).toEqual([]);
  });

  it('garde la mise en forme des segments', () => {
    const runs = applyEditsToRuns([{ text: 'Jeunes curieux :', fontWeight: 700 }, { text: " un premier meuble d'atelier" }], typographyEdits("Jeunes curieux : un premier meuble d'atelier"));
    expect(runs).toEqual([{ text: `Jeunes curieux${NBSP}:`, fontWeight: 700 }, { text: ' un premier meuble d’atelier' }]);
    // Une correction à cheval sur deux segments (espace dans l'un, « ! » dans l'autre).
    const split = applyEditsToRuns([{ text: 'gratuit ' }, { text: '!', color: { swatch: 'bleu' } }], typographyEdits('gratuit !'));
    expect(runsText(split)).toBe(`gratuit${NNBSP}!`);
    expect(split.at(-1)).toMatchObject({ text: '!', color: { swatch: 'bleu' } });
  });

  it('rendu de la fine insécable : seule U+202F devient gluon + espace fine d’Open Sans + gluon', () => {
    expect([...NNBSP_RENDER].map((c) => c.codePointAt(0))).toEqual([0x2060, 0x2009, 0x2060]);
    expect(renderNnbsp(`c’est gratuit${NNBSP}! Oui${NBSP}: non`)).toBe(`c’est gratuit\u{2060}\u{2009}\u{2060}! Oui${NBSP}: non`);
    // Les espaces ordinaires restent des points de coupure.
    expect(renderNnbsp('Votre atelier, pour vous.')).toBe('Votre atelier, pour vous.');
  });

  it('« Corriger tout le document » : les 8 apostrophes droites du dépliant d’exemple deviennent courbes', () => {
    const doc = example();
    const before = allText(doc);
    expect(count(before, "'")).toBe(8);
    const curlyBefore = count(before, '’');
    const changes = documentTypographyChanges(doc);
    expect(changes.filter((c) => c.rule === 'apostrophe')).toHaveLength(8);
    // Et les autres règles, sur les durées (« 1 h 30 »), les deux-points et « ! » « ? » « ; ».
    expect(changes.filter((c) => c.rule === 'duree')).toHaveLength(44);
    expect(changes.filter((c) => c.rule === 'deux-points')).toHaveLength(12);
    expect(changes.filter((c) => c.rule === 'ponctuation')).toHaveLength(4);
    expect(changes.some((c) => c.objId === 'int-t61' && c.rule === 'deux-points')).toBe(true);
    const applied = applyTypographyToDocument(doc);
    expect(applied).toBe(changes.length);
    const after = allText(doc);
    expect(count(after, "'")).toBe(0);
    expect(count(after, '’')).toBe(curlyBefore + 8);
    expect(after).toContain(`Jeunes curieux${NBSP}:`);
    expect(after).toContain(`1${NBSP}h${NBSP}30`);
    expect(after).not.toMatch(/\d h 30/);
    expect(validateDocument(doc).ok).toBe(true);
    // Les logos et les QR codes ne sont pas des textes : intacts.
    const ref = example();
    for (const o of Object.values(doc.objects)) if (o.type !== 'text') expect(o).toEqual(ref.objects[o.id]);
    expect(documentTypographyChanges(doc)).toEqual([]);
  });
});

/** Ordonnée (px) de chaque caractère de `needle` dans le bloc rendu, pour chaque occurrence. */
function charTops(page: Page, objId: string, needle: string): Promise<number[][]> {
  return page.evaluate(
    (id, n) => {
      const el = document.querySelector(`[data-page-id] [data-obj-id="${id}"]`)!;
      const nodes: { node: Text; start: number }[] = [];
      let text = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        nodes.push({ node, start: text.length });
        text += node.data;
      }
      const at = (i: number) => {
        const entry = [...nodes].reverse().find((e) => e.start <= i)!;
        const r = document.createRange();
        r.setStart(entry.node, i - entry.start);
        r.setEnd(entry.node, i - entry.start + 1);
        const rect = [...r.getClientRects()].find((x) => x.width > 0) ?? r.getBoundingClientRect();
        return Math.round((rect.top + rect.bottom) / 2);
      };
      const out: number[][] = [];
      for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
        // Les caractères sans chasse (gluons U+2060) n'ont pas de boîte : on ne mesure que les visibles.
        out.push([...n].map((c, k) => (c === '⁠' ? null : at(i + k))).filter((v): v is number => v !== null));
      }
      return out;
    },
    objId,
    needle,
  );
}

const sameLine = (tops: number[]) => tops.every((t) => Math.abs(t - tops[0]) <= 1);

describe('typographie dans l’éditeur (navigateur)', () => {
  it('« Jeunes curieux : » ne coupe plus avant « : », « 1 h 30 » ne se coupe jamais ; correction à la saisie', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'int-t61' });
          // Avant : le design coupe entre « curieux » et « : ».
          const [before] = await charTops(page, 'int-t61', 'x :');
          expect(sameLine([before[0], before[2]])).toBe(false);

          // Aperçu puis application.
          await page.click('[data-topbar-action="typography"]');
          await page.waitForSelector('[data-typography-changes]');
          expect(await page.$(`[data-typography-object="int-t61"]`)).not.toBeNull();
          const label = await page.$eval('[data-action="apply-typography"]', (el) => el.textContent);
          const total = documentTypographyChanges(example()).length;
          expect(label).toContain(String(total));
          await page.click('[data-action="apply-typography"]');
          await settle(page);
          expect(await page.evaluate(() => window.__editor!.getState().history.undoLabel)).toBe('Corriger la typographie');

          const [after] = await charTops(page, 'int-t61', `x${' '}:`);
          expect(sameLine(after)).toBe(true);

          // « 1 h 30 » : jamais coupé, quelle que soit la largeur du bloc.
          const durations = ['int-t9', 'int-t11', 'int-t15', 'int-t28', 'int-t52'];
          for (const objId of durations) {
            for (let w = 6; w <= 24; w += 1) {
              await page.evaluate((i, width) => window.__editor!.getState().patchSilently((d) => void (d.objects[i].w = width)), objId, w);
              await settle(page);
              const occurrences = await charTops(page, objId, `1${' '}h${' '}30`);
              expect(occurrences.length, objId).toBeGreaterThan(0);
              for (const tops of occurrences) expect(sameLine(tops), `${objId} à ${w} mm`).toBe(true);
            }
          }

          // Fine insécable (« gratuit ! ») : dessinée U+2060 U+2009 U+2060, jamais U+202F (absente d'Open
          // Sans) ; aucune espace ordinaire n'est encadrée de gluons ; aucune police de repli ; pas de
          // coupure entre le mot et « ! », quelle que soit la largeur.
          const dom = await page.evaluate(() => ({
            all: [...document.querySelectorAll('[data-page-id] [data-obj-id]')].map((el) => el.textContent ?? '').join('\n'),
            t41: document.querySelector('[data-page-id] [data-obj-id="ext-t41"]')!.textContent ?? '',
          }));
          expect(dom.t41).toContain(`gratuit${NNBSP_RENDER}!`);
          expect(dom.all).not.toContain(NNBSP);
          expect(dom.all).not.toMatch(/\u{2060} | \u{2060}/u);
          const cdp = await page.createCDPSession();
          await cdp.send('DOM.enable');
          await cdp.send('CSS.enable');
          const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
          const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-page-id] [data-obj-id="ext-t41"] span' });
          const families = new Set<string>();
          for (const nodeId of nodeIds) for (const f of (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts) families.add(f.familyName);
          // Chrome nomme la police réelle (« Open Sans ExtraBold ») : seule Open Sans doit y figurer.
          expect(families.size).toBeGreaterThan(0);
          for (const family of families) expect(family).toMatch(/^Open Sans/);
          await cdp.detach();
          for (let w = 8; w <= 50; w += 1) {
            await page.evaluate((width) => window.__editor!.getState().patchSilently((d) => void (d.objects['ext-t41'].w = width)), w);
            await settle(page);
            const occurrences = await charTops(page, 'ext-t41', `t${NNBSP_RENDER}!`);
            expect(occurrences, `ext-t41 à ${w} mm`).toHaveLength(1);
            expect(sameLine(occurrences[0]), `ext-t41 à ${w} mm`).toBe(true);
          }
          await page.evaluate(() => window.__editor!.getState().undo());
          await page.evaluate(() => window.__editor!.getState().redo());

          // Saisie : double-clic sur un bloc, frappe au clavier.
          await openTextEditor(page, 'ext-t2');
          await page.keyboard.down('Control');
          await page.keyboard.press('End');
          await page.keyboard.up('Control');
          await page.keyboard.type(` Titre : l'atelier "vite" en 1 h 30 !`);
          await page.keyboard.press('Escape');
          await settle(page);
          const typed = await page.evaluate(() => {
            const t = window.__editor!.getState().doc!.objects['ext-t2'] as TextObject;
            return t.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
          });
          expect(typed.endsWith(` Titre${NBSP}: l’atelier «${NBSP}vite${NBSP}» en 1${NBSP}h${NBSP}30${NNBSP}!`)).toBe(true);

          await saveNow(page);
          const saved = await readSavedDocument(dir, id);
          const text = allText(saved);
          expect(count(text, "'")).toBe(0);
          expect(validateDocument(saved).ok).toBe(true);
        },
        { documentsDir: dir },
      );
    });
  });
});
