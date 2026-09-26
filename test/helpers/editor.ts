// Tests d'interaction de l'éditeur : ouvrir /doc/:id sur un dossier de documents temporaire, attendre
// qu'il soit prêt, agir à la souris et au clavier comme un utilisateur, relire le document enregistré.
// Voir docs/ARCHITECTURE.md, « Écrire un test d'interaction ».
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Browser, KeyInput, Page } from 'puppeteer-core';
import type {} from '../../src/editor/devHandle';
import type { Id, LayoutDocument } from '../../src/model/types';
import { PX_PER_MM } from '../../src/model/units';

export { withApp, withTempDocuments } from './browser';

/**
 * Le dépliant d'exemple (organisation fictive « Atelier Horizon »), figé dans test/fixtures : lecture seule,
 * les tests n'en font que des copies dans des dossiers temporaires. Il est fait, dans l'ordre, de l'import de
 * test/fixtures/designs/depliant-exemple.dc.html (texte tel qu'importé : 8 apostrophes droites, aucune
 * correction typographique), des styles déduits par scripts/derive-styles.ts, du nuancier CMJN posé par
 * scripts/print-swatches.ts (--keep rose : une nuance d'accent laissée en exception, variantes « petit
 * texte » des autres) et de cinq photos provisoires synthétiques (paysages dessinés par sharp, extraits
 * d'un PDF par scripts/extract-pdf-images.py --fill). Aucun objet n'y a été ajouté, retiré ni déplacé
 * depuis l'import.
 */
export const EXAMPLE_ID = 'depliant-exemple';
export const EXAMPLE_DIR = path.resolve(import.meta.dirname, '../fixtures/depliant-exemple');
export const EXAMPLE_FILE = path.join(EXAMPLE_DIR, 'document.json');
/** Le design Claude Design dont le dépliant d'exemple est l'import. */
export const EXAMPLE_DESIGN = path.resolve(import.meta.dirname, '../fixtures/designs/depliant-exemple.dc.html');

/** Écrit un document dans un dossier de documents (temporaire). */
export async function writeDocument(dir: string, doc: LayoutDocument): Promise<void> {
  await mkdir(path.join(dir, doc.id), { recursive: true });
  await writeFile(path.join(dir, doc.id, 'document.json'), JSON.stringify(doc, null, 2));
}

/** Copie le dépliant d'exemple figé dans un dossier temporaire ; renvoie son identifiant. */
export async function copyExample(dir: string): Promise<string> {
  await mkdir(path.join(dir, EXAMPLE_ID), { recursive: true });
  await copyFile(EXAMPLE_FILE, path.join(dir, EXAMPLE_ID, 'document.json'));
  // Les photos provisoires sont référencées par le document : sans elles, rendu et export échouent.
  const assets = path.join(EXAMPLE_DIR, 'assets');
  if (existsSync(assets)) await cp(assets, path.join(dir, EXAMPLE_ID, 'assets'), { recursive: true });
  return EXAMPLE_ID;
}

/** Document tel qu'il est sur le disque. */
export async function readSavedDocument(dir: string, id: string): Promise<LayoutDocument> {
  return JSON.parse(await readFile(path.join(dir, id, 'document.json'), 'utf8'));
}

export interface OpenOptions {
  viewport?: { width: number; height: number };
  /** Zoom appliqué après ouverture (1 = taille réelle) ; par défaut « Ajuster ». */
  zoom?: number;
  /** Objet ou face à centrer à l'écran (utile à fort zoom). */
  centerOn?: Id;
}

/** Ouvre l'éditeur sur un document et attend `window.__editor.ready`. */
export async function openEditor(browser: Browser, url: string, docId: string, options: OpenOptions = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(options.viewport ?? { width: 1600, height: 1000 });
  page.on('pageerror', (error) => console.error(`[page] ${error}`));
  await page.goto(`${url}/doc/${encodeURIComponent(docId)}`);
  await page.waitForFunction(() => window.__editor?.ready === true, { timeout: 60_000 });
  if (options.zoom !== undefined) await setZoom(page, options.zoom, options.centerOn);
  else if (options.centerOn) await centerOn(page, options.centerOn);
  return page;
}

