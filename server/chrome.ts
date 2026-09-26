import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer-core';

// Le même Chrome que celui où l'on édite : les coupures de ligne de l'export et de l'écran
// viennent alors du même moteur (décision S5).
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome(): string {
  const found = CANDIDATES.find((p): p is string => !!p && existsSync(p));
  if (!found) throw new Error('Chrome introuvable : définir CHROME_PATH vers chrome.exe');
  return found;
}

// Tous les rendus automatisés (import, contrôle au pixel, export) partagent ces réglages,
// sinon les mesures de texte peuvent différer d'un outil à l'autre.
export const CHROME_ARGS = ['--no-first-run', '--no-default-browser-check', '--font-render-hinting=none', '--hide-scrollbars'];

export function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return puppeteer.launch({ executablePath: findChrome(), headless: true, args: CHROME_ARGS, ...options });
}
