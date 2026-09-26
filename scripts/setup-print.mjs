// Prépare l'environnement Python de l'export imprimeur : print/.venv avec pikepdf et Pillow.
// Relançable sans risque : le venv existant est réutilisé, pip ne tourne que si requirements.txt a changé
// (ou avec --force).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRINT_DIR = path.join(PROJECT_ROOT, 'print');
const VENV_DIR = path.join(PRINT_DIR, '.venv');
const REQUIREMENTS = path.join(PRINT_DIR, 'requirements.txt');
// Empreinte de requirements.txt au dernier pip install réussi.
const STAMP = path.join(VENV_DIR, '.requirements.sha256');
const MIN_PYTHON = [3, 10];
const FOGRA39 = 'C:\\Windows\\System32\\spool\\drivers\\color\\CoatedFOGRA39.icc';

const force = process.argv.includes('--force');
const venvPython = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true, ...options });
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Version de Python (ex. [3, 13, 5]) si la commande répond, sinon null. */
function pythonVersion(command, prefix) {
  const result = run(command, [...prefix, '-c', 'import sys; print(*sys.version_info[:3])']);
  if (result.status !== 0 || !result.stdout) return null;
  const version = result.stdout.trim().split(/\s+/).map(Number);
  return version.length === 3 && version.every(Number.isInteger) ? version : null;
}

const atLeast = (version, min) => version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);

// Sous Windows, « python » peut n'être que le raccourci du Microsoft Store (il répond sans rien faire) :
// on essaie aussi le lanceur « py ».
function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  candidates.push(['python', []]);
  if (process.platform === 'win32') candidates.push(['py', ['-3']]);
  candidates.push(['python3', []]);
  for (const [command, prefix] of candidates) {
    const version = pythonVersion(command, prefix);
    if (version && atLeast(version, MIN_PYTHON)) return { command, prefix, version };
  }
  return null;
}

function venvIsUsable() {
  return existsSync(venvPython) && pythonVersion(venvPython, []) !== null;
}

function importCheck() {
  return run(venvPython, ['-c', 'import pikepdf, PIL; print(pikepdf.__version__, PIL.__version__)']);
}

// ---------------------------------------------------------------- venv

if (!existsSync(REQUIREMENTS)) fail(`Fichier introuvable : ${REQUIREMENTS}`);

if (venvIsUsable()) {
  console.log(`Environnement Python existant : ${path.relative(PROJECT_ROOT, VENV_DIR)}`);
} else {
  const python = findPython();
  if (!python) {
    fail(
      `Python ${MIN_PYTHON.join('.')} ou plus récent introuvable (essayé : python, py -3, python3).\n` +
        "Installer Python depuis python.org, ou indiquer l'exécutable dans la variable PYTHON.",
    );
  }
  // Un venv dont l'interpréteur ne répond plus (Python désinstallé ou mis à jour) ne se répare pas : on le refait.
  if (existsSync(VENV_DIR)) {
    console.log('Environnement Python inutilisable : recréation.');
    rmSync(VENV_DIR, { recursive: true, force: true });
  }
  console.log(`Création de ${path.relative(PROJECT_ROOT, VENV_DIR)} avec Python ${python.version.join('.')}…`);
  const created = run(python.command, [...python.prefix, '-m', 'venv', VENV_DIR], { stdio: 'inherit' });
  if (created.status !== 0 || !venvIsUsable()) fail('Échec de la création du venv (python -m venv).');
}

// ---------------------------------------------------------------- dépendances

const requirementsHash = createHash('sha256').update(readFileSync(REQUIREMENTS)).digest('hex');
const installedHash = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : null;

if (!force && installedHash === requirementsHash && importCheck().status === 0) {
  console.log('Dépendances déjà à jour (requirements.txt inchangé).');
} else {
  console.log('Installation des dépendances (pip install -r print/requirements.txt)…');
  const installed = run(
    venvPython,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', REQUIREMENTS],
    { stdio: 'inherit' },
  );
  if (installed.status !== 0) fail('Échec de pip install : vérifier la connexion Internet et relancer « npm run setup:print ».');
  writeFileSync(STAMP, `${requirementsHash}\n`);
}

// ---------------------------------------------------------------- vérification

const check = importCheck();
if (check.status !== 0) {
  // L'empreinte est retirée : la prochaine exécution réinstallera au lieu de croire l'environnement à jour.
  rmSync(STAMP, { force: true });
  fail(`« import pikepdf » échoue dans le venv :\n${check.stderr.trim()}`);
}
const [pikepdfVersion, pillowVersion] = check.stdout.trim().split(/\s+/);
console.log(`OK : import pikepdf (${pikepdfVersion}) et Pillow (${pillowVersion}) dans ${path.relative(PROJECT_ROOT, venvPython)}`);

// ---------------------------------------------------------------- profils ICC (information seulement)

const profilesDir = path.join(PRINT_DIR, 'profiles');
const localProfiles = existsSync(profilesDir) ? readdirSync(profilesDir).filter((name) => /\.ic[cm]$/i.test(name)) : [];
console.log('\nProfils ICC :');
if (process.platform === 'win32') {
  console.log(`  ${existsSync(FOGRA39) ? 'présent ' : 'ABSENT  '} CoatedFOGRA39.icc (${FOGRA39})`);
}
for (const [label, pattern] of [
  ['PSO Coated v3 (FOGRA51)', /^PSO.?coated.?v3/i],
  ['PSO Uncoated v3 (FOGRA52)', /^PSO.?uncoated.?v3/i],
]) {
  const found = localProfiles.find((name) => pattern.test(name));
  console.log(`  ${found ? 'présent ' : 'absent  '} ${label}${found ? ` (print/profiles/${found})` : ' : voir print/profiles/README.md'}`);
}
