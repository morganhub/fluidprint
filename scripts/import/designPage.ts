// Page statique des faces d'un design Claude Design, partagée par l'importeur et le contrôle au pixel.
//
// On n'exécute pas le moteur de Claude Design (support.js charge React depuis Internet et transforme
// le gabarit) : chaque `<section class="page">` devient une face `.design-face` à la taille de la page
// du design, avec les feuilles de style du design. Les polices locales sont incorporées en data: URL,
// car Chrome refuse de charger une police depuis un fichier local (file://) pour une page elle-même locale.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'puppeteer-core';
import type { DocumentFormat } from '../../src/model/types';
import { mmToPx } from '../../src/model/units';
import { PROJECT_ROOT } from '../../server/paths';
import { assignSections, resolveFormat, type FaceAssignment, type ResolvedFormat } from './designFormat';
import { DesignImportError, parseDesign, type ParsedDesign } from './designSource';

export interface DesignFace {
  /** Face du format qui imprime la section (`exterieur`, `recto`…). */
  faceId: string;
  /** Attribut `id` de la section dans le design. */
  sectionId: string;
  label: string;
}

// Toutes les graisses livrées avec l'éditeur (public/fonts, src/styles/fonts.css) : un texte gras
// italique est mesuré avec la vraie police, comme l'éditeur le dessinera, et non avec un italique simulé.
const FONT_FILES: { file: string; weight: number; style: 'normal' | 'italic' }[] = [
  { file: 'OpenSans-Regular.ttf', weight: 400, style: 'normal' },
  { file: 'OpenSans-Italic.ttf', weight: 400, style: 'italic' },
  { file: 'OpenSans-SemiBold.ttf', weight: 600, style: 'normal' },
  { file: 'OpenSans-SemiBoldItalic.ttf', weight: 600, style: 'italic' },
  { file: 'OpenSans-Bold.ttf', weight: 700, style: 'normal' },
  { file: 'OpenSans-BoldItalic.ttf', weight: 700, style: 'italic' },
  { file: 'OpenSans-ExtraBold.ttf', weight: 800, style: 'normal' },
  { file: 'OpenSans-ExtraBoldItalic.ttf', weight: 800, style: 'italic' },
];

/** Seule famille installée dans l'éditeur : un texte dans une autre police sera rendu autrement. */
export const EDITOR_FONT_FAMILY = 'Open Sans';

async function embeddedFontsCss(): Promise<string> {
  const rules = await Promise.all(
    FONT_FILES.map(async ({ file, weight, style }) => {
      const data = await readFile(path.join(PROJECT_ROOT, 'public', 'fonts', file));
      return `@font-face{font-family:'${EDITOR_FONT_FAMILY}';src:url(data:font/ttf;base64,${data.toString('base64')}) format('truetype');font-weight:${weight};font-style:${style};font-display:block}`;
    }),
  );
  return rules.join('\n');
}

export interface DesignPageOptions {
  /** Export HTML de Claude Design (obligatoire : il n'y a pas de design par défaut). */
  designFile: string;
  /** Garder les repères écran du design (`<sc-if>`) : utile seulement pour les contrôler. */
  keepGuides?: boolean;
  /** Gabarit imposé (identifiant), comme `--template`. */
  templateId?: string;
  /** Format déjà résolu par l'importeur (il a lu le design avant de lancer Chrome). */
  resolved?: ResolvedFormat;
  /** Format d'un document déjà importé (contrôle au pixel) : les sections s'y rangent comme à l'import. */
  format?: DocumentFormat;
}

export interface DesignHtml {
  html: string;
  /** Faces dans l'ordre du format. */
  faces: DesignFace[];
  design: ParsedDesign;
  /** Format résolu ; null quand `format` était fourni. */
  resolved: ResolvedFormat | null;
  /** Fenêtre de Chrome : au moins la largeur d'une face, pour qu'aucun texte ne se coupe à cause d'elle. */
  viewport: { width: number; height: number };
}

