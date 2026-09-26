import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Racine du projet : l'application y vit, et ses documents dans `documents/`. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

// Les documents sont les données de l'utilisateur (ignorées par git) ; la variable d'environnement permet
// de les ranger ailleurs sans toucher au code.
export const DEFAULT_DOCUMENTS_DIR = process.env.FLUIDPRINT_DOCUMENTS_DIR ?? path.join(PROJECT_ROOT, 'documents');

// Un identifiant de document sert de nom de dossier : on refuse tout ce qui pourrait sortir du dossier documents.
export function isValidDocId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

export function documentDir(documentsDir: string, id: string): string {
  if (!isValidDocId(id)) throw new Error(`Identifiant de document invalide : « ${id} »`);
  return path.join(documentsDir, id);
}
