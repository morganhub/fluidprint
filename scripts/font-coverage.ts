// Caractères couverts par les polices de l'éditeur (public/fonts), pour le contrôle en amont : un caractère
// absent d'Open Sans est dessiné par une police du système (Times, Segoe UI Emoji…), qui part dans le PDF en
// police de repli ou en Type 3 (dessin en contours, emoji en couleurs RVB).
//   npx tsx scripts/font-coverage.ts          réécrit src/model/fontCoverage.ts
//   npx tsx scripts/font-coverage.ts --check  code 1 si le fichier ne correspond plus aux polices
// Relancer après tout ajout de police dans public/fonts (test/preflight.test.ts le vérifie).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FONTS_DIR = path.join(PROJECT_ROOT, 'public', 'fonts');
export const COVERAGE_FILE = path.join(PROJECT_ROOT, 'src', 'model', 'fontCoverage.ts');

export interface FontFace {
  file: string;
  /** Famille typographique (nom 16, sinon 1) : « Open Sans ». */
  family: string;
  /** Nom PostScript (nom 6) : celui que Chrome écrit dans le /BaseFont du PDF. */
  postscript: string;
  codepoints: Set<number>;
}

function tables(font: Buffer): Map<string, { offset: number; length: number }> {
  const count = font.readUInt16BE(4);
  const map = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    map.set(font.toString('latin1', at, at + 4), { offset: font.readUInt32BE(at + 8), length: font.readUInt32BE(at + 12) });
  }
  return map;
}

function readNames(font: Buffer, offset: number): Map<number, string> {
  const count = font.readUInt16BE(offset + 2);
  const strings = offset + font.readUInt16BE(offset + 4);
  const names = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const at = offset + 6 + 12 * i;
    const [platform, , language, nameId, length, start] = [0, 2, 4, 6, 8, 10].map((o) => font.readUInt16BE(at + o));
    // Windows, anglais (0x409), UTF-16BE : l'enregistrement que toutes les polices Google fournissent.
    if (platform !== 3 || language !== 0x409 || names.has(nameId)) continue;
    const raw = font.subarray(strings + start, strings + start + length);
    let text = '';
    for (let k = 0; k + 1 < raw.length; k += 2) text += String.fromCharCode(raw.readUInt16BE(k));
    names.set(nameId, text);
  }
  return names;
}

function readCmap(font: Buffer, offset: number): Set<number> {
  const count = font.readUInt16BE(offset + 2);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < count; i++) {
    const at = offset + 4 + 8 * i;
    const [platform, encoding] = [font.readUInt16BE(at), font.readUInt16BE(at + 2)];
    const sub = offset + font.readUInt32BE(at + 4);
    const format = font.readUInt16BE(sub);
    if (format === 12 && (platform === 3 || platform === 0)) format12 = sub;
    if (format === 4 && ((platform === 3 && encoding === 1) || platform === 0)) format4 = sub;
  }
  const codepoints = new Set<number>();
  if (format12 >= 0) {
    const groups = font.readUInt32BE(format12 + 12);
    for (let g = 0; g < groups; g++) {
      const at = format12 + 16 + 12 * g;
      for (let c = font.readUInt32BE(at); c <= font.readUInt32BE(at + 4); c++) codepoints.add(c);
    }
    return codepoints;
  }
  if (format4 < 0) throw new Error('Table cmap sans sous-table Unicode (format 4 ou 12)');
  const segments = font.readUInt16BE(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const rangeOffsets = deltas + 2 * segments;
  for (let s = 0; s < segments; s++) {
    const end = font.readUInt16BE(ends + 2 * s);
    const start = font.readUInt16BE(starts + 2 * s);
    const delta = font.readInt16BE(deltas + 2 * s);
    const rangeOffset = font.readUInt16BE(rangeOffsets + 2 * s);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        const at = rangeOffsets + 2 * s + rangeOffset + 2 * (c - start);
        glyph = font.readUInt16BE(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) codepoints.add(c);
    }
  }
  return codepoints;
}

export function readFontFace(file: string): FontFace {
  const font = readFileSync(file);
  const t = tables(font);
  const name = t.get('name');
  const cmap = t.get('cmap');
  if (!name || !cmap) throw new Error(`${path.basename(file)} : tables name ou cmap absentes`);
  const names = readNames(font, name.offset);
  return {
    file: path.basename(file),
    family: names.get(16) ?? names.get(1) ?? path.basename(file),
    postscript: names.get(6) ?? path.basename(file, path.extname(file)),
    codepoints: readCmap(font, cmap.offset),
  };
}

export function readFontFaces(dir = FONTS_DIR): FontFace[] {
  return readdirSync(dir)
    .filter((f) => /\.(ttf|otf)$/i.test(f))
    .sort()
    .map((f) => readFontFace(path.join(dir, f)));
}

/** Plages « 20-7e,a0-17f » (hexadécimal) : compact et lisible dans le fichier généré. */
export function toRanges(codepoints: Iterable<number>): string {
  const sorted = [...codepoints].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? sorted[i].toString(16) : `${sorted[i].toString(16)}-${sorted[j].toString(16)}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** Contenu de src/model/fontCoverage.ts : par famille, les caractères présents dans TOUTES ses faces. */
export function coverageModule(faces: FontFace[]): string {
  const families = new Map<string, FontFace[]>();
  for (const face of faces) families.set(face.family, [...(families.get(face.family) ?? []), face]);
  const entries = [...families].map(([family, list]) => {
    const common = [...list[0].codepoints].filter((c) => list.every((f) => f.codepoints.has(c)));
    return `  ${JSON.stringify(family)}: ${JSON.stringify(toRanges(common))},`;
  });
  const postscript = faces.map((f) => JSON.stringify(f.postscript)).join(', ');
  return `// Fichier généré par scripts/font-coverage.ts d'après public/fonts : ne pas modifier à la main.
// Caractères présents dans toutes les faces de chaque famille (plages hexadécimales), et noms PostScript des
// faces fournies (ceux que Chrome écrit dans le PDF, contrôlés par print/check_pdfx.py).

export const FONT_COVERAGE: Record<string, string> = {
${entries.join('\n')}
};

export const FONT_POSTSCRIPT_NAMES: readonly string[] = [${postscript}];
`;
}

function main(): number {
  const text = coverageModule(readFontFaces());
  if (process.argv.includes('--check')) {
    const current = readFileSync(COVERAGE_FILE, 'utf8');
    if (current.replace(/\r\n/g, '\n') !== text) {
      console.error(`${path.relative(PROJECT_ROOT, COVERAGE_FILE)} ne correspond plus à public/fonts : relancer npx tsx scripts/font-coverage.ts`);
      return 1;
    }
    console.log('Couverture des polices à jour.');
    return 0;
  }
  writeFileSync(COVERAGE_FILE, text);
  console.log(`Écrit : ${path.relative(PROJECT_ROOT, COVERAGE_FILE)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
