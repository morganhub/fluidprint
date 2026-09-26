// npm run derive-styles -- --doc <id> [--documents <dossier>] [--dry-run]
//
// Déduit les styles de texte d'un document importé (tâche 2.22, décision E3) : les blocs sont regroupés
// par rôle d'après leur corps, leur graisse, leur casse et leur interlettrage ; chaque rôle devient un
// style de paragraphe (valeurs les plus fréquentes du groupe), chaque mise en forme locale récurrente
// (nuance, graisse) un style de caractère. Rien ne bouge à l'œil : les valeurs exactes de chaque bloc
// restent en place et deviennent ses écarts par rapport au style (voir src/model/styles.ts).
// Relançable : un style déjà présent (même nom) est mis à jour, pas dupliqué.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readDocument, saveDocument } from '../server/documents';
import { DEFAULT_DOCUMENTS_DIR } from '../server/paths';
import { CHARACTER_STYLE_KEYS, newStyleId, textOverrides, type CharacterStyleValues } from '../src/model/styles';
import type { LayoutDocument, TextObject, TextRun, TextStyle } from '../src/model/types';

/** Plafond fixé par le plan : au-delà, les styles ne simplifient plus rien. */
export const MAX_PARAGRAPH_STYLES = 12;

/** Rôles dans l'ordre d'affichage du panneau Styles. */
export const ROLES = [
  'Titre de couverture',
  'Titre de volet',
  'Sous-titre',
  'Accroche',
  'Intertitre',
  'Étiquette',
  'Titre de carte',
  'Corps',
  'Légende',
  'Chiffre clé',
  "Numéro d'étape",
] as const;
export type Role = (typeof ROLES)[number];

const plainText = (obj: TextObject) => obj.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n').trim();

/** Rôle d'un bloc d'après sa mise en forme (corps, graisse, casse, interlettrage, alignement). */
export function classifyText(obj: TextObject): Role {
  const s = obj.style;
  const upper = s.transform === 'uppercase';
  if (s.fontSize >= 20) return 'Titre de couverture';
  if (s.fontSize >= 14.5) return 'Titre de volet';
  // Chiffres mis en avant (« 83 », « 10 min à 3 h ») : gros, très gras, centrés.
  if (s.fontSize >= 10 && s.fontWeight >= 800 && s.align === 'center') return 'Chiffre clé';
  if (s.fontSize >= 13) return 'Chiffre clé';
  if (/^\d{1,2}$/.test(plainText(obj)) && s.fontWeight >= 700) return "Numéro d'étape";
  if (upper && s.letterSpacing >= 0.05) return 'Intertitre';
  if (upper) return 'Étiquette';
  if (s.fontSize >= 9.5) return 'Sous-titre';
  if (s.fontSize >= 8) return 'Accroche';
  if (s.fontWeight >= 600) return 'Titre de carte';
  return s.fontSize >= 7 ? 'Corps' : 'Légende';
}

