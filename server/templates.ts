// Gabarits, création et duplication de documents (page d'accueil) :
//   GET  /api/templates              gabarits livrés (src/model/templates)
//   POST /api/doc                    { name, templateId, id? } → 201 { id } : document vierge
//   POST /api/doc/:id/duplicate      { name? } → 201 { id } : copie du document et de ses images
//
// Le dossier d'un nouveau document est réservé par un mkdir exclusif avant toute écriture : deux créations
// simultanées du même nom obtiennent chacune leur identifiant, et aucune n'écrit dans un dossier existant.
// Le document lui-même passe par saveDocumentWithRevision (validation, écriture atomique).
import type { FastifyInstance } from 'fastify';
import { cp, lstat, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyDocument, createBlankDocument, docIdFromName, duplicateName, templateSummary, type TemplateSummary } from '../src/model/newDocument';
import { applySwatchDisplays } from '../src/model/swatches';
import { findTemplate, TEMPLATES } from '../src/model/templates';
import type { LayoutDocument } from '../src/model/types';
import { cmykToRgb, pythonAvailable, referencePreset } from './color';
import { HttpError, readDocument, saveDocumentWithRevision } from './documents';
import { documentDir, isValidDocId } from './paths';
import type { RouteContext } from './routes';

/** Longueur maximale d'un nom de document (celle d'un nom de version). */
export const DOC_NAME_MAX = 120;
/** Au-delà, on renonce à chercher un suffixe libre (-2, -3…) : quelque chose ne va pas dans le dossier. */
const MAX_SUFFIX = 999;

export function templateSummaries(): TemplateSummary[] {
  return TEMPLATES.map(templateSummary);
}

/** Nom saisi, espaces réduits ; 400 s'il est vide ou trop long. */
function cleanDocName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new HttpError(400, 'Nom du document manquant');
  if (name.length > DOC_NAME_MAX) throw new HttpError(400, `Nom du document trop long (${DOC_NAME_MAX} caractères au plus)`);
  return name;
}

const bodyField = (body: unknown, key: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined);

/**
 * Réserve le dossier d'un nouveau document. `exact` : l'identifiant demandé tel quel, 409 s'il est pris ;
 * sinon le premier libre parmi `base`, `base-2`, `base-3`…
 */
export async function reserveDocumentDir(documentsDir: string, base: string, options: { exact?: boolean } = {}): Promise<string> {
  if (!isValidDocId(base)) throw new HttpError(400, `Identifiant de document invalide : « ${base} »`);
  await mkdir(documentsDir, { recursive: true });
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!isValidDocId(id)) break;
    try {
      // Sans `recursive` : échoue si le dossier existe déjà, ce qui rend la réservation atomique.
      await mkdir(documentDir(documentsDir, id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (options.exact) throw new HttpError(409, `Un document « ${id} » existe déjà`);
    }
  }
  throw new HttpError(409, `Aucun identifiant libre pour « ${base} »`);
}

/**
 * RVB affiché des nuances recalculé par le profil du préréglage de référence (le même que le panneau
 * Nuancier). Sans Python, ou si la conversion échoue, le document garde les simulations FOGRA39 du nuancier
 * de départ : mieux vaut créer le document que de le refuser pour une couleur d'écran.
 */
async function refreshSwatchDisplays(doc: LayoutDocument): Promise<void> {
  if (!pythonAvailable()) return;
  try {
    const profile = referencePreset().profile ?? 'FOGRA39';
    applySwatchDisplays(doc, await cmykToRgb(doc.swatches.map((s) => s.cmyk!), profile));
  } catch (error) {
    console.warn(`Nuancier de départ : simulation par le profil impossible (${(error as Error).message}) ; valeurs FOGRA39 gardées`);
  }
}

