// Import de designs Claude Design de tous formats : format déduit du design (gabarit imposé,
// gabarit reconnu, format sur mesure), dans des dossiers jetables.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFormat } from '../scripts/import/designFormat';
import { loadDesign } from '../scripts/import/designPage';
import { DesignImportError, parseDesign } from '../scripts/import/designSource';
import { nameFromFileName, runImport } from '../scripts/import/importer';
import { foldPositions } from '../src/model/format';
import type { DocObject, IconObject, LayoutDocument, RectObject, TextObject } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { PROJECT_ROOT } from '../server/paths';
import { EXAMPLE_DESIGN } from './helpers/editor';

const FIXTURES = path.join(PROJECT_ROOT, 'test', 'fixtures', 'designs');
const FLYER = path.join(FIXTURES, 'flyer-a5.dc.html');
const CUSTOM = path.join(FIXTURES, 'sur-mesure-100.dc.html');
const GUIDED = path.join(FIXTURES, 'depliant-reperes.dc.html');

/** Export Claude Design réduit à l'essentiel : `<doc-page>` et ses sections. */
function design(docPage: string, sections: { id?: string; label?: string; body?: string }[], title?: string): string {
  const pages = sections
    .map((s) => `<section class="page"${s.id ? ` id="${s.id}"` : ''}${s.label ? ` data-screen-label="${s.label}"` : ''}>${s.body ?? '<div>texte</div>'}</section>`)
    .join('\n');
  return `<!DOCTYPE html><html><head>${title ? `<title>${title}</title>` : ''}</head><body><x-dc><doc-page ${docPage}>\n${pages}\n</doc-page></x-dc></body></html>`;
}

/** Repères écran comme ceux de Claude Design : cadre de coupe en retrait, plis en pointillés. */
function guides(inset: number | null, folds: number[]): string {
  const frame = inset === null ? '' : `<div style="position:absolute;inset:${inset}mm;border:0.3mm solid #e0245e;pointer-events:none"></div>`;
  const lines = folds.map((x) => `<div style="position:absolute;top:0;bottom:0;left:${x}mm;border-left:0.3mm dashed #e0245e;pointer-events:none"></div>`).join('');
  return `<div style="position:relative;width:100%;height:100%">texte<sc-if value="{{ showGuides }}">${frame}${lines}</sc-if></div>`;
}

describe('lecture du design, sans navigateur', () => {
  it('lit la taille de page : width/height, sinon size a4/letter et orientation (Letter par défaut)', () => {
    const size = (attrs: string) => {
      const { w, h } = parseDesign(design(attrs, [{ id: 'p' }])).page;
      return [w, h];
    };
    expect(size('width="303mm" height="216mm"')).toEqual([303, 216]);
    expect(size('width="8.5in" height="11in"')).toEqual([215.9, 279.4]);
    expect(size('size="a4"')).toEqual([210, 297]);
    expect(size('size="A4" orientation="landscape"')).toEqual([297, 210]);
    expect(size('size="letter" orientation="landscape"')).toEqual([279.4, 215.9]);
    expect(size('')).toEqual([215.9, 279.4]);
  });

  it('refuse un fichier qui n’est pas un export Claude Design, avec un message clair', () => {
    expect(() => parseDesign('<html><body><h1>Bonjour</h1></body></html>')).toThrow(DesignImportError);
    expect(() => parseDesign('<html><body><h1>Bonjour</h1></body></html>')).toThrow(/pas un export Claude Design/);
    expect(() => parseDesign('<doc-page size="a4"><p>un document qui coule, sans pages</p></doc-page>')).toThrow(/aucune <section class="page">/);
  });

  it('lit titre, sections, libellés et repères du dépliant d’exemple', async () => {
    const parsed = await loadDesign(EXAMPLE_DESIGN);
    expect(parsed.title).toBe('Dépliant exemple');
    expect(parsed.page).toMatchObject({ w: 303, h: 216 });
    expect(parsed.sections.map((s) => [s.id, s.name, s.guides])).toEqual([
      ['exterieur', 'Extérieur', { bleed: 3, folds: [100, 200] }],
      ['interieur', 'Intérieur', { bleed: 3, folds: [103, 203] }],
    ]);
    expect(parsed.styles.join('\n')).toContain("font-family:'Open Sans'");
  });

  it('tire le nom du <title> (hors <doc-page>) ou du fichier', () => {
    expect(parseDesign(design('size="a4"', [{ id: 'p' }], 'Affiche &amp; rentrée')).title).toBe('Affiche & rentrée');
    const svgTitle = design('size="a4"', [{ id: 'p', body: '<svg><title>Logo</title></svg>' }]);
    expect(parseDesign(svgTitle).title).toBeNull();
    expect(nameFromFileName('C:\\designs\\Flyer_été.dc.html')).toBe('Flyer été');
  });
});

