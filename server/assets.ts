import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import sharp, { type Metadata } from 'sharp';
import type { Asset } from '../src/model/types';
import { documentFile, HttpError, renameWithRetry, writeFileAtomic } from './documents';
import { documentDir, isValidDocId } from './paths';
import type { RouteContext } from './routes';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const PREVIEW_MAX_SIDE = 2000;
/** L'aperçu sert à l'écran seulement : au-delà, l'éditeur ralentit sans rien gagner en lisibilité. */
export const PREVIEW_MAX_BYTES = 1_000_000;

interface AcceptedFormat {
  ext: string;
  aliases: string[];
  mimetypes: string[];
}

// Clés = `format` rendu par sharp : c'est le contenu du fichier qui décide, pas son nom.
const FORMATS: Record<string, AcceptedFormat> = {
  jpeg: { ext: '.jpg', aliases: ['.jpg', '.jpeg', '.jpe'], mimetypes: ['image/jpeg', 'image/pjpeg'] },
  png: { ext: '.png', aliases: ['.png'], mimetypes: ['image/png'] },
  tiff: { ext: '.tif', aliases: ['.tif', '.tiff'], mimetypes: ['image/tiff', 'image/x-tiff'] },
  webp: { ext: '.webp', aliases: ['.webp'], mimetypes: ['image/webp'] },
};
const ACCEPTED_LABEL = 'JPG, PNG, TIFF ou WebP';

// Formats que Chrome ne décode pas dans un <image> : la route d'impression charge à leur place une copie PNG.
const NEEDS_PRINT_COPY = new Set(['tiff']);

const declaredAsImage = (filename: string, mimetype: string) => {
  const ext = path.extname(filename).toLowerCase();
  return Object.values(FORMATS).some((f) => f.aliases.includes(ext) || f.mimetypes.includes(mimetype.toLowerCase()));
};

// Noms réservés par Windows, même suivis d'une extension (« nul.jpg » est inutilisable).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Nom de fichier sans accents, espaces ni caractères spéciaux, sans extension. */
export function safeBaseName(filename: string): string {
  // Certains navigateurs envoient le chemin complet (C:\fakepath\photo.jpg).
  const leaf = filename.split(/[\\/]/).pop() ?? '';
  const base = leaf
    .slice(0, leaf.length - path.extname(leaf).length)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80)
    .replace(/[-_]+$/, '');
  if (!base) return 'image';
  return WINDOWS_RESERVED.test(base) ? `image-${base}` : base;
}