/** Valeur la plus fréquente (à égalité : la première rencontrée). */
function mode<T>(values: T[]): T {
  const counts = new Map<string, { value: T; n: number }>();
  for (const v of values) {
    const key = JSON.stringify(v ?? null);
    const entry = counts.get(key) ?? { value: v, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0].value;
}

function representativeStyle(objs: TextObject[]): TextStyle {
  const keys = [...new Set(objs.flatMap((o) => Object.keys(o.style)))] as (keyof TextStyle)[];
  const style: Record<string, unknown> = {};
  for (const key of keys) {
    const value = mode(objs.map((o) => o.style[key]));
    if (value !== undefined) style[key] = structuredClone(value);
  }
  return style as unknown as TextStyle;
}

// ---------------------------------------------------------------- styles de caractère

const CHARACTER_KEYS = new Set<string>(['color', 'fontWeight']);

/** Signature d'un segment qui ne porte qu'une nuance et/ou une graisse (sinon : retouche locale). */
function runSignature(run: TextRun): CharacterStyleValues | null {
  const keys = CHARACTER_STYLE_KEYS.filter((k) => run[k] !== undefined);
  if (!keys.length || keys.some((k) => !CHARACTER_KEYS.has(k))) return null;
  const sig: CharacterStyleValues = {};
  if (run.color) sig.color = structuredClone(run.color);
  if (run.fontWeight !== undefined) sig.fontWeight = run.fontWeight;
  return sig;
}

function characterStyleName(doc: LayoutDocument, sig: CharacterStyleValues): string {
  const weight = sig.fontWeight === undefined ? null : sig.fontWeight >= 600 ? 'Gras' : 'Normal';
  const swatch = sig.color ? (doc.swatches.find((s) => s.id === sig.color!.swatch)?.name ?? sig.color.swatch) : null;
  if (weight && swatch) return `${weight} ${swatch.toLowerCase()}`;
  if (swatch) return `Accent ${swatch.toLowerCase()}`;
  return weight!;
}

// ---------------------------------------------------------------- déduction

export interface DeriveReport {
  paragraph: { id: string; name: string; blocks: number; sizes: number[]; withOverrides: number }[];
  character: { id: string; name: string; runs: number }[];
}

/** Déduit et applique les styles (le document est modifié en place). */
export function deriveStyles(doc: LayoutDocument): DeriveReport {
  const texts = Object.values(doc.objects).filter((o): o is TextObject => o.type === 'text');
  const groups = new Map<Role, TextObject[]>();
  for (const t of texts) {
    const role = classifyText(t);
    groups.set(role, [...(groups.get(role) ?? []), t]);
  }

  const report: DeriveReport = { paragraph: [], character: [] };
  for (const role of ROLES) {
    const members = groups.get(role);
    if (!members?.length) continue;
    const style = representativeStyle(members);
    let ps = doc.styles.paragraph.find((p) => p.name === role);
    if (ps) ps.style = style;
    else {
      ps = { id: newStyleId(doc, 'ps', role), name: role, style };
      doc.styles.paragraph.push(ps);
    }
    // Seule la référence change : chaque bloc garde ses valeurs exactes (écarts).
    for (const t of members) t.paragraphStyleId = ps.id;
    report.paragraph.push({
      id: ps.id,
      name: role,
      blocks: members.length,
      sizes: [...new Set(members.map((m) => m.style.fontSize))].sort((a, b) => a - b),
      withOverrides: members.filter((m) => textOverrides(doc, m).some((o) => o.level === 'bloc')).length,
    });
  }
  if (doc.styles.paragraph.length > MAX_PARAGRAPH_STYLES) {
    throw new Error(`${doc.styles.paragraph.length} styles de paragraphe : au plus ${MAX_PARAGRAPH_STYLES} attendus`);
  }

  const charCounts = new Map<string, number>();
  for (const t of texts) {
    for (const para of t.paragraphs) {
      for (const run of para.runs) {
        const sig = runSignature(run);
        if (!sig) continue;
        const name = characterStyleName(doc, sig);
        let cs = doc.styles.character.find((c) => c.name === name);
        if (!cs) {
          cs = { id: newStyleId(doc, 'cs', name), name, style: sig };
          doc.styles.character.push(cs);
        }
        run.characterStyleId = cs.id;
        charCounts.set(cs.id, (charCounts.get(cs.id) ?? 0) + 1);
      }
    }
  }
  report.character = doc.styles.character.filter((c) => charCounts.has(c.id)).map((c) => ({ id: c.id, name: c.name, runs: charCounts.get(c.id)! }));
  return report;
}

// ---------------------------------------------------------------- ligne de commande

const USAGE = `Usage : npm run derive-styles -- --doc <id> [--documents <dossier>] [--dry-run]
  --doc        document à traiter (dossier documents/<id>)
  --documents  dossier des documents, défaut <projet>/documents
  --dry-run    affiche les styles déduits sans rien écrire`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        doc: { type: 'string' },
        documents: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
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
  if (!values.doc) {
    console.error(`Option --doc manquante.\n\n${USAGE}`);
    return 2;
  }
  const documentsDir = path.resolve(values.documents ?? DEFAULT_DOCUMENTS_DIR);
  try {
    const doc = await readDocument(documentsDir, values.doc);
    const report = deriveStyles(doc);
    console.log(`Styles de paragraphe (${report.paragraph.length}) :`);
    for (const p of report.paragraph) {
      const sizes = p.sizes.map((s) => `${String(s).replace('.', ',')} pt`).join(', ');
      console.log(`  ${p.name.padEnd(20)} ${String(p.blocks).padStart(3)} bloc(s), ${sizes}${p.withOverrides ? ` — ${p.withOverrides} avec écarts` : ''}`);
    }
    console.log(`Styles de caractère (${report.character.length}) :`);
    for (const c of report.character) console.log(`  ${c.name.padEnd(32)} ${String(c.runs).padStart(3)} segment(s)`);
    if (values['dry-run']) {
      console.log('Essai à blanc : rien n’a été écrit.');
      return 0;
    }
    await saveDocument(documentsDir, values.doc, doc);
    console.log(`Écrit : ${path.join(documentsDir, values.doc, 'document.json')}`);
    return 0;
  } catch (error) {
    console.error(`Échec de la déduction des styles : ${(error as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
