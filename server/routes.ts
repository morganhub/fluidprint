import type { FastifyInstance } from 'fastify';
import { registerAssetRoutes } from './assets';
import { registerDocumentRoutes } from './documents';
import { registerExportRoutes } from './export';
import { registerImportRoutes } from './importDesign';
import { registerTemplateRoutes } from './templates';

export interface RouteContext {
  documentsDir: string;
  /** Taille maximale d'une photo envoyée (200 Mo par défaut) ; réglable pour les tests. */
  maxUploadBytes?: number;
}

// Point d'entrée unique des routes d'API ; chaque module (documents, assets, export, gabarits) s'y enregistre.
export async function registerApiRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  registerDocumentRoutes(app, ctx);
  await registerAssetRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  // Après les images : l'import d'un design reçoit lui aussi un envoi multipart (plugin enregistré par assets).
  registerImportRoutes(app, ctx);
}
