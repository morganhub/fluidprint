// Bibliothèque d'icônes Lucide (tâche 2.14), tirée du paquet `lucide-static` : ~1 850 icônes au trait,
// chargées à la demande (icon-nodes.json pèse 780 Ko). Recherche par nom anglais, par les mots-clés de
// Lucide, et par des mots-clés français pour les icônes courantes.

export type IconNode = [tag: string, attrs: Record<string, string>][];

export interface IconLibrary {
  names: string[];
  nodes: Record<string, IconNode>;
  tags: Record<string, string[]>;
}

let loading: Promise<IconLibrary> | null = null;

/**
 * Charge la bibliothèque une fois (import dynamique : hors du paquet initial de l'éditeur). Les JSON
 * sont lus en texte (`?raw`) : importés comme modules JSON, TypeScript typerait 780 Ko de littéraux.
 */
export function loadIconLibrary(): Promise<IconLibrary> {
  loading ??= Promise.all([import('lucide-static/icon-nodes.json?raw'), import('lucide-static/tags.json?raw')]).then(([n, t]) => {
    const nodes = JSON.parse(n.default) as Record<string, IconNode>;
    const tags = JSON.parse(t.default) as Record<string, string[]>;
    return { names: Object.keys(nodes).sort(), nodes, tags };
  });
  return loading;
}

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Contenu SVG d'une icône (éléments internes du viewBox 24 × 24), au format de `IconObject.svg`. */
export function iconSvg(node: IconNode): string {
  return node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeAttr(String(v))}"`).join(' ')}></${tag}>`).join('');
}

/**
 * Mots-clés français → icônes Lucide. Les plus courantes d'un document imprimé (dépliant, flyer…) : on cherche
 * « maison », « téléphone », « formation »… et on trouve l'icône sans connaître son nom anglais.
 */
