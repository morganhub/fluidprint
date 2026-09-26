# Architecture de Fluidprint

Éditeur de mise en page local pour documents imprimés : React 19 + Zustand 5 + Immer 11, rendu HTML/SVG en
millimètres (le même moteur, Chrome, affiche et imprime), chaîne d'impression en Python (pikepdf, Pillow). Ce
document décrit le cœur et **comment brancher une fonction sans toucher au cœur**.

## Routes

| Route | Écran |
| --- | --- |
| `/` | accueil : liste des documents, « Nouveau document », « Nouveau document depuis Word », « Dupliquer », import (`src/viewer/DocumentList.tsx`, voir « Gabarits, nouveau document, duplication » et « Import Word ») |
| `/doc/:id` | **l'éditeur** (`src/editor/EditorApp.tsx`) |
| `/view/:id` | visionneuse en lecture seule (`src/viewer/Viewer.tsx`) |
| `/print/:id` | route d'impression, lue par Puppeteer (`src/render/PrintRoute.tsx`) |

## Carte des fichiers

```
src/store/
  documentStore.ts   store Zustand : document, sélection, outil, zoom/vue, gestes, historique
  history.ts         pile d'annulation par patches Immer (100 étapes, fusion des flèches)
  commands.ts        commandes réutilisables sur un brouillon (déplacer, redimensionner, grouper…)
  tree.ts            lecture de l'arbre : parent, page, descendants, boîtes, sélectionnable
  persistence.ts     ouverture (?open=1) et enregistrement automatique
src/editor/
  EditorApp.tsx      mise en page : barre du haut, outils, plan de travail, panneaux, barre d'état
  Workspace.tsx      plan de travail : faces, zoom, vue, clic, lasso (Selecto), glisser, création
  Transformer.tsx    cadres de sélection + poignées Moveable (redimensionner)
  layout.ts          géométrie : repères face / monde / écran, zoom, pas de la souris
  hitTest.ts         objet sous le pointeur (rect / ellipse sans fond : près du contour seulement), lasso
  shortcuts.ts       moteur de raccourcis + raccourcis de base
  keys.ts            lecture des combinaisons (« Mod+Shift+G »), AZERTY compris
  tools/             outils de base (builtinTools.ts) et fabriques d'objets (defaults.ts)
  registry/          POINTS D'EXTENSION (api.ts + un fichier par type)
  devHandle.ts       window.__editor (développement et tests)
src/panels/
  PropertiesPanel.tsx      panneau Propriétés, fait de sections enregistrées
  properties/*.tsx         sections Position et taille, Apparence, Texte ; registry.ts
src/components/ui/   Button, Input/Label/NativeSelect, NumberField, Tabs, Tooltip, Popover, Dialog
src/components/SwatchPicker.tsx   choix d'une nuance du nuancier
src/word/            import Word : structure lue (types.ts), styles, article, placement, interface (« Placer… »)
server/docx/         lecteur .docx sans dépendance (zip plafonné, XML, structure)
```

## Unités et repères

- **Document** : mm, repère de la **face** (origine au coin haut-gauche du **fond perdu** ; la taille vient
  du gabarit `doc.format` : 303 × 216 mm pour une face du dépliant A4 pli roulé, 154 × 216 mm pour le flyer A5…). Corps et
  filets en **pt**. Coordonnées **absolues**, y compris pour les
  enfants d'un groupe ; la boîte d'un groupe est tenue à jour par les commandes.
- **Affichage** : le panneau Propriétés montre X et Y **depuis le coin du format fini** (x − fond perdu),
  comme les règles et InDesign. Stockage inchangé.
- **Monde** (`layout.ts`) : les faces côte à côte, face *i* à `x = i × (largeur + 24 mm)`, `y = 0`.
- **Écran** : px CSS dans le plan de travail (`[data-workspace-viewport]`) ;
  `écran = view + monde × PX_PER_MM × zoom`. `zoom = 1` : taille réelle (1 mm = 96 / 25,4 px).
  Fonctions : `pageToScreen`, `pageBoxToScreen`, `screenToWorld`, `worldToPage`, `pageSlots`,
  `fitView`, `zoomAround`, `pxPerMm`.
- **Souris** : un déplacement ou un redimensionnement à la souris avance par pas « ronds »
  (`mouseStepMm(zoom)` : le plus fin de 0,05 / 0,1 / 0,2 / 0,25 / 0,5 / 1 / 2 / 5 mm qui dépasse un
  pixel écran). Un glisser de 10 mm donne 10,0 mm à tout zoom. Clavier : 0,5 mm (Maj : 5 mm). Propriétés :
  0,01 mm.
- **Arrondis** : seules les valeurs modifiées sont arrondies (`round4`, 0,0001 mm). Un objet non touché
  garde ses coordonnées d'import au bit près : `npm run diff:import` reste vert.

## Le store

```ts
import { editorStore, getEditor, useEditor, useEditorShallow, selectedObjects } from '../store/documentStore';

const zoom = useEditor((s) => s.zoom);                       // lecture réactive (composant)
const objs = useEditorShallow((s) => selectedObjects(s));    // sélecteur qui renvoie un tableau neuf
getEditor().move(['ext-g9'], 10, 0);                         // hors React : état + actions
```

### État (`EditorData`)

`doc`, `docId`, `revision` (change à chaque modification du document), `selection` (ids au niveau
courant), `enteredGroup` (groupe « entré » par double-clic, ou null), `hoverId`, `activePageId` (face
survolée ou cliquée : cible des collages), `activeLayerId` (calque des nouveaux objets ; null = le plus
haut calque visible, déverrouillé, imprimable), `tool`, `mode` (mode exclusif, voir plus bas), `zoom`,
`zoomMode` (`'fit'` | `'manual'`), `view` ({x, y} px), `viewport` ({w, h} px), `gesture` (geste en
cours ou null), `dragOffset` (aperçu d'un glisser, mm), `history` ({canUndo, canRedo, undoLabel,
redoLabel, depth}), `save` ({status, message, savedAt}), `clipboard`.

### Actions nommées (une étape d'annulation chacune)

| Action | Effet |
| --- | --- |
| `move(ids, dx, dy)` | déplace (groupes avec leurs enfants) |
| `nudge(dx, dy)` | déplace la sélection ; appuis rapprochés fusionnés en une étape |
| `setBox(id, {x?, y?, w?, h?})` | boîte d'un objet (un groupe met ses enfants à l'échelle, un cadre recale sa photo) |
| `resize(ids, from, to)` | boîte commune `from` → `to` |
| `update(ids, patch \| fn, label?)` | champs d'objets (`undefined` supprime le champ) |
| `add(objects, roots, {pageId, groupId?, index?})` | ajoute (racines + descendants) et sélectionne |
| `remove(ids?)` | supprime (descendants compris ; un groupe vidé disparaît) |
| `duplicate(ids?, {dx, dy}?)` | copies juste au-dessus des originaux, décalées de 5 mm par défaut |
| `group(ids?)` / `ungroup(ids?)` | grouper (même face, même parent ; passe sur le calque le plus haut) / dissocier |
| `reorder('front' \| 'back' \| 'forward' \| 'backward', ids?)` | ordre d'empilement dans le parent |
| `setLayer(layerId, ids?)` | change de calque (un enfant de groupe emmène tout son groupe) |
| `copy(ids?)`, `cut(ids?)`, `paste(pageId?)` | presse-papiers interne ; collage à la même position sur une autre face, décalé de 5 mm sur la même |

`ids` absent = la sélection. Sélection et vue : `select(ids, {mode: 'replace'|'add'|'toggle'|'remove'})`,
`clearSelection({exitGroups?})`, `selectAll(pageId?)`, `enterGroup(id, childId?)`, `exitGroup()`,
`setHover`, `setTool`, `setMode`, `setActivePage`, `setActiveLayer`, `setZoom(z, anchor?)`,
`zoomStep(±1)`, `fit()`, `setView`, `panBy`, `centerOn(ids)`.

Une sélection est toujours au niveau d'un même parent : `select([...])` place `enteredGroup` sur le
parent commun des objets (ex. : le panneau Calques qui sélectionne un objet dans un groupe « entre »
dans ce groupe).

### Votre propre action : `apply`

```ts
import { moveObjects, setBox } from '../store/commands';

getEditor().apply('Aligner à gauche', (draft) => {
  for (const id of ids) moveObjects(draft, [id], left - draft.objects[id].x, 0);
}, { select: ids });           // facultatif : sélection après l'action ; { coalesce: 'clé' } pour fusionner
```

