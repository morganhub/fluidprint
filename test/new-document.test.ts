// Création d'un document vierge d'après un gabarit, et duplication d'un document (page d'accueil) :
// modèle (src/model/newDocument.ts) et routes (server/templates.ts), sur des dossiers temporaires.
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { foldModel } from '../src/editor/FoldPreview';
import { defaultColor } from '../src/editor/tools/defaults';
import { faceSize, foldPositions } from '../src/model/format';
import { copyDocument, createBlankDocument, docIdFromName, duplicateName, STARTER_SWATCHES, type TemplateSummary } from '../src/model/newDocument';
import { runPreflight } from '../src/model/preflight';
import { TEMPLATES } from '../src/model/templates';
import type { LayoutDocument } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { cmykToRgb } from '../server/color';
import { registerApiRoutes } from '../server/routes';
import { withTempDocuments } from './helpers/browser';

describe('document vierge (modèle)', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s : valide, une page par face, trois calques, nuancier CMJN, aucun objet', (_id, template) => {
    const before = Date.now();
    const doc = createBlankDocument({ id: 'essai', name: 'Essai', format: template });
    const result = validateDocument(doc);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(doc.format).toEqual(template);
    expect(doc.format).not.toBe(template);
    expect(doc.pages.map((p) => p.faceId)).toEqual(template.faces.map((f) => f.id));
    expect(doc.pages.map((p) => p.name)).toEqual(template.faces.map((f) => f.name));
    expect(new Set(doc.pages.map((p) => p.id)).size).toBe(doc.pages.length);
    expect(doc.pages.every((p) => p.children.length === 0)).toBe(true);
    expect(doc.layers.map((l) => [l.name, l.printable, l.locked, l.visible])).toEqual([
      ['Fonds', true, false, true],
      ['Contenu', true, false, true],
      ['Repères et notes', false, false, true],
    ]);
    expect(doc.swatches.map((s) => s.name)).toEqual(['Blanc', 'Noir 100 %', 'Texte courant', 'Bleu', 'Marine']);
    expect(doc.swatches.map((s) => s.cmyk)).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 100],
      [0, 0, 0, 80],
      [100, 60, 0, 0],
      [100, 80, 25, 35],
    ]);
    expect(new Set(doc.swatches.map((s) => s.rgb)).size).toBe(doc.swatches.length);
    expect(doc.objects).toEqual({});
    expect(doc.styles).toEqual({ paragraph: [], character: [] });
    expect(doc.assets).toEqual([]);
    expect(doc.editedAt).toBeUndefined();
    expect(Date.parse(doc.createdAt)).toBeGreaterThanOrEqual(before - 1);
    // Rien à signaler au contrôle en amont d'un document vide.
    expect(runPreflight(doc).issues).toEqual([]);
    // Les objets créés par la barre d'outils prennent les nuances de départ, sans en ajouter.
    expect(defaultColor(doc, 'text')).toEqual({ swatch: 'texte-courant' });
    expect(defaultColor(doc, 'fill')).toEqual({ swatch: 'bleu' });
    expect(defaultColor(doc, 'dark')).toEqual({ swatch: 'noir' });
    expect(defaultColor(doc, 'white')).toEqual({ swatch: 'blanc' });
    expect(doc.swatches).toHaveLength(5);
  });

  it('chaque document a son propre nuancier et ses propres calques (aucun partage avec les constantes)', () => {
    const a = createBlankDocument({ id: 'a', name: 'A', format: TEMPLATES[0] });
    const b = createBlankDocument({ id: 'b', name: 'B', format: TEMPLATES[0], createdAt: '2026-01-01T00:00:00.000Z' });
    a.swatches[0].cmyk![3] = 50;
    a.layers[0].locked = true;
    a.format.faces[0].panels[0].w = 1;
    expect(b.swatches[0].cmyk).toEqual([0, 0, 0, 0]);
    expect(STARTER_SWATCHES[0].cmyk).toEqual([0, 0, 0, 0]);
    expect(b.layers[0].locked).toBe(false);
    expect(TEMPLATES[0].faces[0].panels[0].w).toBe(97);
    expect(b.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuse un gabarit incohérent (volets ≠ format fini)', () => {
    const broken = structuredClone(TEMPLATES[0]);
    broken.faces[0].panels[0].w = 90;
    expect(() => createBlankDocument({ id: 'x', name: 'X', format: broken })).toThrow(/incohérent/);
  });

  it('les RVB du nuancier de départ sont la simulation FOGRA39 de ses encres (server/color.ts)', async () => {
    const displays = await cmykToRgb(STARTER_SWATCHES.map((s) => s.cmyk));
    expect(STARTER_SWATCHES.map((s) => s.rgb)).toEqual(displays);
  });

  it('identifiant tiré du nom : minuscules, sans accents, tirets ; noms réservés de Windows évités', () => {
    expect(docIdFromName('Flyer rentrée 2026')).toBe('flyer-rentree-2026');
    expect(docIdFromName('  Œuvre à l’été : « Portes ouvertes » !  ')).toBe('oeuvre-a-l-ete-portes-ouvertes');
    expect(docIdFromName('Copie de Dépliant exemple')).toBe('copie-de-depliant-exemple');
    expect(docIdFromName('???')).toBe('document');
    expect(docIdFromName('')).toBe('document');
    expect(docIdFromName('CON')).toBe('document-con');
    expect(docIdFromName('Lpt1')).toBe('document-lpt1');
    const long = docIdFromName('Un nom de document vraiment très long, bien plus long que ce que permet un dossier raisonnable');
    expect(long.length).toBeLessThanOrEqual(56);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('copie d’un document : nouvel identifiant et nom, créée maintenant, sans editedAt, sans lien avec l’original', () => {
    const source = createBlankDocument({ id: 'source', name: 'Source', format: TEMPLATES[3], createdAt: '2026-01-01T00:00:00.000Z' });
    source.editedAt = '2026-02-01T00:00:00.000Z';
    const copy = copyDocument(source, { id: 'copie', name: duplicateName(source.name) });
    expect(copy).toMatchObject({ id: 'copie', name: 'Copie de Source' });
    expect(copy.editedAt).toBeUndefined();
    expect(copy.createdAt).not.toBe(source.createdAt);
    copy.swatches[0].name = 'Autre';
    expect(source.swatches[0].name).toBe('Blanc');
    expect(source.editedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(validateDocument(copy).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- routes

interface Api {
  dir: string;
  request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
}

// Routes seules (Fastify + inject), sans Vite ni Chrome : rapide, et toujours sur un dossier jetable.
function withApi<T>(fn: (api: Api) => Promise<T>): Promise<T> {
  return withTempDocuments(async (dir) => {
    const app = Fastify();
    await registerApiRoutes(app, { documentsDir: dir });
    try {
      return await fn({
        dir,
        async request(method, url, payload) {
          const res = await app.inject({ method, url, payload: payload as object | undefined });
          const json = String(res.headers['content-type'] ?? '').includes('application/json');
          return { status: res.statusCode, body: json ? JSON.parse(res.body) : res.body, headers: res.headers };
        },
      });
    } finally {
      await app.close();
    }
  });
}

const readDoc = async (dir: string, id: string): Promise<LayoutDocument> => JSON.parse(await readFile(path.join(dir, id, 'document.json'), 'utf8'));

describe('GET /api/templates', () => {
  it('liste les six gabarits : id, nom, description, faces et volets, format fini, fond perdu', async () => {
    await withApi(async ({ request }) => {
      const res = await request('GET', '/api/templates');
      expect(res.status).toBe(200);
      const list = res.body as TemplateSummary[];
      expect(list.map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
      const flyer = list.find((t) => t.id === 'flyer-a5')!;
      expect(flyer).toEqual({
        id: 'flyer-a5',
        name: 'Flyer A5 recto verso',
        description: '148 × 210 mm · 2 faces · fond perdu 3 mm',
        faces: [
          { id: 'recto', name: 'Recto', panels: [{ name: 'Recto', w: 148 }] },
          { id: 'verso', name: 'Verso', panels: [{ name: 'Verso', w: 148 }] },
        ],
        trim: { w: 148, h: 210 },
        bleed: 3,
      });
      expect(list.find((t) => t.id === 'depliant-a4-pli-roule')!.description).toBe('297 × 210 mm · 2 faces · 3 volets · fond perdu 3 mm');
    });
  });
});

describe('POST /api/doc', () => {
  it('crée un document vierge : 201 { id } tiré du nom, rendu unique par -2, -3 ; lisible et ouvrable', async () => {
    await withApi(async ({ dir, request }) => {
      const res = await request('POST', '/api/doc', { name: '  Flyer   rentrée ', templateId: 'flyer-a5' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: 'flyer-rentree' });
      expect(res.headers.location).toBe('/api/doc/flyer-rentree');
      const doc = await readDoc(dir, 'flyer-rentree');
      expect(validateDocument(doc).ok).toBe(true);
      expect(doc).toMatchObject({ id: 'flyer-rentree', name: 'Flyer rentrée', format: { id: 'flyer-a5' } });
      expect(doc.pages.map((p) => p.id)).toEqual(['p-recto', 'p-verso']);
      expect(doc.editedAt).toBeUndefined();
      // RVB d'affichage recalculé par le profil de référence (FOGRA39) : identique au nuancier de départ.
      expect(doc.swatches.map((s) => s.rgb)).toEqual(STARTER_SWATCHES.map((s) => s.rgb));

      expect((await request('POST', '/api/doc', { name: 'Flyer rentrée', templateId: 'flyer-a5' })).body).toEqual({ id: 'flyer-rentree-2' });
      expect((await request('POST', '/api/doc', { name: 'FLYER RENTRÉE', templateId: 'affiche-a3' })).body).toEqual({ id: 'flyer-rentree-3' });
      expect((await readDoc(dir, 'flyer-rentree')).format.id).toBe('flyer-a5');
      expect((await readDoc(dir, 'flyer-rentree-3')).format.id).toBe('affiche-a3');

      // Ouverture par l'éditeur (copie d'historique) et liste de la page d'accueil.
      const opened = await request('GET', '/api/doc/flyer-rentree?open=1');
      expect(opened.status).toBe(200);
      expect(opened.headers['x-doc-revision']).toMatch(/^[0-9a-f]{16}$/);
      const list = (await request('GET', '/api/doc')).body as { id: string; name: string }[];
      expect(list.map((d) => d.id).sort()).toEqual(['flyer-rentree', 'flyer-rentree-2', 'flyer-rentree-3']);
    });
  });

  it('créations simultanées du même nom : un identifiant chacune, aucun document écrasé', async () => {
    await withApi(async ({ dir, request }) => {
      const results = await Promise.all(
        TEMPLATES.map((t) => request('POST', '/api/doc', { name: 'Même nom', templateId: t.id })),
      );
      expect(results.map((r) => r.status)).toEqual(TEMPLATES.map(() => 201));
      const ids = results.map((r) => r.body.id as string);
      expect(new Set(ids).size).toBe(TEMPLATES.length);
      expect(ids.sort()).toEqual(['meme-nom', ...TEMPLATES.slice(1).map((_, i) => `meme-nom-${i + 2}`)].sort());
      const formats = await Promise.all(ids.map(async (id) => (await readDoc(dir, id)).format.id));
      expect(formats.sort()).toEqual(TEMPLATES.map((t) => t.id).sort());
    });
  });

  it('identifiant imposé : utilisé tel quel, 409 s’il est pris, 400 s’il est invalide', async () => {
    await withApi(async ({ dir, request }) => {
      const res = await request('POST', '/api/doc', { name: 'Carte Morgan', templateId: 'carte-de-visite', id: 'carte-2026' });
      expect(res).toMatchObject({ status: 201, body: { id: 'carte-2026' } });
      const taken = await request('POST', '/api/doc', { name: 'Autre', templateId: 'carte-de-visite', id: 'carte-2026' });
      expect(taken.status).toBe(409);
      expect(taken.body.error).toMatch(/existe déjà/);
      expect((await readDoc(dir, 'carte-2026')).name).toBe('Carte Morgan');
      for (const id of ['../evil', 'Majuscules', '-tiret', 'a/b', 42]) {
        const bad = await request('POST', '/api/doc', { name: 'Essai', templateId: 'flyer-a5', id });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/Identifiant de document invalide/);
      }
      expect((await readdir(dir)).sort()).toEqual(['carte-2026']);
      expect(existsSync(path.join(dir, '..', 'evil'))).toBe(false);
    });
  });

  it('400 si le gabarit est inconnu ou absent, ou le nom vide ; rien n’est créé', async () => {
    await withApi(async ({ dir, request }) => {
      const unknown = await request('POST', '/api/doc', { name: 'Essai', templateId: 'a0-geant' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe('Gabarit inconnu : a0-geant');
      expect((await request('POST', '/api/doc', { name: 'Essai' })).status).toBe(400);
      const blank = await request('POST', '/api/doc', { name: '   ', templateId: 'flyer-a5' });
      expect(blank.status).toBe(400);
      expect(blank.body.error).toBe('Nom du document manquant');
      expect((await request('POST', '/api/doc', { templateId: 'flyer-a5' })).status).toBe(400);
      expect((await request('POST', '/api/doc', { name: 'x'.repeat(121), templateId: 'flyer-a5' })).status).toBe(400);
      expect((await request('POST', '/api/doc')).status).toBe(400);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});

describe('POST /api/doc/:id/duplicate', () => {
  /** Document source avec une photo (original, aperçu, copie d'impression), historique, versions, exports, épreuves. */
  async function seedSource(api: Api): Promise<{ id: string; files: Record<string, Buffer> }> {
    const { dir, request } = api;
    const { body } = await request('POST', '/api/doc', { name: 'Dépliant salon', templateId: 'depliant-a4-pli-roule' });
    const id = body.id as string;
    const files: Record<string, Buffer> = {
      'assets/originals/photo.tif': Buffer.from('original TIFF (octets quelconques)'),
      'assets/previews/photo.webp': Buffer.from('aperçu'),
      'assets/print/photo.png': Buffer.from('copie d’impression'),
    };
    for (const [rel, data] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, id, rel)), { recursive: true });
      await writeFile(path.join(dir, id, rel), data);
    }
    await mkdir(path.join(dir, id, 'assets', 'proof', 'FOGRA39-perceptual-300'), { recursive: true });
    await writeFile(path.join(dir, id, 'assets', 'proof', 'FOGRA39-perceptual-300', 'previews__photo.webp.webp'), 'épreuve');
    await writeFile(path.join(dir, id, 'assets', 'originals', `photo.tif.${process.pid}-0123abcd.tmp`), 'écriture interrompue');
    await mkdir(path.join(dir, id, 'exports'), { recursive: true });
    await writeFile(path.join(dir, id, 'exports', '2026-09-26-1200-rvb.pdf'), '%PDF-');

    const doc = await readDoc(dir, id);
    doc.assets.push({ id: 'img-1', kind: 'image', name: 'photo.tif', original: 'assets/originals/photo.tif', preview: 'assets/previews/photo.webp', print: 'assets/print/photo.png', width: 1200, height: 800 });
    doc.objects.f1 = { id: 'f1', type: 'frame', layerId: 'contenu', x: 10, y: 10, w: 60, h: 40, shape: { kind: 'rect' }, image: { assetId: 'img-1', fit: 'fill', x: 0, y: 0, w: 60, h: 40 } };
    doc.objects.t1 = {
      id: 't1',
      type: 'text',
      layerId: 'contenu',
      x: 10,
      y: 60,
      w: 60,
      h: 10,
      style: { fontFamily: 'Open Sans', fontWeight: 400, fontSize: 9, lineHeight: 1.4, letterSpacing: 0, color: { swatch: 'texte-courant' }, align: 'left', transform: 'none' },
      paragraphs: [{ runs: [{ text: 'Bienvenue au salon' }] }],
    };
    doc.pages[0].children.push('f1', 't1');
    doc.editedAt = '2026-09-26T10:00:00.000Z';
    expect((await request('PUT', `/api/doc/${id}`, doc)).status).toBe(200);
    expect((await request('GET', `/api/doc/${id}?open=1`)).status).toBe(200);
    expect((await request('POST', `/api/doc/${id}/versions`, { name: 'Avant le salon' })).status).toBe(201);
    expect(existsSync(path.join(dir, id, 'history'))).toBe(true);
    expect(existsSync(path.join(dir, id, 'versions'))).toBe(true);
    return { id, files };
  }

  it('copie document.json (nouvel id, « Copie de … », createdAt maintenant, sans editedAt) et les images, sans historique, versions ni exports', async () => {
    await withApi(async (api) => {
      const { dir, request } = api;
      const { id, files } = await seedSource(api);
      const sourceRaw = await readFile(path.join(dir, id, 'document.json'), 'utf8');
      const sourceHistory = await readdir(path.join(dir, id, 'history'));
      const source = JSON.parse(sourceRaw) as LayoutDocument;

      const t0 = Date.now();
      const res = await request('POST', `/api/doc/${id}/duplicate`, {});
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: 'copie-de-depliant-salon' });
      const copyId = res.body.id as string;
      const copy = await readDoc(dir, copyId);
      expect(validateDocument(copy).ok).toBe(true);
      expect(copy.id).toBe(copyId);
      expect(copy.name).toBe('Copie de Dépliant salon');
      expect(copy.editedAt).toBeUndefined();
      expect(Date.parse(copy.createdAt)).toBeGreaterThanOrEqual(t0 - 1);
      expect(Date.parse(copy.createdAt)).toBeLessThanOrEqual(Date.now());
      const { id: _a, name: _b, createdAt: _c, editedAt: _d, ...sourceRest } = source;
      const { id: _e, name: _f, createdAt: _g, ...copyRest } = copy;
      expect(copyRest).toEqual(sourceRest);

      // Images : mêmes chemins relatifs, mêmes octets ; ni épreuves (cache), ni fichiers temporaires.
      for (const [rel, data] of Object.entries(files)) expect(await readFile(path.join(dir, copyId, rel))).toEqual(data);
      expect(await readdir(path.join(dir, copyId, 'assets'))).toEqual(['originals', 'previews', 'print']);
      expect(await readdir(path.join(dir, copyId, 'assets', 'originals'))).toEqual(['photo.tif']);
      expect((await readdir(path.join(dir, copyId))).sort()).toEqual(['assets', 'document.json']);
      const served = await request('GET', `/api/assets/${copyId}/assets/previews/photo.webp`);
      expect(served.status).toBe(200);

      // L'original n'a pas bougé.
      expect(await readFile(path.join(dir, id, 'document.json'), 'utf8')).toBe(sourceRaw);
      expect(await readdir(path.join(dir, id, 'history'))).toEqual(sourceHistory);
      expect((await request('GET', `/api/doc/${id}/versions`)).body).toHaveLength(1);

      // La copie s'ouvre, s'enregistre et a ses propres versions.
      const opened = await request('GET', `/api/doc/${copyId}?open=1`);
      expect(opened.status).toBe(200);
      expect((await request('GET', `/api/doc/${copyId}/versions`)).body).toEqual([]);
      expect((await request('PUT', `/api/doc/${copyId}`, { ...copy, name: 'Dépliant salon 2027' })).status).toBe(200);
      expect((await readDoc(dir, id)).name).toBe('Dépliant salon');

      // Deuxième copie, même nom proposé : identifiant suivant.
      expect((await request('POST', `/api/doc/${id}/duplicate`)).body).toEqual({ id: 'copie-de-depliant-salon-2' });
    });
  });

  it('nom choisi : identifiant tiré de ce nom ; 404 si l’original est absent, 400 si son identifiant ou le nom est invalide', async () => {
    await withApi(async (api) => {
      const { dir, request } = api;
      const { id } = await seedSource(api);
      const named = await request('POST', `/api/doc/${id}/duplicate`, { name: 'Salon de printemps' });
      expect(named).toMatchObject({ status: 201, body: { id: 'salon-de-printemps' } });
      expect((await readDoc(dir, 'salon-de-printemps')).name).toBe('Salon de printemps');

      const before = (await readdir(dir)).sort();
      expect((await request('POST', '/api/doc/absent/duplicate', {})).status).toBe(404);
      expect((await request('POST', '/api/doc/..%2Fevil/duplicate', {})).status).toBe(400);
      expect((await request('POST', '/api/doc/Majuscules/duplicate', {})).status).toBe(400);
      const blank = await request('POST', `/api/doc/${id}/duplicate`, { name: '  ' });
      expect(blank.status).toBe(400);
      expect(blank.body.error).toBe('Nom du document manquant');
      expect((await readdir(dir)).sort()).toEqual(before);
    });
  });

  it('un original invalide n’est pas copié (422), et aucun dossier ne reste', async () => {
    await withApi(async ({ dir, request }) => {
      await mkdir(path.join(dir, 'casse'), { recursive: true });
      await writeFile(path.join(dir, 'casse', 'document.json'), '{"version": 2, "id": "casse"}');
      expect((await request('POST', '/api/doc/casse/duplicate', {})).status).toBe(422);
      expect(await readdir(dir)).toEqual(['casse']);
      expect((await stat(path.join(dir, 'casse'))).isDirectory()).toBe(true);
    });
  });
});

describe('aperçu plié d’un document vierge', () => {
  it('pli roulé seulement : ni l’accordéon (volets égaux) ni les formats sans pli', () => {
    for (const template of TEMPLATES) {
      const doc = createBlankDocument({ id: 'essai', name: 'Essai', format: template });
      expect([template.id, foldModel(doc) !== null]).toEqual([template.id, template.id === 'depliant-a4-pli-roule']);
    }
  });
});

describe('gabarits : géométrie d’un document vierge', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s : faces fond perdu compris, plis entre les volets', (_id, template) => {
    const doc = createBlankDocument({ id: 'essai', name: 'Essai', format: template });
    expect(faceSize(doc.format)).toEqual({ w: template.trim.w + 2 * template.bleed, h: template.trim.h + 2 * template.bleed });
    for (const face of template.faces) {
      let x = template.bleed;
      expect(foldPositions(doc.format, face.id)).toEqual(face.panels.slice(0, -1).map((p) => (x += p.w)));
    }
  });
});
