import { DEFAULT_PORT, startServer } from './app';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? DEFAULT_PORT);

try {
  const server = await startServer({ dev, hmr: dev, port, logger: false });
  console.log(`Fluidprint : ${server.url}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void server.close().then(() => process.exit(0)));
  }
} catch (error) {
  // Un autre serveur local (un plan fluidplan, une autre instance) tient le port : une ligne qui dit
  // quoi faire plutôt qu'une pile Node.
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const script = dev ? 'dev' : 'start';
    const next = port + 1;
    console.error(`Le port ${port} est déjà pris par un autre serveur local. Relancez avec un autre port : PORT=${next} npm run ${script} (PowerShell : $env:PORT=${next}; npm run ${script})`);
  } else {
    console.error(`Démarrage impossible : ${(error as Error).stack ?? error}`);
  }
  process.exit(1);
}