describe('choix du format', () => {
  it('le dépliant d’exemple retombe sur le pli roulé (plis 100/200 et 103/203), pas sur l’accordéon', async () => {
    const resolved = resolveFormat(await loadDesign(EXAMPLE_DESIGN));
    expect(resolved.origin).toBe('detected');
    expect(resolved.format.id).toBe('depliant-a4-pli-roule');
    expect(resolved.faces.map((f) => [f.sectionId, f.faceId])).toEqual([
      ['exterieur', 'exterieur'],
      ['interieur', 'interieur'],
    ]);
    expect(resolved.notes.join('\n')).toMatch(/accordéon.*écarté/);
  });

  it('reconnaît le flyer A5 et range les sections par identifiant, sinon dans l’ordre', async () => {
    const flyer = resolveFormat(await loadDesign(FLYER));
    expect(flyer.format.id).toBe('flyer-a5');
    expect(flyer.faces.map((f) => f.sectionId)).toEqual(['recto', 'verso']);

    const swapped = resolveFormat(parseDesign(design('width="154mm" height="216mm"', [{ id: 'Verso' }, { id: 'Recto' }])));
    expect(swapped.faces.map((f) => [f.faceId, f.sectionId])).toEqual([
      ['recto', 'Recto'],
      ['verso', 'Verso'],
    ]);
    const unnamed = resolveFormat(parseDesign(design('width="154mm" height="216mm"', [{ id: 'devant' }, { id: 'derriere' }])));
    expect(unnamed.format.id).toBe('flyer-a5');
    expect(unnamed.faces.map((f) => [f.faceId, f.sectionId])).toEqual([
      ['recto', 'devant'],
      ['verso', 'derriere'],
    ]);
  });

  it('gabarit imposé : accepté face par face, refusé clairement si les tailles ou le nombre de faces diffèrent', async () => {
    const flyer = await loadDesign(FLYER);
    const forced = resolveFormat(parseDesign(design('width="303mm" height="216mm"', [{ id: 'a' }, { id: 'b' }])), { templateId: 'depliant-a4-accordeon' });
    expect(forced.origin).toBe('template');
    expect(forced.faces.map((f) => [f.faceId, f.sectionId])).toEqual([
      ['exterieur', 'a'],
      ['interieur', 'b'],
    ]);
    expect(() => resolveFormat(flyer, { templateId: 'a4-recto-verso' })).toThrow(DesignImportError);
    expect(() => resolveFormat(flyer, { templateId: 'a4-recto-verso' })).toThrow(/216 × 303 mm fond perdu compris, celles du design 154 × 216 mm/);
    expect(() => resolveFormat(flyer, { templateId: 'inconnu' })).toThrow(/Gabarit inconnu : « inconnu ».*flyer-a5/);
    const single = parseDesign(design('width="154mm" height="216mm"', [{ id: 'recto' }]));
    expect(() => resolveFormat(single, { templateId: 'flyer-a5' })).toThrow(/a 2 faces \(Recto, Verso\), le design 1 page/);
    // Repères contraires au gabarit imposé : accepté, mais signalé.
    const guided = parseDesign(design('width="303mm" height="216mm"', [{ id: 'exterieur', body: guides(3, [100, 200]) }, { id: 'interieur', body: guides(3, [103, 203]) }]));
    const accordion = resolveFormat(guided, { templateId: 'depliant-a4-accordeon' });
    expect(accordion.warnings.join('\n')).toMatch(/plis du design 100, 200 mm, plis du gabarit 102, 201 mm/);
  });

  it('sur mesure : 3 mm de fond perdu autour d’un format connu, sinon 0 avec un avertissement', () => {
    const a4 = resolveFormat(parseDesign(design('width="216mm" height="303mm"', [{ id: 'une', label: '01 Couverture' }])));
    expect(a4.origin).toBe('custom');
    expect(a4.format).toMatchObject({ bleed: 3, trim: { w: 210, h: 297 }, name: 'A4 sur mesure 210 × 297 mm' });
    expect(a4.format.faces).toEqual([{ id: 'une', name: 'Couverture', panels: [{ name: 'Couverture', w: 210 }] }]);
    expect(a4.warnings).toEqual([]);

    const card = resolveFormat(parseDesign(design('width="91mm" height="61mm"', [{ id: 'recto' }])));
    expect(card.format).toMatchObject({ bleed: 3, trim: { w: 85, h: 55 }, safety: 3 });

    const square = resolveFormat(parseDesign(design('width="100mm" height="100mm"', [{ id: 'carre' }])));
    expect(square.format).toMatchObject({ id: 'sur-mesure-100x100', bleed: 0, trim: { w: 100, h: 100 } });
    expect(square.warnings.join('\n')).toMatch(/pas de fond perdu/);
  });

  it('sur mesure : fond perdu et volets lus dans les repères <sc-if>, une face par section', () => {
    const resolved = resolveFormat(
      parseDesign(
        design('width="216mm" height="106mm"', [
          { id: 'Extérieur', label: '01 Extérieur', body: guides(3, [73, 143]) },
          { id: 'Intérieur', label: '02 Intérieur', body: guides(3, [72, 142]) },
        ]),
      ),
    );
    expect(resolved.origin).toBe('custom');
    const { format } = resolved;
    expect(format).toMatchObject({ bleed: 3, trim: { w: 210, h: 100 } });
    expect(format.faces.map((f) => [f.id, f.name, f.panels.map((p) => p.w)])).toEqual([
      ['exterieur', 'Extérieur', [70, 70, 70]],
      ['interieur', 'Intérieur', [69, 70, 71]],
    ]);
    expect(foldPositions(format, 'exterieur')).toEqual([73, 143]);
    expect(foldPositions(format, 'interieur')).toEqual([72, 142]);
    // Des sections sans identifiant ni libellé ont quand même des faces distinctes.
    const anonymous = resolveFormat(parseDesign(design('width="100mm" height="100mm"', [{}, {}])));
    expect(anonymous.format.faces.map((f) => f.id)).toEqual(['page-1', 'page-2']);
    const twins = parseDesign(design('width="100mm" height="100mm"', [{ id: 'a' }, { id: 'a' }]));
    expect(twins.warnings.join('\n')).toContain("deux sections portent l'identifiant « a »");
    expect(resolveFormat(twins).faces.map((f) => [f.faceId, f.sectionIndex])).toEqual([
      ['a', 0],
      ['a-2', 1],
    ]);
  });
});

