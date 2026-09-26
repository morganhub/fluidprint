// Contrôle en amont (tâche 4.8) : règles, pastille en direct, sélection d'un clic, refus de l'export imprimeur.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { coverageModule, COVERAGE_FILE, readFontFaces } from '../scripts/font-coverage';
import { exportPdf, printRefusal } from '../server/export';
import { loadPresets } from '../server/color';
import { hiddenPrintableLayers, preflightRefusal, qrUrlProblem, runPreflight, safetyBoxes, type PreflightReport } from '../src/model/preflight';
import type { FrameObject, LayoutDocument, QrObject, RectObject, TextObject } from '../src/model/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { clickAt, openEditor, press, readSavedDocument, saveNow, selection, settle, withApp, withTempDocuments, writeDocument } from './helpers/editor';

// Espion sur l'encodeur de QR (le reste du module reste le vrai) : le cache de qrUrlProblem se vérifie au
// nombre d'encodages.
const qr = vi.hoisted(() => ({ encodes: 0 }));
vi.mock('qrcode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('qrcode')>();
  return {
    ...actual,
    create: (...args: Parameters<typeof actual.create>) => {
      qr.encodes++;
      return actual.create(...args);
    },
  };
});

const rules = (r: PreflightReport) => r.issues.map((i) => `${i.severity}:${i.rule}:${i.objectId ?? ''}`);

function doc(): LayoutDocument {
  const d = minimalDoc();
  d.id = 'controle';
  return d;
}

