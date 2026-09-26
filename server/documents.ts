import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateDocument, type ValidationError } from '../src/model/validate';
import type { LayoutDocument } from '../src/model/types';
import { documentDir, isValidDocId } from './paths';
import type { RouteContext } from './routes';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Champs ajoutés au corps de la réponse d'erreur (chemin de l'erreur de validation, par exemple). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const documentFile = (documentsDir: string, id: string) => path.join(documentDir(documentsDir, id), 'document.json');

function assertDocId(id: string): void {
  if (!isValidDocId(id)) throw new HttpError(400, `Identifiant de document invalide : « ${id} »`);
}

function validationError(status: number, prefix: string, errors: ValidationError[]): HttpError {
  const first = errors[0];
  const where = first.path || '(racine)';
  return new HttpError(status, `${prefix} : ${where} : ${first.message}`, { path: first.path, errors: errors.slice(0, 20) });
}

async function loadDocument(documentsDir: string, id: string): Promise<{ raw: string; doc: LayoutDocument }> {
  assertDocId(id);
  let raw: string;
  try {
    raw = await readFile(documentFile(documentsDir, id), 'utf8');
  } catch {
    throw new HttpError(404, `Document introuvable : ${id}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(422, `Document ${id} illisible (JSON invalide) : ${(error as Error).message}`);
  }
  const result = validateDocument(parsed);
  if (!result.ok) throw validationError(422, `Document ${id} invalide`, result.errors);
  return { raw, doc: result.doc };
}

export async function readDocument(documentsDir: string, id: string): Promise<LayoutDocument> {
  return (await loadDocument(documentsDir, id)).doc;
}

export async function listDocuments(documentsDir: string): Promise<{ id: string; name: string; editedAt?: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(documentsDir);
  } catch {
    return [];
  }
  const docs = [];
  for (const id of entries.filter(isValidDocId)) {
    try {
      const doc = JSON.parse(await readFile(documentFile(documentsDir, id), 'utf8'));
      docs.push({ id, name: String(doc.name ?? id), editedAt: doc.editedAt });
    } catch {
      // dossier sans document.json lisible : ignoré
    }
  }
  return docs;
}

// ---------------------------------------------------------------- écriture atomique

const TMP_SUFFIX = '.tmp';
// Sous Windows, un antivirus, l'indexeur ou un client de synchronisation peut tenir le fichier cible
// ouvert quelques millisecondes : le remplacement échoue alors (EPERM, EBUSY, EACCES) mais réussit peu après.
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 10;
const RENAME_BACKOFF_MS = 25;
// Un fichier temporaire plus vieux que ça n'appartient plus à aucune écriture en cours (arrêt brutal).
const STALE_TMP_MS = 60_000;

const inFlightTemps = new Set<string>();

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw error;
      await delay(RENAME_BACKOFF_MS * attempt);
    }
  }
}

/**
 * Écrit dans un fichier temporaire du même dossier puis le renomme par-dessus la cible : un arrêt
 * brutal laisse soit l'ancien fichier, soit le nouveau, jamais un fichier à moitié écrit.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.${process.pid}-${randomBytes(4).toString('hex')}${TMP_SUFFIX}`);
  inFlightTemps.add(tmp);
  try {
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      // Sans fsync, une coupure de courant peut laisser un fichier renommé mais encore vide sur le disque.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  } finally {
    inFlightTemps.delete(tmp);
  }
}

// Rend le renommage durable sous POSIX ; Windows ne permet pas d'ouvrir un dossier pour le synchroniser.
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // certains systèmes de fichiers refusent fsync sur un dossier : le renommage reste atomique
  }
}

/** Supprime les fichiers temporaires abandonnés par une écriture interrompue (processus tué, coupure). */
export async function removeStaleTemps(dir: string, now = Date.now()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!/\.\d+-[0-9a-f]{8}\.tmp$/.test(name)) continue;
    const full = path.join(dir, name);
    if (inFlightTemps.has(full)) continue;
    try {
      if (now - (await stat(full)).mtimeMs < STALE_TMP_MS) continue;
      await rm(full, { force: true });
      removed.push(name);
    } catch {
      // disparu entre-temps : rien à faire
    }
  }
  return removed;
}