export const FRENCH_KEYWORDS: Record<string, string[]> = {
  accueil: ['house'],
  maison: ['house', 'house-heart', 'houses'],
  domicile: ['house'],
  telephone: ['phone', 'smartphone', 'phone-call'],
  portable: ['smartphone', 'laptop'],
  mobile: ['smartphone'],
  courriel: ['mail', 'at-sign'],
  email: ['mail', 'at-sign'],
  mail: ['mail'],
  lettre: ['mail', 'send'],
  envoyer: ['send'],
  adresse: ['map-pin', 'map'],
  lieu: ['map-pin', 'map'],
  carte: ['map', 'map-pin', 'credit-card'],
  localisation: ['map-pin', 'locate'],
  calendrier: ['calendar', 'calendar-days', 'calendar-check'],
  agenda: ['calendar-days', 'calendar'],
  date: ['calendar', 'calendar-days'],
  rendezvous: ['calendar-check', 'calendar-clock'],
  horloge: ['clock', 'alarm-clock'],
  heure: ['clock', 'timer'],
  duree: ['timer', 'hourglass', 'clock'],
  temps: ['clock', 'timer', 'hourglass'],
  minuteur: ['timer'],
  sablier: ['hourglass'],
  personne: ['user', 'user-round'],
  utilisateur: ['user', 'user-round', 'user-check'],
  profil: ['user', 'circle-user-round', 'contact'],
  equipe: ['users', 'users-round'],
  groupe: ['users', 'users-round'],
  participants: ['users'],
  famille: ['users', 'baby'],
  enfant: ['baby', 'school'],
  eleve: ['graduation-cap', 'school', 'backpack'],
  etudiant: ['graduation-cap', 'book-open'],
  ecole: ['school', 'graduation-cap'],
  formation: ['graduation-cap', 'presentation', 'book-open-check'],
  diplome: ['graduation-cap', 'award'],
  cours: ['book-open', 'presentation', 'notebook-pen'],
  livre: ['book-open', 'book', 'library'],
  lecture: ['book-open', 'glasses'],
  enseignant: ['presentation', 'user-check'],
  atelier: ['wrench', 'hammer', 'presentation'],
  outil: ['wrench', 'hammer', 'settings'],
  reglages: ['settings', 'sliders-horizontal'],
  parametres: ['settings'],
  entreprise: ['briefcase', 'building', 'briefcase-business', 'building-complex'],
  bureau: ['building', 'briefcase', 'monitor'],
  travail: ['briefcase', 'briefcase-business'],
  emploi: ['briefcase', 'user-check'],
  recrutement: ['user-plus', 'user-check', 'handshake'],
  partenariat: ['handshake'],
  accord: ['handshake', 'check'],
  ordinateur: ['monitor', 'laptop'],
  ecran: ['monitor', 'tv'],
  tablette: ['tablet'],
  intelligence: ['brain', 'bot', 'sparkles'],
  ia: ['bot', 'brain', 'sparkles', 'cpu'],
  robot: ['bot'],
  cerveau: ['brain'],
  idee: ['lightbulb', 'sparkles'],
  ampoule: ['lightbulb'],
  innovation: ['rocket', 'lightbulb', 'sparkles'],
  fusee: ['rocket'],
  lancement: ['rocket'],
  croissance: ['trending-up', 'chart-no-axes-column-increasing'],
  progression: ['trending-up', 'chart-line'],
  graphique: ['chart-bar', 'chart-line', 'chart-pie', 'chart-no-axes-column-increasing'],
  statistiques: ['chart-bar', 'chart-pie', 'chart-line'],
  document: ['file-text', 'file', 'file-check'],
  fichier: ['file', 'file-text'],
  dossier: ['folder', 'folder-open'],
  valider: ['check', 'circle-check', 'file-check', 'clipboard-check'],
  coche: ['check', 'circle-check', 'square-check'],
  liste: ['list', 'list-checks', 'clipboard-list'],
  securite: ['shield', 'shield-check', 'lock'],
  protection: ['shield', 'shield-check'],
  alerte: ['shield-alert', 'triangle-alert', 'bell'],
  attention: ['triangle-alert', 'circle-alert'],
  cadenas: ['lock', 'lock-open'],
  confidentialite: ['lock', 'eye-off', 'shield'],
  cle: ['key', 'key-round'],
  cloche: ['bell'],
  notification: ['bell', 'bell-ring'],
  coeur: ['heart', 'heart-handshake'],
  sante: ['heart-pulse', 'stethoscope'],
  medecin: ['stethoscope'],
  etoile: ['star', 'sparkles'],
  favori: ['star', 'bookmark'],
  qualite: ['award', 'badge-check', 'star'],
  recompense: ['award', 'trophy', 'medal'],
  trophee: ['trophy'],
  objectif: ['target', 'goal', 'crosshair'],
  cible: ['target'],
  boussole: ['compass'],
  orientation: ['compass', 'signpost', 'route'],
  parcours: ['route', 'map', 'footprints'],
  chemin: ['route', 'signpost'],
  monde: ['globe', 'earth'],
  internet: ['globe', 'wifi', 'link'],
  site: ['globe', 'link'],
  lien: ['link', 'external-link'],
  wifi: ['wifi'],
  nuage: ['cloud'],
  message: ['message-square-text', 'message-circle', 'message-square'],
  discussion: ['messages-square', 'message-circle'],
  conversation: ['messages-square', 'message-square-text'],
  question: ['circle-question-mark', 'message-circle-question-mark'],
  aide: ['circle-question-mark', 'life-buoy', 'hand-helping'],
  information: ['info'],
  info: ['info'],
  cadeau: ['gift'],
  offre: ['gift', 'tag', 'percent'],
  prix: ['tag', 'euro', 'badge-euro'],
  euro: ['euro', 'badge-euro'],
  argent: ['euro', 'wallet', 'banknote'],
  paiement: ['credit-card', 'wallet'],
  panier: ['shopping-cart', 'shopping-basket'],
  achat: ['shopping-cart', 'shopping-bag'],
  photo: ['camera', 'image'],
  image: ['image', 'images'],
  video: ['video', 'play'],
  musique: ['music'],
  micro: ['mic'],
  ecouteurs: ['headphones'],
  imprimer: ['printer'],
  telecharger: ['download'],
  partager: ['share-2', 'share'],
  fleche: ['arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'chevron-right'],
  suivant: ['arrow-right', 'chevron-right'],
  precedent: ['arrow-left', 'chevron-left'],
  haut: ['arrow-up', 'chevron-up'],
  bas: ['arrow-down', 'chevron-down'],
  plus: ['plus', 'circle-plus'],
  ajouter: ['plus', 'circle-plus'],
  moins: ['minus'],
  fermer: ['x'],
  croix: ['x'],
  modifier: ['pencil', 'pen-line'],
  crayon: ['pencil'],
  ecrire: ['pencil', 'pen-line', 'notebook-pen'],
  supprimer: ['trash'],
  corbeille: ['trash'],
  copier: ['copy'],
  rechercher: ['search'],
  loupe: ['search', 'zoom-in'],
  voir: ['eye', 'scan-eye'],
  oeil: ['eye', 'scan-eye'],
  vision: ['eye', 'scan-eye'],
  soleil: ['sun'],
  lune: ['moon'],
  feuille: ['leaf'],
  arbre: ['tree-pine', 'tree-deciduous'],
  nature: ['leaf', 'tree-pine', 'mountain'],
  eau: ['droplet', 'waves-horizontal'],
  goutte: ['droplet'],
  energie: ['zap', 'battery-charging'],
  eclair: ['zap'],
  rapide: ['zap', 'rocket'],
  feu: ['flame'],
  voiture: ['car'],
  velo: ['bike'],
  bus: ['bus'],
  train: ['train-front'],
  avion: ['plane'],
  livraison: ['truck', 'package'],
  colis: ['package'],
  cafe: ['coffee'],
  repas: ['utensils'],
  accessibilite: ['accessibility'],
  handicap: ['accessibility'],
  sourire: ['face-slightly-smiling'],
  pouce: ['thumbs-up'],
  jaime: ['thumbs-up', 'heart'],
  drapeau: ['flag'],
  signet: ['bookmark'],
  etiquette: ['tag'],
  balance: ['scale'],
  justice: ['scale', 'gavel'],
  journal: ['newspaper'],
  actualites: ['newspaper'],
  annonce: ['megaphone'],
  communication: ['megaphone', 'message-circle'],
  presentation: ['presentation'],
  tableau: ['presentation', 'layout-grid', 'table'],
  grille: ['layout-grid', 'grid-3x3'],
  calques: ['layers'],
  blocs: ['blocks', 'boxes'],
  modules: ['blocks', 'puzzle'],
  puzzle: ['puzzle'],
  code: ['code', 'terminal'],
  numerique: ['monitor-smartphone', 'cpu', 'smartphone'],
  telephoneportable: ['smartphone'],
  repeter: ['repeat', 'refresh-cw'],
  actualiser: ['refresh-cw'],
  montagne: ['mountain'],
  vague: ['waves-horizontal'],
  identite: ['id-card', 'contact'],
  contact: ['contact', 'phone', 'mail'],
};

export const normalizeQuery = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[œ]/g, 'oe')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim();

