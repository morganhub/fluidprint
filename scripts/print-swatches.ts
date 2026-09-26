// Nuancier d'impression d'un document :
//   npm run print-swatches -- --doc <id> [--documents <dossier>] [--profile FOGRA39] [--dry-run]
//       [--no-small-text] [--only <id,…>] [--keep <id,…>] [--inks toutes|sans-jaune] [--no-qr]
//
// 1. Chaque nuance sans encres reçoit son CMJN : la couleur du design convertie par le profil de sortie
//    (colorimétrie relative, compensation du point noir, encrage plafonné comme le préréglage imprimeur) ;
//    la couleur du design est gardée dans `sourceRgb`.
// 2. Petits textes (moins de 9 pt) : un texte en quatre encres bave au moindre défaut de repérage. Chaque
//    nuance employée par un petit texte, hors nuances marquées d'exception dans le nuancier, reçoit une
//    variante « petit texte » :
//      - un gris neutre passe en noir seul équivalent (la valeur de N la plus proche, ΔE00 minimal) ;
//      - une couleur à plus de deux encres passe en encres réduites (trois au plus pour quatre encres, deux
//        pour trois) : meilleure combinaison calculée par print/inkmatch.py, ΔE00 minimal face à la nuance
//        imprimée, parmi toutes les encres (--inks toutes) ou sans le jaune (--inks sans-jaune).
//    Les petits textes passent sur la variante (styles compris, pour ne pas créer d'écarts), les grands corps
//    gardent la nuance d'origine. Une variante à trois encres est marquée d'exception (la réduction la plus
//    fidèle possible), que le contrôle en amont et check_pdfx admettent alors comme telle.
// 3. QR codes : nuance « Noir QR » en N 100 seul.
// 4. Le RVB affiché de chaque nuance devient la simulation de ses encres par le profil ; deux nuances ne
//    partagent jamais le même RVB.
// Relançable : une nuance qui a déjà ses encres les garde, une variante déjà créée est réutilisée.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { cmykToRgb, referencePreset, rgbToCmyk, runPrintPython } from '../server/color';
import { readDocument, saveDocument } from '../server/documents';
import { DEFAULT_DOCUMENTS_DIR, documentDir } from '../server/paths';
import { SMALL_TEXT_MAX_INKS, SMALL_TEXT_PT } from '../src/model/preflight';
import { newStyleId, updateCharacterStyle, updateParagraphStyle } from '../src/model/styles';
import { applySwatchDisplays, formatCmyk, inkCount, QR_BLACK_SWATCH, SMALL_TEXT_VARIANT, smallTextVariantId, type Cmyk } from '../src/model/swatches';
import type { ColorRef, Id, LayoutDocument, Swatch, TextObject } from '../src/model/types';
import { isNeutralColor } from './import/colors';

/** Encres admises pour une variante : toutes, ou toutes sauf le jaune (moins de repérage sur les tons froids). */
export type VariantInks = 'toutes' | 'sans-jaune';

export interface SmallTextOptions {
  /** Ne traiter que ces nuances (identifiants). */
  only?: readonly Id[];
  /** Nuances à laisser telles quelles : marquées d'exception dans le nuancier, elles ne reçoivent pas de variante. */
  keep?: readonly Id[];
  inks?: VariantInks;
}

export interface PrintSwatchOptions {
  profile?: string;
  maxInk?: number;
  /** Règle des petits textes ; false la désactive (conversion CMJN et QR codes seulement). */
  smallText?: false | SmallTextOptions;
  /** QR codes en « Noir QR » (N 100) ; false les laisse dans leurs nuances. */
  qr?: boolean;
}

export interface SmallTextMove {
  paragraphStyles: string[];
  characterStyles: string[];
  runs: number;
}