// Deux enregistrements rapprochés du même fichier s'exécutent dans l'ordre d'arrivée : le dernier reçu gagne.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  queues.set(key, next);
  const release = () => {
    if (queues.get(key) === next) queues.delete(key);
  };
  next.then(release, release);
  return next;
}

// ---------------------------------------------------------------- révisions (deux onglets, scripts)

/** En-tête de réponse : révision du fichier document.json (empreinte de son contenu exact). */
export const REVISION_HEADER = 'x-doc-revision';
/** En-tête d'un PUT : révision sur laquelle repose la version envoyée par l'éditeur. */
export const BASE_REVISION_HEADER = 'x-base-revision';

// L'empreinte du contenu plutôt qu'editedAt : les scripts (derive-styles, print-swatches) réécrivent le
// fichier sans toucher à editedAt, et un onglet resté ouvert les écraserait sans rien voir.
export const documentRevision = (raw: string): string => createHash('sha256').update(raw).digest('hex').slice(0, 16);

export const CONFLICT_MESSAGE = 'Le document a été modifié ailleurs (autre onglet ou script) depuis son ouverture';

/** Document validé écrit sur le disque, et révision du fichier écrit. */
export interface SavedDocument {
  doc: LayoutDocument;
  revision: string;
}

/** Valide puis enregistre le document ; le fichier écrit est le document validé (et migré si besoin). */
export async function saveDocument(documentsDir: string, id: string, input: unknown): Promise<LayoutDocument> {
  return (await saveDocumentWithRevision(documentsDir, id, input)).doc;
}

/**
 * Comme saveDocument, et renvoie la révision écrite. `baseRevision` : révision que l'éditeur a lue ; si
 * le fichier a changé depuis, rien n'est écrit (409, avec la révision actuelle).
 */
export async function saveDocumentWithRevision(
  documentsDir: string,
  id: string,
  input: unknown,
  options: { baseRevision?: string | null } = {},
): Promise<SavedDocument> {
  assertDocId(id);
  const result = validateDocument(input);
  if (!result.ok) throw validationError(422, 'Document invalide', result.errors);
  if (result.doc.id !== id) {
    throw new HttpError(422, `Document invalide : id : « ${result.doc.id} » ne correspond pas à l'adresse (« ${id} »)`, {
      path: 'id',
      errors: [{ path: 'id', message: `attendu « ${id} »` }],
    });
  }
  const file = documentFile(documentsDir, id);
  // Indenté : document.json est suivi par git, un diff lisible permet de relire une retouche.
  const content = `${JSON.stringify(result.doc, null, 2)}\n`;
  // La place dans la file est prise sans aucun await avant : un `await mkdir` placé devant laissait deux
  // appels arrivés dans l'ordre A, B entrer dans la file dans l'ordre B, A (le premier reçu gagnait).
  await serialized(file, async () => {
    // Vérifié dans la file : deux PUT concurrents sur la même révision, le second voit le premier.
    if (options.baseRevision) {
      const onDisk = await readFile(file, 'utf8').catch(() => null);
      if (onDisk !== null && documentRevision(onDisk) !== options.baseRevision) {
        throw new HttpError(409, CONFLICT_MESSAGE, { conflict: true, revision: documentRevision(onDisk) });
      }
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, content);
  });
  return { doc: result.doc, revision: documentRevision(content) };
}

// ---------------------------------------------------------------- historique

export const HISTORY_LIMIT = 30;
const HISTORY_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.json$/;

export const historyDir = (documentsDir: string, id: string) => path.join(documentDir(documentsDir, id), 'history');