/** Mots-clés français d'une icône (index inverse de FRENCH_KEYWORDS). */
function frenchIndex(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [word, names] of Object.entries(FRENCH_KEYWORDS)) {
    for (const name of names) {
      if (!out.has(name)) out.set(name, []);
      out.get(name)!.push(word);
    }
  }
  return out;
}
let french: Map<string, string[]> | null = null;

/** Icônes courantes (présentées sans recherche) : celles des mots-clés français, sans doublons. */
export function commonIcons(library: IconLibrary): string[] {
  const seen = new Set<string>();
  for (const names of Object.values(FRENCH_KEYWORDS)) for (const n of names) if (library.nodes[n]) seen.add(n);
  return [...seen];
}

/**
 * Recherche : chaque mot de la requête doit toucher le nom de l'icône, un mot-clé Lucide ou un mot-clé
 * français. Classement : nom exact, mot français exact, début de nom, début de mot-clé, le reste.
 */
export function searchIcons(library: IconLibrary, query: string, limit = 120): string[] {
  const words = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (!words.length) return commonIcons(library).slice(0, limit);
  french ??= frenchIndex();
  const scored: { name: string; score: number }[] = [];
  for (const name of library.names) {
    const tags = (library.tags[name] ?? []).map(normalizeQuery);
    const fr = french.get(name) ?? [];
    let total = 0;
    for (const w of words) {
      let s = 0;
      if (name === w) s = 100;
      else if (fr.includes(w)) s = 90;
      else if (fr.some((f) => f.startsWith(w) && w.length >= 3)) s = 70;
      else if (name.startsWith(w)) s = 60;
      else if (name.split('-').includes(w)) s = 55;
      else if (tags.includes(w)) s = 45;
      else if (name.includes(w)) s = 35;
      else if (tags.some((t) => t.startsWith(w))) s = 25;
      else if (w.length >= 3 && tags.some((t) => t.includes(w))) s = 10;
      if (!s) {
        total = 0;
        break;
      }
      total += s;
    }
    if (total) {
      // Pour un mot français, l'ordre de la liste compte : la première icône est la plus parlante.
      const frRank = words.length === 1 ? (FRENCH_KEYWORDS[words[0]]?.indexOf(name) ?? -1) : -1;
      scored.push({ name, score: total + (frRank >= 0 ? 20 - frRank : 0) - name.length * 0.01 });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name);
}
