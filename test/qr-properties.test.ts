// Propriétés d'un QR code (tâche 3.8) : adresse vérifiée (le code se redessine), niveau de correction,
// bouton « Tester » qui ouvre l'adresse, alerte sous 15 mm.
import { describe, expect, it } from 'vitest';
import type { QrObject } from '../src/model/types';
import { checkQrUrl } from '../src/panels/properties/QrSection';
import { copyExample, openEditor, readSavedDocument, saveNow, settle, typeInField, withApp, withTempDocuments } from './helpers/editor';

// Scénario complet dans Chrome : large marge quand toute la suite tourne en parallèle.
const BROWSER_TIMEOUT_MS = 180_000;

describe('QR code : vérification de l’adresse (3.8)', () => {
  it('accepte https, http (avec avertissement), mailto, tel ; refuse le reste', () => {
    expect(checkQrUrl(' https://example.com/benevoles ', 'M')).toEqual({ ok: true, url: 'https://example.com/benevoles', warning: undefined });
    expect(checkQrUrl('http://example.com', 'M')).toMatchObject({ ok: true, warning: expect.stringMatching(/https/) });
    expect(checkQrUrl('mailto:contact@example.com', 'M').ok).toBe(true);
    expect(checkQrUrl('tel:+33123456789', 'M').ok).toBe(true);
    expect(checkQrUrl('example.com', 'M')).toMatchObject({ ok: false });
    expect(checkQrUrl('javascript:alert(1)', 'M')).toMatchObject({ ok: false, error: expect.stringMatching(/Protocole/) });
    expect(checkQrUrl('https://exemple', 'M')).toMatchObject({ ok: false, error: expect.stringMatching(/domaine/) });
    expect(checkQrUrl('', 'M').ok).toBe(false);
    // Trop long pour un QR code au niveau H (plus de 1 273 octets).
    expect(checkQrUrl(`https://example.com/${'a'.repeat(1400)}`, 'H')).toMatchObject({ ok: false, error: expect.stringMatching(/trop longue/) });
  });
});

describe('QR code : panneau Propriétés (navigateur)', () => {
  it('adresse vérifiée, correction, « Tester », alerte sous 15 mm', async () => {
    await withTempDocuments(async (dir) => {
      const id = await copyExample(dir);
      await withApp(
        async ({ browser, url }) => {
          const page = await openEditor(browser, url, id, { zoom: 2, centerOn: 'ext-q3' });
          await page.evaluate(() => {
            // « Tester » ouvre un onglet : on intercepte l'ouverture (pas de réseau dans les tests).
            (window as unknown as { __opened: string[] }).__opened = [];
            window.open = ((u: string) => {
              (window as unknown as { __opened: string[] }).__opened.push(u);
              return null;
            }) as typeof window.open;
            window.__editor!.getState().select(['ext-q3']);
          });
          await page.click('[data-panel-tab="properties"]');
          await page.waitForSelector('[data-section="qr"]', { visible: true });
          const field = '[data-section="qr"] input[name="qrUrl"]';
          expect(await page.$eval(field, (e) => (e as HTMLInputElement).value)).toBe('https://example.com/benevoles');
          const pathBefore = await page.$eval('[data-workspace-viewport] [data-obj-id="ext-q3"] path', (p) => p.getAttribute('d'));

          // Adresse invalide : refusée, message, rien ne change.
          await typeInField(page, 'qrUrl', 'www.example.com/missions');
          expect(await page.$eval('[data-testid="qr-url-error"]', (e) => e.textContent)).toMatch(/https:\/\//);
          expect(await page.evaluate(() => (window.__editor!.getState().doc!.objects['ext-q3'] as QrObject).url)).toBe('https://example.com/benevoles');

          // Adresse valide : appliquée, le code se redessine.
          await typeInField(page, 'qrUrl', 'https://example.com/missions');
          expect(await page.$('[data-testid="qr-url-error"]')).toBeNull();
          expect(await page.evaluate(() => (window.__editor!.getState().doc!.objects['ext-q3'] as QrObject).url)).toBe('https://example.com/missions');
          const pathAfter = await page.$eval('[data-workspace-viewport] [data-obj-id="ext-q3"] path', (p) => p.getAttribute('d'));
          expect(pathAfter).not.toBe(pathBefore);

          // Niveau de correction.
          await page.select('[data-section="qr"] select[name="qrEcc"]', 'H');
          await settle(page);
          expect(await page.evaluate(() => (window.__editor!.getState().doc!.objects['ext-q3'] as QrObject).ecc)).toBe('H');

          // « Tester » ouvre l'adresse du code.
          await page.click('[data-action="test-qr"]');
          expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(['https://example.com/missions']);

          // 19 mm : pas d'alerte ; réduit à 12 mm : alerte ; remis à 15 mm : plus d'alerte.
          expect(await page.$('[data-testid="qr-size-warning"]')).toBeNull();
          await typeInField(page, 'w', '12');
          await typeInField(page, 'h', '12');
          const warning = await page.waitForSelector('[data-testid="qr-size-warning"]', { visible: true });
          expect(await warning!.evaluate((e) => e.textContent)).toMatch(/12 mm.*15 mm/);
          await typeInField(page, 'w', '15');
          await typeInField(page, 'h', '15');
          expect(await page.$('[data-testid="qr-size-warning"]')).toBeNull();

          await saveNow(page);
          const saved = (await readSavedDocument(dir, id)).objects['ext-q3'] as QrObject;
          expect(saved).toMatchObject({ url: 'https://example.com/missions', ecc: 'H', w: 15, h: 15 });
        },
        { documentsDir: dir },
      );
    });
  }, BROWSER_TIMEOUT_MS);
});