/** Copies d'historique, de la plus ancienne à la plus récente. */
export async function listHistory(documentsDir: string, id: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(historyDir(documentsDir, id));
  } catch {
    return [];
  }
  const key = (name: string) => {
    const match = HISTORY_NAME.exec(name)!;
    return { stamp: match[1], seq: Number(match[2] ?? 1) };
  };
  return entries
    .filter((name) => HISTORY_NAME.test(name))
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka.stamp < kb.stamp ? -1 : ka.stamp > kb.stamp ? 1 : ka.seq - kb.seq;
    });
}

/**
 * Copie horodatée du fichier tel qu'il est sur le disque au moment de l'ouverture. Une copie identique
 * à la précédente est omise : recharger dix fois l'éditeur ne doit pas chasser les états utiles.
 * Renvoie le nom de la copie créée, ou null.
 */
export async function snapshotDocument(documentsDir: string, id: string, raw: string): Promise<string | null> {
  const dir = historyDir(documentsDir, id);
  return serialized(dir, async () => {
    await mkdir(dir, { recursive: true });
    const existing = await listHistory(documentsDir, id);
    const latest = existing.at(-1);
    if (latest && (await readFile(path.join(dir, latest), 'utf8').catch(() => null)) === raw) return null;

    // Les deux-points sont interdits dans un nom de fichier Windows.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let name = `${stamp}.json`;
    for (let seq = 2; existing.includes(name); seq++) name = `${stamp}-${seq}.json`;
    await writeFileAtomic(path.join(dir, name), raw);

    const all = [...existing, name];
    for (const old of all.slice(0, Math.max(0, all.length - HISTORY_LIMIT))) {
      await rm(path.join(dir, old), { force: true });
    }
    return name;
  });
}

// ---------------------------------------------------------------- fichiers d'images

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/** Chemin d'un fichier du document, refusé s'il sort du dossier `assets/` du document. */
export function assetPath(documentsDir: string, id: string, relative: string): string {
  assertDocId(id);
  const root = path.join(documentDir(documentsDir, id), 'assets');
  const full = path.resolve(documentDir(documentsDir, id), relative);
  if (!full.startsWith(root + path.sep)) throw new HttpError(400, `Chemin d'image refusé : ${relative}`);
  return full;
}

const isOpenFlag = (value: string | undefined) => value !== undefined && value !== '0' && value !== 'false';

export function registerDocumentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const status = error instanceof HttpError ? error.status : (error.statusCode ?? 500);
    const details = error instanceof HttpError ? error.details : undefined;
    reply.code(status).send({ error: error.message, ...details });
  });

  app.get('/api/doc', async () => listDocuments(ctx.documentsDir));

  // `?open=1` : ouverture par l'éditeur, qui déclenche la copie d'historique (une simple lecture n'en fait pas).
  app.get<{ Params: { id: string }; Querystring: { open?: string } }>('/api/doc/:id', async (req, reply) => {
    const { raw, doc } = await loadDocument(ctx.documentsDir, req.params.id);
    reply.header(REVISION_HEADER, documentRevision(raw));
    if (isOpenFlag(req.query.open)) {
      try {
        await snapshotDocument(ctx.documentsDir, req.params.id, raw);
        await removeStaleTemps(documentDir(ctx.documentsDir, req.params.id));
        await removeStaleTemps(historyDir(ctx.documentsDir, req.params.id));
      } catch (error) {
        // Mieux vaut ouvrir le document sans copie que de bloquer l'édition.
        console.warn(`Copie d'historique impossible pour ${req.params.id} : ${(error as Error).message}`);
      }
    }
    return doc;
  });

  // Sans en-tête de révision (scripts, anciens clients), l'écriture reste inconditionnelle.
  app.put<{ Params: { id: string }; Body: unknown }>('/api/doc/:id', async (req, reply) => {
    const base = req.headers[BASE_REVISION_HEADER];
    const { revision } = await saveDocumentWithRevision(ctx.documentsDir, req.params.id, req.body, { baseRevision: typeof base === 'string' ? base : null });
    reply.header(REVISION_HEADER, revision);
    return { ok: true, id: req.params.id, savedAt: new Date().toISOString(), revision };
  });

  // Fichiers d'un document (originaux et aperçus) : /api/assets/<id>/assets/originals/photo.jpg
  app.get<{ Params: { id: string; '*': string } }>('/api/assets/:id/*', async (req, reply) => {
    const file = assetPath(ctx.documentsDir, req.params.id, req.params['*']);
    let isFile = false;
    try {
      isFile = (await stat(file)).isFile();
    } catch {
      // absent : traité ci-dessous
    }
    if (!isFile) throw new HttpError(404, `Fichier introuvable : ${req.params['*']}`);
    reply.type(CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(createReadStream(file));
  });

  registerVersionRoutes(app, ctx);
}

