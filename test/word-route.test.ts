// Routes de l'import Word (POST /api/doc/:id/word, POST /api/doc/from-word) par `inject`, sur un dossier de
// documents jetable : structure rendue, images enregistrées comme des photos déposées, refus clairs.
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { registerApiRoutes } from '../server/routes';
import type { LayoutDocument } from '../src/model/types';
import type { NewFromWordResponse, WordImportResponse } from '../src/word/types';
import { minimalDoc } from './fixtures/minimal-doc';
import { withTempDocuments, writeDocument } from './helpers/editor';
import { docxFiles, IMAGE_RUN, makeDocx, makeZip, oleFile, p, r, zipBomb } from './helpers/docx';

const PNG = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#3a7a4a' } }).png().toBuffer();

async function multipart(fields: Record<string, string>, file?: { name: string; content: Buffer; type?: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', new Blob([new Uint8Array(file.content)], { type: file.type ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), file.name);
  const encoded = new Response(form);
  return { headers: { 'content-type': encoded.headers.get('content-type')! }, payload: Buffer.from(await encoded.arrayBuffer()) };
}

async function withRoutes<T>(fn: (app: FastifyInstance, dir: string) => Promise<T>, options: { maxWordBytes?: number } = {}): Promise<T> {
  return withTempDocuments(async (dir) => {
    const app = Fastify();
    await registerApiRoutes(app, { documentsDir: dir, ...options });
    try {
      return await fn(app, dir);
    } finally {
      await app.close();
    }
  });
}

const postWord = async (app: FastifyInstance, docId: string, name: string, content: Buffer) =>
  app.inject({ method: 'POST', url: `/api/doc/${docId}/word`, ...(await multipart({}, { name, content })) });

describe('POST /api/doc/:id/word', () => {
  it('rend la structure et enregistre les images comme des photos déposées (originaux intacts, aperçus), sans toucher au document', async () => {
    await withRoutes(async (app, dir) => {
      await writeDocument(dir, minimalDoc());
      const before = await readFile(path.join(dir, 'essai', 'document.json'), 'utf8');
      // Deux images : un PNG, et un dessin EMF que l'éditeur ne sait pas afficher.
      const body = [p(r('Titre')), p(IMAGE_RUN), p(IMAGE_RUN.replace('rId4', 'rId5'))].join('');
      const files = docxFiles(body, PNG);
      files['word/_rels/document.xml.rels'] = (files['word/_rels/document.xml.rels'] as string).replace(
        '</Relationships>',
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.emf"/></Relationships>',
      );
      files['word/media/image2.emf'] = Buffer.from('dessin EMF');
      const res = await postWord(app, 'essai', 'Rapport annuel.docx', makeZip(files));
      expect(res.statusCode, res.body).toBe(200);
      const body2 = res.json() as WordImportResponse;
      expect(body2.fileName).toBe('Rapport annuel.docx');
      expect(body2.document.blocks.length).toBeGreaterThan(0);
      expect(body2.document.images.map((i) => i.name)).toEqual(['image1.png', 'image2.emf']);
      expect(Object.keys(body2.assets)).toEqual(['img1']);
      const asset = body2.assets.img1;
      expect(asset).toMatchObject({ kind: 'image', name: 'Rapport annuel · image1.png', width: 120, height: 80 });
      expect(asset.original).toMatch(/^assets\/originals\/rapport-annuel-image1\.png$/);
      // Original intact, octet pour octet ; aperçu WebP.
      expect((await readFile(path.join(dir, 'essai', asset.original))).equals(PNG)).toBe(true);
      expect((await sharp(await readFile(path.join(dir, 'essai', asset.preview!))).metadata()).format).toBe('webp');
      expect(body2.document.warnings).toEqual([expect.stringMatching(/Image « image2\.emf » non importée : format EMF/)]);
      // Le document ouvert dans l'éditeur n'est pas réécrit : c'est l'éditeur qui ajoute photos et texte.
      expect(await readFile(path.join(dir, 'essai', 'document.json'), 'utf8')).toBe(before);
    });
  });

  it('refus clairs : .doc, fichier chiffré, zip qui n’est pas un Word, autre format, bombe de décompression, fichier trop lourd, document inconnu', async () => {
    await withRoutes(
      async (app, dir) => {
        await writeDocument(dir, minimalDoc());
        const refused = async (name: string, content: Buffer, status = 400) => {
          const res = await postWord(app, 'essai', name, content);
          expect(res.statusCode, res.body).toBe(status);
          return res.json() as { error: string; code?: string };
        };
        expect(await refused('ancien.doc', oleFile())).toMatchObject({ code: 'legacy-doc', error: expect.stringMatching(/« ancien\.doc » est un document Word 97-2003 \(\.doc\)/) });
        // Un .doc renommé en .docx est reconnu à son contenu.
        expect(await refused('renomme.docx', oleFile())).toMatchObject({ code: 'legacy-doc' });
        expect(await refused('secret.docx', oleFile({ encrypted: true }))).toMatchObject({ code: 'encrypted', error: expect.stringMatching(/protégé par un mot de passe/) });
        expect(await refused('archive.docx', makeZip({ 'lisez-moi.txt': 'bonjour' }))).toMatchObject({ code: 'not-word', error: expect.stringMatching(/pas un document Word/) });
        expect(await refused('texte.docx', Buffer.from('du texte, pas un zip'))).toMatchObject({ code: 'not-zip' });
        expect(await refused('notes.txt', Buffer.from('bonjour'))).toMatchObject({ code: 'not-docx', error: expect.stringMatching(/n'est pas un fichier Word \.docx/) });
        // Bombe : 70 Mo de XML dans quelques dizaines de kilo-octets, au-delà du plafond de 64 Mo par entrée.
        const bomb = zipBomb(70 * 1024 * 1024);
        expect(bomb.length).toBeLessThan(200_000);
        expect(await refused('bombe.docx', bomb)).toMatchObject({ code: 'too-large', error: expect.stringMatching(/bombe de décompression/) });
        expect((await app.inject({ method: 'POST', url: '/api/doc/inconnu/word', ...(await multipart({}, { name: 'a.docx', content: makeDocx() })) })).statusCode).toBe(404);
        expect((await app.inject({ method: 'POST', url: '/api/doc/essai/word', payload: { a: 1 } })).statusCode).toBe(415);
        // Aucun fichier laissé par les refus.
        expect(existsSync(path.join(dir, 'essai', 'assets'))).toBe(false);
      },
    );
    // Plafond de l'envoi (réduit à 64 Ko pour le test).
    await withRoutes(
      async (app, dir) => {
        await writeDocument(dir, minimalDoc());
        const res = await postWord(app, 'essai', 'lourd.docx', Buffer.concat([makeDocx(), Buffer.alloc(80 * 1024)]));
        expect(res.statusCode).toBe(413);
        expect(res.json().error).toBe('Fichier trop lourd : 64 Ko au maximum pour un fichier Word');
      },
      { maxWordBytes: 64 * 1024 },
    );
  });
});

describe('POST /api/doc/from-word', () => {
  it('crée le document d’après le gabarit et lit le fichier ; un fichier refusé ne laisse aucun document', async () => {
    await withRoutes(async (app, dir) => {
      const res = await app.inject({ method: 'POST', url: '/api/doc/from-word', ...(await multipart({ templateId: 'flyer-a5' }, { name: 'Guide_atelier.docx', content: makeDocx(undefined, PNG) })) });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json() as NewFromWordResponse;
      expect(body.id).toBe('guide-atelier');
      expect(res.headers.location).toBe('/api/doc/guide-atelier');
      expect(body.assets.img1.name).toBe('Guide_atelier · image1.png');
      const doc = JSON.parse(await readFile(path.join(dir, body.id, 'document.json'), 'utf8')) as LayoutDocument;
      expect(doc).toMatchObject({ name: 'Guide atelier', format: { id: 'flyer-a5' }, objects: {}, assets: [] });

      const refused = await app.inject({ method: 'POST', url: '/api/doc/from-word', ...(await multipart({ templateId: 'flyer-a5', name: 'Ancien' }, { name: 'ancien.docx', content: oleFile() })) });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'legacy-doc' });
      const unknown = await app.inject({ method: 'POST', url: '/api/doc/from-word', ...(await multipart({ templateId: 'nope' }, { name: 'a.docx', content: makeDocx() })) });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error).toMatch(/Gabarit inconnu/);
      expect(await readdir(dir)).toEqual(['guide-atelier']);
    });
  });
});
