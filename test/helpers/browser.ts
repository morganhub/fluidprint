import type { Browser } from 'puppeteer-core';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer, type ServerOptions } from '../../server/app';
import { launchBrowser } from '../../server/chrome';

export interface AppContext {
  server: RunningServer;
  browser: Browser;
  url: string;
}

// Démarre le serveur (sources servies par Vite, port libre) et un Chrome sans fenêtre, le temps d'un test.
export async function withApp<T>(fn: (ctx: AppContext) => Promise<T>, options: ServerOptions = {}): Promise<T> {
  const server = await startServer({ dev: true, hmr: false, port: 0, ...options });
  // Chrome lancé dans le try : s'il ne démarre pas, le serveur est quand même fermé (sinon le processus ne se termine jamais).
  try {
    const browser = await launchBrowser();
    try {
      return await fn({ server, browser, url: server.url });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

// Dossier de documents jetable, pour que les tests n'écrivent jamais dans documents/.
export async function withTempDocuments<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluidprint-docs-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
