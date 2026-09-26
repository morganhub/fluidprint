// Côté navigateur de l'import Word : envoi du fichier au serveur, et passage du fichier lu de la page
// d'accueil (« Nouveau document depuis Word ») à l'éditeur qui remplit le document neuf.
import { serverFetch } from '../store/http';
import type { PlaceWordOptions } from './place';
import type { NewFromWordResponse, WordImportResponse } from './types';

/** Type MIME d'un .docx (glisser-déposer, sélecteur de fichier). */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Pour un <input type="file">. */
export const DOCX_ACCEPT = `.docx,${DOCX_MIME}`;

/** Fichier Word (ou qui s'annonce comme tel : .doc compris, pour le refuser clairement plutôt que l'ignorer). */
export const isWordFile = (file: { name: string; type: string }): boolean => /\.(docx?|docm|dotx)$/i.test(file.name) || file.type === DOCX_MIME || file.type === 'application/msword';

/** Un glisser qui ne transporte QUE des fichiers Word (types connus pendant le survol, pas les noms). */
export function carriesOnlyWordFiles(dt: DataTransfer | null): boolean {
  if (!dt || !dt.types.includes('Files')) return false;
  const items = [...(dt.items ?? [])].filter((i) => i.kind === 'file');
  return items.length > 0 && items.every((i) => i.type === DOCX_MIME || i.type === 'application/msword');
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Erreur ${res.status}`;
}

/** Envoie un .docx pour un document ouvert : structure du texte et photos enregistrées (POST /api/doc/:id/word). */
export async function uploadWord(docId: string, file: File): Promise<WordImportResponse> {
  const body = new FormData();
  body.append('file', file, file.name);
  const res = await serverFetch(`/api/doc/${encodeURIComponent(docId)}/word`, { method: 'POST', body }, 'fichier Word non envoyé, réessayez');
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as WordImportResponse;
}

/** Crée un document d'après un gabarit et y lit un .docx (POST /api/doc/from-word). */
export async function createFromWord(file: File, fields: { name: string; templateId: string }): Promise<NewFromWordResponse> {
  const body = new FormData();
  if (fields.name.trim()) body.append('name', fields.name.trim());
  body.append('templateId', fields.templateId);
  body.append('file', file, file.name);
  const res = await serverFetch('/api/doc/from-word', { method: 'POST', body }, 'document non créé, réessayez');
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as NewFromWordResponse;
}

// ---------------------------------------------------------------- remplissage d'un document neuf

/** Fichier Word lu à la création du document, que l'éditeur place en ouvrant le document. */
export interface PendingWord {
  response: WordImportResponse;
  options: PlaceWordOptions;
}

const pendingKey = (docId: string) => `fluidprint:word-pending:${docId}`;

/**
 * Garde le fichier lu le temps d'ouvrir l'éditeur (même onglet). L'éditeur seul sait mesurer la coulée du
 * texte (polices, coupures de Chrome) : c'est lui qui remplit les faces.
 */
export function stashPendingWord(docId: string, pending: PendingWord): void {
  sessionStorage.setItem(pendingKey(docId), JSON.stringify(pending));
}

/** Reprend (une seule fois) le fichier lu pour ce document. */
export function takePendingWord(docId: string): PendingWord | null {
  try {
    const raw = sessionStorage.getItem(pendingKey(docId));
    if (!raw) return null;
    sessionStorage.removeItem(pendingKey(docId));
    return JSON.parse(raw) as PendingWord;
  } catch {
    return null;
  }
}

/**
 * Charge toutes les graisses d'Open Sans avant de mesurer une coulée : les styles créés pour un fichier Word
 * (titres en 700 ou 800, citations en italique) peuvent employer des faces encore jamais affichées, et une
 * mesure faite avant leur chargement couperait faux.
 */
export async function loadWordFonts(): Promise<void> {
  const faces = [400, 600, 700, 800].flatMap((w) => [`${w} 16px 'Open Sans'`, `italic ${w} 16px 'Open Sans'`]);
  await Promise.all(faces.map((f) => document.fonts.load(f).catch(() => [])));
  await document.fonts.ready;
}
