// Import d'un design Claude Design vers documents/<id>/document.json, quel que soit
// son format : gabarit imposé, gabarit reconnu ou format sur mesure (voir designFormat.ts).
//
// Décision S3 : l'import est une amorce unique, l'éditeur fait foi ensuite. L'import refuse donc
// d'écraser un document existant, et `--replace` n'est admis que si l'éditeur ne l'a jamais enregistré.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { docIdFromName } from '../../src/model/newDocument';
import { assertValidDocument } from '../../src/model/validate';
import type { LayoutDocument } from '../../src/model/types';
import { launchBrowser } from '../../server/chrome';
import { documentFile, writeFileAtomic } from '../../server/documents';
import { DEFAULT_DOCUMENTS_DIR, documentDir, PROJECT_ROOT } from '../../server/paths';
import { reserveDocumentDir } from '../../server/templates';
import { describeOrigin, resolveFormat, type ResolvedFormat } from './designFormat';
import { loadDesign, openDesignPage } from './designPage';
import { createIconMatcher } from './icons';
import { measureDesign, type MeasureResult, type MNode } from './measure';
import { decodeQrCodes, matchingQrSettings, modulesFromPath } from './qr';
import { renderReport } from './report';
import { buildDocument, type BuildResult, type QrInfo } from './toObjects';

/**
 * Copie du design gardée dans le dossier du document (route d'import, ligne de commande) : elle devient la
 * source du document, que le contrôle au pixel relit même si le fichier d'origine a bougé ou disparu.
 */
export const DESIGN_COPY_NAME = 'design.dc.html';

export interface ImportOptions {
  /** Identifiant (et dossier) du document ; défaut : tiré du nom, rendu unique. */
  id?: string;
  /** Nom du document ; défaut : `<title>` du design, sinon le nom du fichier. */
  name?: string;
  /** Export HTML de Claude Design à importer (obligatoire : il n'y a pas de design par défaut). */
  designFile: string;
  /** Nom d'origine du fichier, quand `designFile` n'en est qu'une copie temporaire (import depuis l'interface). */
  designName?: string;
  documentsDir?: string;
  replace?: boolean;
  /** Gabarit imposé (identifiant de src/model/templates) ; défaut : gabarit reconnu, sinon format sur mesure. */
  templateId?: string;
  /** Garde une copie du design dans le dossier du document : elle devient la source du document. */
  keepDesignCopy?: boolean;
  log?: (message: string) => void;
}

export interface ImportOutcome {
  documentFile: string;
  reportFile: string;
  doc: LayoutDocument;
  result: BuildResult;
  resolved: ResolvedFormat;
  durationMs: number;
}

/** Refus du garde-fou : le message nomme toujours le fichier concerné. */
export class ImportRefusedError extends Error {}

/** Vérifie qu'on a le droit d'écrire documents/<id>/document.json ; renvoie son chemin. */
export async function checkImportTarget(documentsDir: string, id: string, replace: boolean): Promise<string> {
  const file = documentFile(documentsDir, id);
  if (!existsSync(file)) return file;
  if (!replace) {
    throw new ImportRefusedError(
      `Le document ${file} existe déjà : l'import ne l'écrase pas. Choisissez un autre identifiant (par exemple --id ${id}-2), ` +
        `ou relancez avec --replace s'il n'a jamais été modifié dans l'éditeur.`,
    );
  }
  let existing: { editedAt?: unknown };
  try {
    existing = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ImportRefusedError(`Refus de remplacer ${file} : fichier illisible (${(error as Error).message}). Importez sous un autre identifiant avec --id.`);
  }
  if (existing && typeof existing === 'object' && existing.editedAt !== undefined) {
    throw new ImportRefusedError(
      `Refus de remplacer ${file} : il a été modifié dans l'éditeur (editedAt = ${String(existing.editedAt)}). ` +
        `Importez sous un autre identifiant, par exemple --id ${id}-2.`,
    );
  }
  return file;
}

// ---------------------------------------------------------------- nom et identifiant

