// Couleurs de l'import : lecture des couleurs CSS, nuances nommées par rôle ou par teinte, fusion des quasi-doublons.
import type { ColorRef, Swatch } from '../../src/model/types';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000' };

/** Lit `rgb()`, `rgba()`, `#rgb`, `#rrggbb` et quelques noms ; null pour `none`, `transparent`, `currentColor`. */
export function parseColor(value: string | undefined | null): Rgba | null {
  if (!value) return null;
  const v = (NAMED[value.trim().toLowerCase()] ?? value).trim().toLowerCase();
  if (v === 'none' || v === 'transparent' || v === 'currentcolor') return null;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]);
    return { r: Math.round(Number(m[1])), g: Math.round(Number(m[2])), b: Math.round(Number(m[3])), a: alpha };
  }
  return null;
}

export const toHex = ({ r, g, b }: Rgba): string => '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- ΔE 2000 (sRGB → Lab D65)

function toLab(hex: string): [number, number, number] {
  const c = parseColor(hex)!;
  const lin = (u: number) => {
    const s = u / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE2000(hexA: string, hexB: string): number {
  const [L1, a1, b1] = toLab(hexA);
  const [L2, a2, b2] = toLab(hexB);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (a: number, b: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1p = hp(a1p, b1);
  const h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hpm = (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad) + 0.32 * Math.cos((3 * hpm + 6) * rad) - 0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// ---------------------------------------------------------------- rôles et teintes

// Chaque couleur du design reçoit un nom lisible, pour que le nuancier se lise comme une charte et non
// comme une liste de codes hexadécimaux : son rôle quand l'import le connaît (texte principal, titres,
// QR codes, repères), sinon sa teinte et sa clarté (« Vert foncé », « Orange très clair »). Le nom ne
// dépend que de l'usage et de la couleur : aucun design n'a de table à lui.

/** Couleur des repères de coupe et de plis posés par l'importeur (calque non imprimable). */
export const GUIDE_COLOR = '#e0245e';

/** Nuances nommées par leur rôle, reconnues ensuite par nom ou identifiant (scripts/print-swatches.ts). */
export const ROLE = {
  mainText: 'Texte principal',
  titles: 'Titres',
  qr: 'Noir QR',
  guides: 'Repères coupe et plis',
} as const;

/** Corps (pt) à partir duquel un texte compte comme titre pour nommer la nuance « Titres ». */
export const TITLE_MIN_PT = 12;

/** Usage d'une couleur, noté par l'importeur : il décide du rôle de la nuance. */
export type ColorUse = { kind: 'text'; chars: number; sizePt: number } | { kind: 'qr' } | { kind: 'guide' } | { kind: 'other' };

/** Clarté, écart des canaux et saturation (HSL, 0-1) d'une couleur. */
function hsl(hex: string) {
  const { r, g, b } = parseColor(hex)!;
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  return { r, g, b, max, l, d, saturation: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) };
}

/**
 * Gris neutre (blanc et noir compris) : ce que describeColor nomme « Gris », et ce que les petits textes
 * peuvent imprimer en noir seul (scripts/print-swatches.ts). La saturation plutôt que l'écart brut des
 * canaux : une teinte très pâle (fond de carte rosé) a peu d'écart mais reste une couleur, un gris chaud
 * de 9 unités d'écart reste un gris.
 */
export function isNeutralColor(hex: string): boolean {
  const { d, saturation } = hsl(hex);
  return d < 0.025 || saturation < 0.12;
}

/** Nom descriptif d'une couleur : famille de teinte et clarté (« Vert foncé », « Gris très clair », « Orange vif »). */
export function describeColor(hex: string): string {
  const { r, g, b, max, l, d, saturation } = hsl(hex);
  const shade = l > 0.9 ? ' très clair' : l > 0.72 ? ' clair' : l < 0.18 ? ' très foncé' : l < 0.32 ? ' foncé' : '';
  if (isNeutralColor(hex)) return l > 0.97 ? 'Blanc' : l < 0.08 ? 'Noir' : `Gris${shade}`;
  let h = 0;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  // Un orange sombre se lit comme un brun : sans cette famille, bois et terre cuite porteraient le même nom.
  const family =
    h < 12 ? 'Rouge' : h < 45 ? (l < 0.4 ? 'Brun' : 'Orange') : h < 65 ? 'Jaune' : h < 160 ? 'Vert' : h < 195 ? 'Sarcelle' : h < 255 ? 'Bleu' : h < 290 ? 'Violet' : h < 340 ? 'Rose' : 'Rouge';
  const vivid = !shade && saturation > 0.75 ? ' vif' : '';
  return `${family}${shade}${vivid}`;
}

export const kebab = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export interface SwatchUsage {
  swatch: Swatch;
  uses: number;
  /** Couleurs du design fusionnées dans cette nuance (ΔE00 < 1). */
  merged: string[];
}

interface UseStats {
  /** Caractères visibles de texte dans cette couleur, et parmi eux ceux des titres. */
  textChars: number;
  titleChars: number;
  qr: number;
  guide: number;
  other: number;
}

const emptyStats = (): UseStats => ({ textChars: 0, titleChars: 0, qr: 0, guide: 0, other: 0 });

/** Luminance relative (0 = noir, 1 = blanc), pour distinguer un noir de QR d'une couleur claire. */
function luminance(hex: string): number {
  const { r, g, b } = parseColor(hex)!;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Nuancier en construction : les objets reçoivent une référence provisoire, résolue par `finalize()`. */
export class SwatchRegistry {
  private uses = new Map<string, number>();
  private stats = new Map<string, UseStats>();
  private refs: { hex: string; ref: ColorRef }[] = [];
  private order: string[] = [];

  ref(color: string | Rgba, use: ColorUse = { kind: 'other' }): ColorRef {
    const rgba = typeof color === 'string' ? parseColor(color) : color;
    if (!rgba) throw new Error(`Couleur illisible : ${String(color)}`);
    const hex = toHex(rgba);
    if (!this.uses.has(hex)) this.order.push(hex);
    this.uses.set(hex, (this.uses.get(hex) ?? 0) + 1);
    this.note(hex, use);
    const ref: ColorRef = { swatch: `hex-${hex.slice(1)}` };
    this.refs.push({ hex, ref });
    return ref;
  }

  /** Usage de texte d'une référence déjà donnée : les caractères ne se comptent qu'une fois les segments lus. */
  noteText(ref: ColorRef, chars: number, sizePt: number): void {
    this.note(`#${ref.swatch.replace(/^hex-/, '')}`, { kind: 'text', chars, sizePt });
  }

  private note(hex: string, use: ColorUse): void {
    const s = this.stats.get(hex) ?? emptyStats();
    if (use.kind === 'text') {
      s.textChars += use.chars;
      if (use.sizePt >= TITLE_MIN_PT) s.titleChars += use.chars;
    } else s[use.kind]++;
    this.stats.set(hex, s);
  }

  /** Nom de rôle des couleurs gardées qui en ont un (les autres sont nommées par leur teinte). */
  private roles(kept: string[], statsOf: (hex: string) => UseStats): Map<string, string> {
    const roles = new Map<string, string>();
    const isWhite = (hex: string) => describeColor(hex) === 'Blanc';
    for (const hex of kept) {
      const s = statsOf(hex);
      if (s.guide > 0 && s.textChars === 0 && s.qr === 0 && s.other === 0) roles.set(hex, ROLE.guides);
      else if (s.qr > 0 && s.textChars === 0 && s.other === 0 && s.guide === 0 && luminance(hex) < 0.25) roles.set(hex, ROLE.qr);
    }
    // Texte principal : la couleur qui porte le plus de caractères ; titres : celle des grands corps, si elle diffère.
    const most = (key: 'textChars' | 'titleChars') =>
      kept
        .filter((hex) => !roles.has(hex) && !isWhite(hex) && statsOf(hex)[key] > 0)
        .sort((a, b) => statsOf(b)[key] - statsOf(a)[key] || this.order.indexOf(a) - this.order.indexOf(b))[0];
    const main = most('textChars');
    if (main) roles.set(main, ROLE.mainText);
    const titles = most('titleChars');
    if (titles) roles.set(titles, ROLE.titles);
    return roles;
  }

  /** Fusionne les quasi-doublons, nomme et numérote les nuances, puis corrige toutes les références. */
  finalize(threshold = 1): SwatchUsage[] {
    // Les plus utilisées d'abord : c'est elles qui absorbent leurs quasi-doublons.
    const byUse = [...this.order].sort((a, b) => this.uses.get(b)! - this.uses.get(a)! || this.order.indexOf(a) - this.order.indexOf(b));
    const target = new Map<string, string>();
    const kept: string[] = [];
    for (const hex of byUse) {
      const into = kept.find((k) => deltaE2000(k, hex) < threshold);
      if (into) target.set(hex, into);
      else {
        kept.push(hex);
        target.set(hex, hex);
      }
    }
    const stats = new Map<string, UseStats>();
    for (const [hex, into] of target) {
      const s = this.stats.get(hex) ?? emptyStats();
      const m = stats.get(into) ?? emptyStats();
      stats.set(into, { textChars: m.textChars + s.textChars, titleChars: m.titleChars + s.titleChars, qr: m.qr + s.qr, guide: m.guide + s.guide, other: m.other + s.other });
    }
    const roles = this.roles(kept, (hex) => stats.get(hex) ?? emptyStats());
    // Texte principal et titres en tête du nuancier, puis l'ordre d'apparition dans le design.
    const rank = (hex: string) => (roles.get(hex) === ROLE.mainText ? 0 : roles.get(hex) === ROLE.titles ? 1 : 2);
    kept.sort((a, b) => rank(a) - rank(b) || this.order.indexOf(a) - this.order.indexOf(b));
    const usedNames = new Set<string>();
    const usedIds = new Set<string>();
    const result = new Map<string, SwatchUsage>();
    for (const hex of kept) {
      const base = roles.get(hex) ?? describeColor(hex);
      let name = base;
      for (let n = 2; usedNames.has(name); n++) name = `${base} ${n}`;
      usedNames.add(name);
      let id = kebab(name) || `nuance-${hex.slice(1)}`;
      for (let n = 2; usedIds.has(id); n++) id = `${kebab(name)}-${n}`;
      usedIds.add(id);
      result.set(hex, { swatch: { id, name, rgb: hex }, uses: 0, merged: [] });
    }
    for (const [hex, into] of target) {
      const entry = result.get(into)!;
      entry.uses += this.uses.get(hex)!;
      if (hex !== into) entry.merged.push(hex);
    }
    for (const { hex, ref } of this.refs) ref.swatch = result.get(target.get(hex)!)!.swatch.id;
    return kept.map((hex) => result.get(hex)!);
  }
}
