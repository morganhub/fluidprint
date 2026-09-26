# CLAUDE.md — fluidprint

Éditeur de mise en page local pour documents imprimés : import Claude Design, édition façon Canva,
export PDF/X-4 CMJN. Architecture : `docs/ARCHITECTURE.md`. Mode d'emploi : `README.md`.

## Git

- Branche unique `main` ; commits directement dessus, sans branche.
- Message de commit = **la version seule**, `vX.X` (ex. `v1.2`), rien d'autre : ni corps, ni ligne
  d'attribution. Demander ou déduire la version suivante (mineure pour une fonctionnalité).
- Dépôt distant : `origin` = https://github.com/morganhub/fluidprint.git. Pousser seulement sur demande.

## Données

- `documents/` contient les documents de l'utilisateur (ignoré par git). **Aucun test, script d'essai ou
  sonde n'y écrit** : utiliser `test/fixtures/` ou un dossier temporaire (`withTempDocuments`). Des sondes
  ont déjà abîmé un vrai document.
- Un document ouvert dans l'éditeur s'enregistre tout seul : ne pas modifier `documents/<id>/document.json`
  pendant qu'un éditeur est ouvert dessus (le serveur répond alors 409 à l'éditeur).

## Commandes

- Sous PowerShell, `npm run x -- --arg` perd ses arguments : utiliser Git Bash ou `npm.cmd`.
- `npm run dev` → http://127.0.0.1:5190 (ne recharge pas le code serveur : le relancer après une
  modification de `server/` ou de `src/model/`).
- Avant une version : `npm run typecheck`, `npx vitest run` (toute la suite, un seul passage),
  `npm run test:print`.
