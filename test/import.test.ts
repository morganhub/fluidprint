// Import du design Claude Design (tâches 1.7, 1.8, 1.10, 1.12, 1.13, 1.15), dans un dossier jetable : le
// dépliant d'exemple (test/fixtures/designs/depliant-exemple.dc.html, organisation fictive).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkImportTarget, ImportRefusedError, runImport, type ImportOutcome } from '../scripts/import/importer';
import { validateDocument } from '../src/model/validate';
import type { DocObject, FrameObject, GroupObject, IconObject, LayoutDocument, QrObject, SvgObject, TextObject } from '../src/model/types';
import { PROJECT_ROOT } from '../server/paths';
import { EXAMPLE_DESIGN, EXAMPLE_FILE, EXAMPLE_ID } from './helpers/editor';

let dir: string;
let outcome: ImportOutcome;
let doc: LayoutDocument;
const objects = () => Object.values(doc.objects) as DocObject[];
const ofType = <T extends DocObject>(type: T['type']) => objects().filter((o): o is T => o.type === type);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-import-'));
  outcome = await runImport({ designFile: EXAMPLE_DESIGN, documentsDir: dir });
  doc = outcome.doc;
}, 120_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("import du dépliant d'exemple", () => {
  it('écrit un document valide de 2 pages, nommé d’après le <title> du design', async () => {
    const file = path.join(dir, EXAMPLE_ID, 'document.json');
    expect(outcome.documentFile).toBe(file);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    const result = validateDocument(onDisk);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors.slice(0, 5))).toBe(true);
    expect(doc.id).toBe(EXAMPLE_ID);
    expect(doc.name).toBe('Dépliant exemple');
    expect(doc.version).toBe(2);
    expect(doc.source).toMatchObject({ kind: 'claude-design', path: 'test/fixtures/designs/depliant-exemple.dc.html' });
    expect(doc.pages.map((p) => [p.id, p.faceId])).toEqual([
      ['p-exterieur', 'exterieur'],
      ['p-interieur', 'interieur'],
    ]);
    expect(doc.editedAt).toBeUndefined();
    expect(doc.assets).toEqual([]);
  });

  it('retombe sur le gabarit depliant-a4-pli-roule : mêmes pages et mêmes objets que le dépliant d’exemple figé', async () => {
    // Le dépliant figé des tests d'interaction est cet import, complété depuis (styles, nuancier, photos
    // provisoires) sans qu'aucun objet n'ait été ajouté, retiré ou déplacé d'une page à l'autre.
    const fixture = JSON.parse(await readFile(EXAMPLE_FILE, 'utf8')) as LayoutDocument;
    expect(outcome.result.format.origin).toBe('detected');
    expect(doc.format.id).toBe('depliant-a4-pli-roule');
    expect(doc.format).toEqual(fixture.format);
    const pages = (d: LayoutDocument) => d.pages.map(({ id, faceId, name, children }) => ({ id, faceId, name, children }));
    expect(pages(doc)).toEqual(pages(fixture));
    const types = (d: LayoutDocument) => Object.fromEntries(Object.entries(d.objects).map(([id, o]) => [id, o.type]));
    expect(Object.keys(doc.objects)).toHaveLength(Object.keys(fixture.objects).length);
    expect(types(doc)).toEqual(types(fixture));
  });

  it('crée environ 370 objets', () => {
    const count = objects().length;
    expect(count).toBeGreaterThanOrEqual(320);
    expect(count).toBeLessThanOrEqual(420);
  });

  it('reconnaît les 5 zones image, dont 4 découpes (1 goutte, 3 vagues), sans photo', () => {
    const frames = ofType<FrameObject>('frame');
    expect(frames).toHaveLength(5);
    const cut = frames.filter((f) => f.shape.kind === 'path');
    expect(cut).toHaveLength(4);
    const presets = cut.map((f) => (f.shape.kind === 'path' ? f.shape.preset : undefined)).sort();
    expect(presets).toEqual(['goutte', 'vague', 'vague', 'vague']);
    const drop = cut.find((f) => f.shape.kind === 'path' && f.shape.preset === 'goutte')!;
    expect(doc.swatches.find((s) => s.id === drop.fill?.swatch)?.rgb).toBe('#ffffff');
    for (const f of frames) {
      expect(f.image).toBeUndefined();
      expect(f.placeholder).toBeTruthy();
    }
  });

  it('groupe chaque bandeau photo : cadre vague + trait de vague non déformable', () => {
    const bandeaux = ofType<GroupObject>('group').filter((g) => g.name?.startsWith('Bandeau · '));
    expect(bandeaux.map((g) => g.name).sort()).toEqual(['Bandeau · Intérieur centre', 'Bandeau · Intérieur droit', 'Bandeau · Intérieur gauche']);
    for (const g of bandeaux) {
      const kids = g.children.map((id) => doc.objects[id]);
      expect(kids.map((k) => k.type)).toEqual(['frame', 'path']);
      const wave = kids[1];
      expect(wave.type === 'path' && wave.nonScalingStroke).toBe(true);
      expect(wave.type === 'path' && wave.stroke?.width).toBeCloseTo(2.25, 4);
    }
  });

  it('décode les 6 QR codes', () => {
    const qrs = ofType<QrObject>('qr');
    expect(qrs).toHaveLength(6);
    for (const q of qrs) {
      expect(q.url).toMatch(/^https:\/\/example\.com\/\S+$/);
      expect(q).toMatchObject({ ecc: 'M', margin: 4 });
    }
    expect(outcome.result.qrCodes.every((q) => q.decoded)).toBe(true);
    expect(new Set(qrs.map((q) => q.url)).size).toBe(6);
  });

  it('nomme chaque groupe d’après son type et son texte principal ; le logo marqué comme tel nomme son bloc', () => {
    const groups = ofType<GroupObject>('group');
    expect(groups.length).toBeGreaterThan(20);
    for (const g of groups) {
      expect(g.name).toMatch(/^[\p{L}'’ ]+ · \S.{1,48}$/u);
      expect(g.name).not.toMatch(/undefined|null|#\d/);
      expect(g.children.length).toBeGreaterThanOrEqual(2);
    }
    const names = groups.map((g) => g.name);
    expect(names).toContain('Carte · Pains, brioches et pâtes levées faites maison');
    expect(names).toContain('Étape · Choisissez');
    expect(names.some((n) => n?.startsWith("Appel à l'action · "))).toBe(true);
    // Logo reconnu par son aria-label (« Logo Atelier Horizon »), sans rien savoir de son dessin : bloc
    // « Logo », et le bloc logo + lignes de contact devient « Coordonnées ».
    expect(names.filter((n) => n === 'Logo · Atelier Horizon')).toHaveLength(2);
    expect(names).toContain('Coordonnées · example.com');
    const svgs = ofType<SvgObject>('svg');
    expect(svgs.filter((s) => s.name === 'Logo Atelier Horizon')).toHaveLength(2);
    // Le même soleil sans aria-label (appels à l'action) n'est qu'un graphique.
    expect(svgs.filter((s) => s.name === 'Graphique')).toHaveLength(3);
  });

  it('reconnaît toutes les icônes Lucide par lucide-static seul (nom usuel d’un alias)', () => {
    expect(outcome.result.unknownIcons).toEqual([]);
    const icons = ofType<IconObject>('icon');
    expect(icons.length).toBeGreaterThan(50);
    expect(icons.every((i) => i.iconName !== 'inconnue')).toBe(true);
    // « clock » et « clock-4 » ont le même dessin : c'est le nom usuel qui l'emporte.
    expect(icons.filter((i) => i.iconName === 'clock')).toHaveLength(2);
    expect(icons.some((i) => i.iconName === 'clock-4')).toBe(false);
  });

  it('range les objets en calques Fonds (verrouillé), Contenu, Repères (non imprimable)', () => {
    expect(doc.layers.map((l) => l.id)).toEqual(['fonds', 'contenu', 'reperes']);
    const [fonds, contenu, reperes] = doc.layers;
    expect(fonds).toMatchObject({ name: 'Fonds', locked: true, printable: true });
    expect(contenu).toMatchObject({ name: 'Contenu', locked: false, printable: true });
    expect(reperes).toMatchObject({ name: 'Repères et notes', printable: false });

    // Fond sombre de la couverture et bandeaux de couleur du bas des volets.
    const background = objects().filter((o) => o.layerId === 'fonds');
    expect(background.length).toBeGreaterThanOrEqual(5);
    expect(background.every((o) => o.type === 'rect' && o.w >= 99)).toBe(true);

    for (const page of doc.pages) {
      const guides = page.children.map((id) => doc.objects[id]).filter((o) => o.layerId === 'reperes');
      expect(guides.filter((o) => o.type === 'rect')).toHaveLength(1);
      expect(guides.filter((o) => o.type === 'line')).toHaveLength(2);
      expect(guides.find((o) => o.type === 'rect')).toMatchObject({ x: 3, y: 3, w: 297, h: 210 });
    }
  });

  it('mesure le nombre de lignes de chaque texte et garde les retours forcés', () => {
    const texts = ofType<TextObject>('text');
    expect(texts.length).toBeGreaterThan(100);
    for (const t of texts) expect(t.lines).toBeGreaterThanOrEqual(1);
    const title = texts.find((t) => t.paragraphs[0].runs[0].text.startsWith('Créer de vos mains,'))!;
    expect(title.paragraphs[0].runs.map((r) => r.text).join('')).toBe('Créer de vos mains,\npas à pas, avec nous.');
    expect(title.lines).toBe(2);
    expect(title.style).toMatchObject({ fontSize: 17, fontWeight: 800, lineHeight: 1.15, letterSpacing: -0.01 });
  });

  it('nomme les nuances par rôle (texte principal, titres, QR, repères), sinon par teinte, jamais d’après le design', () => {
    const byRgb = new Map(doc.swatches.map((s) => [s.rgb, s]));
    // Texte principal : la couleur qui porte le plus de caractères ; titres : celle des corps de 12 pt et plus.
    expect(byRgb.get('#46474c')).toMatchObject({ id: 'texte-principal', name: 'Texte principal' });
    expect(byRgb.get('#1f3a30')).toMatchObject({ id: 'titres', name: 'Titres' });
    expect(byRgb.get('#1a1a1a')).toMatchObject({ id: 'noir-qr', name: 'Noir QR' });
    expect(byRgb.get('#e0245e')).toMatchObject({ id: 'reperes-coupe-et-plis', name: 'Repères coupe et plis' });
    // Par teinte et clarté : une teinte pâle reste une couleur, un gris chaud reste un gris.
    expect(byRgb.get('#2d7a55')).toMatchObject({ id: 'vert', name: 'Vert' });
    expect(byRgb.get('#edf4ef')).toMatchObject({ id: 'vert-tres-clair', name: 'Vert très clair' });
    expect(byRgb.get('#8a5a2b')).toMatchObject({ id: 'brun', name: 'Brun' });
    expect(byRgb.get('#2a2724')).toMatchObject({ id: 'gris-tres-fonce', name: 'Gris très foncé' });
    expect(byRgb.get('#f2b77a')).toMatchObject({ id: 'orange-vif', name: 'Orange vif' });
    // Texte principal et titres en tête du nuancier.
    expect(doc.swatches.slice(0, 2).map((s) => s.id)).toEqual(['texte-principal', 'titres']);
    const family = /^(Texte principal|Titres|Noir QR|Repères coupe et plis|Blanc|Noir|(Gris|Rouge|Orange|Brun|Jaune|Vert|Sarcelle|Bleu|Violet|Rose)( très clair| clair| très foncé| foncé)?( vif)?)( \d+)?$/;
    for (const s of doc.swatches) {
      expect(s.name, s.rgb).toMatch(family);
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(new Set(doc.swatches.map((s) => s.name)).size).toBe(doc.swatches.length);
  });

  it('écrit un rapport avec les 6 adresses des QR codes', async () => {
    const report = await readFile(outcome.reportFile, 'utf8');
    for (const q of ofType<QrObject>('qr')) expect(report).toContain(q.url);
    expect(report).toContain('## Éléments ignorés');
    expect(report).toContain('## Nuances');
    // Les contacts du design sont en white-space: nowrap : signalé, la boîte garde sa largeur mesurée.
    expect(outcome.result.warnings.filter((w) => /nowrap/.test(w.why))).toHaveLength(6);
    // Les aplats blancs posés sur le papier blanc (faces et volets) n'impriment rien : écartés, et dits.
    expect(outcome.result.skipped.filter((s) => /^aplat #ffffff/.test(s.what) && /même couleur que le fond/.test(s.why))).toHaveLength(4);
  });
});

describe("garde-fou de l'import (1.8)", () => {
  it('refuse un second import sous le même identifiant sans --replace, en nommant le fichier', async () => {
    const file = path.join(dir, EXAMPLE_ID, 'document.json');
    await expect(runImport({ designFile: EXAMPLE_DESIGN, documentsDir: dir, id: EXAMPLE_ID })).rejects.toThrow(ImportRefusedError);
    await expect(checkImportTarget(dir, EXAMPLE_ID, false)).rejects.toThrow(file);
  });

  it('la ligne de commande échoue elle aussi et propose un autre --id ; sans --design, elle refuse', () => {
    const tsx = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cli = (...args: string[]) => spawnSync(process.execPath, [tsx, 'scripts/import-claude-design.ts', '--documents', dir, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    const run = cli('--design', EXAMPLE_DESIGN, '--id', EXAMPLE_ID);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path.join(dir, EXAMPLE_ID, 'document.json'));
    expect(run.stderr).toContain('--id');
    // Il n'y a plus de design par défaut : --design est obligatoire.
    const missing = cli();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('Option --design manquante');
  });

  it('refuse --replace sur un document retouché dans l’éditeur', async () => {
    const file = path.join(dir, EXAMPLE_ID, 'document.json');
    const saved = await readFile(file, 'utf8');
    await writeFile(file, JSON.stringify({ ...JSON.parse(saved), editedAt: '2026-09-25T17:00:00.000Z' }));
    try {
      await expect(runImport({ designFile: EXAMPLE_DESIGN, documentsDir: dir, id: EXAMPLE_ID, replace: true })).rejects.toThrow(file);
      expect(JSON.parse(await readFile(file, 'utf8')).editedAt).toBe('2026-09-25T17:00:00.000Z');
    } finally {
      await writeFile(file, saved);
    }
  });

  it('accepte --replace sur un document jamais retouché', async () => {
    const again = await runImport({ designFile: EXAMPLE_DESIGN, documentsDir: dir, id: EXAMPLE_ID, replace: true });
    expect(again.doc.source?.importedAt).not.toBe(doc.source?.importedAt);
    expect(Object.keys(again.doc.objects).length).toBe(Object.keys(doc.objects).length);
    expect(existsSync(again.reportFile)).toBe(true);
  }, 120_000);
});
