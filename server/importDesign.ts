// Import d'un design Claude Design depuis l'interface : POST /api/import/claude-design.
//
// Corps multipart : `file` (l'export HTML du design), `name` et `template` facultatifs. L'importeur de la
// ligne de commande (scripts/import) tourne ici, dans le dossier documents du serveur ; il répond
// 201 { id, report } une fois le document écrit. Le fichier reçu n'est que temporaire : une copie en est
// gardée dans le dossier du document (source du document et du contrôle au pixel).
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesignImportError, parseDesign } from '../scripts/import/designSource';
import { ImportRefusedError, runImport } from '../scripts/import/importer';
import { summarizeImport, type ImportSummary } from '../scripts/import/report';
import { findTemplate, TEMPLATES } from '../src/model/templates';
import { HttpError } from './documents';
import type { RouteContext } from './routes';

/** Un design exporté pèse quelques centaines de Ko ; des images incorporées en data: URL peuvent le grossir. */
export const MAX_DESIGN_BYTES = 30 * 1024 * 1024;
const NAME_MAX = 120;
/** Valeur du champ `template` qui laisse l'importeur choisir (comme l'absence du champ). */
export const AUTO_TEMPLATE = 'auto';

export interface ImportResponse {
  id: string;
  report: ImportSummary;
}

// Un import à la fois : chacun lance son propre Chrome pour mesurer le design, et deux imports
// simultanés se disputeraient la machine (mesures plus lentes, délais dépassés). Les suivants attendent.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => undefined).then(task);
  queue = run;
  return run;
}

interface Upload {
  filename: string;
  data: Buffer;
}

/** Lit le corps multipart : le fichier en mémoire (il est petit) et les champs texte. */
async function readForm(parts: AsyncIterableIterator<import('@fastify/multipart').Multipart>): Promise<{ upload: Upload | null; fields: Record<string, string> }> {
  let upload: Upload | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of parts) {
      if (part.type === 'file') {
        upload = { filename: part.filename.split(/[\\/]/).pop() || 'design.html', data: await part.toBuffer() };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, `Fichier trop lourd : ${MAX_DESIGN_BYTES / 1024 / 1024} Mo au maximum pour un design`);
    if (code === 'FST_FILES_LIMIT') throw new HttpError(400, 'Un seul fichier à la fois : l’export HTML du design');
    throw error;
  }
  return { upload, fields };
}

export function registerImportRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/api/import/claude-design', async (req, reply) => {
    if (!req.isMultipart()) {
      throw new HttpError(415, 'Envoi attendu en multipart/form-data : le fichier .html du design (champ « file »), et « name », « template » facultatifs');
    }
    const { upload, fields } = await readForm(req.parts({ limits: { fileSize: MAX_DESIGN_BYTES, files: 1, fields: 10, fieldSize: 10_000 } }));
    if (!upload || !upload.data.length) throw new HttpError(400, 'Aucun fichier reçu : choisissez l’export HTML du design (fichier .html)');
    if (!/\.html?$/i.test(upload.filename)) {
      throw new HttpError(400, `« ${upload.filename} » n'est pas un fichier .html : exportez le design depuis Claude Design au format HTML`);
    }

    // Contrôlé tout de suite, sans attendre son tour ni lancer Chrome : un fichier quelconque est refusé net.
    try {
      parseDesign(upload.data.toString('utf8'));
    } catch (error) {
      if (error instanceof DesignImportError) throw new HttpError(400, `${upload.filename} : ${error.message}`);
      throw error;
    }
    const template = (fields.template ?? '').trim();
    const templateId = template && template !== AUTO_TEMPLATE ? template : undefined;
    if (templateId && !findTemplate(templateId)) {
      throw new HttpError(400, `Gabarit inconnu : « ${templateId} ». Gabarits disponibles : ${TEMPLATES.map((t) => t.id).join(', ')}`);
    }
    const name = (fields.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length > NAME_MAX) throw new HttpError(400, `Nom trop long (${NAME_MAX} caractères au plus)`);

    let outcome;
    try {
      outcome = await enqueue(async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-upload-'));
        try {
          const designFile = path.join(dir, 'design.dc.html');
          await writeFile(designFile, upload.data);
          return await runImport({
            designFile,
            designName: upload.filename,
            documentsDir: ctx.documentsDir,
            ...(name ? { name } : {}),
            ...(templateId ? { templateId } : {}),
            keepDesignCopy: true,
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    } catch (error) {
      // Gabarit dont la taille ne correspond pas, fichier refusé : l'utilisateur peut corriger son choix.
      if (error instanceof DesignImportError) throw new HttpError(400, error.message);
      if (error instanceof ImportRefusedError) throw new HttpError(409, error.message);
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, `Échec de l'import : ${(error as Error).message}`);
    }
    const body: ImportResponse = { id: outcome.doc.id, report: summarizeImport(outcome.result, outcome.durationMs) };
    return reply.code(201).send(body);
  });
}
