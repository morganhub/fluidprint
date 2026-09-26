// Lecture d'une archive zip sans dépendance (un .docx est un zip de fichiers XML) : répertoire central,
// ZIP64, entrées stockées (0) ou compressées (8). Repris du lecteur .docx de fluidplan.
//
// Un fichier forgé peut se décompresser en gigaoctets (« bombe de décompression ») : chaque entrée et
// l'archive entière ont un plafond une fois décompressées, et le fichier reçu lui-même est plafonné.
import { inflateRawSync } from 'node:zlib';
import { ZipLimitError } from './errors';

export interface ZipLimits {
  /** Taille maximale du fichier .docx lui-même. */
  inputBytes: number;
  /** Taille maximale d'une entrée une fois décompressée. */
  entryBytes: number;
  /** Taille maximale de toutes les entrées lues, une fois décompressées. */
  totalBytes: number;
}

export const ZIP_LIMITS: ZipLimits = { inputBytes: 100 * 1024 * 1024, entryBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };

export const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} Mo`;

export interface ZipArchive {
  names: string[];
  /** Nom réel d'une entrée : les noms de parties OPC ne distinguent pas la casse et sont parfois encodés en %xx. */
  find(name: string): string | undefined;
  /** Contenu décompressé d'une entrée (compte dans le budget de l'archive). */
  read(name: string): Buffer;
}

interface ZipEntry {
  flags: number;
  method: number;
  csize: number;
  usize: number;
  local: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOCATOR = 0x07064b50;
const U32_MAX = 0xffffffff;

/** Erreur de structure : l'archive n'est pas lisible (message destiné à l'utilisateur). */
export class ZipFormatError extends Error {}

export function openZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipArchive {
  const end = findEndOfCentralDirectory(buf);
  if (end === -1) throw new ZipFormatError('ce n’est pas une archive zip (fin du répertoire central introuvable) : fichier d’un autre format, ou tronqué');
  let entries: Map<string, ZipEntry>;
  try {
    entries = readCentralDirectory(buf, end);
  } catch (error) {
    if (error instanceof RangeError) throw new ZipFormatError('archive zip abîmée : structure hors des limites du fichier');
    throw error;
  }
  const byLowerName = new Map([...entries.keys()].map((name) => [name.toLowerCase(), name]));
  const find = (name: string): string | undefined => {
    if (entries.has(name)) return name;
    const lower = byLowerName.get(name.toLowerCase());
    if (lower) return lower;
    try {
      const decoded = decodeURIComponent(name);
      return entries.has(decoded) ? decoded : byLowerName.get(decoded.toLowerCase());
    } catch {
      return undefined;
    }
  };
  let decompressed = 0;
  return {
    names: [...entries.keys()],
    find,
    read(name) {
      const entry = entries.get(find(name) ?? '');
      if (!entry) throw new Error(`entrée absente : ${name}`);
      const budget = Math.min(limits.entryBytes, limits.totalBytes - decompressed);
      if (budget <= 0) throw new ZipLimitError(`archive de plus de ${megabytes(limits.totalBytes)} une fois décompressée`);
      const out = extract(buf, entry, budget, limits);
      decompressed += out.length;
      return out;
    },
  };
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // Le commentaire de fin d'archive fait au plus 65 535 octets : inutile de chercher plus loin.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let p = buf.length - 22; p >= min; p--) {
    if (buf[p] === 0x50 && buf[p + 1] === 0x4b && buf.readUInt32LE(p) === SIG_END) return p;
  }
  return -1;
}

function toSafeNumber(big: bigint): number {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('valeur zip64 hors limites');
  return Number(big);
}

function readCentralDirectory(buf: Buffer, end: number): Map<string, ZipEntry> {
  const corrupt = (why: string) => new ZipFormatError(`archive zip abîmée : ${why}`);
  let count = buf.readUInt16LE(end + 10);
  let size = buf.readUInt32LE(end + 12);
  let offset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || size === U32_MAX || offset === U32_MAX) {
    const locator = end - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === SIG_END64_LOCATOR) {
      const record = toSafeNumber(buf.readBigUInt64LE(locator + 8));
      if (record + 56 <= buf.length && buf.readUInt32LE(record) === SIG_END64) {
        count = toSafeNumber(buf.readBigUInt64LE(record + 32));
        size = toSafeNumber(buf.readBigUInt64LE(record + 40));
        offset = toSafeNumber(buf.readBigUInt64LE(record + 48));
      }
    }
  }
  if (offset + size > buf.length) throw corrupt('répertoire central hors du fichier (fichier tronqué ?)');

  const entries = new Map<string, ZipEntry>();
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw corrupt('entrée du répertoire central illisible');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    if (csize === U32_MAX || usize === U32_MAX || local === U32_MAX) {
      // Champ extra ZIP64 (id 1) : seules les valeurs saturées à 0xFFFFFFFF y figurent, dans cet ordre.
      for (let e = p + 46 + nameLen, stop = e + extraLen; e + 4 <= stop; e += 4 + buf.readUInt16LE(e + 2)) {
        if (buf.readUInt16LE(e) !== 1) continue;
        let q = e + 4;
        const next = () => toSafeNumber(buf.readBigUInt64LE((q += 8) - 8));
        if (usize === U32_MAX) usize = next();
        if (csize === U32_MAX) csize = next();
        if (local === U32_MAX) local = next();
        break;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.set(name, { flags, method, csize, usize, local });
  }
  return entries;
}

function extract(buf: Buffer, entry: ZipEntry, limit: number, limits: ZipLimits): Buffer {
  if (entry.flags & 1) throw new Error('entrée chiffrée');
  const p = entry.local;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error('en-tête local introuvable');
  // Les longueurs du nom et de l'extra de l'en-tête local peuvent différer de celles du répertoire central.
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const stop = start + entry.csize;
  if (stop > buf.length) throw new Error('données tronquées');
  const data = buf.subarray(start, stop);
  const tooLarge = () =>
    new ZipLimitError(
      limit < limits.entryBytes ? `archive de plus de ${megabytes(limits.totalBytes)} une fois décompressée` : `entrée de plus de ${megabytes(limit)} une fois décompressée`,
    );
  if (entry.method === 0) {
    if (data.length > limit) throw tooLarge();
    return Buffer.from(data);
  }
  if (entry.method === 8) {
    try {
      // maxOutputLength arrête la décompression au plafond : une bombe ne remplit jamais la mémoire.
      return inflateRawSync(data, { maxOutputLength: limit });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) throw tooLarge();
      throw new Error(`décompression impossible (${(error as Error).message})`);
    }
  }
  throw new Error(`méthode de compression ${entry.method} non prise en charge`);
}