export interface SmallTextVariant {
  source: { id: Id; name: string; cmyk: Cmyk };
  id: Id;
  name: string;
  rule: 'noir-seul' | 'encres-reduites';
  cmyk: Cmyk;
  /** ΔE00 face à la nuance imprimée (`cmyk`) et à la couleur du design (`rgb`) ; absent pour une variante réutilisée. */
  deltaE?: { cmyk?: number; rgb?: number };
  /** Variante à trois encres, marquée d'exception pour le contrôle des petits textes. */
  exception: boolean;
  /** Déjà présente dans le nuancier (relance) : ses encres n'ont pas été recalculées. */
  reused: boolean;
  moved: SmallTextMove;
}

export interface PrintSwatchReport {
  converted: { id: string; name: string; source: string; cmyk: Cmyk }[];
  added: string[];
  qr: number;
  /** Nuances marquées d'exception à la demande (--keep). */
  kept: string[];
  variants: SmallTextVariant[];
}

const textObjects = (doc: LayoutDocument) => Object.values(doc.objects).filter((o): o is TextObject => o.type === 'text');

/** Segments d'un bloc avec leur corps et leur couleur effectifs. */
function effectiveRuns(obj: TextObject) {
  return obj.paragraphs.flatMap((p) => p.runs.map((run) => ({ run, size: run.fontSize ?? p.fontSize ?? obj.style.fontSize, color: run.color ?? obj.style.color })));
}

