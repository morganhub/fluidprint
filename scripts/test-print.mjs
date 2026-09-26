// Tests Python de l'export imprimeur : pytest dans print/.venv. Les arguments sont transmis à pytest
// (ex. `npm run test:print -- -k couleurs`).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRINT_DIR = path.join(PROJECT_ROOT, 'print');
const venvPython = path.join(PRINT_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SKIPPED_DIRS = new Set(['.venv', '__pycache__', '.pytest_cache', 'node_modules']);

function findTests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : findTests(path.join(dir, entry.name));
    return /^test_.*\.py$/.test(entry.name) ? [path.join(dir, entry.name)] : [];
  });
}

if (findTests(PRINT_DIR).length === 0) {
  console.log("Aucun test d'impression pour l'instant (phase 4)");
  process.exit(0);
}

if (!existsSync(venvPython)) {
  console.error('Environnement Python absent : lancer « npm run setup:print » avant les tests.');
  process.exit(1);
}

// Le cache de pytest (--lf, --ff) est rangé dans le venv, déjà ignoré par git, plutôt qu'à la racine d'editor/.
const cacheDir = path.relative(PROJECT_ROOT, path.join(PRINT_DIR, '.venv', '.pytest_cache'));
const result = spawnSync(venvPython, ['-m', 'pytest', 'print/', '-o', `cache_dir=${cacheDir}`, ...process.argv.slice(2)], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(`Impossible de lancer pytest : ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