export async function loadDesign(designFile: string): Promise<ParsedDesign> {
  return parseDesign(await readFile(designFile, 'utf8'));
}

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** HTML autonome des faces du design, chacune dans `section.design-face[data-face-id]` à la taille de la page. */
export async function buildDesignHtml(options: DesignPageOptions): Promise<DesignHtml> {
  const design = await loadDesign(options.designFile);
  let resolved: ResolvedFormat | null = null;
  let assignments: FaceAssignment[];
  if (options.format) {
    if (options.format.faces.length !== design.sections.length) {
      throw new DesignImportError(`Le design a ${design.sections.length} page(s), le format du document ${options.format.faces.length} face(s)`);
    }
    assignments = assignSections(design.sections, options.format);
  } else {
    resolved = options.resolved ?? resolveFormat(design, { templateId: options.templateId });
    assignments = resolved.faces;
  }

  const faces: DesignFace[] = [];
  const bodies: string[] = [];
  for (const a of assignments) {
    const section = design.sections[a.sectionIndex];
    let body = options.keepGuides ? section.inner.replace(/<\/?sc-if\b[^>]*>/gi, '') : section.inner.replace(/<sc-if\b[\s\S]*?<\/sc-if\s*>/gi, '');
    // Un script du design n'a rien à mesurer : il ne doit pas s'exécuter dans la page de mesure.
    body = body.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
    // La section elle-même devient la face : son style (fond, marges intérieures) et les règles du design
    // qui la visent (.page, #id) s'appliquent comme dans Claude Design.
    const classes = ['design-face', ...(section.attrs.class ?? '').split(/\s+/).filter(Boolean)];
    const attrs = Object.entries(section.attrs)
      .filter(([name]) => name !== 'class' && !name.startsWith('data-face-') && name !== 'data-section-id')
      .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
      .join('');
    faces.push({ faceId: a.faceId, sectionId: section.id, label: section.label });
    bodies.push(`<section class="${escapeAttr(classes.join(' '))}" data-face-id="${escapeAttr(a.faceId)}" data-section-id="${escapeAttr(section.id)}"${attrs}>${body}</section>`);
  }

  const { w, h } = design.page;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<style>
${await embeddedFontsCss()}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:'${EDITOR_FONT_FAMILY}',sans-serif;background:#ffffff}
.design-face{background:#ffffff}
image-slot{display:block;width:100%;height:100%}
</style>
${design.styles.map((css) => `<style>${css}</style>`).join('\n')}
<style>
.design-face{position:relative !important;display:block !important;width:${w}mm !important;height:${h}mm !important;margin:0 !important;overflow:hidden !important;box-sizing:border-box;container-type:size}
</style></head><body>${bodies.join('\n')}</body></html>`;
  return {
    html,
    faces,
    design,
    resolved,
    // Largeur d'une face en px CSS arrondie au-dessus (303 mm ≈ 1145,2 px → 1146) : pas de retour à la ligne dû à la fenêtre.
    viewport: { width: Math.ceil(mmToPx(w)), height: 900 },
  };
}

/** Ouvre la page statique du design dans un onglet, polices chargées. */
export async function openDesignPage(
  browser: Browser,
  options: DesignPageOptions & { deviceScaleFactor?: number },
): Promise<{ page: Page } & Omit<DesignHtml, 'html'>> {
  const { html, ...built } = await buildDesignHtml(options);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-design-'));
  try {
    const file = path.join(dir, 'design.html');
    await writeFile(file, html, 'utf8');
    const page = await browser.newPage();
    await page.setViewport({ ...built.viewport, deviceScaleFactor: options.deviceScaleFactor ?? 1 });
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return { page, ...built };
  } finally {
    // La page chargée n'a plus besoin du fichier (polices en data: URL) : sans cela, chaque import et
    // chaque contrôle au pixel laissait 1,1 Mo dans le dossier temporaire.
    await rm(dir, { recursive: true, force: true });
  }
}