/** Nombre de segments visibles de moins de 9 pt par nuance (couleur effective). */
export function smallTextUses(doc: LayoutDocument): Map<Id, number> {
  const uses = new Map<Id, number>();
  for (const obj of textObjects(doc)) {
    for (const r of effectiveRuns(obj)) {
      if (r.size < SMALL_TEXT_PT && r.run.text.trim()) uses.set(r.color.swatch, (uses.get(r.color.swatch) ?? 0) + 1);
    }
  }
  return uses;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fait passer les textes de moins de 9 pt de la nuance `from` à la nuance `to` (teinte gardée). Les styles
 * de paragraphe et de caractère dont tous les usages sont petits changent eux-mêmes de nuance (les blocs
 * suivent sans écart) ; le reste est corrigé bloc par bloc, puis segment par segment.
 */
export function moveSmallText(doc: LayoutDocument, from: Id, to: { id: Id; name: string }): SmallTextMove {
  const report: SmallTextMove = { paragraphStyles: [], characterStyles: [], runs: 0 };
  const isFrom = (ref: ColorRef | undefined) => ref?.swatch === from;
  // Segments (non vides) déplacés, que ce soit par leur style, leur bloc ou eux-mêmes.
  const smallFromRuns = () => textObjects(doc).reduce((n, o) => n + effectiveRuns(o).filter((r) => r.size < SMALL_TEXT_PT && r.run.text.trim() && isFrom(r.color)).length, 0);
  const before = smallFromRuns();
  const target = (ref: ColorRef): ColorRef => ({ swatch: to.id, ...(ref.tint !== undefined ? { tint: ref.tint } : {}) });

  for (const ps of doc.styles.paragraph) {
    if (isFrom(ps.style.color) && ps.style.fontSize < SMALL_TEXT_PT) {
      updateParagraphStyle(doc, ps.id, { color: target(ps.style.color) });
      report.paragraphStyles.push(ps.name);
    }
  }
  for (const cs of doc.styles.character) {
    if (!isFrom(cs.style.color)) continue;
    const uses = textObjects(doc).flatMap((o) => effectiveRuns(o).filter((r) => r.run.characterStyleId === cs.id));
    if (uses.length && uses.every((u) => u.size < SMALL_TEXT_PT)) {
      updateCharacterStyle(doc, cs.id, { color: target(cs.style.color!) });
      report.characterStyles.push(cs.name);
    }
  }
  // Un style nommé d'après l'ancienne nuance (« Gras vert », derive-styles) prend le nom de la nouvelle :
  // sinon une nouvelle déduction des styles en créerait un second.
  const fromName = doc.swatches.find((s) => s.id === from)?.name.toLowerCase();
  for (const cs of doc.styles.character) {
    if (!fromName || cs.style.color?.swatch !== to.id || !cs.name.toLowerCase().includes(fromName) || cs.name.toLowerCase().includes(to.name.toLowerCase())) continue;
    cs.name = cs.name.replace(new RegExp(escapeRegExp(fromName), 'i'), to.name.toLowerCase());
    const id = newStyleId(doc, 'cs', cs.name);
    for (const obj of textObjects(doc)) for (const p of obj.paragraphs) for (const r of p.runs) if (r.characterStyleId === cs.id) r.characterStyleId = id;
    cs.id = id;
  }
  for (const obj of textObjects(doc)) {
    const runs = effectiveRuns(obj);
    const inheriting = runs.filter((r) => !r.run.color);
    // La couleur du bloc change si tous les segments qui en héritent sont petits ; sinon, segment par segment.
    if (isFrom(obj.style.color) && inheriting.length && inheriting.every((r) => r.size < SMALL_TEXT_PT)) {
      obj.style.color = target(obj.style.color);
    }
    for (const r of runs) {
      if (r.size >= SMALL_TEXT_PT || !isFrom(r.run.color ?? obj.style.color)) continue;
      r.run.color = target(r.color);
    }
  }
  report.runs = before - smallFromRuns();
  return report;
}

/** QR codes en « Noir QR » (N 100 seul) ; renvoie le nombre de QR codes du document. */
export function applyQrBlack(doc: LayoutDocument): number {
  let count = 0;
  for (const obj of Object.values(doc.objects)) {
    if (obj.type !== 'qr') continue;
    if (obj.color.swatch !== QR_BLACK_SWATCH.id) obj.color = { swatch: QR_BLACK_SWATCH.id };
    count++;
  }
  return count;
}

/**
 * Gris neutre d'après la couleur du design (celle que l'import nomme « Gris ») : son équivalent en noir seul
 * se lit pareil. Une teinte pâle ou un gris teinté garde sa teinte, donc ses encres réduites.
 */
export function isNeutralGray(swatch: Swatch): boolean {
  return isNeutralColor(swatch.sourceRgb ?? swatch.rgb);
}

const INK_LETTERS = ['C', 'M', 'J', 'N'] as const;

/** Jeux d'encres candidats d'une variante : toutes les combinaisons de `size` encres parmi celles permises. */
export function variantInkSets(size: number, inks: VariantInks = 'toutes'): string[][] {
  const letters = inks === 'sans-jaune' ? INK_LETTERS.filter((l) => l !== 'J') : [...INK_LETTERS];
  const out: string[][] = [];
  const pick = (start: number, acc: string[]) => {
    if (acc.length === size) return void out.push(acc);
    for (let i = start; i < letters.length; i++) pick(i + 1, [...acc, letters[i]]);
  };
  pick(0, []);
  return out;
}

/** Règle d'une nuance employée en petit texte : null si elle n'a pas besoin de variante. */
export function smallTextRule(swatch: Swatch): { rule: SmallTextVariant['rule']; inkSets: (inks: VariantInks) => string[][] } | null {
  if (!swatch.cmyk || swatch.smallTextException) return null;
  const n = inkCount(swatch.cmyk);
  if (isNeutralGray(swatch)) return n > 1 ? { rule: 'noir-seul', inkSets: () => [['N']] } : null;
  if (n <= SMALL_TEXT_MAX_INKS) return null;
  // Quatre encres → trois au plus ; trois → deux : toujours au moins une encre de moins que la nuance.
  const size = Math.min(3, n - 1);
  return { rule: 'encres-reduites', inkSets: (inks) => variantInkSets(size, inks) };
}

interface InkMatchResult {
  id: string;
  best: { cmyk: number[]; inks: number; deltaE: { cmyk?: number; rgb?: number } };
}

/** Variantes « petit texte » des nuances des petits textes (règle générique, voir l'en-tête). */
export async function applySmallTextRule(doc: LayoutDocument, options: SmallTextOptions & { profile: string; maxInk?: number }): Promise<SmallTextVariant[]> {
  const uses = smallTextUses(doc);
  const variantIds = new Set(doc.swatches.map((s) => s.id).filter((id) => id.endsWith(SMALL_TEXT_VARIANT.idSuffix)));
  const todo: { swatch: Swatch; rule: NonNullable<ReturnType<typeof smallTextRule>> }[] = [];
  for (const swatch of doc.swatches) {
    if (!uses.get(swatch.id) || variantIds.has(swatch.id)) continue;
    if (options.only && !options.only.includes(swatch.id)) continue;
    const rule = smallTextRule(swatch);
    if (rule) todo.push({ swatch, rule });
  }
  // Variantes à calculer (absentes du nuancier) : un seul lancement de Python pour toutes.
  const missing = todo.filter(({ swatch }) => !doc.swatches.some((s) => s.id === smallTextVariantId(swatch.id) && s.cmyk));
  const results = new Map<string, InkMatchResult>();
  if (missing.length) {
    const { results: list } = await runPrintPython<{ results: InkMatchResult[] }>('inkmatch.py', [], {
      input: JSON.stringify({
        profile: options.profile,
        jobs: missing.map(({ swatch, rule }) => ({
          id: swatch.id,
          targetCmyk: swatch.cmyk,
          targetRgb: swatch.sourceRgb ?? swatch.rgb,
          inkSets: rule.inkSets(options.inks ?? 'toutes'),
          ...(options.maxInk ? { maxInk: options.maxInk } : {}),
        })),
      }),
      timeoutMs: 600_000,
    });
    for (const r of list) results.set(r.id, r);
  }

  const variants: SmallTextVariant[] = [];
  for (const { swatch, rule } of todo) {
    const id = smallTextVariantId(swatch.id);
    const name = `${swatch.name}${SMALL_TEXT_VARIANT.nameSuffix}`;
    let variant = doc.swatches.find((s) => s.id === id);
    const reused = !!variant?.cmyk;
    const found = results.get(swatch.id);
    if (!variant) {
      // Juste après la nuance d'origine : le nuancier les montre ensemble. Le RVB affiché est posé à la fin.
      variant = { id, name, rgb: '#000000', sourceRgb: swatch.sourceRgb ?? swatch.rgb };
      doc.swatches.splice(doc.swatches.indexOf(swatch) + 1, 0, variant);
    }
    if (!reused) variant.cmyk = found!.best.cmyk.map((v) => Math.round(v * 10) / 10) as Cmyk;
    const exception = inkCount(variant.cmyk!) > SMALL_TEXT_MAX_INKS;
    if (exception) variant.smallTextException = true;
    const moved = moveSmallText(doc, swatch.id, { id, name: variant.name });
    variants.push({
      source: { id: swatch.id, name: swatch.name, cmyk: [...swatch.cmyk!] as Cmyk },
      id,
      name: variant.name,
      rule: rule.rule,
      cmyk: [...variant.cmyk!] as Cmyk,
      ...(found ? { deltaE: found.best.deltaE } : {}),
      exception,
      reused,
      moved,
    });
  }
  return variants;
}

/** Nuancier CMJN complet d'un document (voir l'en-tête) ; modifie `doc` et renvoie ce qui a changé. */
export async function convertDocumentSwatches(doc: LayoutDocument, options: PrintSwatchOptions = {}): Promise<PrintSwatchReport> {
  const preset = referencePreset();
  const profile = options.profile ?? preset.profile ?? 'FOGRA39';
  const maxInk = options.maxInk ?? preset.maxInk;
  const added: string[] = [];
  const kept: string[] = [];
  const smallText = options.smallText === false ? false : (options.smallText ?? {});

  if (smallText) {
    for (const id of smallText.keep ?? []) {
      const swatch = doc.swatches.find((s) => s.id === id);
      if (!swatch) throw new Error(`Nuance inconnue (--keep) : « ${id} »`);
      swatch.smallTextException = true;
      kept.push(swatch.name);
    }
    for (const id of smallText.only ?? []) if (!doc.swatches.some((s) => s.id === id)) throw new Error(`Nuance inconnue (--only) : « ${id} »`);
  }

  const withQr = options.qr !== false && Object.values(doc.objects).some((o) => o.type === 'qr');
  if (withQr) {
    let swatch = doc.swatches.find((s) => s.id === QR_BLACK_SWATCH.id);
    if (!swatch) {
      // Couleur du design : celle des QR codes avant leur passage en N 100 (référence du contrôle au pixel).
      const firstQr = Object.values(doc.objects).find((o) => o.type === 'qr');
      const was = firstQr?.type === 'qr' ? doc.swatches.find((s) => s.id === firstQr.color.swatch) : undefined;
      swatch = { id: QR_BLACK_SWATCH.id, name: QR_BLACK_SWATCH.name, rgb: '#000000', sourceRgb: was?.sourceRgb ?? was?.rgb ?? '#000000' };
      doc.swatches.push(swatch);
      added.push(QR_BLACK_SWATCH.name);
    }
    // La couleur du design (celle que l'import a nommée « Noir QR ») reste la référence du contrôle au pixel.
    if (!swatch.sourceRgb && swatch.rgb !== '#000000') swatch.sourceRgb = swatch.rgb;
    swatch.cmyk = [...QR_BLACK_SWATCH.cmyk];
  }

  const toConvert = doc.swatches.filter((s) => !s.cmyk);
  const sources = toConvert.map((s) => s.sourceRgb ?? s.rgb);
  const cmyks = await rgbToCmyk(sources, profile, { intent: 'relative', bpc: true, maxInk });
  const converted = toConvert.map((s, i) => {
    s.sourceRgb = sources[i];
    s.cmyk = cmyks[i];
    return { id: s.id, name: s.name, source: sources[i], cmyk: cmyks[i] };
  });

  const qr = withQr ? applyQrBlack(doc) : 0;
  const before = new Set(doc.swatches.map((s) => s.id));
  const variants = smallText ? await applySmallTextRule(doc, { ...smallText, profile, maxInk }) : [];
  added.push(...doc.swatches.filter((s) => !before.has(s.id)).map((s) => s.name));

  const displays = await cmykToRgb(
    doc.swatches.map((s) => s.cmyk!),
    profile,
  );
  applySwatchDisplays(doc, displays);
  return { converted, added, qr, kept, variants };
}

// ---------------------------------------------------------------- rapport

const fmtDeltaE = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(2).replace('.', ','));