describe('contrôle en amont : règles', () => {
  it('un document sain ne signale rien ; la zone de sécurité est celle des repères', () => {
    expect(runPreflight(doc()).issues).toEqual([]);
    // Extérieur : 3 + 97 = pli à 100 mm ; sécurité 4 mm de part et d'autre, et 4 mm du trait de coupe.
    expect(safetyBoxes(doc(), 'exterieur')[0]).toEqual({ x: 7, y: 7, w: 89, h: 202 });
    expect(safetyBoxes(doc(), 'exterieur')[1].x).toBe(104);
  });

  it('texte près de la coupe ou d’un pli : erreur rouge ; l’étendue réelle des lignes prime sur la boîte', () => {
    const d = doc();
    const t1 = d.objects.t1 as TextObject;
    t1.x = 5;
    const r = runPreflight(d);
    expect(rules(r)).toEqual(['error:safety:t1']);
    expect(r.issues[0].message).toContain('2 mm de la coupe');
    expect(r.blocking).toHaveLength(1);
    // Mesuré : les lignes commencent 3 mm dans la boîte, donc à 5 mm de la coupe.
    expect(runPreflight(d, { texts: { t1: { ink: { x: 3, y: 0, w: 40, h: 4 } } } }).issues).toEqual([]);
    // Un bloc mesuré sans texte visible n'est jamais signalé.
    expect(runPreflight(d, { texts: { t1: { ink: null } } }).issues).toEqual([]);
    t1.x = 12;
    t1.w = 86;
    expect(runPreflight(d).issues[0]).toMatchObject({ rule: 'safety', severity: 'error', message: expect.stringContaining('pli') });
    // Tourné de 90° : c'est la boîte tournée qui compte.
    t1.w = 80;
    t1.rotation = 90;
    t1.y = 20;
    expect(rules(runPreflight(d))).toEqual(['error:safety:t1']);
  });

  it('texte en excès (mesuré), sauf en hauteur auto ou quand il continue dans un bloc chaîné', () => {
    const d = doc();
    expect(rules(runPreflight(d, { texts: { t1: { contentH: 20.2 } } }))).toEqual([]);
    expect(rules(runPreflight(d, { texts: { t1: { contentH: 26 } } }))).toEqual(['error:overset:t1']);
    (d.objects.t1 as TextObject).autoHeight = true;
    expect(rules(runPreflight(d, { texts: { t1: { contentH: 26 } } }))).toEqual([]);
  });

  it('photos : provisoire et sous 150 ppi en rouge (confirmable), sous 250 ppi en orange', () => {
    const d = doc();
    d.assets = [{ id: 'a1', kind: 'image', name: 'photo.jpg', original: 'assets/originals/photo.jpg', width: 1000, height: 800 }];
    const frame: FrameObject = { id: 'f1', type: 'frame', layerId: 'contenu', x: 110, y: 20, w: 80, h: 64, shape: { kind: 'rect' }, image: { assetId: 'a1', fit: 'fill', x: 0, y: 0, w: 80, h: 64 } };
    d.objects.f1 = frame;
    d.pages[0].children.push('f1');
    // 1 000 px sur 80 mm : 317 ppi.
    expect(runPreflight(d).issues).toEqual([]);
    frame.image!.w = 120;
    frame.image!.h = 96;
    expect(rules(runPreflight(d))).toEqual(['warning:ppi-warn:f1']);
    frame.image!.w = 200;
    frame.image!.h = 160;
    const low = runPreflight(d);
    expect(rules(low)).toEqual(['error:ppi-error:f1']);
    expect(low.blocking).toEqual([]);
    expect(low.toConfirm).toHaveLength(1);
    expect(preflightRefusal(low)).toContain('confirmer');
    expect(preflightRefusal(low, { confirmLowResolution: true })).toBeNull();
    d.assets[0].placeholder = true;
    expect(rules(runPreflight(d))).toEqual(['error:placeholder:f1', 'error:ppi-error:f1']);
  });

  it('couleurs : hors nuancier, encrage maximal, petits textes à plus de deux encres (erreur rouge, sauf nuance d’accent)', () => {
    const d = doc();
    d.objects.s1 = { id: 's1', type: 'svg', layerId: 'contenu', x: 20, y: 120, w: 20, h: 20, viewBox: '0 0 10 10', content: '<path d="M0 0H10V10Z" fill="#ff0000"/>' };
    d.pages[0].children.push('s1');
    expect(rules(runPreflight(d))).toEqual(['warning:foreign-color:s1']);
    delete d.objects.s1;
    d.pages[0].children.pop();

    d.swatches[0].cmyk = [100, 100, 100, 100];
    // « pour vous. » (7,5 pt) est dans ce bleu à 4 encres : il est aussi signalé comme petit texte.
    expect(rules(runPreflight(d))).toEqual(['error:small-text-inks:t1', 'error:ink-limit:r1', 'error:ink-limit:t1']);
    expect(rules(runPreflight(d, {}, { maxInk: 400 }))).toEqual(['error:small-text-inks:t1']);
    (d.objects.r1 as RectObject).fill = { swatch: 'bleu', tint: 0.5 };
    expect(rules(runPreflight(d))).toEqual(['error:small-text-inks:t1', 'error:ink-limit:t1']);
    d.swatches[0].cmyk = [86, 55, 0, 0];

    // Sous 9 pt, deux encres au plus. Le gris du design à 4 encres bloque l'export imprimeur, comme le
    // contrôle PDF/X qui refuserait le même fichier.
    d.swatches[1].cmyk = [74, 61, 42, 34];
    const four = runPreflight(d);
    expect(rules(four)).toEqual(['error:small-text-inks:t1']);
    expect(four.blocking).toHaveLength(1);
    expect(four.issues[0].message).toMatch(/7,5 pt avec 4 encres \(Gris texte\).*2 au plus sous 9 pt/);
    // Deux encres (cyan + noir, comme une variante « petit texte ») : accepté.
    d.swatches[1].cmyk = [39, 0, 0, 91];
    expect(runPreflight(d).issues).toEqual([]);
    // Nuance d'accent déclarée (intertitres, texte clair sur fond foncé) : exception actée.
    d.swatches[1].cmyk = [81, 27, 39, 10];
    d.swatches[1].smallTextException = true;
    expect(runPreflight(d).issues).toEqual([]);
    delete d.swatches[1].smallTextException;
    d.swatches[1].cmyk = [0, 0, 0, 80];
    expect(runPreflight(d).issues).toEqual([]);
  });

  it('caractère absent d’Open Sans (emoji, flèche, coche) : alerte ; la fine insécable et les blancs ne comptent pas', () => {
    const d = doc();
    const t1 = d.objects.t1 as TextObject;
    // Typographie française (U+202F, U+00A0, apostrophe courbe) : tout est dans Open Sans ou dessiné par le rendu.
    t1.paragraphs = [{ runs: [{ text: 'Votre atelier\u202f: l\u2019équipe\u00a0» — 12\u00a0€' }] }];
    expect(runPreflight(d).issues).toEqual([]);
    t1.paragraphs = [{ runs: [{ text: 'Votre ✓ → ' }, { text: '📱', color: { swatch: 'bleu' } }] }];
    const r = runPreflight(d);
    expect(rules(r)).toEqual(['warning:missing-glyph:t1']);
    expect(r.issues[0].message).toContain('« ✓ » (U+2713)');
    expect(r.issues[0].message).toContain('« → » (U+2192)');
    expect(r.issues[0].message).toContain('« 📱 » (U+1F4F1)');
    expect(r.issues[0].message).toContain('Open Sans');
    // Police que l'éditeur ne fournit pas : tout le bloc part dans une police du système.
    t1.paragraphs = [{ runs: [{ text: 'Bonjour' }] }];
    t1.style.fontFamily = 'Comic Sans MS';
    expect(runPreflight(d).issues[0]).toMatchObject({ rule: 'missing-glyph', message: expect.stringContaining('police « Comic Sans MS » non fournie') });
  });

  it('la couverture des polices suit public/fonts (scripts/font-coverage.ts)', () => {
    const faces = readFontFaces();
    // Chaque graisse du design a sa face italique : sans elle, Chrome dessinait un faux italique en Type 3.
    expect(faces.map((f) => f.postscript)).toEqual(
      expect.arrayContaining(['OpenSans-SemiBoldItalic', 'OpenSans-BoldItalic', 'OpenSans-ExtraBoldItalic', 'OpenSans-Italic']),
    );
    expect(readFileSync(COVERAGE_FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(coverageModule(faces));
  });

  it('calque imprimable masqué : alerte, et confirmation exigée par l’export imprimeur', () => {
    const d = doc();
    d.layers[0].visible = false;
    expect(hiddenPrintableLayers(d)).toEqual([{ id: 'contenu', name: 'Contenu', objects: 2 }]);
    const r = runPreflight(d);
    expect(rules(r)).toEqual(['warning:hidden-layer:']);
    expect(r.issues[0].message).toBe('Calque imprimable « Contenu » masqué : 2 objets ne seront pas imprimés');
    expect(r.blocking).toEqual([]);
    expect(r.toConfirm).toHaveLength(1);
    expect(preflightRefusal(r)).toMatch(/1 point à confirmer.*calque imprimable masqué : confirmer/);
    expect(preflightRefusal(r, { confirmHiddenLayers: true })).toBeNull();
    // La confirmation des photos ne vaut pas pour le calque.
    expect(preflightRefusal(r, { confirmLowResolution: true })).not.toBeNull();
    const refusal = printRefusal(d, loadPresets().presets.imprimeur);
    expect(refusal?.details).toMatchObject({ reason: 'hidden-layers', confirm: ['hidden-layers'] });
    expect(printRefusal(d, loadPresets().presets.imprimeur, { confirmHiddenLayers: true })).toBeNull();
    // Un calque non imprimable (notes, repères) masqué, ou vide, ne compte pas.
    d.layers[0].printable = false;
    expect(hiddenPrintableLayers(d)).toEqual([]);
    d.layers[0].printable = true;
    d.pages.forEach((p) => (p.children = []));
    expect(hiddenPrintableLayers(d)).toEqual([]);
  });

  it('QR codes : l’adresse n’est encodée qu’une fois par adresse et niveau (contrôle relancé à chaque image d’un geste)', () => {
    const d = doc();
    for (let i = 0; i < 6; i++) {
      d.objects[`q${i}`] = { id: `q${i}`, type: 'qr', layerId: 'contenu', x: 110 + i, y: 20, w: 20, h: 20, url: 'https://example.com/cache', ecc: 'M', color: { swatch: 'gris' }, margin: 4 };
      d.pages[0].children.push(`q${i}`);
    }
    const before = qr.encodes;
    for (let frame = 0; frame < 30; frame++) runPreflight(d);
    expect(qr.encodes - before).toBe(1);
    // Le résultat reste celui du calcul, et un autre niveau est encodé à part.
    expect(qrUrlProblem('https://example.com/cache', 'M')).toBeNull();
    qrUrlProblem('https://example.com/cache', 'H');
    expect(qr.encodes - before).toBe(2);
    expect(qrUrlProblem('pas une adresse', 'M')).toMatch(/adresse invalide/);
  });

  it('filets sous 0,25 pt et QR codes : trop petits, marge insuffisante, adresse illisible', () => {
    const d = doc();
    (d.objects.r1 as RectObject).stroke = { color: { swatch: 'bleu' }, width: 0.1 };
    expect(rules(runPreflight(d))).toEqual(['warning:thin-stroke:r1']);
    (d.objects.r1 as RectObject).stroke!.width = 0.25;
    const qr: QrObject = { id: 'q1', type: 'qr', layerId: 'contenu', x: 120, y: 20, w: 20, h: 20, url: 'https://example.com', ecc: 'M', color: { swatch: 'gris' }, margin: 4 };
    d.objects.q1 = qr;
    d.pages[0].children.push('q1');
    expect(runPreflight(d).issues).toEqual([]);
    qr.w = qr.h = 12;
    qr.margin = 2;
    expect(rules(runPreflight(d))).toEqual(['warning:qr-small:q1', 'warning:qr-quiet-zone:q1']);
    qr.url = 'pas une adresse';
    expect(rules(runPreflight(d))[0]).toBe('error:qr-unreadable:q1');
  });

  it('seuls les objets imprimés comptent ; une page type est contrôlée sur les faces qui l’utilisent', () => {
    const d = doc();
    (d.objects.t1 as TextObject).x = 5;
    d.objects.t1.hidden = true;
    expect(runPreflight(d).issues).toEqual([]);
    delete d.objects.t1.hidden;
    d.layers.push({ id: 'notes', name: 'Notes', visible: true, locked: false, printable: false, color: '#999999' });
    d.objects.t1.layerId = 'notes';
    expect(runPreflight(d).issues).toEqual([]);
    d.objects.t1.layerId = 'contenu';
    d.pages[0].children = ['r1'];
    d.masters = [{ id: 'pt-a', faceId: 'exterieur', name: 'A', children: ['t1'] }];
    expect(runPreflight(d).issues).toEqual([]);
    d.pages[1].masterId = 'pt-a';
    expect(runPreflight(d).issues).toMatchObject([{ rule: 'safety', objectId: 't1', pageId: 'pt-a' }]);
  });
});

describe('contrôle en amont : éditeur et export', () => {
  it('un texte poussé à 2 mm de la coupe passe la pastille au rouge et se sélectionne d’un clic ; l’export imprimeur refuse tant que l’erreur subsiste', async () => {
    await withTempDocuments(async (dir) => {
      await writeDocument(dir, doc());
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, 'controle', { zoom: 1.5, centerOn: 't1' });
          await page.waitForSelector('[data-preflight-status="ok"]');

          // Le texte (x = 12 mm) est poussé vers la coupe : Maj+← (5 mm) puis 4 × ← (0,5 mm) = 2 mm du trait de coupe.
          await clickAt(page, 'p-ext', 30, 65);
          expect(await selection(page)).toEqual(['t1']);
          await press(page, 'Shift', 'ArrowLeft');
          for (let i = 0; i < 4; i++) await press(page, 'ArrowLeft');
          expect(await page.evaluate(() => window.__editor!.getState().doc!.objects.t1.x)).toBe(5);
          await page.waitForSelector('[data-preflight-status="error"]');
          expect(await page.$eval('[data-preflight-status]', (el) => el.textContent)).toContain('1 erreur');

          // La pastille ouvre la liste ; un clic sur le problème sélectionne le bloc en cause.
          await press(page, 'Escape');
          expect(await selection(page)).toEqual([]);
          await page.click('[data-preflight-status]');
          await page.waitForSelector('[data-panel-tab="preflight"][data-state="active"], [data-preflight-panel]');
          const item = await page.waitForSelector('[data-preflight-issue="safety:t1"]');
          expect(await item!.evaluate((el) => el.textContent)).toContain('2 mm de la coupe');
          await item!.click();
          await settle(page);
          expect(await selection(page)).toEqual(['t1']);

          // Export imprimeur : refusé tant que l'erreur rouge subsiste.
          await saveNow(page);
          await expect(exportPdf({ docId: 'controle', preset: 'imprimeur', documentsDir: dir, baseUrl: url })).rejects.toThrow(/Contrôle en amont.*à 2(,\d)? mm de la coupe/);

          // Corrigé (annuler) : la pastille repasse au vert et le contrôle ne bloque plus l'export.
          await press(page, 'Control', 'z');
          await page.waitForSelector('[data-preflight-status="ok"]');
          await saveNow(page);
          const saved = await readSavedDocument(dir, 'controle');
          expect(saved.objects.t1.x).toBe(12);
          expect(printRefusal(saved, loadPresets().presets.imprimeur)).toBeNull();
          const outcome = await exportPdf({ docId: 'controle', preset: 'imprimeur', documentsDir: dir, baseUrl: url }).then(
            () => 'exporté',
            (e: Error) => e.message,
          );
          expect(outcome).not.toMatch(/Contrôle en amont/);

          // Le texte en excès ne se voit qu'une fois le texte mis en page : l'export le mesure à l'impression.
          await page.evaluate(() => window.__editor!.getState().setBox('t1', { h: 2 }));
          await page.waitForSelector('[data-preflight-issue="overset:t1"]');
          await saveNow(page);
          await expect(exportPdf({ docId: 'controle', preset: 'imprimeur', documentsDir: dir, baseUrl: url })).rejects.toThrow(/Texte en excès/);
        },
        { documentsDir: dir },
      );
    });
  });
});