// ---------------------------------------------------------------- versions nommées (tâche 2.17)
//
// Une version est un instantané NOMMÉ du document, gardé dans documents/<id>/versions/<vid>.json avec
// ses métadonnées (`{ version, document }`) : un fichier se suffit à lui-même, rien à resynchroniser.
// Contrairement à l'historique automatique (history/, 30 copies tournantes), une version n'est jamais
// effacée d'office. Restaurer une version enregistre d'abord l'état courant comme version automatique.

export interface VersionMeta {
  id: string;
  name: string;
  createdAt: string;
  /** manual : enregistrée par l'utilisateur ; auto : copie faite avant une restauration. */
  kind: 'manual' | 'auto';
  /** Nom du document au moment de la version. */
  docName?: string;
}

export interface VersionFile {
  version: VersionMeta;
  document: LayoutDocument;
}

const VERSION_ID = /^v-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;
const VERSION_NAME_MAX = 120;

export const versionsDir = (documentsDir: string, id: string) => path.join(documentDir(documentsDir, id), 'versions');

function versionFile(documentsDir: string, id: string, vid: string): string {
  if (!VERSION_ID.test(vid)) throw new HttpError(400, `Identifiant de version invalide : « ${vid} »`);
  return path.join(versionsDir(documentsDir, id), `${vid}.json`);
}

function cleanVersionName(name: unknown): string {
  const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new HttpError(400, 'Nom de version manquant');
  if (text.length > VERSION_NAME_MAX) throw new HttpError(400, `Nom de version trop long (${VERSION_NAME_MAX} caractères au plus)`);
  return text;
}

/** Document fourni par l'éditeur (état à l'écran) ou, à défaut, celui du disque ; toujours validé. */
async function documentForVersion(documentsDir: string, id: string, input: unknown): Promise<LayoutDocument> {
  if (input === undefined || input === null) return readDocument(documentsDir, id);
  const result = validateDocument(input);
  if (!result.ok) throw validationError(422, 'Document de la version invalide', result.errors);
  if (result.doc.id !== id) throw new HttpError(422, `Document de la version invalide : id « ${result.doc.id} » au lieu de « ${id} »`);
  return result.doc;
}

/** Une version (métadonnées et document validé). */
export async function readVersion(documentsDir: string, id: string, vid: string): Promise<VersionFile> {
  assertDocId(id);
  let raw: string;
  try {
    raw = await readFile(versionFile(documentsDir, id, vid), 'utf8');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, `Version introuvable : ${vid}`);
  }
  const parsed = JSON.parse(raw) as VersionFile;
  const result = validateDocument(parsed.document);
  if (!result.ok) throw validationError(422, `Version ${vid} invalide`, result.errors);
  return { version: parsed.version, document: result.doc };
}

