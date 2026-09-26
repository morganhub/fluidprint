// Reconnaissance des raccourcis : « Mod+Shift+G », « Shift+ArrowUp », « Delete », « Mod+? »…
// Une lettre ou un chiffre est reconnu par le caractère produit ET par la touche physique : sur un
// clavier AZERTY, Ctrl+0 produit « à » mais reste la touche Digit0.

export interface KeyCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Touche normalisée : lettre en majuscule, « ArrowUp », « Delete », « ? »… */
  key: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const ALIASES: Record<string, string> = {
  Del: 'Delete',
  Esc: 'Escape',
  Space: ' ',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Plus: '+',
};

export function parseCombo(spec: string): KeyCombo {
  // « Mod++ » : la dernière partie est la touche, même si c'est un « + ».
  const parts = spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+');
  const combo: KeyCombo = { mod: false, shift: false, alt: false, key: '' };
  for (const raw of parts) {
    const p = raw.trim();
    if (/^(mod|ctrl|cmd)$/i.test(p)) combo.mod = true;
    else if (/^shift$/i.test(p)) combo.shift = true;
    else if (/^alt$/i.test(p)) combo.alt = true;
    else combo.key = normalizeKey(ALIASES[p] ?? p);
  }
  return combo;
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Touche physique ramenée à son caractère « QWERTY » (KeyG → G, Digit0 → 0, BracketRight → ]). */
function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  const map: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    NumpadAdd: '+',
    NumpadSubtract: '-',
    Slash: '/',
    Backslash: '\\',
  };
  return map[code] ?? null;
}

/** Les caractères qui demandent Maj sur certains claviers (« ? », « + ») ignorent l'état de Maj. */
const SHIFT_AGNOSTIC = new Set(['?', '+', '/', '=', '-', '[', ']']);

export function matchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod !== combo.mod) return false;
  if (e.altKey !== combo.alt) return false;
  const produced = normalizeKey(e.key);
  const physical = keyFromCode(e.code);
  const keyOk = produced === combo.key || (physical !== null && physical === combo.key);
  if (!keyOk) return false;
  if (SHIFT_AGNOSTIC.has(combo.key) && !combo.shift) return true;
  return e.shiftKey === combo.shift;
}

/** Libellé lisible d'un raccourci, pour l'aide et les infobulles (« Ctrl+Maj+G »). */
export function formatCombo(spec: string): string {
  const combo = parseCombo(spec);
  const names: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Delete: 'Suppr',
    Backspace: 'Retour arrière',
    Escape: 'Échap',
    ' ': 'Espace',
    Enter: 'Entrée',
  };
  const parts: string[] = [];
  if (combo.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Maj');
  parts.push(names[combo.key] ?? combo.key);
  return parts.join('+');
}

/** Vrai si le focus est dans un champ où la frappe doit rester au navigateur. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'range', 'color', 'submit', 'reset'].includes(type);
}
