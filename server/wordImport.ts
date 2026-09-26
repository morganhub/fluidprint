// Import d'un fichier Word (.docx), sur le modèle de la commande « Placer » d'InDesign :
//   POST /api/doc/:id/word      multipart `file` → 200 WordImportResponse : structure du texte, photos
//                               enregistrées dans le dossier du document (le document.json n'est PAS
//                               modifié : l'éditeur, qui l'a ouvert, place le texte en une étape d'annulation)
//   POST /api/doc/from-word     multipart `file`, `name`, `templateId` → 201 NewFromWordResponse : document
//                               vierge d'après le gabarit, puis même lecture ; l'éditeur remplit ses faces
//
// Le fichier est lu en mémoire (plafond MAX_WORD_BYTES), contrôlé (.docx seulement : .doc, fichier chiffré,
// zip qui n'est pas un Word et bombe de décompression refusés par server/docx), puis ses images passent par
// le même enregistrement que les photos déposées (storeImageAsset : originaux intacts, aperçus).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rm, stat } from 'node:fs/promises';
import type { Asset } from '../src/model/types';
import type { NewFromWordResponse, WordImportResponse } from '../src/word/types';
import { storeImageAsset } from './assets';
import { DocxError } from './docx/errors';
import { readDocx, type DocxMedia } from './docx/read';
import { documentFile, HttpError } from './documents';
import { documentDir, isValidDocId } from './paths';
import type { RouteContext } from './routes';
import { createDocument } from './templates';

/** Un rapport de quelques dizaines de pages pèse moins de 5 Mo ; les photos incorporées le grossissent. */
export const MAX_WORD_BYTES = 50 * 1024 * 1024;

const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} Mo` : `${Math.round(bytes / 1024)} Ko`);

interface Upload {
  filename: string;
  data: Buffer;
}

/** Lit le corps multipart : le fichier en mémoire et les champs texte. */
async function readWordForm(req: FastifyRequest, maxBytes: number): Promise<{ upload: Upload | null; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw new HttpError(415, 'Envoi attendu en multipart/form-data : le fichier .docx (champ « file »)');
  let upload: Upload | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 10_000 } })) {
      if (part.type === 'file') {
        const data = await part.toBuffer();
        upload = { filename: part.filename.split(/[\\/]/).pop() || 'document.docx', data };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, `Fichier trop lourd : ${sizeLabel(maxBytes)} au maximum pour un fichier Word`);
    if (code === 'FST_FILES_LIMIT') throw new HttpError(400, 'Un seul fichier à la fois : le fichier Word (.docx)');
    throw error;
  }
  return { upload, fields };
}

/** Refus immédiat d'un fichier qui n'est pas un .docx, avant toute lecture. */
function checkFileName(upload: Upload | null): Upload {
  if (!upload || !upload.data.length) throw new HttpError(400, 'Aucun fichier reçu : choisissez un fichier Word (.docx)', { code: 'empty' });
  const name = upload.filename;
  if (/\.doc$/i.test(name)) {
    throw new HttpError(400, `« ${name} » est un document Word 97-2003 (.doc) : ouvrez-le dans Word et enregistrez-le au format .docx (Fichier > Enregistrer sous > Document Word).`, {
      code: 'legacy-doc',
    });
  }
  if (!/\.docx$/i.test(name)) throw new HttpError(400, `« ${name} » n'est pas un fichier Word .docx : seuls les documents Word (.docx) peuvent être placés.`, { code: 'not-docx' });
  return upload;
}

function readUpload(upload: Upload) {
  try {
    return readDocx(upload.data, { label: upload.filename });
  } catch (error) {
    if (error instanceof DocxError) throw new HttpError(400, error.message, { code: error.code });
    throw error;
  }
}

const extensionOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toUpperCase();

/**
 * Enregistre les images du fichier Word comme des photos déposées. Une image dans un format que l'éditeur
 * n'affiche pas (EMF, WMF, GIF…) n'est pas importée : elle est signalée dans les avertissements.
 */
async function storeWordImages(documentsDir: string, docId: string, fileName: string, media: DocxMedia[], warnings: string[]): Promise<Record<string, Asset>> {
  const stem = fileName.replace(/\.docx$/i, '');
  const assets: Record<string, Asset> = {};
  for (const { image, bytes } of media) {
    try {
      assets[image.id] = await storeImageAsset(documentsDir, docId, { content: bytes, displayName: `${stem} · ${image.name}` });
    } catch (error) {
      if (!(error instanceof HttpError) || (error.status !== 415 && error.status !== 422)) throw error;
      const ext = extensionOf(image.name);
      warnings.push(
        /^(EMF|WMF)$/.test(ext)
          ? `Image « ${image.name} » non importée : format ${ext} (dessin Windows) que l'éditeur ne sait pas afficher. Enregistrez-la en PNG depuis Word pour l'importer.`
          : `Image « ${image.name} » non importée : ${error.message}.`,
      );
    }
  }
  return assets;
}

async function assertDocument(documentsDir: string, id: string): Promise<void> {
  if (!isValidDocId(id)) throw new HttpError(400, `Identifiant de document invalide : « ${id} »`);
  try {
    await stat(documentFile(documentsDir, id));
  } catch {
    throw new HttpError(404, `Document introuvable : ${id}`);
  }
}

export function registerWordRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const maxBytes = ctx.maxWordBytes ?? MAX_WORD_BYTES;

  app.post<{ Params: { id: string } }>('/api/doc/:id/word', async (req) => {
    const { id } = req.params;
    await assertDocument(ctx.documentsDir, id);
    const upload = checkFileName((await readWordForm(req, maxBytes)).upload);
    const { document, media } = readUpload(upload);
    const assets = await storeWordImages(ctx.documentsDir, id, upload.filename, media, document.warnings);
    const body: WordImportResponse = { fileName: upload.filename, document, assets };
    return body;
  });

  app.post('/api/doc/from-word', async (req, reply) => {
    const { upload: received, fields } = await readWordForm(req, maxBytes);
    const upload = checkFileName(received);
    // Le fichier est lu AVANT de créer le document : un fichier refusé ne laisse pas de document vide derrière lui.
    const { document, media } = readUpload(upload);
    const fromFile = upload.filename.replace(/\.docx$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
    const name = (fields.name ?? '').replace(/\s+/g, ' ').trim() || fromFile || 'Document Word';
    const { id } = await createDocument(ctx.documentsDir, { name, templateId: fields.templateId });
    try {
      const assets = await storeWordImages(ctx.documentsDir, id, upload.filename, media, document.warnings);
      const body: NewFromWordResponse = { id, fileName: upload.filename, document, assets };
      return reply.code(201).header('location', `/api/doc/${id}`).send(body);
    } catch (error) {
      // Aucun demi-document : le dossier créé à l'instant est retiré.
      await rm(documentDir(ctx.documentsDir, id), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}