describe('import complet dans Chrome', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-import-formats-'));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const byName = (doc: LayoutDocument) => (name: string) => Object.values(doc.objects).find((o) => o.name === name);
  const textOf = (o: DocObject) => (o.type === 'text' ? o.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n') : '');
  /** Position mesurée par Chrome : au 1/64 de pixel près, soit quelques millièmes de mm. */
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} ≠ ${expected}`).toBeLessThan(0.01);

  it('flyer A5 : gabarit flyer-a5 reconnu, objets placés au bon endroit sur chaque face', async () => {
    const outcome = await runImport({ designFile: FLYER, documentsDir: dir });
    const { doc } = outcome;
    expect(validateDocument(JSON.parse(await readFile(outcome.documentFile, 'utf8'))).ok).toBe(true);
    expect(doc.id).toBe('flyer-a5-d-essai');
    expect(doc.name).toBe("Flyer A5 d'essai");
    expect(doc.format.id).toBe('flyer-a5');
    expect(doc.pages.map((p) => [p.id, p.faceId, p.name])).toEqual([
      ['p-recto', 'recto', 'Recto'],
      ['p-verso', 'verso', 'Verso'],
    ]);
    const onPage = (pageId: string) => doc.pages.find((p) => p.id === pageId)!.children.map((id) => doc.objects[id]);
    const recto = onPage('p-recto');
    const verso = onPage('p-verso');

    // Aplat pleine largeur en haut du recto : calque Fonds.
    const band = recto.find((o): o is RectObject => o.type === 'rect' && o.layerId === 'fonds')!;
    expect(band.name).toBe('Aplat · Recto (haut)');
    near(band.x, 0);
    near(band.y, 0);
    near(band.w, 154);
    near(band.h, 60);
    expect(doc.swatches.find((s) => s.id === band.fill?.swatch)?.rgb).toBe('#2f5f9e');

    const title = recto.find((o): o is TextObject => o.type === 'text' && textOf(o) === 'Atelier numérique')!;
    near(title.x, 13);
    near(title.y, 20);
    expect(title.style).toMatchObject({ fontFamily: 'Open Sans', fontSize: 20, fontWeight: 800 });
    expect(doc.swatches.find((s) => s.id === title.style.color.swatch)?.rgb).toBe('#ffffff');
    const body = recto.find((o): o is TextObject => o.type === 'text' && textOf(o).startsWith('Un texte de présentation'))!;
    near(body.x, 13);
    near(body.y, 80);
    expect(body.lines).toBeGreaterThanOrEqual(2);

    const icon = recto.find((o): o is IconObject => o.type === 'icon')!;
    expect(icon.iconName).toBe('arrow-right');
    near(icon.x, 13);
    near(icon.y, 150);
    near(icon.w, 8);
    near(icon.h, 8);

    const card = verso.find((o): o is RectObject => o.type === 'rect' && o.layerId === 'contenu')!;
    near(card.x, 20);
    near(card.y, 30);
    near(card.w, 50);
    near(card.h, 20);
    expect(card.radius).toBeCloseTo(2, 3);
    const signature = verso.find((o): o is TextObject => o.type === 'text')!;
    expect(textOf(signature)).toBe('Inscriptions : example.com');
    near(signature.x, 20);
    near(signature.y, 100);

    // Repères tirés du gabarit : trait de coupe à 3 mm, aucun pli.
    for (const page of doc.pages) {
      const marks = page.children.map((id) => doc.objects[id]).filter((o) => o.layerId === 'reperes');
      expect(marks.map((o) => [o.type, o.x, o.y, o.w, o.h])).toEqual([['rect', 3, 3, 148, 210]]);
    }
    expect(outcome.result.unknownIcons).toEqual([]);
    expect(outcome.result.warnings.filter((w) => w.faceId === 'document')).toEqual([]);
    const report = await readFile(outcome.reportFile, 'utf8');
    expect(report).toContain('## Format');
    expect(report).toContain('gabarit reconnu');
    // Un second import du même design ne remplace rien : il reçoit un identifiant libre.
    const again = await runImport({ designFile: FLYER, documentsDir: dir });
    expect(again.doc.id).toBe('flyer-a5-d-essai-2');
  }, 120_000);

  it('design sur mesure sans repères (100 × 100 mm) : fond perdu 0 et avertissement dans le rapport', async () => {
    const outcome = await runImport({ designFile: CUSTOM, documentsDir: dir });
    const { doc } = outcome;
    expect(doc.id).toBe('sur-mesure-100');
    expect(doc.format).toMatchObject({ id: 'sur-mesure-100x100', bleed: 0, trim: { w: 100, h: 100 } });
    expect(doc.format.faces).toEqual([{ id: 'carre', name: 'Carré', panels: [{ name: 'Carré', w: 100 }] }]);
    expect(doc.pages.map((p) => [p.id, p.name])).toEqual([['p-carre', 'Carré']]);
    expect(outcome.result.warnings.some((w) => w.faceId === 'document' && /pas de fond perdu/.test(w.why))).toBe(true);
    expect(await readFile(outcome.reportFile, 'utf8')).toContain('pas de fond perdu');
    const rect = Object.values(doc.objects).find((o): o is RectObject => o.type === 'rect' && o.layerId === 'contenu')!;
    near(rect.x, 10);
    near(rect.y, 10);
    expect(byName(doc)('Trait de coupe')).toMatchObject({ x: 0, y: 0, w: 100, h: 100 });
    // Fond donné à la section elle-même : un aplat de toute la face, sous les objets, sur le calque Fonds.
    const background = byName(doc)('Fond de page') as RectObject;
    expect(background).toMatchObject({ type: 'rect', layerId: 'fonds', x: 0, y: 0, w: 100, h: 100 });
    expect(doc.pages[0].children[0]).toBe(background.id);
    expect(doc.swatches.find((s) => s.id === background.fill?.swatch)?.rgb).toBe('#f5f1e8');
  }, 120_000);

  it('design avec repères <sc-if> (retrait 3 mm, deux plis) : fond perdu et volets lus, repères non importés tels quels', async () => {
    const outcome = await runImport({ designFile: GUIDED, documentsDir: dir, name: 'Mon dépliant' });
    const { doc } = outcome;
    expect(doc.id).toBe('mon-depliant');
    expect(doc.name).toBe('Mon dépliant');
    expect(doc.format).toMatchObject({ bleed: 3, trim: { w: 210, h: 100 } });
    expect(doc.format.faces.map((f) => f.panels.map((p) => p.w))).toEqual([
      [70, 70, 70],
      [69, 70, 71],
    ]);
    for (const page of doc.pages) {
      const objs = page.children.map((id) => doc.objects[id]);
      // Les traits roses du design ne deviennent pas des objets : seuls les repères tirés du format restent.
      expect(objs.filter((o) => o.layerId !== 'reperes').every((o) => o.type === 'text')).toBe(true);
      const folds = objs.filter((o) => o.type === 'line').map((o) => o.x);
      expect(folds).toEqual(foldPositions(doc.format, page.faceId));
      expect(objs.find((o) => o.type === 'rect')).toMatchObject({ x: 3, y: 3, w: 210, h: 100 });
    }
  }, 120_000);

  it('ligne de commande : --template refusé avec un message clair, --name donne nom et identifiant', () => {
    const tsx = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cli = (...args: string[]) => spawnSync(process.execPath, [tsx, 'scripts/import-claude-design.ts', '--documents', dir, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    const refused = cli('--design', FLYER, '--template', 'affiche-a3');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Le gabarit « Affiche A3 » (affiche-a3) ne correspond pas au design');
    expect(refused.stderr).not.toContain('    at ');

    const named = cli('--design', FLYER, '--name', 'Flyer de la rentrée', '--template', 'flyer-a5');
    expect(named.status, named.stderr).toBe(0);
    expect(named.stdout).toContain('Gabarit imposé : Flyer A5 recto verso');
    expect(named.stdout).toContain('Flyer de la rentrée (flyer-de-la-rentree)');
    // Comme la route d'import : le design reçu est copié dans le dossier du document, qui en fait sa source.
    const copy = path.join(dir, 'flyer-de-la-rentree', 'design.dc.html');
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(FLYER, 'utf8'));
    const saved = JSON.parse(readFileSync(path.join(dir, 'flyer-de-la-rentree', 'document.json'), 'utf8')) as LayoutDocument;
    expect(saved.source?.path).toBe(copy.split(path.sep).join('/'));
  }, 120_000);
});