export async function setZoom(page: Page, zoom: number, center?: Id): Promise<void> {
  await page.evaluate(
    (z, c) => {
      const s = window.__editor!.getState();
      s.setZoom(z);
      if (c) window.__editor!.getState().centerOn([c]);
    },
    zoom,
    center ?? null,
  );
  await settle(page);
}

export async function centerOn(page: Page, id: Id): Promise<void> {
  await page.evaluate((c) => window.__editor!.getState().centerOn([c]), id);
  await settle(page);
}

/** Laisse React peindre (deux images). */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

export async function editorState<T>(page: Page, pick: (s: ReturnType<NonNullable<Window['__editor']>['getState']>) => T): Promise<T> {
  // La fonction est sérialisée et réévaluée dans la page : elle ne doit pas capturer de variable.
  return page.evaluate(`(${pick.toString()})(window.__editor.getState())`) as Promise<T>;
}

export const selection = (page: Page): Promise<Id[]> => page.evaluate(() => window.__editor!.getState().selection);

/** Point d'une face (mm) en coordonnées client. */
export function pageToClient(page: Page, pageId: Id, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate((p, xx, yy) => window.__editor!.pageToClient(p, xx, yy), pageId, x, y);
}

/** Centre d'un objet à l'écran, en coordonnées client. */
export async function objectCenter(page: Page, id: Id): Promise<{ x: number; y: number }> {
  const b = await page.evaluate((i) => window.__editor!.objectClientBox(i), id);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export interface DragOptions {
  /** Nombre d'étapes de souris (≥ 1). */
  steps?: number;
  /** Durée totale du geste, en ms (pauses réparties entre les étapes). */
  durationMs?: number;
  /** Touches tenues pendant le geste (Shift, Alt…). */
  hold?: KeyInput[];
}

/**
 * Glisse de (dxMm, dyMm) à l'écran depuis un point client, au zoom courant : la distance en pixels est
 * celle qu'une vraie souris parcourrait (arrondie au pixel entier, comme une souris).
 */
export async function dragFrom(page: Page, from: { x: number; y: number }, dxMm: number, dyMm: number, options: DragOptions = {}): Promise<void> {
  const zoom = await page.evaluate(() => window.__editor!.getState().zoom);
  const dxPx = Math.round(dxMm * PX_PER_MM * zoom);
  const dyPx = Math.round(dyMm * PX_PER_MM * zoom);
  const steps = Math.max(1, options.steps ?? 10);
  const pause = options.durationMs ? options.durationMs / steps : 0;
  for (const key of options.hold ?? []) await page.keyboard.down(key);
  const x0 = Math.round(from.x);
  const y0 = Math.round(from.y);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + Math.round((dxPx * i) / steps), y0 + Math.round((dyPx * i) / steps));
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  await page.mouse.up();
  for (const key of options.hold ?? []) await page.keyboard.up(key);
  await settle(page);
}

/** Glisse un objet (saisi en son centre) de (dxMm, dyMm) à l'écran. */
export async function dragObject(page: Page, id: Id, dxMm: number, dyMm: number, options: DragOptions = {}): Promise<void> {
  await dragFrom(page, await objectCenter(page, id), dxMm, dyMm, options);
}

/** Clic en un point d'une face (mm). */
export async function clickAt(page: Page, pageId: Id, x: number, y: number, options: { shift?: boolean } = {}): Promise<void> {
  const p = await pageToClient(page, pageId, x, y);
  if (options.shift) await page.keyboard.down('Shift');
  await page.mouse.click(Math.round(p.x), Math.round(p.y));
  if (options.shift) await page.keyboard.up('Shift');
  await settle(page);
}

/** Raccourci clavier : `press(page, 'Control', 'd')`. */
export async function press(page: Page, ...keys: KeyInput[]): Promise<void> {
  for (const k of keys) await page.keyboard.down(k);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  await settle(page);
}

/** Enregistre tout de suite (comme Ctrl+S) et attend la réponse du serveur. */
export async function saveNow(page: Page): Promise<void> {
  await page.evaluate(() => window.__editor!.saveNow());
}

/** Saisit une valeur dans un champ du panneau Propriétés (par son attribut name) et valide par Entrée. */
export async function typeInField(page: Page, name: string, value: string): Promise<void> {
  const input = await page.waitForSelector(`[data-side-panels] input[name="${name}"]`, { visible: true });
  await input!.click({ count: 3 });
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await settle(page);
}
