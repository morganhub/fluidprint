// Aides des tests du texte : ouvrir l'édition d'un bloc comme un utilisateur (double-clic au milieu du
// bloc ; un texte dans une carte demande deux double-clics : entrer dans le groupe, puis éditer).
import type { Page } from 'puppeteer-core';
import { settle } from './editor';

export async function openTextEditor(page: Page, id: string): Promise<void> {
  await page.evaluate((i) => window.__editor!.getState().centerOn([i]), id);
  await settle(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    const box = await page.evaluate((i) => window.__editor!.objectClientBox(i), id);
    await page.mouse.click(Math.round(box.x + box.w / 3), Math.round(box.y + box.h / 2), { count: 2 });
    await settle(page);
    if (await page.$(`[data-text-editor="${id}"]`)) break;
    // Double-clics trop rapprochés : on laisse passer le délai du double-clic.
    await new Promise((r) => setTimeout(r, 450));
  }
  await page.waitForFunction((i) => document.activeElement?.getAttribute('data-text-editor') === i, {}, id);
  await settle(page);
}