/** Nom lisible d'un fichier de design : « Flyer_A5.dc.html » → « Flyer A5 ». */
export function nameFromFileName(file: string): string {
  const leaf = file.split(/[\\/]/).pop() ?? '';
  return leaf
    .replace(/\.html?$/i, '')
    .replace(/\.dc$/i, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chemin du design pour `doc.source.path` : relatif au projet s'il y est, absolu sinon. */
function sourcePathOf(file: string): string {
  const relative = path.relative(PROJECT_ROOT, file);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return (inside ? relative : file).split(path.sep).join('/');
}

function walk(nodes: MNode[], fn: (node: MNode) => void): void {
  for (const node of nodes) {
    fn(node);
    walk(node.children, fn);
  }
}

// ---------------------------------------------------------------- import

export async function runImport(options: ImportOptions): Promise<ImportOutcome> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const documentsDir = path.resolve(options.documentsDir ?? DEFAULT_DOCUMENTS_DIR);
  if (!options.designFile) throw new ImportRefusedError('Aucun design à importer : indiquez le fichier exporté de Claude Design (--design).');
  const designFile = path.resolve(options.designFile);
  if (!existsSync(designFile)) throw new ImportRefusedError(`Design introuvable : ${designFile}`);

  // Lu et rangé avant d'ouvrir Chrome : un fichier ou un gabarit refusé doit l'être immédiatement.
  const design = await loadDesign(designFile);
  const resolved = resolveFormat(design, { templateId: options.templateId });
  const name = options.name?.replace(/\s+/g, ' ').trim() || design.title || nameFromFileName(options.designName ?? designFile) || 'Design importé';
  // Identifiant tiré du nom comme pour un nouveau document (« Dépliant exemple » → depliant-exemple), rendu
  // unique par -2, -3… à l'écriture ; mais un identifiant choisi (--id) ou --replace passent par le garde-fou
  // d'écrasement : un document retouché dans l'éditeur n'est jamais remplacé.
  const guarded = options.id !== undefined || !!options.replace;
  const baseId = options.id ?? docIdFromName(name);
  if (guarded) await checkImportTarget(documentsDir, baseId, !!options.replace);

  log(`${describeOrigin(resolved)} (${resolved.format.faces.length} face(s))`);
  log(`Mesure du design ${designFile}…`);
  const browser = await launchBrowser();
  let measure: MeasureResult;
  const qr = new Map<number, QrInfo>();
  try {
    const { page } = await openDesignPage(browser, { designFile, resolved });
    measure = await measureDesign(page);
    const qrNodes: MNode[] = [];
    walk(
      measure.faces.flatMap((f) => f.children),
      (n) => n.svg?.attrs['shape-rendering'] === 'crispEdges' && qrNodes.push(n),
    );
    log(`Décodage de ${qrNodes.length} QR code(s)…`);
    for (const decoded of await decodeQrCodes(
      page,
      qrNodes.map((n) => n.imp),
    )) {
      const node = qrNodes.find((n) => n.imp === decoded.imp)!;
      const info: QrInfo = { url: decoded.url, ...(decoded.error ? { error: decoded.error } : {}) };
      const d = node.svg!.elements.find((e) => e.tag.toLowerCase() === 'path')?.attrs.d;
      const vb = (node.svg!.attrs.viewBox ?? '').split(/\s+/).map(Number);
      if (decoded.url && d && vb.length === 4) {
        // viewBox « -m -m n+2m n+2m » : n modules et m modules de marge.
        const size = Math.round(vb[2] + 2 * vb[0]);
        const { matches, defaultMask } = matchingQrSettings(decoded.url, modulesFromPath(d, size));
        info.designSettings = matches;
        info.defaultMask = defaultMask;
      }
      qr.set(decoded.imp, info);
    }
  } finally {
    await browser.close();
  }

  // Le garde-fou est repassé juste avant d'écrire : l'éditeur a pu créer le document pendant la mesure.
  let id = baseId;
  let file: string;
  if (guarded) {
    file = await checkImportTarget(documentsDir, id, !!options.replace);
    await mkdir(documentDir(documentsDir, id), { recursive: true });
  } else {
    // Création exclusive du dossier, comme pour un nouveau document : deux imports simultanés (ou un import
    // et une création depuis l'accueil) n'obtiennent jamais le même identifiant.
    id = await reserveDocumentDir(documentsDir, baseId);
    file = documentFile(documentsDir, id);
  }
  const dir = path.dirname(file);
  try {
    let source = designFile;
    if (options.keepDesignCopy) {
      source = path.join(dir, DESIGN_COPY_NAME);
      await copyFile(designFile, source);
    }
    const importedAt = new Date().toISOString();
    const result = buildDocument({
      measure,
      resolved,
      designWarnings: design.warnings,
      qr,
      icons: createIconMatcher(),
      id,
      name,
      sourcePath: sourcePathOf(source),
      importedAt,
    });
    const doc = assertValidDocument(result.doc);
    await writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
    const reportFile = path.join(dir, 'import-report.md');
    const durationMs = Date.now() - started;
    await writeFileAtomic(reportFile, renderReport(result, { documentFile: file, durationMs }));
    log(`Document écrit : ${file}`);
    log(`Rapport : ${reportFile}`);
    return { documentFile: file, reportFile, doc, result, resolved, durationMs };
  } catch (error) {
    // Dossier réservé pour cet import : il ne doit pas rester vide et bloquer l'identifiant.
    if (!guarded) await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