/** Versions d'un document, de la plus récente à la plus ancienne. */
export async function listVersions(documentsDir: string, id: string): Promise<VersionMeta[]> {
  assertDocId(id);
  let entries: string[];
  try {
    entries = await readdir(versionsDir(documentsDir, id));
  } catch {
    return [];
  }
  const out: VersionMeta[] = [];
  for (const name of entries) {
    const vid = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !VERSION_ID.test(vid)) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(versionsDir(documentsDir, id), name), 'utf8')) as Partial<VersionFile>;
      if (parsed.version?.id === vid) out.push(parsed.version);
    } catch {
      // fichier illisible (écriture interrompue) : ignoré dans la liste
    }
  }
  // L'identifiant commence par l'horodatage : l'ordre alphabétique inverse est l'ordre chronologique inverse.
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Enregistre une version nommée ; `document` absent = le fichier du disque. */
export async function createVersion(
  documentsDir: string,
  id: string,
  options: { name: unknown; document?: unknown; kind?: VersionMeta['kind'] },
): Promise<VersionMeta> {
  assertDocId(id);
  const name = cleanVersionName(options.name);
  const document = await documentForVersion(documentsDir, id, options.document);
  const now = new Date();
  const version: VersionMeta = {
    id: `v-${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`,
    name,
    createdAt: now.toISOString(),
    kind: options.kind ?? 'manual',
    docName: document.name,
  };
  const dir = versionsDir(documentsDir, id);
  await mkdir(dir, { recursive: true });
  const file: VersionFile = { version, document };
  await writeFileAtomic(path.join(dir, `${version.id}.json`), `${JSON.stringify(file, null, 2)}\n`);
  return version;
}

export async function deleteVersion(documentsDir: string, id: string, vid: string): Promise<void> {
  assertDocId(id);
  const file = versionFile(documentsDir, id, vid);
  try {
    await stat(file);
  } catch {
    throw new HttpError(404, `Version introuvable : ${vid}`);
  }
  await rm(file, { force: true });
}

/**
 * Restaure une version : l'état courant (`current`, l'état de l'éditeur, sinon le disque) est d'abord
 * enregistré comme version automatique, puis la version devient le document. Renvoie le document
 * restauré et la copie de sécurité.
 */
export async function restoreVersion(
  documentsDir: string,
  id: string,
  vid: string,
  options: { current?: unknown } = {},
): Promise<{ document: LayoutDocument; backup: VersionMeta; restored: VersionMeta; revision: string }> {
  const { version, document } = await readVersion(documentsDir, id, vid);
  const backup = await createVersion(documentsDir, id, {
    name: `Avant restauration de « ${version.name} »`.slice(0, VERSION_NAME_MAX),
    document: options.current,
    kind: 'auto',
  });
  // editedAt posé : un import Claude Design ne doit pas écraser un document restauré à la main.
  const saved = await saveDocumentWithRevision(documentsDir, id, { ...document, id, editedAt: new Date().toISOString() });
  // La révision permet à l'éditeur de continuer à enregistrer par-dessus le document restauré.
  return { document: saved.doc, backup, restored: version, revision: saved.revision };
}

function registerVersionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Params: { id: string } }>('/api/doc/:id/versions', async (req) => listVersions(ctx.documentsDir, req.params.id));

  app.post<{ Params: { id: string }; Body: { name?: unknown; document?: unknown } | undefined }>('/api/doc/:id/versions', async (req, reply) => {
    await loadDocument(ctx.documentsDir, req.params.id);
    const version = await createVersion(ctx.documentsDir, req.params.id, { name: req.body?.name, document: req.body?.document });
    return reply.code(201).send(version);
  });

  app.get<{ Params: { id: string; vid: string } }>('/api/doc/:id/versions/:vid', async (req) => readVersion(ctx.documentsDir, req.params.id, req.params.vid));

  app.post<{ Params: { id: string; vid: string }; Body: { current?: unknown } | undefined }>('/api/doc/:id/versions/:vid/restore', async (req) =>
    restoreVersion(ctx.documentsDir, req.params.id, req.params.vid, { current: req.body?.current }),
  );

  app.delete<{ Params: { id: string; vid: string } }>('/api/doc/:id/versions/:vid', async (req) => {
    await deleteVersion(ctx.documentsDir, req.params.id, req.params.vid);
    return { ok: true };
  });
}
