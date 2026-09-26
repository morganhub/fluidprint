// Guide d'un agent IA (Claude dans Chrome, Cowork…) qui pilote Fluidprint depuis le navigateur : affiché par le
// bouton « Agent IA » de la barre du haut et de l'accueil, et renvoyé par `window.fluidprint.help()`. Tenu à
// jour avec l'API (api.ts) : chaque méthode citée ici doit y exister (test/agent.test.ts le vérifie).
export const AGENT_GUIDE = `# Fluidprint — guide de l'agent IA

Fluidprint est un éditeur de mise en page pour documents imprimés (dépliants, flyers, affiches, cartes de
visite), façon InDesign / Canva, avec export PDF/X-4 CMJN pour l'imprimeur. L'utilisateur regarde l'écran
pendant que tu travailles : chaque modification apparaît aussitôt, s'annule avec Ctrl+Z et s'enregistre
toute seule.

## Règle d'or : agir par programme, pas à la souris

N'essaie PAS de glisser des blocs, de cliquer dans les poignées ou de taper dans les blocs texte : c'est lent
et imprécis. Toute la page se pilote par JavaScript, avec l'objet global \`window.fluidprint\`, dans l'onglet
de l'éditeur (outil d'exécution JavaScript de ton extension). Les méthodes marquées « async » renvoient une
Promise : utilise \`await\`. Une erreur (objet inconnu, calque verrouillé…) lève une exception au message
clair, en français : lis-la et corrige l'appel.

Pour vérifier le rendu, fais une capture d'écran ; pour vérifier le contenu, relis avec \`objects()\`.

## Démarrer

\`\`\`js
fluidprint.help()          // ce guide
fluidprint.ready()         // vrai quand un document est ouvert dans l'éditeur
fluidprint.info()          // format, pages, volets, calques, nuances, styles, photos, sélection
fluidprint.size()          // format fini, face avec fond perdu, fond perdu, zone de sécurité (mm)
fluidprint.objects()       // tous les objets résumés (id, type, boîte, texte, style, couleur…)
\`\`\`

Sur l'accueil (liste des documents) :

\`\`\`js
await fluidprint.docs()                          // documents existants
await fluidprint.templates()                     // gabarits : depliant-a4-pli-roule, flyer-a5, carte-de-visite…
const id = await fluidprint.create('Flyer salon', 'flyer-a5')
fluidprint.open(id)                              // charge l'éditeur (la page change : attendre ready())
\`\`\`

## Repères et unités

- Longueurs en **mm**, depuis le coin haut-gauche du **format fini** (le trait de coupe), comme le panneau
  Propriétés et les règles. Le fond perdu (\`info().format.bleed\`, souvent 3 mm) est donc en négatif et
  au-delà de la largeur finie : un fond qui doit « saigner » va de -3 à largeur + 3.
- Corps du texte et épaisseur des filets en **points (pt)**.
- Une **page** imprime une **face** (recto, verso). Une face de dépliant est découpée en **volets** séparés par
  des plis : \`info().format.faces[i].panels\` donne x et largeur de chaque volet. Garde le texte à au moins
  \`info().format.safety\` mm (zone de sécurité) du trait de coupe et des plis.
- \`page\` accepte un identifiant, un nom (« Recto ») ou un rang (0 = première). Par défaut : la page active.

## Lire

\`\`\`js
fluidprint.objects({ page: 0 })              // objets d'une page (dessous → dessus, groupes compris)
fluidprint.objects({ type: 'text' })         // filtres : page, type, layer, text, masters: true
fluidprint.find('inscription')               // ids dont le nom ou le texte contient « inscription »
fluidprint.get(id)                           // objet complet du modèle (+ box au format fini)
fluidprint.getText(id)                       // texte brut ; un paragraphe par ligne
fluidprint.selection()                       // ce que l'utilisateur a sélectionné
\`\`\`

Types d'objets : \`text\` (bloc texte), \`rect\`, \`ellipse\`, \`line\`, \`path\` (tracé), \`frame\` (cadre photo ou
forme pleine), \`icon\` (icône Lucide), \`svg\` (logo), \`qr\`, \`group\`. Un résumé signale \`overset\` (texte en
excès, mm), \`chain\` (blocs chaînés), \`empty\` (cadre sans photo), \`locked\`, \`hidden\`.

## Modifier le texte

\`\`\`js
fluidprint.setText(id, 'Titre\\nPremier paragraphe.\\nDeuxième.')      // \\n = nouveau paragraphe
fluidprint.setText(id, 'Du **gras** et de l'*italique*', { markdown: true })
fluidprint.replaceText('2025', '2026')                                 // partout, mise en forme gardée
fluidprint.setTextStyle(id, { fontSize: 12, fontWeight: 700, align: 'center', color: 'Bleu' })
fluidprint.applyParagraphStyle([id1, id2], 'Titre 1')                  // styles : info().paragraphStyles
fluidprint.createParagraphStyle('Accroche', id)
fluidprint.typography()                                                 // espaces insécables, apostrophes
\`\`\`

- \`setText\` garde les réglages et la mise en forme des anciens paragraphes de même rang : pour un bloc
  « intertitre + texte », la ligne 1 reste l'intertitre. La typographie française s'applique toute seule
  (\`{ typo: false }\` pour l'éviter).
- Texte chaîné : le texte de toute la chaîne est porté par le premier bloc ; \`setText\` sur n'importe quel
  bloc de la chaîne remplace le texte de toute la chaîne, qui coule d'un bloc à l'autre.
- Réglages de \`setTextStyle\` : fontSize (pt), fontWeight (400 normal, 600 semi-gras, 700 gras, 800
  extra-gras), italic, lineHeight (multiple du corps : 1.4), letterSpacing (em : 0.02), align (left, center,
  right, justify), transform ('none' | 'uppercase'), color, verticalAlign (top, middle, bottom), autoHeight
  (la hauteur suit le texte). Seule la police Open Sans est disponible.
- Après un changement de texte, contrôle \`fluidprint.overset()\` : un bloc qui déborde doit être agrandi
  (\`setBox\`), son corps réduit, ou son texte raccourci.

## Position, taille, apparence

\`\`\`js
fluidprint.setBox(id, { x: 10, y: 20, w: 80, h: 30 })   // champs absents inchangés
fluidprint.move([id1, id2], 5, 0)                       // décalage relatif en mm
fluidprint.rotate(id, 90)
fluidprint.align([id1, id2], 'hcenter', 'panel')        // left|hcenter|right|top|vcenter|bottom ; 'selection' | 'panel'
fluidprint.distribute([a, b, c], 'y')
fluidprint.setColor(id, 'Bleu')                         // texte, fond, trait d'une ligne, QR, icône
fluidprint.setColor(id, 'Bleu 30%')                     // teinte
fluidprint.setColor(id, '#e85d2a')                      // nuance existante de même couleur, sinon créée (CMJN)
fluidprint.setColor(rectId, null)                       // sans fond
fluidprint.setStroke(id, { color: 'Noir', width: 0.5 }) // filet en pt ; null pour le retirer
fluidprint.update(id, { opacity: 0.8, radius: 2, name: 'Bandeau' })   // champ brut du modèle
fluidprint.update(qrId, { url: 'https://exemple.fr' })
\`\`\`

Couleurs : jamais de couleur en dur ; tout passe par le **nuancier** (\`info().swatches\`). Préfère les nuances
existantes (par leur nom) : ce sont les couleurs de la charte, déjà définies en CMJN. Pour un champ de couleur
passé à \`update\`, utilise \`fluidprint.color('Bleu')\`.

## Créer, organiser

\`\`\`js
const t = fluidprint.add('text', { page: 0, x: 10, y: 15, w: 90, h: 20, text: 'Bonjour', paragraphStyle: 'Titre 1' })
fluidprint.add('text', { x: 10, y: 40, w: 90, h: 50, text: 'Corps…', style: { fontSize: 9 }, autoHeight: true })
fluidprint.add('rect', { x: -3, y: -3, w: 154, h: 40, color: 'Bleu' })   // bandeau à fond perdu (flyer A5)
fluidprint.add('ellipse', { x: 20, y: 20, w: 30, h: 30, color: 'Bleu 40%' })
fluidprint.add('line', { x: 10, y: 60, w: 80, color: 'Noir' })
fluidprint.add('frame', { x: 10, y: 70, w: 60, h: 40 })                  // cadre photo vide
fluidprint.add('shape', { shape: 'goutte', x: 50, y: 50, w: 30, h: 39, color: 'Bleu' })
fluidprint.add('qr', { url: 'https://exemple.fr', x: 110, y: 170, w: 25 })
await fluidprint.addIcon('téléphone', { x: 10, y: 180, w: 6, color: 'Bleu' })
await fluidprint.searchIcons('calendrier')
fluidprint.duplicate(id, { dx: 0, dy: 20 })
fluidprint.remove([id1, id2])
fluidprint.group([id1, id2]);  fluidprint.ungroup(groupId)
fluidprint.reorder(id, 'front')                          // front, back, forward, backward
fluidprint.setLayer(id, 'Textes')                        // calques : info().layers
\`\`\`

Sans x / y, l'objet est centré sur la page. Options communes : page, layer, name, color, stroke, opacity,
rotation. Un nouvel objet va sur le calque actif (le plus haut calque visible et déverrouillé).

## Photos

\`\`\`js
await fluidprint.placeImage(frameId, 'https://site.fr/photo.jpg')   // dans un cadre existant (remplir)
await fluidprint.placeImage(frameId, assetId, { fit: 'fit' })       // photo déjà dans le document : info().assets
await fluidprint.addImage('/chemin/photo.jpg', { page: 0, x: 75, y: 100, w: 60 })  // nouveau cadre
const asset = await fluidprint.uploadImage(blob)   // envoi seul (URL, File ou Blob) : { id, name, width, height }
\`\`\`

Une URL d'un autre site doit autoriser CORS ; sinon demande à l'utilisateur de déposer la photo sur le cadre
(glisser depuis l'explorateur) ou de l'ajouter au panneau Images. Une photo d'impression doit avoir au moins
250 ppi à sa taille affichée (le contrôle le signale).

## Montrer, annuler, grouper les étapes

\`\`\`js
fluidprint.focus(id)              // sélectionne et centre la vue : montre à l'utilisateur ce que tu as fait
fluidprint.select([id1, id2]);  fluidprint.fit()
fluidprint.undo();  fluidprint.redo()
await fluidprint.batch('Refonte du recto', async () => {   // tout le lot = UNE étape d'annulation
  fluidprint.setText(a, '…');
  fluidprint.setBox(b, { y: 40 });
})
await fluidprint.save()           // l'enregistrement est automatique (2 s) ; save() force et attend
\`\`\`

## Contrôler et exporter

\`\`\`js
fluidprint.preflight()            // { errors, warnings, blocking, issues: [{ severity, rule, message, objectId, page }] }
fluidprint.overset()              // { id: mm de texte en excès }
await fluidprint.presets()        // imprimeur (PDF/X-4 CMJN), traits-de-coupe, rvb, email
const pdf = await fluidprint.export('imprimeur')   // { file, url } : ouvrir url pour télécharger
\`\`\`

L'export imprimeur refuse un document avec des erreurs bloquantes (texte en excès, photo provisoire…) : corrige
d'abord ce que \`preflight()\` signale. Une photo sous 150 ppi ou un calque imprimable masqué exigent une
confirmation (\`{ confirmLowResolution: true }\`, \`{ confirmHiddenLayers: true }\`) : demande-la à l'utilisateur.

## Bonnes pratiques

1. Commence par \`info()\` et \`objects()\` ; travaille avec les identifiants, jamais avec des positions d'écran.
2. Respecte la charte du document : nuances et styles de paragraphe existants, Open Sans, marges de sécurité.
3. Un objet ou un calque **verrouillé** est refusé : ne le déverrouille pas sans l'accord de l'utilisateur.
4. Après une série de changements : \`overset()\`, \`preflight()\`, puis \`focus()\` sur le résultat et capture
   d'écran pour vérifier.
5. Regroupe une intention en un \`batch\` : l'utilisateur l'annule d'un seul Ctrl+Z.
6. Ne modifie jamais les fichiers du serveur directement, et n'exporte ou n'écrase rien d'irréversible sans
   l'avoir annoncé.

## API HTTP (secours)

Même origine, mêmes droits que la page : \`GET /api/doc\` (liste), \`GET /api/doc/:id\` (document JSON),
\`GET /api/templates\`, \`POST /api/doc\` { name, templateId }, \`POST /api/doc/:id/duplicate\`,
\`POST /api/doc/:id/export-jobs?preset=imprimeur\` puis \`GET /api/export-jobs/:job\`,
\`GET /api/doc/:id/exports\`. N'écris pas le document par l'API pendant qu'il est ouvert dans l'éditeur (conflit
d'enregistrement) : passe par \`window.fluidprint\`.
`;