/** Écrit le document dans le dossier réservé ; en cas d'échec, le dossier est retiré (aucun demi-document). */
async function fillReservedDir(documentsDir: string, id: string, fill: (dir: string) => Promise<void>): Promise<void> {
  const dir = documentDir(documentsDir, id);
  try {
    await fill(dir);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Crée un document vierge d'après un gabarit ; renvoie son identifiant. */
export async function createDocument(documentsDir: string, body: unknown): Promise<{ id: string; doc: LayoutDocument; revision: string }> {
  const name = cleanDocName(bodyField(body, 'name'));
  const templateId = bodyField(body, 'templateId');
  const format = typeof templateId === 'string' ? findTemplate(templateId) : undefined;
  if (!format) throw new HttpError(400, typeof templateId === 'string' && templateId ? `Gabarit inconnu : ${templateId}` : 'Gabarit manquant (templateId)');
  const wanted = bodyField(body, 'id');
  const explicit = wanted !== undefined && wanted !== null && wanted !== '';
  if (explicit && (typeof wanted !== 'string' || !isValidDocId(wanted))) throw new HttpError(400, `Identifiant de document invalide : « ${String(wanted)} »`);

  const id = await reserveDocumentDir(documentsDir, explicit ? (wanted as string) : docIdFromName(name), { exact: explicit });
  let saved!: { doc: LayoutDocument; revision: string };
  await fillReservedDir(documentsDir, id, async () => {
    const doc = createBlankDocument({ id, name, format });
    await refreshSwatchDisplays(doc);
    saved = await saveDocumentWithRevision(documentsDir, id, doc);
  });
  return { id, ...saved };
}

// Copiés avec le document : originaux, aperçus, copies d'impression. Le cache d'épreuves (assets/proof/) se
// recalcule ; les fichiers temporaires d'un envoi ou d'une écriture en cours n'appartiennent à personne.
const SKIPPED_ASSET_DIRS = new Set(['proof']);
const isTempFile = (name: string) => /\.tmp$/.test(name) || /^\.upload-.*\.part$/.test(name);

async function copyAssets(fromDir: string, toDir: string): Promise<void> {
  const source = path.join(fromDir, 'assets');
  try {
    if (!(await stat(source)).isDirectory()) return;
  } catch {
    return;
  }
  await cp(source, path.join(toDir, 'assets'), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (file) => {
      const relative = path.relative(source, file);
      if (!relative) return true;
      if (SKIPPED_ASSET_DIRS.has(relative.split(path.sep)[0]) || isTempFile(path.basename(file))) return false;
      // Un lien symbolique pourrait désigner un fichier hors du dossier documents : il n'est pas recopié.
      return !(await lstat(file)).isSymbolicLink();
    },
  });
}

/**
 * Duplique un document : nouveau dossier avec document.json (nouvel identifiant, « Copie de … » par défaut,
 * créé maintenant, sans editedAt) et les images (assets/). L'historique, les versions et les exports
 * restent avec l'original : la copie repart d'une page blanche de ce côté-là.
 */
export async function duplicateDocument(documentsDir: string, sourceId: string, body: unknown): Promise<{ id: string; doc: LayoutDocument; revision: string }> {
  const source = await readDocument(documentsDir, sourceId);
  const given = bodyField(body, 'name');
  const name = given === undefined || given === null ? duplicateName(source.name).slice(0, DOC_NAME_MAX).trim() : cleanDocName(given);
  const id = await reserveDocumentDir(documentsDir, docIdFromName(name));
  let saved!: { doc: LayoutDocument; revision: string };
  await fillReservedDir(documentsDir, id, async (dir) => {
    await copyAssets(documentDir(documentsDir, sourceId), dir);
    saved = await saveDocumentWithRevision(documentsDir, id, copyDocument(source, { id, name }));
  });
  return { id, ...saved };
}

export function registerTemplateRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/templates', async () => templateSummaries());

  app.post<{ Body: unknown }>('/api/doc', async (req, reply) => {
    const { id } = await createDocument(ctx.documentsDir, req.body);
    return reply.code(201).header('location', `/api/doc/${id}`).send({ id });
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/doc/:id/duplicate', async (req, reply) => {
    const { id } = await duplicateDocument(ctx.documentsDir, req.params.id, req.body);
    return reply.code(201).header('location', `/api/doc/${id}`).send({ id });
  });
}