/** Rapport lisible (Markdown) : conversions, variantes « petit texte » avec leurs encres et leurs ΔE00. */
export function renderPrintSwatchReport(doc: LayoutDocument, report: PrintSwatchReport, profile: string): string {
  const out = [`# Nuancier d'impression — ${doc.name}\n`, `Profil : ${profile}. Petits textes : moins de ${SMALL_TEXT_PT} pt, ${SMALL_TEXT_MAX_INKS} encres au plus hors exceptions.\n`];
  out.push('## Variantes « petit texte »\n');
  if (!report.variants.length) out.push('_Aucune : aucun petit texte n’emploie une nuance à trop d’encres._\n');
  else {
    out.push('| Nuance | Variante | Règle | Encres | ΔE00 imprimé | ΔE00 design | Exception | Segments |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const v of report.variants) {
      const rule = v.rule === 'noir-seul' ? 'gris neutre → noir seul' : 'encres réduites';
      out.push(
        `| ${v.source.name} (${formatCmyk(v.source.cmyk)}) | ${v.name} | ${rule} | ${formatCmyk(v.cmyk)}${v.reused ? ' (existante)' : ''} | ${fmtDeltaE(v.deltaE?.cmyk)} | ${fmtDeltaE(v.deltaE?.rgb)} | ${v.exception ? 'oui (3 encres)' : 'non'} | ${v.moved.runs} |`,
      );
    }
    out.push('');
  }
  if (report.kept.length) out.push(`Nuances laissées telles quelles (exception) : ${report.kept.join(', ')}.\n`);
  out.push(`QR codes en « ${QR_BLACK_SWATCH.name} » (N 100) : ${report.qr}.\n`);
  out.push('## Nuancier\n', '| Nuance | Encres | Écran | Design |', '| --- | --- | --- | --- |');
  for (const s of doc.swatches) out.push(`| ${s.name}${s.smallTextException ? ' (exception)' : ''} | ${s.cmyk ? formatCmyk(s.cmyk) : '—'} | ${s.rgb} | ${s.sourceRgb ?? ''} |`);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- ligne de commande

const USAGE = `Usage : npm run print-swatches -- --doc <id> [--documents <dossier>] [--profile FOGRA39] [--dry-run]
       [--no-small-text] [--only <id,…>] [--keep <id,…>] [--inks toutes|sans-jaune] [--no-qr]
  --no-small-text  ne pas créer de variantes « petit texte »
  --only           ne traiter que ces nuances (identifiants séparés par des virgules)
  --keep           laisser ces nuances telles quelles, marquées d'exception dans le nuancier
  --inks           encres des variantes : toutes (défaut) ou sans-jaune
  --no-qr          laisser les QR codes dans leurs nuances`;

const list = (value: string | undefined) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        doc: { type: 'string' },
        documents: { type: 'string' },
        profile: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'no-small-text': { type: 'boolean', default: false },
        only: { type: 'string' },
        keep: { type: 'string' },
        inks: { type: 'string', default: 'toutes' },
        'no-qr': { type: 'boolean', default: false },
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
  if (values.inks !== 'toutes' && values.inks !== 'sans-jaune') {
    console.error(`--inks : « toutes » ou « sans-jaune » attendu, pas « ${values.inks} ».\n\n${USAGE}`);
    return 2;
  }
  const documentsDir = path.resolve(values.documents ?? DEFAULT_DOCUMENTS_DIR);
  try {
    const doc = await readDocument(documentsDir, values.doc);
    const profile = values.profile ?? referencePreset().profile ?? 'FOGRA39';
    const report = await convertDocumentSwatches(doc, {
      profile,
      qr: !values['no-qr'],
      smallText: values['no-small-text'] ? false : { only: list(values.only), keep: list(values.keep), inks: values.inks as VariantInks },
    });
    console.log(`Nuances converties en CMJN (${report.converted.length}) :`);
    for (const c of report.converted) console.log(`  ${c.name.padEnd(28)} ${c.source} → ${formatCmyk(c.cmyk)}`);
    if (report.added.length) console.log(`Nuances ajoutées : ${report.added.join(', ')}`);
    if (report.kept.length) console.log(`Nuances laissées telles quelles (exception) : ${report.kept.join(', ')}`);
    console.log(`Variantes « petit texte » (${report.variants.length}) :`);
    for (const v of report.variants) {
      const dE = v.deltaE ? `ΔE00 ${fmtDeltaE(v.deltaE.cmyk)} (imprimé), ${fmtDeltaE(v.deltaE.rgb)} (design)` : 'existante';
      console.log(`  ${v.source.name.padEnd(24)} ${formatCmyk(v.source.cmyk)} → ${formatCmyk(v.cmyk)}  ${dE}${v.exception ? ', exception (3 encres)' : ''} ; ${v.moved.runs} segment(s)`);
    }
    console.log(`QR codes en « ${QR_BLACK_SWATCH.name} » : ${report.qr}`);
    if (values['dry-run']) {
      console.log('Essai à blanc : rien n’a été écrit.');
      return 0;
    }
    await saveDocument(documentsDir, values.doc, doc);
    const reportFile = path.join(documentDir(documentsDir, values.doc), 'print-swatches-report.md');
    await writeFile(reportFile, renderPrintSwatchReport(doc, report, profile));
    console.log(`Écrit : ${path.join(documentsDir, values.doc, 'document.json')}`);
    console.log(`Rapport : ${reportFile}`);
    return 0;
  } catch (error) {
    console.error(`Échec : ${(error as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