async function createExclusive(file: string): Promise<boolean> {
  try {
    await (await open(file, 'wx')).close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Réserve un nom libre à la fois dans originals/ et previews/ (création exclusive) : deux envois
 * simultanés du même fichier obtiennent chacun leur nom, sans jamais s'écraser.
 */
async function reserveNames(originalsDir: string, previewsDir: string, base: string, ext: string) {
  for (let n = 1; n < 10_000; n++) {
    const stem = n === 1 ? base : `${base}-${n}`;
    const original = path.join(originalsDir, stem + ext);
    const preview = path.join(previewsDir, `${stem}.webp`);
    if (!(await createExclusive(original))) continue;
    if (!(await createExclusive(preview))) {
      await rm(original, { force: true });
      continue;
    }
    return { stem, original, preview };
  }
  throw new HttpError(500, `Aucun nom libre pour « ${base}${ext} »`);
}

const PREVIEW_QUALITY = 82;
const PREVIEW_MIN_QUALITY = 60;
const PREVIEW_MIN_SIDE = 300;

/**
 * Aperçu WebP ≤ 2000 px de côté, en sRGB, sous 1 Mo. Le décodage (le plus coûteux) n'a lieu qu'une fois ;
 * si l'aperçu est trop lourd, on baisse la qualité puis la taille, en visant directement le bon poids
 * plutôt que par petits paliers (chaque encodage d'une image très détaillée coûte près d'une seconde).
 */
export async function makePreview(source: Buffer, hasProfile: boolean): Promise<Buffer> {
  let pipelineIn = sharp(source, { failOn: 'error', autoOrient: true }).resize({
    width: PREVIEW_MAX_SIDE,
    height: PREVIEW_MAX_SIDE,
    fit: 'inside',
    withoutEnlargement: true,
  });
  // Profil incorporé (Adobe RGB, FOGRA39…) : conversion explicite vers sRGB. Sans profil, la conversion
  // par défaut de sharp est la bonne ; forcer le profil sRGB fausse alors les couleurs des images 16 bits.
  if (hasProfile) pipelineIn = pipelineIn.withIccProfile('srgb');
  const { data, info } = await pipelineIn.raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };

  let side = Math.max(info.width, info.height);
  let quality = PREVIEW_QUALITY;
  for (let attempt = 0; attempt < 6; attempt++) {
    const resized = side < Math.max(info.width, info.height);
    let encoder = sharp(data, { raw });
    if (resized) encoder = encoder.resize({ width: side, height: side, fit: 'inside' });
    const webp = await encoder.webp({ quality }).toBuffer();
    if (webp.length < PREVIEW_MAX_BYTES) return webp;
    // Marge de 10 % : le poids ne suit le nombre de pixels qu'à peu près.
    const ratio = (PREVIEW_MAX_BYTES * 0.9) / webp.length;
    // Passer de 82 à 60 fait gagner environ 20 % : inutile d'essayer si l'écart est plus grand.
    const qualityIsEnough = quality > PREVIEW_MIN_QUALITY && ratio > 0.8;
    quality = PREVIEW_MIN_QUALITY;
    if (!qualityIsEnough) {
      if (side <= PREVIEW_MIN_SIDE) break;
      side = Math.max(PREVIEW_MIN_SIDE, Math.floor(side * Math.sqrt(ratio)));
    }
  }
  throw new HttpError(422, 'Impossible de produire un aperçu de moins de 1 Mo');
}

/**
 * Copie d'impression d'un original que Chrome ne sait pas décoder (TIFF) : PNG sans perte, pleine
 * résolution, orientation appliquée comme pour l'aperçu. Un profil RVB incorporé est gardé (Chrome le
 * respecte) ; une image CMJN est convertie en sRGB, le PNG ne connaissant pas le CMJN.
 */
export async function makePrintCopy(source: Buffer, meta: Metadata): Promise<Buffer> {
  let copy = sharp(source, { failOn: 'error', autoOrient: true });
  if (meta.space === 'cmyk') copy = copy.withIccProfile('srgb');
  else if (meta.hasProfile) copy = copy.keepIccProfile();
  // Compression rapide : la copie peut peser 100 Mo non compressée, et le poids importe peu en local.
  return copy.png({ compressionLevel: 3 }).toBuffer();
}

async function drain(stream: Readable): Promise<void> {
  stream.resume();
  await finished(stream).catch(() => undefined);
}

export async function registerAssetRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const maxBytes = ctx.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  await app.register(multipart, { limits: { fileSize: maxBytes, files: 1 } });

  app.post<{ Params: { id: string } }>('/api/assets/:id', async (req, reply) => {
    const { id } = req.params;
    if (!isValidDocId(id)) throw new HttpError(400, `Identifiant de document invalide : « ${id} »`);
    try {
      await stat(documentFile(ctx.documentsDir, id));
    } catch {
      throw new HttpError(404, `Document introuvable : ${id}`);
    }
    if (!req.isMultipart()) throw new HttpError(415, 'Envoi attendu en multipart/form-data (champ fichier)');

    const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
    if (!part) throw new HttpError(400, 'Aucun fichier reçu');
    const displayName = part.filename.split(/[\\/]/).pop() || 'image';
    // Refus immédiat sur le type annoncé, pour ne pas écrire 200 Mo sur le disque avant de dire non.
    if (!declaredAsImage(part.filename, part.mimetype)) {
      await drain(part.file);
      throw new HttpError(415, `Type de fichier refusé (${part.mimetype || 'inconnu'}) : ${ACCEPTED_LABEL} attendu`);
    }

    const assetsDir = path.join(documentDir(ctx.documentsDir, id), 'assets');
    const originalsDir = path.join(assetsDir, 'originals');
    const previewsDir = path.join(assetsDir, 'previews');
    const printDir = path.join(assetsDir, 'print');
    await mkdir(originalsDir, { recursive: true });
    await mkdir(previewsDir, { recursive: true });

    // Le fichier reçu est d'abord écrit sous un nom temporaire : un envoi interrompu ne laisse
    // jamais un « original » tronqué qui ressemblerait à une vraie photo.
    const upload = path.join(originalsDir, `.upload-${randomUUID()}.part`);
    let reserved: { stem: string; original: string; preview: string } | undefined;
    let printFile: string | undefined;
    try {
      await pipeline(part.file, createWriteStream(upload, { flags: 'wx' }));
      if (part.file.truncated) {
        throw new HttpError(413, `Fichier trop lourd : ${Math.round(maxBytes / 1024 / 1024)} Mo au maximum`);
      }

      // sharp reçoit le contenu, jamais le chemin : libvips garde en cache les fichiers qu'il ouvre (et en
      // mappe certains en mémoire), et Windows refuse alors de les renommer ou de les supprimer (EBUSY).
      const content = await readFile(upload);
      let meta: Metadata;
      try {
        meta = await sharp(content).metadata();
      } catch {
        throw new HttpError(415, `Fichier illisible comme image : ${ACCEPTED_LABEL} attendu`);
      }
      const format = meta.format ? FORMATS[meta.format] : undefined;
      if (!format || !meta.width || !meta.height) {
        throw new HttpError(415, `Format ${meta.format ?? 'inconnu'} refusé : ${ACCEPTED_LABEL} attendu`);
      }

      const declaredExt = path.extname(displayName).toLowerCase();
      const ext = format.aliases.includes(declaredExt) ? declaredExt : format.ext;
      reserved = await reserveNames(originalsDir, previewsDir, safeBaseName(displayName), ext);
      await renameWithRetry(upload, reserved.original);

      let preview: Buffer;
      try {
        preview = await makePreview(content, !!meta.hasProfile);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, `Image illisible : ${(error as Error).message}`);
      }
      await writeFileAtomic(reserved.preview, preview);

      if (NEEDS_PRINT_COPY.has(meta.format!)) {
        let copy: Buffer;
        try {
          copy = await makePrintCopy(content, meta);
        } catch (error) {
          throw new HttpError(422, `Image illisible : ${(error as Error).message}`);
        }
        await mkdir(printDir, { recursive: true });
        // Le nom de l'aperçu, réservé de façon exclusive, garantit un nom libre ici aussi.
        printFile = path.join(printDir, `${reserved.stem}.png`);
        await writeFileAtomic(printFile, copy);
      }

      const asset: Asset = {
        id: `img-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        kind: 'image',
        name: displayName,
        original: `assets/originals/${path.basename(reserved.original)}`,
        preview: `assets/previews/${path.basename(reserved.preview)}`,
        ...(printFile ? { print: `assets/print/${path.basename(printFile)}` } : {}),
        // Dimensions telles qu'affichées : une photo de portrait marquée « tourner de 90° » par l'EXIF
        // est stockée en paysage.
        width: meta.autoOrient?.width ?? meta.width,
        height: meta.autoOrient?.height ?? meta.height,
      };
      return reply.code(201).send(asset);
    } catch (error) {
      if (reserved) {
        await rm(reserved.original, { force: true });
        await rm(reserved.preview, { force: true });
        if (printFile) await rm(printFile, { force: true });
      }
      throw error;
    } finally {
      await rm(upload, { force: true });
    }
  });
}
