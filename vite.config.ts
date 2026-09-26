import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tests du serveur (dont l'envoi d'une photo de 40 Mo chronométré à 5 s) : ils passent seuls, avant les
// autres. En parallèle des tests qui lancent Chrome à 300 ppi, le chronomètre mesurait la charge de la
// machine plutôt que le serveur, et le test échouait une fois sur deux.
const TIMED = ['test/server.test.ts'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Même port que server/app.ts (DEFAULT_PORT), hors de la plage 5178-5187 de fluidplan.
  server: { host: '127.0.0.1', port: 5190, strictPort: true },
  test: {
    environment: 'node',
    // Les tests de rendu lancent Chrome : on leur laisse le temps de démarrer.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Chaque fichier de rendu lance son serveur Vite et son Chrome : à 7 en parallèle (défaut sur 8 cœurs),
    // certains dépassaient 90 s par pure charge et la suite n'était jamais verte d'un seul passage.
    maxWorkers: '50%',
    projects: [
      { extends: true, test: { name: 'serveur', include: TIMED, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'rendu', include: ['test/**/*.test.ts', 'src/**/*.test.ts'], exclude: TIMED, sequence: { groupOrder: 1 } } },
    ],
  },
});
