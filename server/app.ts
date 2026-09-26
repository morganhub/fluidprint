import Fastify, { type FastifyInstance } from 'fastify';
import middie from '@fastify/middie';
import fastifyStatic from '@fastify/static';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { InlineConfig } from 'vite';
import { clientDependencies } from './clientDeps';
import { DEFAULT_DOCUMENTS_DIR, DIST_DIR, PROJECT_ROOT } from './paths';

export interface ServerOptions {
  /** Sert l'app via Vite (sources) plutôt que le build `dist/`. */
  dev?: boolean;
  /** Rechargement à chaud : seulement pour `npm run dev` (inutile et gênant dans les tests et l'export). */
  hmr?: boolean;
  /** 0 = port libre choisi par le système (tests, export en ligne de commande). */
  port?: number;
  documentsDir?: string;
  logger?: boolean;
  /** Adresse d'écoute : 127.0.0.1 par défaut ; 0.0.0.0 dans un conteneur, derrière un proxy. */
  host?: string;
  /** Mot de passe exigé (authentification HTTP Basic, identifiant libre) : seulement pour un serveur exposé. */
  password?: string;
}

export interface RunningServer {
  app: FastifyInstance;
  url: string;
  documentsDir: string;
  close(): Promise<void>;
}

// Écoute uniquement en local : l'éditeur lit et écrit des fichiers du disque (décision S4). Un serveur en ligne
// (conteneur) écoute plus large, mais seulement avec un mot de passe (`password`).
const HOST = '127.0.0.1';

function passwordMatches(header: string | undefined, password: string): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const given = createHash('sha256').update(decoded.slice(decoded.indexOf(':') + 1)).digest();
  // Empreintes de même longueur : comparaison à temps constant, quelle que soit la saisie.
  return timingSafeEqual(given, createHash('sha256').update(password).digest());
}

// Hors de la plage que balaie fluidplan (5178 et les 9 suivants) : ses serveurs de plans prenaient
// 5180 dès que deux ou trois tournaient, et `npm run dev` échouait alors sur EADDRINUSE.
export const DEFAULT_PORT = 5190;

/** Dossiers de cache des serveurs Vite sans rechargement à chaud (un par serveur). */
export const NO_HMR_CACHE_ROOT = path.join(PROJECT_ROOT, 'node_modules', '.vite-sans-hmr');
const STALE_CACHE_MS = 24 * 3600_000;

/** Caches laissés par un processus interrompu (plus d'un jour) : un serveur de test ou d'export ne dure pas si longtemps. */
async function pruneStaleCaches(): Promise<void> {
  const entries = await readdir(NO_HMR_CACHE_ROOT, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(NO_HMR_CACHE_ROOT, entry.name);
      const info = await stat(full).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_CACHE_MS) await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

/** Réglages du serveur Vite de développement (avec ou sans rechargement à chaud). */
export function viteServerConfig(options: Pick<ServerOptions, 'hmr' | 'logger'>, httpServer?: HttpServer): InlineConfig {
  if (options.hmr) {
    return {
      root: PROJECT_ROOT,
      appType: 'spa',
      // Le WebSocket du rechargement à chaud passe par le serveur HTTP de Fastify (`hmr.server`, déprécié par Vite 8).
      server: { middlewareMode: true, hmr: true, ws: { server: httpServer } },
      // Dossier à part : `npm run dev` garde la découverte des dépendances (lui sait recharger la page), et
      // son empreinte diffère de celle des serveurs sans rechargement ci-dessous.
      cacheDir: path.join(PROJECT_ROOT, 'node_modules', '.vite'),
      logLevel: options.logger ? 'info' : 'error',
    };
  }
  // Sans WebSocket, la page ne peut pas se recharger quand Vite réoptimise ses dépendances : elle reçoit
  // des 504 « Outdated Optimize Dep » et la route d'impression attend jusqu'au délai (audit C5). Deux causes :
  // - une dépendance découverte en cours de route : liste figée (lue dans src/), aucune découverte ;
  // - un autre processus qui réécrit le cache partagé (l'empreinte de Vite dépend de NODE_ENV : un export en
  //   ligne de commande et les tests n'ont pas la même, et des démarrages simultanés se marchent dessus) :
  //   chaque serveur a donc son propre dossier de cache (environ 1 s et 15 Mo de plus au démarrage), effacé
  //   à l'arrêt.
  return {
    root: PROJECT_ROOT,
    appType: 'spa',
    // Pas de WebSocket : plusieurs serveurs (tests, export) se disputeraient le port 24678.
    server: { middlewareMode: true, hmr: false, ws: false },
    cacheDir: path.join(NO_HMR_CACHE_ROOT, `${process.pid}-${randomUUID().slice(0, 8)}`),
    optimizeDeps: { include: clientDependencies(), noDiscovery: true },
    logLevel: options.logger ? 'info' : 'error',
  };
}

export async function createApp(options: ServerOptions = {}): Promise<FastifyInstance> {
  const documentsDir = options.documentsDir ?? DEFAULT_DOCUMENTS_DIR;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
  app.decorate('documentsDir', documentsDir);

  const password = options.password;
  if (password) {
    // Tout est protégé sauf /api/health (contrôle du déploiement ; ne dit rien des documents). Le navigateur
    // renvoie ensuite l'identifiant de lui-même, requêtes fetch de l'éditeur comprises.
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/api/health' || passwordMatches(req.headers.authorization, password)) return;
      reply.header('www-authenticate', 'Basic realm="Fluidprint", charset="UTF-8"').code(401).send({ error: 'Mot de passe requis' });
      return reply;
    });
  }

  app.get('/api/health', async () => ({ ok: true }));

  // Les routes de l'API sont branchées ici par les modules qui les portent (documents, assets, export).
  const routes = await import('./routes');
  await routes.registerApiRoutes(app, { documentsDir });

  if (options.dev) {
    const { createServer } = await import('vite');
    await app.register(middie);
    const config = viteServerConfig(options, app.server);
    if (!options.hmr) await pruneStaleCaches();
    const vite = await createServer(config);
    // Le repli SPA de Vite répondrait index.html aux appels d'API : on ne lui confie que le reste.
    app.use((req, res, next) => (req.url?.startsWith('/api/') ? next() : vite.middlewares(req, res, next)));
    app.addHook('onClose', async () => {
      await vite.close();
      if (!options.hmr && config.cacheDir) await rm(config.cacheDir, { recursive: true, force: true }).catch(() => undefined);
    });
  } else {
    if (!existsSync(DIST_DIR)) throw new Error('Build absent : lancer `npm run build`, ou `npm run dev`');
    await app.register(fastifyStatic, { root: DIST_DIR, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Route inconnue' }) : reply.sendFile('index.html'),
    );
  }
  return app;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const app = await createApp(options);
  try {
    await app.listen({ host: options.host ?? HOST, port: options.port ?? DEFAULT_PORT });
  } catch (error) {
    // Sans cela, le serveur Vite déjà créé garderait le processus en vie après l'échec.
    await app.close();
    throw error;
  }
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    url: `http://${HOST}:${port}`,
    documentsDir: options.documentsDir ?? DEFAULT_DOCUMENTS_DIR,
    close: () => app.close(),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    documentsDir: string;
  }
}