La recette reçoit un **brouillon Immer** (à muter) ; elle peut renvoyer une valeur (`apply` la renvoie).
Aucun patch = aucune étape. Les commandes de `store/commands.ts` sont faites pour ça : `moveObjects`,
`setPosition`, `setBox`, `resizeObjects`, `updateObjects`, `addObjects`, `removeObjects`,
`duplicateObjects`, `extractObjects`/`reidentify` (copier), `groupObjects`, `ungroupObjects`,
`reorderObjects`, `setObjectsLayer`, `refreshGroupBounds`, `refreshAncestors`, `newObjectId`, `round4`.
Lecture de l'arbre : `store/tree.ts` (`parentOf`, `pageIdOf`, `ancestorsOf`, `descendantsOf`,
`rootsOf`, `resolveAtScope`, `isSelectable`, `objectBounds` (rotation comprise), `unionBoxes`…).

### Gestes : une seule étape, quelle que soit la durée

```ts
const s = getEditor();
s.beginGesture('Redimensionner');           // l'enregistrement automatique se met en pause
// geste long et modal (texte, recadrage, points) : s.beginGesture('Recadrer', { autosave: true })
s.previewGesture((d) => { /* état FINAL calculé depuis le début du geste */ });   // à chaque image
// ou : s.apply(...) plusieurs fois (patches accumulés)
s.commitGesture({ select: ids });           // une étape ; ou s.cancelGesture() pour tout annuler
```

`previewGesture` repart toujours du document du début du geste : idéal pour redimensionner, tourner,
recadrer. Pendant un geste court (glisser, poignées), **aucun enregistrement** ne part. Un geste
`autosave` (édition de texte, recadrage, points de la plume) enregistre son aperçu 2 s après la dernière
retouche, sans toucher à l'historique (toujours une étape à la fin).

### Modes exclusifs

`setMode({ id: 'text-edit', target: objId })` (édition de texte, recadrage, plume…) : tant qu'un mode
est actif, le plan de travail ne traite plus les clics sur la page, les poignées disparaissent et les
raccourcis sont coupés (sauf `allowInMode`). À vous de rendre la main avec `setMode(null)`.

## Enregistrement (`store/persistence.ts`)

