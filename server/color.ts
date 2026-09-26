// Couleurs d'impression côté serveur (tâches 4.1 et 4.9, décision P1) : conversions CMJN ↔ RVB par le
// profil de sortie (Pillow ImageCms, dans print/.venv), épreuvage des photos, préréglages d'export.
//
// Chaque conversion lance Python (≈ 0,3 s) : les résultats sont gardés en mémoire et sur le disque
// (node_modules/.cache/fluidprint-color/), la simulation d'une nuance ne dépend que de ses encres et du profil.
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Cmyk } from '../src/model/swatches';
import { assetPath, HttpError } from './documents';
import { documentDir, PROJECT_ROOT } from './paths';
import type { RouteContext } from './routes';

export const PRINT_DIR = path.join(PROJECT_ROOT, 'print');
export const PRESETS_FILE = path.join(PRINT_DIR, 'presets.json');
export const VENV_PYTHON = path.join(PRINT_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const CACHE_DIR = path.join(PROJECT_ROOT, 'node_modules', '.cache', 'fluidprint-color');

// ---------------------------------------------------------------- préréglages

export type ColorMode = 'cmyk' | 'rgb';

export interface PrintPreset {
  id: string;
  label: string;
  description: string;
  colorMode: ColorMode;
  /** « PDF/X-4 » ou null (PDF simple). */
  standard: string | null;
  /** Identifiant du profil de sortie (clé de `profiles`), null en RVB. */
  profile: string | null;
  imageIntent?: 'perceptual' | 'relative' | 'saturation' | 'absolute';
  vectorIntent?: 'perceptual' | 'relative' | 'saturation' | 'absolute';
  blackPointCompensation?: boolean;
  /** Fond perdu gardé dans le PDF, en mm (0 = coupé au format fini). */
  bleed: number;
  cropMarks: boolean;
  /** Marge autour du fond perdu pour les traits de coupe, en mm. */
  marksMargin?: number;
  /** Encrage total maximal, en %. */
  maxInk?: number;
  /** Refuse l'export tant qu'une photo provisoire est en place. */
  refusePlaceholders?: boolean;
  /** Résolution des photos réduites (e-mail : toutes celles au-delà ; imprimeur : celles au-delà de `downsampleAbovePpi`). */
  downsamplePpi?: number;
  /** Seuil de réduction des préréglages CMJN : une photo affichée au-delà est ramenée à `downsamplePpi`. */
  downsampleAbovePpi?: number;
  jpegQuality?: number;
  /** Poids au-delà duquel l'export avertit (e-mail ; limite courante des imprimeurs pour les préréglages CMJN). */
  maxBytes?: number;
  /** Aperçus PNG de chaque face, à cette résolution. */
  pngPpi?: number;
}

export interface OutputProfile {
  label: string;
  file: string;
  outputConditionIdentifier: string;
  outputCondition: string;
  registryName: string;
  info: string;
}

export interface PresetsFile {
  defaultPreset: string;
  profiles: Record<string, OutputProfile>;
  presets: Record<string, PrintPreset>;
}

const presetsCache = new Map<string, { mtimeMs: number; value: PresetsFile }>();

/** Seule norme que produit la chaîne d'impression (print/pdf_cmyk.py). */
export const SUPPORTED_STANDARDS: readonly string[] = ['PDF/X-4'];

/**
 * Refus, au chargement, d'un préréglage que la chaîne ne sait pas produire. Le plan prévoyait « PDF/X-4 ou
 * X-1a » : une norme X-1a aurait été inscrite telle quelle sur un PDF 1.6 à transparence vivante, donc un
 * fichier faussement conforme (audit A6).
 */
export function presetProblems(presets: PresetsFile, file: string): string[] {
  const problems: string[] = [];
  const where = (id: string) => `Préréglage « ${id} » (${path.basename(file)})`;
  for (const [id, p] of Object.entries(presets.presets)) {
    if (p.colorMode !== 'cmyk' && p.colorMode !== 'rgb') problems.push(`${where(id)} : colorMode « ${String(p.colorMode)} » inconnu (cmyk ou rgb)`);
    if (p.standard != null && !SUPPORTED_STANDARDS.includes(p.standard)) {
      problems.push(
        `${where(id)} : norme « ${p.standard} » non prise en charge. Seule PDF/X-4 est produite ; PDF/X-1a exigerait d'aplatir la transparence et de passer en PDF 1.3. Mettre "standard": "PDF/X-4", ou demander à l'imprimeur s'il accepte le PDF/X-4.`,
      );
    }
    if (p.standard != null && p.colorMode !== 'cmyk') problems.push(`${where(id)} : une norme PDF/X suppose "colorMode": "cmyk"`);
    if (p.colorMode === 'cmyk' && (!p.profile || !presets.profiles[p.profile])) {
      problems.push(`${where(id)} : profil de sortie « ${p.profile ?? ''} » absent de "profiles" (connus : ${Object.keys(presets.profiles).join(', ')})`);
    }
    if (p.downsampleAbovePpi !== undefined && (p.downsamplePpi === undefined || p.downsampleAbovePpi < p.downsamplePpi)) {
      problems.push(`${where(id)} : downsampleAbovePpi (${p.downsampleAbovePpi}) doit accompagner un downsamplePpi plus petit`);
    }
  }
  if (!presets.presets[presets.defaultPreset]) problems.push(`defaultPreset « ${presets.defaultPreset} » absent de "presets"`);
  return problems;
}

/** Préréglages (print/presets.json, ou un autre fichier pour les tests), relus s'il a changé. */
export function loadPresets(file = PRESETS_FILE): PresetsFile {
  const mtimeMs = statSync(file).mtimeMs;
  const cached = presetsCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Omit<PresetsFile, 'presets'> & { presets: Record<string, Omit<PrintPreset, 'id'>> };
  const presets = Object.fromEntries(Object.entries(raw.presets).map(([id, p]) => [id, { ...p, id } as PrintPreset]));
  const value: PresetsFile = { defaultPreset: raw.defaultPreset, profiles: raw.profiles, presets };
  const problems = presetProblems(value, file);
  if (problems.length) throw new HttpError(500, `Préréglages d'export refusés : ${problems.join(' ; ')}`);
  presetsCache.set(file, { mtimeMs, value });
  return value;
}

/** Préréglage de référence de l'écran (épreuvage, encrage maximal du nuancier) : celui de l'imprimeur par défaut. */
export function referencePreset(file = PRESETS_FILE): PrintPreset {
  const all = loadPresets(file);
  return all.presets[all.defaultPreset] ?? Object.values(all.presets).find((p) => p.colorMode === 'cmyk')!;
}

// ---------------------------------------------------------------- Python

export function pythonAvailable(): boolean {
  return existsSync(VENV_PYTHON);
}

/**
 * Lance un script de print/ avec l'interpréteur du venv et lit sa réponse JSON. Une erreur prévue du script
 * (profil absent, PDF illisible) devient une HttpError de même message.
 */
export function runPrintPython<T>(script: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<T> {
  if (!pythonAvailable()) {
    return Promise.reject(new HttpError(500, 'Environnement Python absent : lancer « npm run setup:print »'));
  }
  return new Promise<T>((resolve, reject) => {
    const child = execFile(
      VENV_PYTHON,
      [path.join(PRINT_DIR, script), ...args],
      {
        cwd: PRINT_DIR,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 10 * 60_000,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONWARNINGS: 'ignore' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim().split(/\r?\n/).filter(Boolean);
          // Une trace Python finit par la ligne utile ; un message prévu tient en une ligne.
          reject(new HttpError(422, `${script} : ${detail.at(-1) ?? 'échec'}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as T);
        } catch {
          reject(new HttpError(500, `${script} : réponse illisible (${stdout.slice(0, 200)})`));
        }
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input, 'utf8');
  });
}

// ---------------------------------------------------------------- conversions (avec cache)

type Intent = NonNullable<PrintPreset['vectorIntent']>;

interface ColorCacheFile {
  [key: string]: string | Cmyk;
}

const memory = new Map<string, ColorCacheFile>();

function cacheFile(profile: string): string {
  return path.join(CACHE_DIR, `${profile.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

async function loadCache(profile: string): Promise<ColorCacheFile> {
  let cache = memory.get(profile);
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(cacheFile(profile), 'utf8')) as ColorCacheFile;
  } catch {
    cache = {};
  }
  memory.set(profile, cache);
  return cache;
}

async function saveCache(profile: string): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile(profile), JSON.stringify(memory.get(profile) ?? {}));
  } catch {
    // Le cache n'est qu'une accélération.
  }
}

const cmykKey = (cmyk: Cmyk, intent: Intent, bpc: boolean) => `c2r:${cmyk.join(',')}:${intent}:${bpc ? 1 : 0}`;
const rgbKey = (rgb: string, intent: Intent, bpc: boolean, maxInk?: number) => `r2c:${rgb}:${intent}:${bpc ? 1 : 0}:${maxInk ?? ''}`;

/** RVB affiché (simulation du profil) de chaque couleur CMJN, en `#rrggbb`. */
export async function cmykToRgb(values: Cmyk[], profile = 'FOGRA39', intent: Intent = 'relative', bpc = true): Promise<string[]> {
  const cache = await loadCache(profile);
  const missing = [...new Set(values.map((v) => v.join(',')))].map((k) => k.split(',').map(Number) as Cmyk).filter((v) => cache[cmykKey(v, intent, bpc)] === undefined);
  if (missing.length) {
    const out = await runPrintPython<{ values: string[] }>('colorconv.py', [], {
      input: JSON.stringify({ op: 'cmyk-to-rgb', profile, intent, bpc, values: missing }),
      timeoutMs: 60_000,
    });
    missing.forEach((v, i) => (cache[cmykKey(v, intent, bpc)] = out.values[i]));
    await saveCache(profile);
  }
  return values.map((v) => cache[cmykKey(v, intent, bpc)] as string);
}

/** CMJN (en %) de couleurs `#rrggbb`, colorimétrie relative et compensation du point noir par défaut. */
export async function rgbToCmyk(values: string[], profile = 'FOGRA39', options: { intent?: Intent; bpc?: boolean; maxInk?: number } = {}): Promise<Cmyk[]> {
  const intent = options.intent ?? 'relative';
  const bpc = options.bpc ?? true;
  const cache = await loadCache(profile);
  const missing = [...new Set(values)].filter((v) => cache[rgbKey(v, intent, bpc, options.maxInk)] === undefined);
  if (missing.length) {
    const out = await runPrintPython<{ values: Cmyk[] }>('colorconv.py', [], {
      input: JSON.stringify({ op: 'rgb-to-cmyk', profile, intent, bpc, maxInk: options.maxInk, values: missing }),
      timeoutMs: 60_000,
    });
    missing.forEach((v, i) => (cache[rgbKey(v, intent, bpc, options.maxInk)] = out.values[i]));
    await saveCache(profile);
  }
  return values.map((v) => cache[rgbKey(v, intent, bpc, options.maxInk)] as Cmyk);
}

// ---------------------------------------------------------------- épreuvage des photos (4.9)

export interface ProofOptions {
  profile: string;
  intent: Intent;
  maxInk?: number;
}

/** Dossier du cache d'épreuves d'un document, par profil, intention et encrage. */
export function proofDir(documentsDir: string, docId: string, options: ProofOptions): string {
  const variant = `${options.profile}-${options.intent}-${options.maxInk ?? 'libre'}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(documentDir(documentsDir, docId), 'assets', 'proof', variant);
}

/** Épreuve écran d'une photo du document (RVB → CMJN → RVB) : chemin du fichier en cache. */
export async function proofAsset(documentsDir: string, docId: string, relative: string, options: ProofOptions): Promise<string> {
  const source = assetPath(documentsDir, docId, relative);
  if (relative.split('/').includes('proof')) throw new HttpError(400, `Chemin d'épreuve refusé : ${relative}`);
  try {
    if (!(await stat(source)).isFile()) throw new Error();
  } catch {
    throw new HttpError(404, `Fichier introuvable : ${relative}`);
  }
  const target = path.join(proofDir(documentsDir, docId, options), `${relative.replace(/^assets\//, '').replace(/[\\/]/g, '__')}.webp`);
  const args = [source, target, '--profile', options.profile, '--intent', options.intent];
  if (options.maxInk) args.push('--max-ink', String(options.maxInk));
  // Deux cadres qui montrent la même photo la demandent en même temps : une seule conversion.
  let pending = proofsInFlight.get(target);
  if (!pending) {
    pending = runPrintPython<{ output: string }>('proof.py', args, { timeoutMs: 120_000 }).finally(() => proofsInFlight.delete(target));
    proofsInFlight.set(target, pending);
  }
  await pending;
  return target;
}

const proofsInFlight = new Map<string, Promise<unknown>>();

// ---------------------------------------------------------------- routes

const isCmyk = (v: unknown): v is Cmyk => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 100);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v);

export function registerColorRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/print/presets', async () => loadPresets());

  app.post<{ Body: { values?: unknown; profile?: string } }>('/api/color/cmyk-to-rgb', async (req) => {
    const values = req.body?.values;
    if (!Array.isArray(values) || !values.every(isCmyk)) throw new HttpError(400, 'values : tableau de [C, M, J, N] (0-100) attendu');
    const profile = req.body?.profile ?? referencePreset().profile ?? 'FOGRA39';
    return { values: await cmykToRgb(values, profile), profile };
  });

  app.post<{ Body: { values?: unknown; profile?: string; maxInk?: number } }>('/api/color/rgb-to-cmyk', async (req) => {
    const values = req.body?.values;
    if (!Array.isArray(values) || !values.every(isHex)) throw new HttpError(400, 'values : tableau de couleurs #rrggbb attendu');
    const preset = referencePreset();
    const profile = req.body?.profile ?? preset.profile ?? 'FOGRA39';
    return { values: await rgbToCmyk(values, profile, { maxInk: req.body?.maxInk ?? preset.maxInk }), profile };
  });

  // Épreuve écran d'une photo : /api/proof/<id>/assets/previews/photo.webp?profile=FOGRA39
  app.get<{ Params: { id: string; '*': string }; Querystring: { profile?: string; intent?: string; maxInk?: string } }>('/api/proof/:id/*', async (req, reply) => {
    const preset = referencePreset();
    const intent = (req.query.intent ?? preset.imageIntent ?? 'perceptual') as Intent;
    if (!['perceptual', 'relative', 'saturation', 'absolute'].includes(intent)) throw new HttpError(400, `Intention inconnue : ${intent}`);
    const profile = req.query.profile ?? preset.profile ?? 'FOGRA39';
    if (!loadPresets().profiles[profile]) throw new HttpError(400, `Profil inconnu : ${profile}`);
    const maxInk = req.query.maxInk ? Number(req.query.maxInk) : preset.maxInk;
    const file = await proofAsset(ctx.documentsDir, req.params.id, req.params['*'], { profile, intent, maxInk });
    reply.type('image/webp');
    return reply.send(createReadStream(file));
  });
}
