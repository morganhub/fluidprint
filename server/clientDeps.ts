// Dépendances que le navigateur importe (src/**), pour figer le pré-bundling de Vite sur les serveurs sans
// rechargement à chaud (tests, export en ligne de commande, audit C5).
//
// Sans liste figée, Vite découvre une dépendance en cours de route, la réoptimise et répond 504 « Outdated
// Optimize Dep » aux modules déjà demandés : sans WebSocket, la page ne peut pas se recharger et la route
// d'impression attend jusqu'au délai. Avec `include` complet et `noDiscovery`, l'optimisation est faite une
// fois au démarrage, identique d'un processus à l'autre (même empreinte, donc cache relu, jamais réécrit).
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { PROJECT_ROOT } from './paths';

const SOURCE_DIR = path.join(PROJECT_ROOT, 'src');

// Injectées par @vitejs/plugin-react (JSX) et par react-dom/client, sans import écrit dans src/.
const IMPLICIT = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom'];

// import … from 'x' ; export … from 'x' ; import 'x' ; import('x'). Les imports de type seul sont effacés
// à la compilation : ils ne comptent pas.
const IMPORT = /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[\w*${},\s]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

/** Spécificateur de paquet (« react-dom/client », « @tiptap/pm/state »), ou null pour un chemin, un fichier brut… */
function packageSpecifier(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.includes('?') || spec.startsWith('virtual:')) return null;
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  if (builtinModules.includes(name)) return null;
  // Feuilles de style et données : servies telles quelles, pas pré-bundlées.
  if (/\.(css|json|svg|png|woff2?|ttf)$/.test(spec)) return null;
  return spec;
}

/** Toutes les dépendances de paquets importées par le code du navigateur, triées. */
export function clientDependencies(dir = SOURCE_DIR): string[] {
  const found = new Set(IMPLICIT);
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      if (m[2]) continue;
      const spec = packageSpecifier(m[3] ?? m[4]);
      if (spec) found.add(spec);
    }
  }
  return [...found].sort();
}
