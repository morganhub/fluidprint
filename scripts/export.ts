// npm run export -- --doc <id> [--preset imprimeur|traits-de-coupe|rvb|email] [--documents <dossier>] [--confirmer-basse-resolution] [--confirmer-calques-masques]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HttpError } from '../server/documents';
import { EXPORT_PRESETS, exportPdf, parsePreset } from '../server/export';

const USAGE = `Usage : npm run export -- --doc <id> [--preset ${EXPORT_PRESETS.join('|')}] [--documents <dossier>]
  --doc        identifiant (et dossier) du document à exporter
  --preset     préréglage d'export (print/presets.json), défaut rvb
  --documents  dossier des documents, défaut <projet>/documents
  --confirmer-basse-resolution  exporter pour l'imprimeur malgré des photos sous 150 ppi
  --confirmer-calques-masques   exporter pour l'imprimeur sans les objets des calques imprimables masqués`;

// Code 1 pour toute erreur ; de simples avertissements de coupure laissent le code à 0.
async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        doc: { type: 'string' },
        preset: { type: 'string' },
        documents: { type: 'string' },
        'confirmer-basse-resolution': { type: 'boolean', default: false },
        'confirmer-calques-masques': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.doc) {
    console.error(`Option --doc manquante.\n\n${USAGE}`);
    return 1;
  }
  try {
    const result = await exportPdf({
      docId: values.doc,
      preset: parsePreset(values.preset),
      documentsDir: values.documents ? path.resolve(values.documents) : undefined,
      confirmLowResolution: values['confirmer-basse-resolution'],
      confirmHiddenLayers: values['confirmer-calques-masques'],
      onProgress: (p) => process.stderr.write(`  ${Math.round(p.progress * 100)} % ${p.label}\n`),
    });
    console.log(`PDF écrit : ${result.file}`);
    console.log(`Pages : ${result.pages}, ${(result.bytes / 1e6).toFixed(2)} Mo`);
    if (result.standard) console.log(`Norme : ${result.standard}, profil ${result.profile}`);
    for (const png of result.pngs) console.log(`Aperçu PNG : ${png}`);
    if (result.check) {
      const s = result.check.stats;
      console.log(`Contrôle PDF/X : ${result.check.ok ? 'conforme' : 'NON CONFORME'} (encrage max : vecteurs ${s.maxInkVector} %, photos ${s.maxInkImages} %)`);
    }
    if (!result.warnings.length) console.log('Avertissements : aucun');
    else {
      console.warn(`Avertissements : ${result.warnings.length}`);
      for (const warning of result.warnings) console.warn(`  - ${warning.message}`);
    }
    return 0;
  } catch (error) {
    // Une erreur prévue (document introuvable, délai dépassé) se lit en une ligne ; une autre montre sa pile.
    console.error(`Échec de l'export : ${error instanceof HttpError ? error.message : ((error as Error).stack ?? String(error))}`);
    return 1;
  }
}

process.exitCode = await main();