Ouverture : `GET /api/doc/:id?open=1` une seule fois (copie d'historique côté serveur), même si React
monte deux fois l'éditeur. Enregistrement (`PUT`) 2 s après la dernière modification, tout de suite sur
Ctrl+S (`getPersistence()?.saveNow()`), jamais pendant un geste court. `editedAt` est posé à chaque
enregistrement (l'import refuse alors d'écraser le document). Indicateur dans la barre du haut
(`[data-save-status="saved" | "dirty" | "error" | "conflict"]`), alerte `beforeunload` s'il reste des changements.
**Conflits** : le GET renvoie la révision du fichier (en-tête `x-doc-revision`, empreinte du contenu) ; chaque
PUT envoie celle qu'il a lue (`x-base-revision`). Si le fichier a changé depuis (autre onglet, script), le
serveur répond 409 sans rien écrire et l'éditeur propose « Recharger » ou « Écraser »
(`getPersistence()?.reload()` / `overwrite()`). Une route qui réécrit le document (restauration d'une version)
renvoie la nouvelle révision : `adoptRevision(docId, revision)`. Erreurs réseau en français (`store/http.ts`).
Une modification faite par `apply`/un geste est enregistrée automatiquement : rien à faire de plus.
`patchSilently(fn)` modifie le document sans étape ni enregistrement (métadonnées seulement).

## Gabarits, nouveau document, duplication

Un document ne naît plus seulement d'un import Claude Design : la page d'accueil en crée un vierge d'après un
gabarit, ou en duplique un existant.

| Fichier | Rôle |
| --- | --- |
| `model/templates/*.json`, `index.ts` | les six gabarits (`TEMPLATES`) : dépliant A4 pli roulé (défaut, `DEFAULT_TEMPLATE_ID`), dépliant A4 accordéon, A4 recto verso, flyer A5, carte de visite, affiche A3 ; `findTemplate` (copie), `templatesForFaceSize` (importeur), `describeTemplate`. Un gabarit incohérent (volets ≠ format fini) est refusé au chargement |
| `model/newDocument.ts` | `createBlankDocument({ id, name, format, createdAt? })` : une page par face (`p-<face>`), calques Fonds / Contenu / Repères et notes (non imprimable, rien de verrouillé), nuancier de départ `STARTER_SWATCHES` (Blanc, Noir 100 %, Texte courant N 80, Bleu C100 M60, Marine C100 M80 J25 N35 ; RVB = simulation FOGRA39), aucun objet ni style ; `copyDocument` (sans `editedAt`), `duplicateName` (« Copie de … »), `docIdFromName` (kebab-case sans accents, 56 caractères au plus, noms réservés de Windows évités), `templateSummary` |
| `server/templates.ts` | routes ci-dessous ; `createDocument`, `duplicateDocument`, `reserveDocumentDir` |
| `viewer/DocumentList.tsx`, `viewer/DocumentDialogs.tsx` | accueil (liste, liste vide qui invite à créer ou importer), boîtes « Nouveau document » (nom, gabarits en cartes avec schéma des faces et des plis) et « Dupliquer » (nom proposé tout sélectionné) ; `ImportDesignButton` (agent de l'importeur) y est affiché |

| Route | Effet |
| --- | --- |
| `GET /api/templates` | `[{ id, name, description, faces, trim, bleed }]` |
| `POST /api/doc` `{ name, templateId, id? }` | 201 `{ id }` (+ `Location`) ; identifiant tiré du nom, rendu unique par `-2`, `-3`… ; `id` imposé : tel quel, 409 s'il est pris ; 400 si nom vide ou trop long (120), gabarit absent ou inconnu, `id` invalide |
| `POST /api/doc/:id/duplicate` `{ name? }` | 201 `{ id }` : nouveau dossier avec `document.json` (nouvel id, « Copie de … » par défaut, `createdAt` maintenant, sans `editedAt`) et `assets/` (originaux, aperçus, copies d'impression) ; ni `history/`, ni `versions/`, ni `exports/`, ni le cache d'épreuves `assets/proof/`, ni fichiers temporaires ou liens symboliques ; 404 / 400 / 422 comme `GET /api/doc/:id` |

- **Réservation atomique** : le dossier du nouveau document est créé par un `mkdir` sans `recursive` (échoue s'il
  existe) avant toute écriture ; deux créations simultanées du même nom obtiennent chacune leur identifiant. Le
  document passe ensuite par `saveDocumentWithRevision` (validation, écriture atomique) ; en cas d'échec, le
  dossier réservé est retiré. Identifiants toujours validés par `isValidDocId`.
- **Nuancier** : à la création, le serveur recalcule le RVB affiché des nuances par le profil du préréglage de
  référence (`cmykToRgb`, puis `applySwatchDisplays` de `model/swatches.ts`, le même mécanisme que
  `scripts/print-swatches.ts`) ; sans Python, les simulations FOGRA39 de `STARTER_SWATCHES` restent.
- **Formats** : rien dans l'éditeur, le rendu ni l'export ne suppose un format (faces, règles, repères de coupe
  et de plis, magnétisme, `@page`, boîtes du PDF, repères de pli de l'imprimeur : tout vient de `doc.format`).
  Seul l'« Aperçu plié » est propre au pli roulé : `foldModel` renvoie null (et le bouton disparaît) hors de deux
  faces de trois volets dont un volet d'extrémité plus étroit que le central (pli accordéon : volets égaux).
- **Tests** : `test/new-document.test.ts` (modèle, routes par `inject`), `test/document-list.test.ts` (accueil →
  flyer A5 → texte → rechargement → duplication ; chaque gabarit ouvert dans l'éditeur, un objet ajouté, export RVB).

## Import Claude Design (tous formats)

`npm run import:claude-design -- --design <fichier> [--name <nom>] [--template <gabarit>] [--id <id>] [--documents <dossier>] [--replace]`
(`--design` obligatoire : il n'y a pas de design par défaut), ou le bouton « Importer un design Claude Design » de
l'accueil. Le design est un export HTML de Claude Design mis en pages : `<doc-page>` et une `<section class="page">`
par face ; les scripts du moteur de Claude Design (support.js, doc-page.js, image-slot.js) ne sont ni nécessaires ni
exécutés. La ligne de commande, comme la route, copie le design reçu dans `documents/<id>/design.dc.html`.

| Fichier | Rôle |
| --- | --- |
| `scripts/import/designSource.ts` | lecture sans navigateur : `parseDesign(html)` → titre, taille de page (`width`/`height` de `<doc-page>`, sinon `size` a4 / letter / legal et `orientation`, Letter par défaut comme `doc-page.js`), sections (`id`, nom = `data-screen-label` sans numéro de tête), repères des `<sc-if>` (cadre `inset` en trait plein = coupe ; traits en pointillés `left:` = plis ; pli horizontal signalé et ignoré), feuilles de style ; `DesignImportError` (message destiné à l'utilisateur) |
| `scripts/import/designFormat.ts` | `resolveFormat(design, { templateId })` → `{ format, origin: 'template' \| 'detected' \| 'custom', faces, notes, warnings }` ; `assignSections` |
| `scripts/import/designPage.ts` | page de mesure : chaque section devient `section.design-face[data-face-id][data-section-id]` à la taille de la page, avec les styles du design (sans `@import`, sans scripts) et les huit fichiers Open Sans ; fenêtre de Chrome à la largeur d'une face ; `openDesignPage(browser, { designFile, templateId? \| resolved? \| format? })` |
| `scripts/import/measure.ts`, `toObjects.ts` | mesure dans Chrome puis objets ; `buildDocument({ measure, resolved, … })` ne suppose aucun format : préfixe d'objet = 3 lettres de la face (`ext-t1`), la face entière si deux faces les partagent ; fond de la section → aplat « Fond de page » (calque Fonds) ; `<img>` → cadre photo vide légendé ; texte hors Open Sans signalé ; un graphique dont l'`aria-label`, l'id ou la classe contient « logo » est un logo (`logoName`), qui nomme son bloc (« Logo · … », « Coordonnées · … ») |
| `scripts/import/icons.ts` | icônes Lucide reconnues par comparaison des éléments SVG avec `lucide-static` seul (`createIconMatcher`) ; entre deux alias d'un même dessin, le nom le plus court (« clock » plutôt que « clock-4 ») |
| `scripts/import/colors.ts` | couleurs CSS, ΔE00, fusion des quasi-doublons ; nuances nommées par rôle (« Texte principal » : la couleur qui porte le plus de caractères ; « Titres » : celle des corps de 12 pt et plus ; « Noir QR » ; « Repères coupe et plis ») sinon par teinte et clarté (`describeColor` : « Vert foncé », « Orange très clair », « Gris »…) ; `isNeutralColor` (gris neutre, partagé avec le nuancier d'impression) |
| `scripts/import/importer.ts` | `runImport({ designFile, name?, templateId?, id?, documentsDir?, replace?, keepDesignCopy?, designName? })` → `{ doc, result, resolved, documentFile, reportFile, durationMs }` |
| `scripts/import/report.ts` | `import-report.md` (section « Format » : choix, notes, section de chaque face) ; `summarizeImport` (réponse de la route) |
| `server/importDesign.ts` | `POST /api/import/claude-design` et sa file d'attente |
| `viewer/ImportDesignButton.tsx` | bouton et boîte de dialogue : fichier, nom (proposé d'après le `<title>`), gabarit (« Détection automatique » ou l'un des six), progression, résumé du rapport, « Ouvrir le document » |

**Format du document**, dans l'ordre :

1. **Gabarit imposé** (`--template`, champ Gabarit) : sa face (fond perdu compris, à 0,5 mm près) et son nombre de faces
   doivent être ceux du design, sinon refus clair (400 par la route) ; des repères contraires sont seulement signalés.
2. **Gabarit reconnu** : `templatesForFaceSize(l, h, nombre de sections)`, dont le fond perdu et les plis ne contredisent
   pas les repères `<sc-if>` (à 0,5 mm près) ; s'il en reste plusieurs, le premier de `TEMPLATES` (le rapport cite les
   autres). Le dépliant d'exemple (`test/fixtures/designs/depliant-exemple.dc.html`) retombe ainsi sur `depliant-a4-pli-roule` (plis 100/200 et 103/203 mm : l'accordéon,
   102/201, est écarté), avec les mêmes pages `p-exterieur` et `p-interieur` et le même document qu'avant.
3. **Format sur mesure** `sur-mesure-<l>x<h>` : taille de la page ; fond perdu = retrait du cadre de coupe, sinon 3 mm
   si la page moins 6 mm est un A3, A4, A5, A6 ou une carte de visite (deux orientations), sinon 0 avec l'avertissement
   « pas de fond perdu » ; volets entre les plis dessinés (« Volet 1 », « Volet 2 »… ; sinon un seul) ; une face par
   section (id de la section nettoyé, nom sans numéro de tête) ; zone de sécurité 3, 4 ou 5 mm selon le petit côté.

Sections → faces : **par identifiant** si chaque face du gabarit trouve la section de même nom (nettoyé : « Recto » →
`recto`), **sinon dans l'ordre** ; gabarit imposé compris. Pages `p-<face>`. Nom : `--name`, sinon le `<title>` du design
(hors `<doc-page>`), sinon le nom du fichier sans `.dc.html` ; identifiant `docIdFromName(nom)` (`model/newDocument.ts`)
rendu unique par `-2`, `-3`… (`reserveDocumentDir`, création exclusive). `--id` et `--replace` gardent le garde-fou :
un identifiant choisi n'est jamais dédoublé, et l'import refuse d'écraser un document retouché (`editedAt`).

**Route** `POST /api/import/claude-design`, multipart : `file` (.html, 30 Mo au plus), `name` et `template` (`auto` ou
absent : détection) facultatifs. 201 `{ id, report }` (`ImportSummary` : format et manière dont il a été choisi, pages,
objets par type, avertissements, QR codes décodés, durée) ; 400 fichier absent, pas en `.html`, pas un export Claude
Design, gabarit inconnu ou incompatible (message à montrer tel quel) ; 413 fichier trop lourd ; 415 corps non multipart.
Le fichier est contrôlé tout de suite ; les imports passent ensuite un par un (chacun lance son Chrome). Le design reçu
est gardé dans `documents/<id>/design.dc.html`, source du document (`source.path`).

- **Contrôle au pixel** : `npm run diff:import -- --doc <id> [--design <fichier>]` compare tout document importé à son
  design : `--design`, sinon la copie `documents/<id>/design.dc.html` gardée à l'import, sinon `source.path`
  (`designFileOf`) ; sections rangées sur les faces du document comme à l'import, captures à la taille d'une face.
- **Limites** : l'éditeur n'a qu'Open Sans (une autre police est mesurée et rendue avec une police de remplacement,
  signalée) ; `<img>` devient un cadre vide, `background-image` et les puces de liste sont ignorées ; toutes les pages
  ont la taille de `<doc-page>` ; `content-width` / `content-height` (mise à l'échelle) sont ignorés ; plis verticaux
  seulement.
- **Tests** : `test/import.test.ts` (dépliant d'exemple : même format, mêmes pages et objets que `test/fixtures/depliant-exemple`),
  `test/import-formats.test.ts` (lecture, choix du format, imports des designs de `test/fixtures/designs/` : flyer A5,
  carré 100 × 100 sans fond perdu, dépliant 210 × 100 à repères ; ligne de commande), `test/import-route.test.ts`
  (route par `inject`, accueil → import du flyer → éditeur).

## Import Word (.docx)

Sur le modèle de « Placer » d'InDesign : le serveur LIT le fichier (structure, images), l'éditeur le PLACE (il est
seul à savoir mesurer la coulée du texte : polices, coupures de Chrome), en une seule étape d'annulation.

| Fichier | Rôle |
| --- | --- |
| `server/docx/zip.ts` | zip sans dépendance (répertoire central, ZIP64, entrées stockées ou compressées) ; `ZIP_LIMITS` : fichier 100 Mo, entrée 64 Mo et archive 256 Mo une fois décompressées (`inflateRawSync` plafonné : une bombe ne remplit jamais la mémoire) |
| `server/docx/xml.ts` | analyseur XML maison (arbre léger), espaces de noms ramenés à leurs préfixes canoniques (`ns0:p` → `w:p`) |
| `server/docx/read.ts` | `readDocx(buffer, { label, limits })` → `{ document: WordDocument, media }` ; refus = `DocxError` (`code` : `empty`, `legacy-doc`, `encrypted`, `not-zip`, `not-word`, `too-large`, `corrupt`) au message français destiné à l'utilisateur. Repris du lecteur de fluidplan (Markdown), porté en TypeScript |
| `src/word/types.ts` | structure partagée : `WordDocument` (blocs, images, styles employés, polices et couleurs rencontrées, avertissements), `WordParagraph` (style Word : `styleId`, `styleName` ; `heading` 1-6, `title`, `list` {kind, level, number, format, marker}, `align`, `content`), `WordText` (texte, `\n`, `\t`, bold / italic / underline directs, `link`), `WordImageRef` (position dans le flux), `WordTable` (lignes et cellules) ; `WordImportResponse`, `NewFromWordResponse` |
| `server/wordImport.ts` | routes ci-dessous ; images enregistrées par `storeImageAsset` (`server/assets.ts`, la même logique que `POST /api/assets` : originaux intacts, aperçus, copie PNG d'un TIFF) |
| `src/word/styles.ts` | `styleTarget` (style Word → nom du style du document : nom affiché par Word en français pour les styles prédéfinis, « heading 1 » → « Titre 1 », « Quote » → « Citation »…), `bodyBaseStyle` (style de corps du document, sinon texte par défaut), `scaledStyle` (échelle : Titre ×2,4 800, Titre 1 à 6 ×1,9 / 1,55 / 1,3 / 1,15 / 1 / 1 en 700, Citation italique… ; nuance « Titres » du nuancier si elle existe), `resolveStyles` (réutilise un style de même nom, casse et accents ignorés ; sinon le crée, `origin: 'word'`) |
| `src/word/story.ts` | `buildWordStory(draft, word, assets, { typography, targetStyle })` : article du modèle (paragraphes nettoyés, style du bloc = le plus employé, styles propres des autres paragraphes, mise en forme directe, listes, tableaux en tabulations, liens → texte, typographie française), images non placées et leur position, avertissements |
| `src/word/place.ts` | `placeWord(state, response, target, options, measure)` → `WordPlacementReport` ; cibles `frame` (texte remplacé, toute la chaîne), `point` (`frameBoxAtPoint` : zone de sécurité du volet, du point jusqu'en bas), `panel` ; « Remplir automatiquement » : `nextSafetySlots` (volets suivants puis faces suivantes), blocs chaînés créés, coulée mesurée une fois, blocs restés vides retirés ; `frameZone` : blocs neufs à 1,5 mm sous le haut et 0,5 mm au-dessus du bas de la zone (l'étendue des lignes d'un grand titre serré et la tolérance de la coulée restent dans la zone surveillée par le contrôle en amont) |
| `src/render/textFlow.ts` | `fitStory(doc, frameIds)` : coulée mesurée comme au rendu, avec le texte en excès (un bloc fictif très haut derrière le dernier) — la mesure que `placeWord` reçoit dans le navigateur |
| `src/word/client.ts` | `uploadWord`, `createFromWord`, `isWordFile`, `carriesOnlyWordFiles` ; `stashPendingWord` / `takePendingWord` (sessionStorage : le fichier lu à l'accueil attend l'éditeur) ; `loadWordFonts` (toutes les graisses d'Open Sans avant de mesurer) |
| `src/word/PlaceWord.tsx` | action « Placer… » (barre du haut, ordre 5) et sa boîte (fichier, « Remplir automatiquement », « Typographie française ») ; mode `place-word` (curseur chargé, Échap annule) ; dépôt d'un `.docx` sur la page (DropImageOverlay laisse passer les fichiers Word) ; remplissage d'un document créé depuis l'accueil ; rapport (`[data-word-report]`). Surcouche `place-word` |
| `src/viewer/NewFromWordDialog.tsx` | « Nouveau document depuis Word » (fichier, nom, gabarit, typographie) |

| Route | Effet |
| --- | --- |
| `POST /api/doc/:id/word` | multipart `file` (.docx, 50 Mo au plus : `MAX_WORD_BYTES`, `RouteContext.maxWordBytes` pour les tests) → 200 `WordImportResponse` ; images enregistrées dans `documents/<id>/assets/` ; `document.json` n'est PAS réécrit (l'éditeur ouvert ajoute photos et texte, sinon le serveur lui répondrait 409). 400 `{ error, code }` : pas un `.docx` (`not-docx`), `.doc`, chiffré, zip qui n'est pas un Word, bombe ; 404 document ; 413 trop lourd ; 415 pas multipart. Une image EMF, WMF, GIF… n'est pas importée : avertissement |
| `POST /api/doc/from-word` | multipart `file`, `name`, `templateId` → 201 `NewFromWordResponse` : fichier lu d'abord (un refus ne laisse aucun document), puis `createDocument` et images ; nom par défaut tiré du fichier |

Correspondance Word → modèle :

- **Paragraphe** → `Paragraph` ; espaces multiples réduites (le rendu les fusionne, l'éditeur non) ; paragraphes vides
  écartés. Retour à la ligne → `\n` ; tabulation → `\t`.
- **Style** → style de paragraphe de même nom. Le style qui porte le plus de texte devient celui du bloc
  (`paragraphStyleId`, `style`) ; les autres paragraphes ont un style propre (`Paragraph.paragraphStyleId`) dont TOUTES
  les valeurs sont écrites chez eux (voir « Texte »). Titre de niveau hiérarchique sans style de titre → « Titre N ».
- **Gras / italique / souligné** directs (ou d'un style de caractère) → `fontWeight` 700 / 400, `italic`, `underline`
  des segments, seulement s'ils changent quelque chose au style. Le soulignement du style « Lien hypertexte » est ignoré.
- **Liste** → `list` ({ kind, level, format, suffix, start }), `leftIndent` = 1,5 cadratin × (niveau + 1),
  `firstLineIndent` = −1,5 cadratin ; `start` seulement là où la numérotation de Word diffère de la règle du rendu
  (`model/lists.ts`). Format inconnu de Word → chiffres, avec avertissement.
- **Tableau** → une rangée = un paragraphe, cellules séparées par `\t` (avertissement) ; tableau dans une cellule : aplati
  en « / ». **Lien** → texte ; adresse au rapport. **Note de bas de page, graphique, SmartArt, équation** : avertissement.
- **Image** → `doc.assets` (non placée), sa position (« après « … » ») au rapport.
- **Polices, couleurs, tailles** de Word : ignorées ; polices et couleurs listées dans un avertissement.

- **Tests** : `test/docx.test.ts` (lecteur : structure, refus, bombe), `test/word-import.test.ts` (article, styles,
  placement dans le store avec une coulée simulée, une étape d'annulation), `test/word-route.test.ts` (routes par
  `inject`), `test/word-editor.test.ts` (Chrome : bloc sélectionné, curseur chargé, remplissage automatique mesuré,
  dépôt, édition d'une liste, accueil → document neuf → export RVB). Les `.docx` sont fabriqués dans le code
  (`test/helpers/docx.ts` : écrivain zip minimal).

## Rendu

`src/render/**` dessine aussi bien l'éditeur que la route d'impression. Pour l'éditeur, **chaque objet
est mémoïsé** (`ObjectView = memo(...)`) : un objet dont la référence n'a pas changé ne se re-rend pas.
Le contexte de rendu (`useRender()`) garde son identité tant que seuls `objects`, `pages` ou `editedAt`
changent ; il change dès qu'un autre champ du document change (nuancier, calques, styles, images, et tout
champ ajouté plus tard). Conséquence pour qui modifie une vue : **lire `useRender().doc` au rendu** (il
est toujours à jour) ; un groupe lit ses enfants dans `ObjectsContext`.

## Points d'extension

Principe : votre module appelle `registerXxx({...})` (importé de `src/editor/registry/api.ts`) à son
chargement, puis vous ajoutez **UNE ligne** `import '…/votreModule';` dans le fichier registre du type.
Réenregistrer le même `id` remplace la définition. Tous les registres sont chargés par
`src/editor/registry/index.ts`.

| Type | Fichier où ajouter la ligne | Fonction |
| --- | --- | --- |
| Panneau (onglet à droite) | `src/editor/registry/panels.ts` | `registerPanel` |
| Section de Propriétés | `src/panels/properties/registry.ts` | `registerPropertySection` |
| Raccourci clavier | `src/editor/registry/shortcuts.ts` | `registerShortcut` |
| Outil de la barre de gauche | `src/editor/registry/tools.ts` | `registerTool` |
| Surcouche du plan de travail | `src/editor/registry/overlays.ts` | `registerOverlay` |
| Action de la barre du haut | `src/editor/registry/topbar.ts` | `registerTopbarAction` |
| Élément de la barre d'état | `src/editor/registry/statusbar.ts` | `registerStatusbarItem` |
| Double-clic sur un objet | `src/editor/registry/interactions.ts` | `registerInteraction` |
| Extension des poignées | `src/editor/registry/transformer.ts` | `registerTransformerExtension` |

Un même module peut enregistrer plusieurs choses (un panneau et son raccourci) : une seule ligne
d'import suffit, dans le registre de votre choix.

### Panneau

```ts
// src/panels/LayersPanel.tsx
import { Layers } from 'lucide-react';
import { registerPanel } from '../editor/registry/api';
export function LayersPanel() { /* useEditor(...) */ }
registerPanel({ id: 'layers', title: 'Calques', icon: Layers, order: 20, component: LayersPanel });
// + dans src/editor/registry/panels.ts :  import '../../panels/LayersPanel';
```

Ordres réservés : Propriétés 10, Calques 20, Nuancier 30, Styles 40, Images 50, Contrôle 60,
Versions 70. Ouvrir un onglet par programme : `uiStore.getState().setActivePanel('layers')`
(`src/editor/uiStore.ts`). Les onglets sont des pictogrammes (`icon`, nom en infobulle et `aria-label`) : sept
onglets tiennent dans le volet sans défilement ; le nom du panneau ouvert s'affiche dessous (`[data-panel-title]`).

### Section de Propriétés

```ts
registerPropertySection({
  id: 'qr', title: 'QR code', order: 40,
  appliesTo: (objects) => objects.every((o) => o.type === 'qr'),
  component: ({ objects, ids, doc }) => …,   // objets = racines sélectionnées (au moins un)
});
```

Briques : `Section`, `Field`, `Warning`, `common` (valeur commune ou null → « — »), `commonOrMixed`
(`src/panels/properties/common.tsx`), `NumberField` (`value={null}` affiche « — »), `SwatchPicker`.
Ordres : Position et taille 10, Alignement 15, Apparence 20, Texte 30, Style de paragraphe 35, QR 40,
Image 50. Écrire : `getEditor().update(ids, fn, 'Libellé')` ou `apply`.

### Raccourci

```ts
registerShortcut({
  id: 'toggle-guides', keys: 'W', label: 'Afficher / masquer les repères', group: 'Affichage',
  run: (e, state) => { … },        // renvoyer false pour laisser passer
  when: (state) => !!state.doc,   // facultatif (défaut : document ouvert)
  allowInInput: false, allowInMode: false,
});
```

Syntaxe : `Mod` (Ctrl), `Shift`, `Alt`, puis la touche (`D`, `ArrowUp`, `Delete`, `?`, `]`…). Les
lettres et chiffres sont aussi reconnus par leur touche physique (AZERTY). Déjà pris : Ctrl+S, Z, Y, C,
X, V, D, G, Maj+G, A, [, ], Maj+[, Maj+], =, +, -, 0, 1, ?, / ; Suppr, Retour arrière, flèches, Échap ;
outils V, H, T, R, E, L, F, S, K, Q ; Espace (main temporaire). Libres pour la suite : W (repères),
Ctrl+L (verrouiller), Ctrl+F (rechercher), P (plume)… L'aide (Ctrl+?) liste tout, automatiquement.

### Outil

```ts
registerTool({
  id: 'pen', label: 'Plume', icon: PenTool, order: 65, shortcut: 'P', cursor: 'crosshair',
  // soit création par clic-glisser : le plan de travail trace le cadre (mm, face) et vous appelle
  create: (ctx) => createOnPage(ctx, 'Ajouter …', (draft, { layerId, box }) => makeX(draft, …), ctx.box),
  // soit gestion libre du pointeur (plume, pipette) :
  onPointerDown: (e, { state, point, world }) => { … },
  options: MesOptions,   // colonne entre la barre d'outils et le plan de travail (Échap la ferme)
  sticky: false,         // true : l'outil reste actif après une création
});
```

`createOnPage` (`src/editor/tools/builtinTools.ts`) et les fabriques `makeText`, `makeRect`,
`makeFrame`, `makeShape`, `makeIcon`, `makeQr`… (`src/editor/tools/defaults.ts`) créent un objet avec
des nuances du nuancier (jamais de couleur en dur). L'outil Forme pose la forme choisie dans
`SHAPE_PRESETS` (`src/model/shapes.ts`) : ajouter une forme à ce dictionnaire la rend disponible.

### Surcouche

```ts
// Dans chaque face, en mm (repère de la face), au-dessus des objets, à l'échelle du zoom :
registerOverlay({ id: 'page-guides', space: 'page', component: ({ doc, page, zoom }) =>
  <div style={{ position: 'absolute', left: '100mm', top: 0, bottom: 0, borderLeft: `${1 / zoom}px dashed #e0245e` }} /> });
// Sur tout le plan de travail, en px écran (règles, recadrage, plume) :
registerOverlay({ id: 'rulers', space: 'viewport', component: Rulers });
```

Les surcouches ne captent pas le pointeur (`pointer-events: none` sur le conteneur « page ») ; rétablir
`pointer-events: auto` sur ce qui doit être cliquable. Elles ne vont jamais à l'impression (rendues hors
de `PageView`). Géométrie écran : `layout.ts` + `useEditor((s) => s.zoom)` et `useEditor((s) => s.view)`
(un sélecteur qui renvoie un objet ou un tableau neuf passe par `useEditorShallow`).

### Action de la barre du haut

```ts
registerTopbarAction({ id: 'export', order: 10, label: 'Exporter', icon: FileDown, run: (state) => … });
// ou un rendu libre (bouton + dialogue) :
registerTopbarAction({ id: 'versions', order: 30, label: 'Versions', component: VersionsButton });
```

Ordres en place : Placer (Word) 5, Exporter 10, Aperçu impression 20, Enregistrer une version 30, Typographie 40,
Pages types 45, Aperçu plié 50.

### Double-clic sur un objet

```ts
registerInteraction({ id: 'text-edit', order: 10, onDoubleClick: ({ state, objectId, deepId, event }) => {
  const obj = state.doc!.objects[deepId];
  if (obj.type !== 'text') return false;
  state.setMode({ id: 'text-edit', target: deepId });
  return true;
} });
```

`objectId` : l'objet au niveau courant (le groupe) ; `deepId` : le plus profond sous le pointeur. Sans
interaction qui réponde, un double-clic sur un groupe y entre.

### Poignées : rotation, magnétisme

```ts
registerTransformerExtension({
  id: 'snapping',
  adjustMove: ({ dx, dy }, ctx) => ({ dx, dy }),     // mm ; ctx.event.altKey coupe l'aimantation
  adjustResize: (box, ctx) => box,                   // mm, repère de la face ; ctx.direction
  render: (ctx) => …,                                // lignes d'aide en px écran
  onGestureEnd: () => …,
  moveableProps: (ctx) => ({ rotatable: true, onRotateStart, onRotate, onRotateEnd }),  // Moveable
});
```

Le déplacement à la souris est géré par `Workspace.tsx` (aperçu par `transform` CSS sur les éléments,
une seule écriture au lâcher) ; `adjustMove` y est appelé à chaque mouvement. Le redimensionnement
passe par Moveable (`Transformer.tsx`, cadre témoin `[data-selection-box]`) ; `adjustResize` y est
appelé à chaque image. Pour la rotation : ajouter via `moveableProps` `rotatable` et ses événements, et
écrire l'angle avec `beginGesture` / `previewGesture` / `commitGesture`. N'écrasez pas `onResize*`.
Poignées : `.editor-moveable .moveable-control[data-direction="e"]`.

## Tests d'interaction

Les tests d'interaction ouvrent le vrai éditeur (serveur Vite + Chrome) sur un **dossier de documents
temporaire** ; ils ne touchent jamais `documents/`. Aides : `test/helpers/editor.ts`. Le document de travail est le
**dépliant d'exemple** figé dans `test/fixtures/depliant-exemple` (organisation fictive « Atelier Horizon ») : import de
`test/fixtures/designs/depliant-exemple.dc.html`, styles déduits, nuancier d'impression (`--keep rose`) et cinq photos
provisoires synthétiques (`copyExample(dir)` en fait une copie).

```ts
import { clickAt, copyExample, dragObject, openEditor, press, readSavedDocument, saveNow, selection,
  withApp, withTempDocuments, writeDocument } from './helpers/editor';

it('déplace une carte', async () => {
  await withTempDocuments(async (dir) => {
    const id = await copyExample(dir);                  // ou writeDocument(dir, minimalDoc())
    await withApp(async ({ browser, url }) => {
      const page = await openEditor(browser, url, id, { zoom: 1, centerOn: 'ext-g9' });
      await dragObject(page, 'ext-g9', 10, 0);          // 10 mm à l'écran, souris au pixel entier
      await press(page, 'Control', 'z');                // raccourcis
      await clickAt(page, 'p-exterieur', 4, 200);       // clic en mm sur une face
      expect(await selection(page)).toEqual([]);
      await saveNow(page);                              // = Ctrl+S, attend la réponse
      const saved = await readSavedDocument(dir, id);   // document.json sur le disque
    }, { documentsDir: dir });
  });
});
```

Autres aides : `setZoom`, `centerOn`, `pageToClient` (mm → px client), `objectCenter`, `dragFrom`
(glisser depuis un point, `{ steps, durationMs, hold: ['Shift'] }`), `typeInField(page, name, valeur)`
(champ du volet de droite par son attribut `name`), `settle` (attendre deux images), `editorState`.
Dans la page, `window.__editor` (dev/test seulement, `src/editor/devHandle.ts`) donne `ready`,
`getState()` (état + actions), `store`, `pageToClient`, `objectClientBox`, `saveNow`,
`hasUnsavedChanges`, `registries()`. Attributs utiles : `[data-workspace-viewport]`,
`[data-page-id]`, `[data-obj-id]`, `[data-selection-box]`, `[data-save-status]`, `[data-tool="rect"]`,
`[data-action="duplicate"]`, `[data-panel-tab="properties"]`, `[data-panel="properties"]`,
`[data-zoom-fit]`, `[data-testid="zoom-value"]`.

Chaque `withApp` démarre Vite et Chrome (quelques secondes) : regroupez les vérifications d'un même
scénario dans un seul `it`. Tests unitaires du store sans navigateur : `createEditorStore()` (voir
`test/store.test.ts`). Lancer : `npx vitest run <filtre>` (Git Bash si vous passez des arguments après
`--` à npm).

## Photos et formes-masques

Toute forme est un cadre (`FrameObject`) : rectangle, ellipse ou tracé normalisé 0..1 (`shape.kind = 'path'`).

| Fichier | Rôle |
| --- | --- |
| `src/model/images.ts` | ppi effective (`imagePpi`, `framePpi`), seuils `PPI_WARN` 250 / `PPI_ERROR` 150, `assetUsages`, `placeholderFrames`, placement (`placeImage`, `refitFrameImage`, `relinkImage`), recadrage (`constrainCover`, `zoomImageAt`, `constrainCrop`, `leavesGap`) |
| `src/model/shapes.ts` | arcs → Bézier (`parsePath(d, { convertArcs: true })` ; sans l'option, un arc reste refusé), transformations SVG, boîte exacte (`pathBounds`), `shapeFromSvg`, `polygonPath`, contours éditables (`pathToContours` / `contoursToPath`), `frameShapePath` (contour en mm), `findShape` |
| `src/editor/CropMode.tsx` | mode `crop` : `startCrop(frameId)`, `finishCrop(commit)` ; un seul geste, donc un seul Ctrl+Z |
| `src/editor/dropImage.ts` + `DropImageOverlay.tsx` | `uploadImage`, `placeAssetInFrame`, `createFrameForAsset`, `frameAtPoint` ; dépôt de fichiers et de photos du panneau Images (`ASSET_DRAG_TYPE`) ; les fichiers Word déposés sont laissés à l'import Word |
| `server/assets.ts` | `POST /api/assets/:id` ; `storeImageAsset(documentsDir, docId, { content, displayName, uploadFile? })` : l'enregistrement d'une photo (original intact, aperçu WebP, copie PNG d'impression d'un TIFF), partagé avec l'import Word |
| `src/editor/PenTool.tsx` | outil `pen` (P), mode `pen-edit` : `startPenEdit(frameId)` |
| `src/editor/ShapeTool.tsx` | remplace l'outil `shape` : polygones réglables, formes du document, `importSvgShape` |
| `src/panels/AssetsPanel.tsx` | panneau Images (ordre 50) + surcouche `ppi-badges` (`[data-ppi-badge="warn" \| "error"]`) ; une photo sans cadre est « Non placée » (`[data-asset-unplaced]`) : sa vignette se glisse sur un cadre |
| `src/panels/properties/FrameSection.tsx` | sections Forme (45) et Photo (50) |
| `scripts/extract-pdf-images.py` | `npm run extract-pdf-images -- --pdf <fichier> --doc <id> [--fill]` : images d'un PDF (dans l'ordre où elles sont peintes, masque compris, décors de moins de 100 px écartés) → photos provisoires `provisoire-<n>.png` du document ; `--fill` garnit dans l'ordre ses cadres vides ou provisoires (pages, puis ordre d'empilement), jamais un cadre qui porte une vraie photo ; relançable |

Modèle (ajouts facultatifs) : `FrameImage.cover` (la photo doit couvrir le cadre : Remplir, même recadrée à la
main), `ShapeRef.polygon` ({ sides, inset, rounding } : le tracé en est recalculé), `LayoutDocument.shapes`
(bibliothèque de formes importées). Une photo provisoire (`Asset.placeholder`) porte un filigrane à l'écran et
l'export la signale (`placeholderWarnings`, `kind: 'placeholder-image'`) ; l'export imprimeur (4.x) doit la
refuser avec `placeholderFrames(doc)`.

## Plan de travail : repères, règles, magnétisme, rotation

| Fichier | Rôle |
| --- | --- |
| `editor/PageGuides.tsx` | fond perdu, coupe, sécurité (`format.safety`, 4 mm depuis la coupe et de part et d'autre de chaque pli), plis ; `pageGuideGeometry(format, faceId)` ; W = aperçu (`guidesView` : repères et calques non imprimables masqués à l'écran, document intact) |
| `editor/Rulers.tsx` | règles en mm (surcouche `viewport`), 0 au coin du format fini de chaque face, plis marqués (`data-ruler-fold`), pointeur marqué ; `rulerSteps(zoom)` ; graduations mémoïsées (ni la souris ni un geste ne les recalculent : `__editor.rulerRenders()`) |
| `editor/Guides.tsx` | repères de `Page.guides` (mm depuis le fond perdu) : tirés des règles (`startGuideDrag`), éditeur flottant (0,1 mm, verrou, suppression), liste dans la barre d'état ; `addGuide`, `updateGuide`, `removeGuide` (annulables) |
| `editor/snapping.ts` | magnétisme (extension des poignées) : `collectTargets`, `snapMove`, `snapResize` en mm ; seuil `1 mm / zoom` ; Alt le coupe pendant un geste ; interrupteur « Magnétisme » de la barre d'état (`snapUi.enabled`) |
| `editor/rotation.ts` | `rotateObjects(draft, ids, delta, pivot?)`, `setRotation`, `angleOf`, `normalizeAngle` (]-180, 180]) ; un groupe fait pivoter ses objets autour de son centre |
| `editor/Transformer.tsx` | poignée de rotation (Maj : 15°) ; un objet seul tourné a un témoin tourné et se redimensionne selon ses propres côtés |
| `panels/properties/RotationSection.tsx` | champ Angle et quarts de tour (ordre 11) |
| `editor/FoldPreview.tsx` | « Aperçu plié » (barre du haut) : pli roulé en CSS 3D, `foldModel(doc)` (null, et bouton masqué, pour tout autre format) |

Tests d'interaction : le magnétisme agit sur tout glisser. Un test qui vérifie un pas de souris exact le coupe
d'abord : `await page.click('[data-snapping-toggle]')`. Alt pressé AU DÉPART d'un glisser duplique ; pressé
pendant le geste, il coupe l'aimantation.

## Texte : édition, typographie, styles

| Fichier | Rôle |
| --- | --- |
| `text/TextEditor.tsx` | édition sur place : double-clic (interaction `text-edit`) → Tiptap dans une surcouche « page », barre flottante (surcouche « viewport »), `startTextEdit(id)` / `finishTextEdit()` |
| `text/extensions.ts` | schéma Tiptap réduit au modèle (une marque par champ de segment), collage nettoyé, typographie à la saisie |
| `text/richText.ts` | conversion paragraphes/segments ↔ JSON Tiptap (`paragraphsToDoc`, `docToParagraphs`, `sameParagraphs`) |
| `text/typographyFr.ts` | règles françaises (`typographyEdits`, `fixTypography`, `applyEditsToRuns`, `documentTypographyChanges`) |
| `text/TypographyDialog.tsx` | « Typographie » (barre du haut) : aperçu puis correction de tout le document |
| `text/findReplace.ts`, `panels/FindReplace.tsx` | Ctrl+F : recherche dans les seuls objets texte, remplacement un par un ou partout |
| `model/styles.ts` | styles de paragraphe et de caractère, écarts (`textOverrides`), propagation |
| `panels/StylesPanel.tsx`, `panels/properties/ParagraphStyleSection.tsx` | panneau Styles ; sections « Style de paragraphe » (35) et « Bloc texte » (36) |
| `render/textMetrics.ts`, `text/overset.tsx`, `text/autoHeight.ts` | mesure à l'écran, « + » rouge du texte en excès, hauteur auto |
| `scripts/derive-styles.ts` | `npm run derive-styles -- --doc <id>` : styles déduits d'un document importé |

- **Édition = un geste** : `startTextEdit` pose le mode `text-edit` et ouvre un geste ; chaque frappe fait un
  `previewGesture` (le document suit en direct), la sortie (Échap, « Terminé », clic ailleurs, Ctrl+S) fait
  `commitGesture` : une étape « Modifier le texte ». Pendant l'édition, l'aperçu s'enregistre 2 s après la
  dernière frappe (geste `autosave`) ; une autre
  écriture dans le store (`apply`) serait écrasée par l'aperçu suivant : terminez d'abord avec
  `finishTextEdit()` (Ctrl+F et « Typographie » le font).
- **Styles, stockage dénormalisé** : `obj.style` et les champs des segments restent les valeurs effectives
  (le rendu et l'export les lisent sans rien savoir des styles). `paragraphStyleId` / `characterStyleId`
  ne sont que des références ; les écarts d'un bloc sont ce qui diffère de son style (`textOverrides`).
  Modifier un style passe par `updateParagraphStyle` / `updateCharacterStyle` (dans `apply`), qui ne
  réécrivent que les valeurs égales à l'ancienne valeur du style. Écrire directement `obj.style` (section
  Texte) crée donc simplement un écart.
- **Nouveaux champs facultatifs** : `TextStyle.spaceBefore` / `spaceAfter` (mm, entre paragraphes),
  `TextRun.characterStyleId`, `TextObject.autoHeight`. `checkIntegrity` vérifie les références de styles
  et les nuances des styles.
- **Import Word** (champs facultatifs, rétrocompatibles) : `TextRun.underline` ; `Paragraph.spaceAfter`,
  `leftIndent` (≥ 0) et `firstLineIndent` (mm ; négatif = retrait suspendu, `validate.ts` refuse une première ligne
  qui sortirait du bloc), `list` ({ kind 'bullet' | 'number', level 0-8, format, suffix « . » ou « ) », start }),
  `paragraphStyleId` (style propre d'un paragraphe, référence vérifiée) ; `ParagraphStyle.origin: 'word'`.
- **Style propre d'un paragraphe** : `applyStyleToParagraph` écrit toutes les valeurs du style dans le paragraphe
  (corps, interlignage, alignement, espaces : `PARAGRAPH_LEVEL_KEYS`) et ses segments (graisse, italique, nuance,
  interlettrage, casse : `PARAGRAPH_RUN_KEYS`) ; le style du bloc ne déteint donc pas. `updateParagraphStyle` suit
  aussi ces paragraphes, `textOverrides` n'y compte comme écarts que ce qui diffère de leur style,
  `clearOverrides` les remet à leur style, `applyParagraphStyle` (sur le bloc) retire les styles propres,
  `deleteParagraphStyle` les détache.
- **Listes** (`model/lists.ts`) : `listMarkers(paragraphs)` numérote dans l'ordre de l'article (les sous-niveaux
  repartent, un paragraphe hors liste n'interrompt pas, `start` impose) ; puces « • » puis « – ». La puce n'est pas du
  texte : `data-list-marker` sur le paragraphe et la règle `[data-list-marker]::before` de `styles/app.css`, dans le
  retrait suspendu (`--fl-marker-w`). Même dessin au rendu (TextFrameView, `TextFlow.markers`), dans la mesure
  du texte chaîné (numéros de l'article entier, `StorySlice.first`) et dans l'éditeur (décorations,
  `listMarkersPlugin`). La suite d'un paragraphe coupé entre deux blocs perd puce et retrait de première ligne.
- **Tabulations** : le bloc est en `white-space: normal` ; chaque `\t` est dessinée dans un `span` en `pre-wrap`
  (`tabbedParts`), taquets tous les 8 cadratins (`TAB_SIZE`, lu aussi par l'éditeur, entièrement en `pre-wrap`).
  `breakPositions` coupe aussi après une tabulation. Souligné : `text-decoration`, marque `runUnderline`, Ctrl+U.
- **Fine insécable U+202F** : absente d'Open Sans ; le rendu la dessine « U+2060 U+2009 U+2060 »
  (`NNBSP_RENDER`), le document garde U+202F.
- **Mesures** : `TextFrameView` publie, à l'écran et seulement si l'éditeur écoute
  (`subscribeTextMeasurements`), la hauteur réelle du texte et son nombre de lignes. `text/overset.tsx`
  en tire le « + », la hauteur auto (étape « Hauteur auto » hors édition, jamais juste après une
  annulation) et resynchronise `lines` (par `patchSilently`) pour un bloc modifié depuis l'ouverture.
- **Tests** : `text`, `typography`, `styles`, `overset`, `find-replace`. Pour éditer un bloc dans un test,
  double-cliquer au milieu du bloc (un clic près d'un bord attrape une poignée) puis attendre
  `document.activeElement[data-text-editor]`.

## Contrôle en amont, pages types, texte chaîné, habillage

| Fichier | Rôle |
| --- | --- |
| `model/preflight.ts` | règles pures (éditeur ET serveur) : `runPreflight(doc, { texts }, { maxInk, unmeasuredText })` → `{ issues, errors, warnings, blocking, toConfirm }` ; `preflightRefusal(report, { confirmLowResolution, confirmHiddenLayers })` ; `pendingConfirmations`, `hiddenPrintableLayers`, `missingGlyphs`, `printedObjects`, `safetyBoxes`, `qrUrlProblem` (mis en cache par adresse et niveau) |
| `model/fontCoverage.ts` | généré par `npx tsx scripts/font-coverage.ts` d'après `public/fonts` : caractères de chaque famille (règle `missing-glyph`), noms PostScript attendus dans le PDF |
| `panels/PreflightPanel.tsx` | onglet « Contrôle » (ordre 60), pastille de la barre d'état (`[data-preflight-status="ok" \| "warning" \| "error"]`), `[data-preflight-issue="règle:objet"]` sélectionne et centre l'objet (ouvre sa page type au besoin) ; `preflightStore`, `recompute()` |
| `model/masters.ts` | pages types : `findPageOrMaster`, `masterOf`, `addMaster`, `applyMaster`, `moveToMaster`, `removeMaster`, `pagesUsingMaster` |
| `editor/masterView.ts` | mode d'édition d'une page type (`masterView.editing`) ; `workspacePages(doc)` = ce que montre le plan de travail (lu par `pageSlots`) |
| `editor/MasterPages.tsx` | menu « Pages types » (barre du haut, ordre 45), bandeau `[data-master-banner]` et `editMaster(id \| null)` |
| `model/threading.ts` | chaînage : `chainFrames`, `chainHead`, `isChained`, `linkFrames`, `unlinkAfter`, `removeFromChain`, `detachChains` (appelé par `removeObjects`), `breakPositions`, `sliceStory` |
| `model/wrap.ts` | habillage : `objectOutline` (contour exact, rotation comprise), `wrapFloatsFor(text, obstacles)` (flottants `shape-outside`), `wrapIndex(doc, printing)` |
| `render/textFlow.ts` | ce qu'affiche chaque bloc : `useTextFlow(obj)` / `textFlowFor(doc, obj, mode)` ; coupe mesurée hors écran ; `TextFlowStore` par PageView ; `refreshTextFlow()` après chargement des polices |
| `render/textCss.ts` | styles d'un bloc texte partagés (rendu, éditeur, mesure) ; toujours réexportés par `TextFrameView` |
| `text/threadingUi.tsx`, `text/wrapUi.tsx` | sections « Chaînage » (37) et « Habillage » (47) ; liens de chaîne à l'écran (surcouche `chain-links`) |

- **Modèle** (ajouts facultatifs) : `LayoutDocument.masters?: MasterPage[]` (même forme qu'une page : `faceId`, `children`,
  `guides`), `Page.masterId?`, `TextObject.nextId?` (bloc suivant), `BaseObject.wrap?: { margin, invert? }` (porté par
  l'objet contourné). `validate.ts` vérifie références, appartenance unique et boucles.
- **Pages types** : leurs objets vivent dans `doc.objects` ; `pageIdOf(objet)` = id de la page type ; `getPage`,
  `addObjects`, `paste`, `selectAll`, `centerOn`, `pageSlots` connaissent les pages types. Sur une face, PageView les
  dessine calque par calque SOUS les objets de la face, dans `[data-master-item]` (`pointer-events: none` : ni clic ni
  lasso) ; on les modifie en mode page type (le plan de travail ne montre alors qu'elle). La sélection et le survol
  ne visent jamais un objet non affiché (garde dans `MasterPages.tsx`).
- **Texte chaîné** : l'article (paragraphes et style) est porté par le premier bloc ; `lines` de chaque bloc suit la
  mesure (overset.tsx), donc l'export compare les bons nombres. Double-clic sur n'importe quel bloc : édition du
  premier (les suivants sont masqués pendant l'édition).
- **Habillage** : au plus deux flottants (`[data-wrap-float]`) en tête du bloc texte, jamais comptés dans la hauteur
  du texte ; un bloc habillé reste aligné en haut. Même rendu à l'écran, dans l'éditeur de texte et à l'impression.
- **Impression** : la route d'impression publie aussi `window.__textMeasures` (hauteur et étendue réelle du texte) ;
  l'export imprimeur fait un premier contrôle avant le rendu (texte non mesuré ignoré), puis le refait sur le texte
  imprimé (`printRefusal(doc, preset, options, { texts })`). Les préréglages qui ne bloquent pas (RVB, e-mail)
  reprennent ses erreurs rouges en avertissements `preflight`.
- **Règles des petits textes et du reste** : petit texte (< 9 pt) à plus de deux encres = erreur rouge, sauf nuance d'accent
  (`Swatch.smallTextException`, case du Nuancier) ; caractère absent des polices (`missing-glyph`, alerte) ; calque
  imprimable masqué (`hidden-layer`, alerte qui demande `confirm: 'hidden-layers'` à l'export imprimeur, comme
  `'low-resolution'` pour les photos sous 150 ppi).

## Chaîne d'impression

Chrome rend les faces en RVB ; Python (`print/.venv`, pikepdf + Pillow ImageCms) fait le reste.

| Fichier | Rôle |
| --- | --- |
| `print/presets.json` | préréglages (`imprimeur`, `traits-de-coupe`, `rvb`, `email`) et profils ICC (FOGRA39, GRACoL2006, FOGRA51/52 à déposer dans `print/profiles/`) |
| `print/printcore.py` | profils, conversions CMJN ↔ RVB, limiteur d'encrage des photos |
| `print/pdf_cmyk.py` | post-traitement : `rg`/`RG` → `k`/`K` d'après la table du nuancier, photos RVB → CMJN (perceptif, Flate, pixels inchangés), groupes de transparence, PDF/X-4 (OutputIntent, XMP, Info), traits de coupe et repères de pli (couleur de repérage `/All`) |
| `print/check_pdfx.py` | contrôle maison PDF/X-4 (version, OutputIntent, XMP, boîtes, polices, aucun RVB, encrage, petits textes) ; lancé par l'export, et en ligne de commande. Petits textes : au plus deux encres hors couleurs d'exception, erreur en mode strict (préréglages CMJN) ; polices Type 3 et hors liste signalées |
| `print/pdfwalk.py` | parcours partagé : flux de contenu (glyphes Type 3 et ressources de leurs polices comprises), ressources, images, dégradés ; `Seen` reconnaît aussi les objets directs ; `image_usages`, `effective_ppi` |
| `print/inkmatch.py` | encres imposées les plus proches d'une couleur (table A2B1 du profil en flottant, ΔE00) : variantes « petit texte » ; plusieurs jeux d'encres (`inkSets`), plusieurs nuances par lancement (`jobs`) ; à trois encres, grille à 5 % affinée au pour cent (`search_inks`, vérifiée contre la recherche exhaustive, `exhaustive: true`) |
| `print/pdf_light.py` | PDF e-mail : photos réduites à 150 ppi, MediaBox = TrimBox |
| `print/proof.py` | épreuve écran d'une photo (RVB → CMJN → RVB), cache dans `documents/<id>/assets/proof/` |
| `print/test_*.py` | `npm run test:print` (PDF d'essai produit par Chrome : `scripts/print-fixture.ts`) |
| `server/color.ts` | `loadPresets`, `runPrintPython`, `cmykToRgb` / `rgbToCmyk` (cache `node_modules/.cache/fluidprint-color/`), routes `GET /api/print/presets`, `POST /api/color/cmyk-to-rgb`, `POST /api/color/rgb-to-cmyk`, `GET /api/proof/:id/<chemin>` |
| `server/export.ts` | `exportPdf({ docId, preset, presetsFile?, confirmLowResolution?, confirmHiddenLayers?, onProgress? })` → `{ file, pages, bytes, pngs, warnings, check, report, profile, standard }` ; `printRefusal` (`details.confirm` : confirmations qui lèveraient le refus) ; `buildColorTable` ; `openPrintRoute` (un 504 « Outdated Optimize Dep » recharge la page une fois) ; travaux suivis : `POST /api/doc/:id/export-jobs?preset=` puis `GET /api/export-jobs/:job` ; `GET /api/doc/:id/exports` et `/exports/:fichier` (téléchargement) |
| `server/app.ts`, `server/clientDeps.ts` | serveur Vite sans rechargement à chaud (tests, export) : dépendances figées (`clientDependencies()`, lues dans `src/`, `noDiscovery`) et un dossier de cache par serveur, effacé à l'arrêt |
| `scripts/print-swatches.ts` | `npm run print-swatches -- --doc <id> [--no-small-text] [--only <ids>] [--keep <ids>] [--inks toutes\|sans-jaune] [--no-qr] [--dry-run]` : nuancier CMJN (FOGRA39, colorimétrie relative + point noir) ; QR codes en « Noir QR » N 100 (`applyQrBlack`) ; règle générique des petits textes (`applySmallTextRule`) : chaque nuance employée sous 9 pt, hors nuances marquées d'exception, reçoit une variante « <nuance> petit texte » (`smallTextVariantId`) — gris neutre (`isNeutralColor`) → noir seul équivalent, couleur à plus de deux encres → une encre de moins (trois au plus), combinaison au ΔE00 minimal calculée par `inkmatch.py` ; variante à trois encres marquée d'exception ; petits textes, styles compris, déplacés sur la variante (`moveSmallText`) ; rapport `print-swatches-report.md` (encres, ΔE00) ; relançable |
| `panels/SwatchesPanel.tsx`, `panels/printColors.ts` | saisie C M J N, encrage total, alerte au-delà de l'encrage du préréglage, « Convertir en CMJN » ; `applySwatchCmyk`, `convertSwatchToCmyk`, `usePresets` |
| `panels/ExportDialog.tsx` | action « Exporter » (ordre 10) : préréglage, résumé, refus des photos provisoires, progression, liens de téléchargement |
| `editor/PrintPreview.tsx` | action « Aperçu impression » (ordre 20) : photos en épreuve (`render/imageVariant.ts`, lu par PageView), repères masqués |

- **Nuancier** : `Swatch.cmyk` fait foi ; `Swatch.rgb` = simulation écran de ces encres (jamais deux nuances au même RVB :
  `distinctRgb`, appliqué par `addSwatch`, `updateSwatch`, `setSwatchCmyk`) ; `Swatch.sourceRgb` = couleur du design,
  rendue par `/print/:id?colors=source` (contrôle au pixel `diff:import`). Modifier une nuance CMJN : `setSwatchCmyk`
  (dans un `apply`) avec le RVB calculé par le serveur ; une nuance sans `cmyk` est convertie à l'export et signalée.
- **Export imprimeur** : refuse une photo provisoire (cadres nommés), puis toute erreur rouge du contrôle en amont ; une
  photo sous 150 ppi passe avec `confirmLowResolution`, un calque imprimable masqué avec `confirmHiddenLayers`. Le PDF
  n'est écrit que si `check_pdfx.py` le dit conforme (petits textes en mode strict, couleurs d'exception = encres des
  nuances d'accent et de leurs teintes). Photos affichées au-delà de `downsampleAbovePpi` (450) ramenées à
  `downsamplePpi` (300) ; `maxBytes` (100 Mo) : avertissement `file-size`. Un original CMJN est retrouvé dans le PDF
  (dimensions, orientation EXIF) et y remet ses pixels (limités à l'encrage maximal) au lieu du RVB de Chrome ; faute de
  le retrouver, avertissement `cmyk-original`. Seule la norme PDF/X-4 est acceptée dans `presets.json`.
- **Table RVB → CMJN** : `printColorTable(doc)` (nuances et teintes utilisées) ; blanc pur → papier, noir pur → N 100 ;
  toute autre couleur inconnue est convertie par le profil et listée dans les avertissements (`unknown-color`).
