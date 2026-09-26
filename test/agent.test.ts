// API de l'agent IA (window.fluidprint) et bouton « IA Agent » : un agent de navigateur pilote l'éditeur par
// programme, chaque action est une étape d'annulation, le guide cite exactement les méthodes de l'API.
import { describe, expect, it } from 'vitest';
import type {} from '../src/agent/api';
import type { RectObject, TextObject } from '../src/model/types';
import { copyExample, openEditor, readSavedDocument, settle, withApp, withTempDocuments } from './helpers/editor';

describe('agent IA (navigateur)', () => {
  it('lit, modifie, crée, regroupe en une étape, respecte les verrous ; guide et bouton à jour', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id);
          // Quitter l'éditeur (retour à l'accueil) ne doit pas rester bloqué sur l'alerte « modifications non enregistrées ».
          page.on('dialog', (dialog) => void dialog.accept());

          // Le guide cite toutes les méthodes, et seulement elles.
          const coverage = await page.evaluate(() => {
            const api = window.fluidprint!;
            const guide = api.help();
            const methods = Object.keys(api).filter((k) => typeof (api as unknown as Record<string, unknown>)[k] === 'function');
            const cited = [...guide.matchAll(/fluidprint\.(\w+)\(/g)].map((m) => m[1]);
            return { missing: methods.filter((m) => !cited.includes(m)), unknown: [...new Set(cited)].filter((m) => !methods.includes(m)) };
          });
          expect(coverage).toEqual({ missing: [], unknown: [] });

          // Lecture : repère du format fini (fond perdu de 3 mm retiré).
          const info = await page.evaluate(() => window.fluidprint!.info());
          expect(info.format.trim).toEqual({ w: 297, h: 210 });
          expect(info.pages.map((p) => p.name)).toEqual(['Extérieur', 'Intérieur']);
          expect(info.format.faces[0].panels.map((p) => p.w).reduce((a, b) => a + b, 0)).toBeCloseTo(297, 5);
          const t2 = await page.evaluate(() => window.fluidprint!.objects({ type: 'text' }).find((o) => o.id === 'ext-t2')!);
          expect(t2).toMatchObject({ x: 6, y: 24.29, pageName: 'Extérieur', layer: 'Contenu' });
          expect(await page.evaluate(() => window.fluidprint!.find('atelier horizon'))).toContain('ext-t2');

          // Texte : paragraphes, gras en markdown, typographie française, une étape nommée « Agent IA ».
          await page.evaluate(() => window.fluidprint!.setText('ext-t2', "L'atelier **ouvre**\nDeuxième paragraphe", { markdown: true }));
          const edited = await page.evaluate(() => window.__editor!.getState().doc!.objects['ext-t2'] as TextObject);
          expect(edited.paragraphs).toHaveLength(2);
          expect(edited.paragraphs[0].runs.map((r) => [r.text, r.fontWeight ?? null])).toEqual([
            ['L’atelier ', null],
            ['ouvre', 700],
          ]);
          expect(await page.evaluate(() => window.fluidprint!.getText('ext-t2'))).toBe('L’atelier ouvre\nDeuxième paragraphe');
          expect(await page.evaluate(() => window.__editor!.getState().history.undoLabel)).toBe('Agent IA : Texte');

          // Position au format fini ; style de paragraphe ; création sur le calque actif avec une nuance du nuancier.
          await page.evaluate(() => window.fluidprint!.setBox('ext-t2', { x: 10 }));
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects['ext-t2'].x)).toBe(13);
          await page.evaluate(() => window.fluidprint!.applyParagraphStyle('ext-t2', 'corps'));
          expect(await page.evaluate(() => (window.__editor!.getState().doc!.objects['ext-t2'] as TextObject).paragraphStyleId)).toBe('ps-corps');
          const rectId = await page.evaluate(() => window.fluidprint!.add('rect', { page: 1, x: -3, y: -3, w: 50, h: 20, color: 'Bleu 40%' }));
          const rect = await page.evaluate((rid) => window.__editor!.getState().doc!.objects[rid] as RectObject, rectId);
          expect(rect).toMatchObject({ x: 0, y: 0, w: 50, h: 20, layerId: 'contenu', fill: { swatch: 'bleu', tint: 0.4 } });
          expect(await page.evaluate(() => window.__editor!.getState().selection)).toEqual([rectId]);

          // Couleur hexadécimale inconnue : nuance créée.
          await page.evaluate((rid) => window.fluidprint!.setColor(rid, '#123456'), rectId);
          expect(await page.evaluate(() => window.__editor!.getState().doc!.swatches.some((s) => s.name === 'Couleur #123456'))).toBe(true);
          // Sa conversion en CMJN (Python, asynchrone) est une étape à part : attendue pour compter les étapes du lot.
          await page.waitForFunction(() => !!window.__editor!.getState().doc!.swatches.find((s) => s.name === 'Couleur #123456')?.cmyk, { timeout: 30_000 });

          // Un lot = une étape ; une erreur dans le lot annule tout le lot.
          const depth = await page.evaluate(() => window.__editor!.getState().history.depth);
          await page.evaluate((rid) => window.fluidprint!.batch('Mise en page', () => {
            window.fluidprint!.move(rid, 5, 5);
            window.fluidprint!.rotate(rid, 10);
          }), rectId);
          expect(await page.evaluate(() => window.__editor!.getState().history)).toMatchObject({ depth: depth + 1, undoLabel: 'Agent IA : Mise en page' });
          const failed = await page.evaluate((rid) =>
            window.fluidprint!.batch('Échec', () => {
              window.fluidprint!.move(rid, 50, 0);
              window.fluidprint!.setBox('ext-r6', { x: 0 });
            }).then(() => null, (e: Error) => e.message),
          rectId);
          expect(failed).toMatch(/Calque verrouillé : « Fonds »/);
          expect(await page.evaluate((rid) => window.__editor!.getState().doc!.objects[rid].x, rectId)).toBe(5);

          // Icône par un mot français.
          const iconId = await page.evaluate(() => window.fluidprint!.addIcon('téléphone', { page: 1, x: 20, y: 20 }));
          expect(await page.evaluate((iid) => window.__editor!.getState().doc!.objects[iid].type, iconId)).toBe('icon');

          // Bouton de la barre du haut : le guide, la consigne ; l'indicateur montre la dernière action.
          expect(await page.$eval('[data-agent-activity]', (el) => el.textContent)).toContain('Icône');
          await page.click('[data-topbar-action="agent"]');
          await page.waitForSelector('[data-agent-guide]');
          expect(await page.$eval('[data-agent-guide]', (el) => el.textContent)).toContain('window.fluidprint');
          expect(await page.$eval('[data-agent-prompt]', (el) => el.textContent)).toContain('fluidprint.help()');

          await page.evaluate(() => window.fluidprint!.save());
          const saved = await readSavedDocument(dir, id);
          expect(saved.objects[rectId]).toBeDefined();
          expect(saved.objects[iconId]).toBeDefined();

          // Accueil : la même API liste et crée des documents.
          await page.goto(url);
          await page.waitForFunction(() => !!window.fluidprint);
          await settle(page);
          expect(await page.evaluate(() => window.fluidprint!.docs().then((d) => (d as { id: string }[]).map((x) => x.id)))).toContain(id);
          const created = await page.evaluate(() => window.fluidprint!.create('Essai agent', 'flyer-a5'));
          expect(created).toBe('essai-agent');
        },
        { documentsDir: dir },
      );
    });
  });
});
