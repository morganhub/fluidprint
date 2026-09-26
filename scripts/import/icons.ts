// Reconnaissance des icônes Lucide du design : on compare les éléments SVG (balise et attributs),
// pas le texte brut, car le design et lucide-static n'écrivent pas le SVG à l'identique (espaces,
// balises fermantes, ordre des attributs). La bibliothèque installée (lucide-static) fait seule foi :
// aucun fichier propre à un design n'est nécessaire.
import { createRequire } from 'node:module';

type SvgElement = { tag: string; attrs: Record<string, string> };

// Attributs sans effet sur le dessin : ils ne doivent pas empêcher une correspondance.
const IGNORED_ATTRS = new Set(['class', 'key', 'data-imp', 'xmlns']);

function canonical(elements: SvgElement[]): string {
  return elements
    .map(({ tag, attrs }) => {
      const parts = Object.entries(attrs)
        .filter(([name]) => !IGNORED_ATTRS.has(name))
        .map(([name, value]) => `${name}=${value.replace(/\s+/g, ' ').trim()}`)
        .sort();
      return `${tag.toLowerCase()}[${parts.join(';')}]`;
    })
    .join('|');
}

/** Éléments d'un fragment SVG simple (celui des icônes Lucide : balises sans imbrication). */
export function parseSvgFragment(fragment: string): SvgElement[] {
  const out: SvgElement[] = [];
  for (const m of fragment.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ tag: m[1], attrs });
  }
  return out;
}

export interface IconMatcher {
  /** Nom Lucide de l'icône, ou null si elle n'est pas dans lucide-static. */
  match(elements: SvgElement[]): { name: string; source: 'lucide-static' } | null;
}

// Table construite une fois par processus (~1 700 icônes), à la première icône rencontrée.
let lucideIndex: Map<string, string> | null = null;

function lucide(): Map<string, string> {
  if (!lucideIndex) {
    const index = new Map<string, string>();
    const require = createRequire(import.meta.url);
    const nodes = require('lucide-static/icon-nodes.json') as Record<string, [string, Record<string, string>][]>;
    for (const [name, list] of Object.entries(nodes)) {
      const key = canonical(list.map(([tag, attrs]) => ({ tag, attrs })));
      // Deux noms pour un même dessin (alias, « clock-4 » pour « clock ») : le plus court, le nom usuel.
      const known = index.get(key);
      if (!known || name.length < known.length) index.set(key, name);
    }
    lucideIndex = index;
  }
  return lucideIndex;
}

export function createIconMatcher(): IconMatcher {
  return {
    match(elements) {
      const name = lucide().get(canonical(elements));
      return name ? { name, source: 'lucide-static' } : null;
    },
  };
}
