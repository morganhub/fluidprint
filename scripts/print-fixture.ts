// PDF d'essai produit par Chrome pour les tests du post-traitement imprimeur (print/test_*.py) :
// texte petit et grand, aplats, découpe vectorielle d'une photo, photo JPEG et PNG à transparence,
// groupe transparent (opacité), filet, et une couleur hors nuancier.
//   tsx scripts/print-fixture.ts --out <fichier.pdf> [--json <description.json>]
// Variantes : --emoji (« Votre ✓ → 📱 » : emoji en police Type 3, symboles en police de repli) ;
// --photo <fichier> (une photo, telle quelle, dans un cadre de 40 × 25 mm : original CMJN, haute définition).
// La description JSON donne les couleurs utilisées et les dimensions des photos, que les tests comparent.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { launchBrowser } from '../server/chrome';

export const FIXTURE_COLORS = {
  marine: '#22313f',
  gris: '#4b4d55',
  bleu: '#2563eb',
  violet: '#7446c4',
  blanc: '#ffffff',
  noirRiche: '#101820',
  // Absente du nuancier des tests : doit être convertie par le profil et signalée.
  horsNuancier: '#e0245e',
} as const;

export const FIXTURE_PHOTO = { width: 1200, height: 800 };
export const FIXTURE_ALPHA = { width: 400, height: 300 };

/** Photo synthétique : dégradé coloré et bruit, pour qu'une compression ou un rééchantillonnage se voie. */
async function photo(width: number, height: number, alpha: boolean): Promise<Buffer> {
  const channels = alpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 16) % 24;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      data[o] = Math.min(255, Math.round((255 * x) / width) + noise());
      data[o + 1] = Math.min(255, Math.round((200 * y) / height) + noise());
      data[o + 2] = Math.min(255, 90 + noise() * 4);
      // Photo de départ saturée (rouge vif en haut à droite) : la conversion CMJN la ternit visiblement.
      if (alpha) data[o + 3] = Math.round(255 * Math.min(1, Math.hypot(x - width / 2, y - height / 2) / (width / 2)) ** 0.5);
    }
  }
  const img = sharp(data, { raw: { width, height, channels } });
  return alpha ? img.png().toBuffer() : img.jpeg({ quality: 92 }).toBuffer();
}

export async function fixtureHtml(): Promise<string> {
  const jpeg = (await photo(FIXTURE_PHOTO.width, FIXTURE_PHOTO.height, false)).toString('base64');
  const png = (await photo(FIXTURE_ALPHA.width, FIXTURE_ALPHA.height, true)).toString('base64');
  const c = FIXTURE_COLORS;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 100mm 70mm; margin: 0; }
    html, body { margin: 0; padding: 0; background: ${c.blanc}; }
    .page { position: relative; width: 100mm; height: 70mm; overflow: hidden; font-family: Arial, sans-serif; }
    .abs { position: absolute; }
  </style></head><body><div class="page">
    <div class="abs" style="left:0;top:0;width:100mm;height:12mm;background:${c.marine}"></div>
    <div class="abs" style="left:4mm;top:3mm;font-size:14pt;font-weight:700;color:${c.blanc}">Titre sur marine</div>
    <div class="abs" style="left:4mm;top:15mm;width:44mm;font-size:7pt;line-height:1.4;color:${c.gris}">Petit texte courant, gris, de moins de 9 pt, sur deux lignes au moins pour l'essai.</div>
    <div class="abs" style="left:4mm;top:26mm;font-size:12pt;color:${c.bleu}">Bleu d'essai</div>
    <div class="abs" style="left:4mm;top:33mm;width:20mm;height:8mm;background:${c.violet}"></div>
    <div class="abs" style="left:26mm;top:33mm;width:20mm;height:8mm;background:${c.noirRiche}"></div>
    <div class="abs" style="left:4mm;top:43mm;width:42mm;height:0;border-top:0.5pt solid ${c.horsNuancier}"></div>
    <svg class="abs" style="left:52mm;top:14mm;width:44mm;height:30mm;clip-path:url(#goutte)" viewBox="0 0 44 30" preserveAspectRatio="none">
      <defs><clipPath id="goutte" clipPathUnits="objectBoundingBox"><ellipse cx="0.5" cy="0.5" rx="0.5" ry="0.5"/></clipPath></defs>
      <image href="data:image/jpeg;base64,${jpeg}" x="0" y="0" width="44" height="30" preserveAspectRatio="none"/>
    </svg>
    <img class="abs" style="left:52mm;top:46mm;width:24mm;height:18mm" src="data:image/png;base64,${png}">
    <div class="abs" style="left:4mm;top:48mm;width:40mm;height:18mm;opacity:0.5">
      <div class="abs" style="left:0;top:0;width:40mm;height:18mm;background:${c.bleu}"></div>
      <div class="abs" style="left:3mm;top:5mm;font-size:10pt;color:${c.blanc}">Groupe transparent</div>
    </div>
  </div></body></html>`;
}

/** Page des variantes : un titre, une ligne d'emoji et de symboles, une photo facultative. */
export function variantHtml(options: { emoji?: boolean; photo?: { mime: string; base64: string } }): string {
  const c = FIXTURE_COLORS;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 100mm 70mm; margin: 0; }
    html, body { margin: 0; padding: 0; background: ${c.blanc}; }
    .page { position: relative; width: 100mm; height: 70mm; overflow: hidden; font-family: Arial, sans-serif; }
    .abs { position: absolute; }
  </style></head><body><div class="page">
    <div class="abs" style="left:4mm;top:4mm;font-size:14pt;color:${c.marine}">Variante d'essai</div>
    ${options.emoji ? `<div class="abs" style="left:4mm;top:14mm;font-size:16pt;color:${c.bleu}">Votre ✓ → 📱</div>` : ''}
    ${options.photo ? `<img class="abs" style="left:50mm;top:30mm;width:40mm;height:25mm" src="data:${options.photo.mime};base64,${options.photo.base64}">` : ''}
  </div></body></html>`;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, json: { type: 'string' }, emoji: { type: 'boolean', default: false }, photo: { type: 'string' } } });
  if (!values.out) throw new Error('Usage : tsx scripts/print-fixture.ts --out <fichier.pdf> [--json <description.json>] [--emoji] [--photo <fichier>]');
  const variant = values.emoji || values.photo;
  const photo = values.photo
    ? { mime: /\.png$/i.test(values.photo) ? 'image/png' : 'image/jpeg', base64: (await readFile(values.photo)).toString('base64') }
    : undefined;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(variant ? variantHtml({ emoji: values.emoji, photo }) : await fixtureHtml(), { waitUntil: 'load' });
    const pdf = await page.pdf({ width: '100mm', height: '70mm', printBackground: true, preferCSSPageSize: true });
    await writeFile(values.out, pdf);
  } finally {
    await browser.close();
  }
  if (values.json) {
    await writeFile(values.json, JSON.stringify({ colors: FIXTURE_COLORS, photo: FIXTURE_PHOTO, alpha: FIXTURE_ALPHA }, null, 2));
  }
}

if (process.argv[1] && /print-fixture\.ts$/.test(process.argv[1])) await main();
