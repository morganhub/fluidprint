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
- **Import Word (.docx)**, comme « Placer » dans InDesign : titres, styles, listes, gras / italique /
  souligné, tableaux et images, dans un bloc texte, un bloc neuf, ou toutes les faces d'un document neuf
  (remplissage automatique en blocs chaînés).
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

## Importer un fichier Word

Le texte d'un fichier Word (`.docx`) se place dans le document comme avec la commande « Placer » d'InDesign.

- **Dans l'éditeur** : bouton **Placer…** de la barre du haut. Choisissez le fichier et les options, puis :
  - si un bloc texte est sélectionné, le texte du Word **remplace** le sien (toute sa chaîne s'il est chaîné) ;
  - sinon, le curseur se « charge » : un clic sur un bloc texte en remplace le texte, un clic sur une zone vide
    crée un **bloc neuf** à cet endroit, à la largeur de la zone de sécurité du volet et jusqu'en bas
    (Échap annule).
  - On peut aussi **glisser un `.docx`** depuis l'explorateur sur la page : même chose au point de dépôt, avec
    les dernières options choisies.
- **Depuis l'accueil** : **Nouveau document depuis Word** — fichier, nom, gabarit. Le document est créé et le
  texte remplit toutes ses faces, volet par volet.
- **Remplir automatiquement** (option) : si le texte déborde, des blocs chaînés sont créés dans la zone de
  sécurité des volets suivants, puis des faces suivantes, jusqu'à ce que tout tienne ou que le document soit
  plein ; le texte restant est signalé (« + » rouge et rapport).
- **Typographie française** (option, cochée par défaut) : espaces insécables, apostrophes courbes, guillemets.
- **Styles** : chaque style Word (Titre, Titre 1 à 6, Normal, Citation, Paragraphe de liste…) devient le style
  de paragraphe du document **de même nom** — réutilisé s'il existe, sinon créé sur une échelle de tailles
  fondée sur le style de corps du document, et marqué « Word » dans le panneau Styles. Gras, italique et
  souligné sont gardés ; les **polices et couleurs de Word sont ignorées** (Open Sans et nuancier du
  document), avec un avertissement.
- **Listes** : puces et numéros dessinés dans un vrai retrait suspendu ; ajouter un élément renumérote la suite.
- **Tableaux** : une ligne par paragraphe, cellules séparées par des tabulations (avertissement : à remettre en
  forme). **Liens** : le texte reste, l'adresse est dans le rapport.
- **Images** : enregistrées comme des photos déposées (originaux intacts, aperçus), listées « Non placée » dans
  le panneau **Images** : glissez-les sur un cadre.
- Tout se fait en **une seule étape d'annulation** (Ctrl+Z retire texte, blocs, styles et images ajoutés). Un
  **rapport** récapitule : paragraphes, blocs, styles créés ou réutilisés, images, liens, avertissements, texte
  en excès.
- Refusés, avec un message clair : `.doc` (Word 97-2003 : l'enregistrer en `.docx`), fichier protégé par mot de
  passe, fichier qui n'est pas un Word, fichier de plus de 50 Mo ou anormalement gros une fois décompressé.

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

## Agent IA

Un agent IA de navigateur (Claude dans Chrome, Cowork…) pilote Fluidprint par programme plutôt qu'à la souris :
bouton **IA Agent** (robot) de l'accueil et de la barre du haut → consigne à copier dans sa conversation et guide
complet. L'agent exécute `window.fluidprint` dans l'onglet (`fluidprint.help()` renvoie le guide) : lire le document
(`info`, `objects`, `getText`), modifier texte, styles, couleurs et positions en mm, créer des objets, placer des
photos, contrôler (`preflight`, `overset`) et exporter. Chaque action est une étape d'annulation « Agent IA : … »,
enregistrée automatiquement et visible aussitôt. Code : `src/agent/` (`api.ts`, `guide.ts`).

## En ligne

https://fluidprint.fluidifia.com : conteneur Docker (`Dockerfile`, `docker-compose.yml`) sous `/opt/fluidprint` du
VPS, derrière nginx de Plesk, déployé par fluiddeploy (`fluiddeploy.json`). Protégé par mot de passe (HTTP Basic,
identifiant libre) : `FLUIDPRINT_PASSWORD` du `.env` local (non versionné), recopié sur le serveur à chaque
déploiement. Documents dans `/opt/fluidprint/data/documents`.

```sh
fluiddeploy deploy --yes              # construit l'image sur le serveur et relance le conteneur
fluiddeploy run deploy/nginx_setup.sh # une fois : proxy nginx vers le conteneur (127.0.0.1:18090)
fluiddeploy docker logs
```

Les profils ICC d'Adobe (`CoatedFOGRA39.icc`, `CoatedGRACoL2006.icc`) sont copiés depuis
`C:\Windows\System32\spool\drivers\color` dans `print/profiles/` (ignorés par git) pour partir dans l'image.

## Architecture

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) : modèle de document, store, rendu, points
d'extension (panneaux, outils, raccourcis), import, chaîne d'impression.

Stack : React 19, Zustand, Tailwind 4, Vite 8, TypeScript 7, Fastify 5, Vitest, puppeteer-core, zod ;
Python pour le post-traitement PDF (pikepdf, Pillow / littleCMS).

## Polices

Open Sans (licence SIL Open Font License, [`public/fonts/OFL.txt`](public/fonts/OFL.txt)), servie en
local pour un rendu identique hors ligne et une incorporation garantie dans le PDF.
