# Fluidprint

Éditeur de mise en page local pour documents imprimés (dépliants, flyers, affiches, cartes de visite).
On importe un design [Claude Design](https://claude.ai), on l'édite comme dans Canva — pensé comme
InDesign — et on exporte un PDF/X-4 en CMJN prêt pour l'imprimeur.

## Fonctionnalités

- **Import Claude Design**, tous formats : chaque objet du design devient un objet éditable, positionné au
  millimètre (fidélité vérifiée au pixel). Le format est reconnu parmi les gabarits, ou déduit du design
  (fond perdu, plis).
- **Nouveau document** depuis un gabarit : dépliant A4 pli roulé ou accordéon, A4 recto verso, flyer A5,
  carte de visite, affiche A3 — et duplication d'un document.
- **Édition** : sélection, poignées, rotation, magnétisme et repères intelligents, règles et repères,
  alignement, groupes, calques (masquer, verrouiller, non imprimable), annuler / rétablir, enregistrement
  automatique, versions nommées.
- **Texte** : édition sur place, styles de paragraphe et de caractère, typographie française automatique
  (espaces insécables, apostrophes courbes), correcteur orthographique, rechercher / remplacer, texte
  chaîné entre blocs, habillage autour des formes, texte en excès signalé.
- **Photos et formes** : toute forme est un cadre photo (goutte, vagues, polygones, étoiles, forme tirée
  d'un SVG, tracé à la plume), recadrage dans la forme, résolution effective affichée.
- **QR codes** régénérés depuis leur adresse, en vectoriel.
- **Impression** : nuancier en CMJN (profil FOGRA39 par défaut), épreuvage écran, contrôle en amont
  (zone de sécurité, résolution, encrage, petits textes à trop d'encres, polices…), export PDF/X-4 avec
  fond perdu et boîtes exactes, traits de coupe en option, PDF léger pour l'e-mail et aperçus PNG.

## Prérequis

- Node.js 22 ou plus récent.
- Python 3.11 ou plus récent (chaîne d'impression : pikepdf, Pillow).
- Google Chrome installé (ou `CHROME_PATH` vers un navigateur Chromium) : il affiche, mesure et imprime.
- Un profil ICC CMJN : `CoatedFOGRA39.icc` est présent sous Windows ; ailleurs, voir
  [`print/profiles/README.md`](print/profiles/README.md).

## Installation

```sh
npm ci
npm run setup:print   # crée print/.venv et installe pikepdf et Pillow
```

## Lancer

```sh
npm run dev           # http://127.0.0.1:5190 (PORT=5191 npm run dev pour un autre port)
```

L'accueil liste les documents du dossier `documents/` (données locales, jamais versionnées) et permet de
créer, dupliquer ou importer un document.

## En ligne de commande

Sous PowerShell, `npm run x -- --option` perd ses options : passer par Git Bash ou `npm.cmd`.

```sh
# Importer un design Claude Design (export HTML) comme nouveau document
npm run import:claude-design -- --design mon-design.dc.html [--name "Mon flyer"] [--template flyer-a5]

# Vérifier au pixel qu'un document importé reproduit son design
npm run diff:import -- --doc mon-flyer

# Exporter : imprimeur (PDF/X-4 CMJN), traits-de-coupe, rvb, email
npm run export -- --doc mon-flyer --preset imprimeur

# Nuancier CMJN et petits textes (moins de 9 pt) à encres réduites
npm run print-swatches -- --doc mon-flyer

# Déduire les styles de paragraphe d'un document importé
npm run derive-styles -- --doc mon-flyer

# Placer les images d'un PDF comme photos provisoires dans les cadres vides
npm run extract-pdf-images -- --pdf ancien.pdf --doc mon-flyer --fill
```

## Tests

```sh
npm run typecheck
npx vitest run        # tests unitaires et tests dans Chrome
npm run test:print    # chaîne d'impression (pytest)
```

## Architecture

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) : modèle de document, store, rendu, points
d'extension (panneaux, outils, raccourcis), import, chaîne d'impression.

Stack : React 19, Zustand, Tailwind 4, Vite 8, TypeScript 7, Fastify 5, Vitest, puppeteer-core, zod ;
Python pour le post-traitement PDF (pikepdf, Pillow / littleCMS).

## Polices

Open Sans (licence SIL Open Font License, [`public/fonts/OFL.txt`](public/fonts/OFL.txt)), servie en
local pour un rendu identique hors ligne et une incorporation garantie dans le PDF.
