// Lance un script Python avec l'interpréteur de print/.venv (pikepdf, Pillow), sur toutes les plates-formes :
// `node scripts/run-print-python.mjs <script.py> [arguments…]`. Le venv se crée par `npm run setup:print`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvPython = path.join(PROJECT_ROOT, 'print', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('Usage : node scripts/run-print-python.mjs <script.py> [arguments…]');
  process.exit(1);
}
if (!existsSync(venvPython)) {
  console.error('Environnement Python absent : lancer « npm run setup:print » d’abord.');
  process.exit(1);
}
const result = spawnSync(venvPython, [path.resolve(PROJECT_ROOT, script), ...args], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  windowsHide: true,
  // Accents des messages : la console Windows ne parle pas UTF-8 par défaut.
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
});
if (result.error) {
  console.error(`Impossible de lancer Python : ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
