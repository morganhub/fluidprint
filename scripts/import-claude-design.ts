// npm run import:claude-design -- --design <fichier .dc.html> [--name <nom>] [--template <gabarit>] [--id <id>] [--documents <dossier>] [--replace]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TEMPLATES } from '../src/model/templates';
import { DesignImportError } from './import/designSource';
import { DESIGN_COPY_NAME, ImportRefusedError, runImport } from './import/importer';
import { countObjects } from './import/report';

const USAGE = `Usage : npm run import:claude-design -- --design <fichier> [--name <nom>] [--template <gabarit>] [--id <id>] [--documents <dossier>] [--replace]
  --design     design Claude Design à importer (export HTML), obligatoire ; il est copié dans
               documents/<id>/${DESIGN_COPY_NAME}, source du document et référence du contrôle au pixel
  --name       nom du document, défaut : <title> du design, sinon le nom du fichier
  --template   gabarit imposé (${TEMPLATES.map((t) => t.id).join(', ')}) ;
               défaut : le gabarit dont les faces ont la taille du design, sinon un format sur mesure
  --id         identifiant (et dossier) du document, défaut : tiré du nom et rendu unique ;
               un identifiant choisi n'est jamais dédoublé (refus s'il existe, sauf --replace)
  --documents  dossier des documents, défaut <projet>/documents
  --replace    remplacer un document existant, seulement s'il n'a jamais été modifié dans l'éditeur`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        id: { type: 'string' },
        name: { type: 'string' },
        template: { type: 'string' },
        design: { type: 'string' },
        documents: { type: 'string' },
        replace: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.design) {
    console.error(`Option --design manquante : indiquez l'export HTML de Claude Design à importer.\n\n${USAGE}`);
    return 2;
  }
  try {
    const outcome = await runImport({
      id: values.id,
      name: values.name,
      templateId: values.template,
      designFile: path.resolve(values.design),
      // Comme la route d'import : le document garde sa copie du design, quoi qu'il advienne du fichier d'origine.
      keepDesignCopy: true,
      documentsDir: values.documents ? path.resolve(values.documents) : undefined,
      replace: values.replace,
      log: (m) => console.log(m),
    });
    const { byType, total } = countObjects(outcome.doc);
    console.log(`${outcome.doc.name} (${outcome.doc.id}) : ${total} objets : ${[...byType.entries()].map(([t, n]) => `${n} ${t}`).join(', ')}`);
    for (const q of outcome.result.qrCodes) console.log(`QR ${q.id} (${q.faceId}) : ${q.url}${q.decoded ? '' : ' — ILLISIBLE, adresse provisoire'}`);
    for (const w of outcome.result.warnings.filter((i) => i.faceId === 'document')) console.warn(`Attention : ${w.what} : ${w.why}`);
    const problems = outcome.result.unknownIcons.length + outcome.result.qrCodes.filter((q) => !q.decoded).length + outcome.result.warnings.length;
    if (problems) console.warn(`${problems} point(s) à vérifier : voir ${outcome.reportFile}`);
    return 0;
  } catch (error) {
    const expected = error instanceof ImportRefusedError || error instanceof DesignImportError;
    console.error(expected ? (error as Error).message : `Échec de l'import : ${(error as Error).stack ?? error}`);
    return 1;
  }
}

process.exitCode = await main();
