// Points d'extension de l'éditeur : types des définitions et fonctions d'enregistrement.
//
// Pour brancher une fonction : un module appelle `registerXxx({...})` à son chargement, puis UNE ligne
// `import '…/monModule';` est ajoutée dans le fichier registre du type concerné (panels.ts, tools.ts,
// shortcuts.ts, overlays.ts, topbar.ts, statusbar.ts, interactions.ts, transformer.ts, ou
// panels/properties/registry.ts). Ce fichier-ci n'importe aucun module de fonction : pas de cycle.
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { MoveableProps } from 'react-moveable';
import type { DocObject, Id, LayoutDocument, Mm, Page } from '../../model/types';
import type { EditorState } from '../../store/documentStore';
import type { Box } from '../../store/tree';
import { createRegistry } from './core';

// ---------------------------------------------------------------- panneaux latéraux

/** Onglet du volet de droite. Ordres réservés : Propriétés 10, Calques 20, Nuancier 30, Styles 40,
 *  Images 50, Contrôle 60, Versions 70. */
export interface PanelDefinition {
  id: string;
  title: string;
  icon?: LucideIcon;
  order?: number;
  component: ComponentType;
}
export const panelRegistry = createRegistry<PanelDefinition>('panneau');
export const registerPanel = panelRegistry.register;

// ---------------------------------------------------------------- sections du panneau Propriétés

export interface PropertySectionProps {
  /** Objets sélectionnés (racines de la sélection), au moins un. */
  objects: DocObject[];
  ids: Id[];
  doc: LayoutDocument;
}

/** Section du panneau Propriétés. Ordres : Position et taille 10, Alignement 15, Apparence 20,
 *  Texte 30, Style de paragraphe 35, QR code 40, Image 50. */
export interface PropertySectionDefinition {
  id: string;
  title: string;
  order?: number;
  /** Vrai si la section a du sens pour cette sélection (non vide). */
  appliesTo(objects: DocObject[], doc: LayoutDocument): boolean;
  component: ComponentType<PropertySectionProps>;
}
export const propertySectionRegistry = createRegistry<PropertySectionDefinition>('section de propriétés');
export const registerPropertySection = propertySectionRegistry.register;

// ---------------------------------------------------------------- raccourcis clavier

/**
 * Raccourci déclaratif. `keys` : « Mod+D », « Mod+Shift+G », « Shift+ArrowUp », « Delete », « W »,
 * « Mod+? ». `Mod` = Ctrl (Cmd sur Mac). Les lettres et chiffres sont reconnus par leur touche physique
 * aussi (AZERTY : Ctrl+0 fonctionne). Le libellé apparaît dans l'aide (Ctrl+?).
 */
export interface ShortcutDefinition {
  id: string;
  keys: string | string[];
  label: string;
  /** Rubrique de l'aide : Fichier, Édition, Objets, Sélection, Affichage, Outils… */
  group?: string;
  order?: number;
  /** Renvoyer `false` laisse l'événement au navigateur (et aux raccourcis suivants). */
  run(e: KeyboardEvent, state: EditorState): void | boolean;
  /** Condition d'activation (par défaut : un document est ouvert et aucun mode exclusif n'est actif). */
  when?(state: EditorState): boolean;
  /** Actif aussi quand le focus est dans un champ de saisie. */
  allowInInput?: boolean;
  /** Actif aussi pendant un mode exclusif (édition de texte, recadrage…). */
  allowInMode?: boolean;
  /** Masqué dans l'aide. */
  hidden?: boolean;
}
export const shortcutRegistry = createRegistry<ShortcutDefinition>('raccourci');
export const registerShortcut = shortcutRegistry.register;

// ---------------------------------------------------------------- outils

export interface CreateContext {
  doc: LayoutDocument;
  state: EditorState;
  pageId: Id;
  /** Cadre tracé, en mm dans le repère de la face ; au simple clic, w = h = 0 au point cliqué. */
  box: Box;
  isClick: boolean;
  /** Point de départ du tracé (mm, face) : utile à une ligne tracée de droite à gauche. */
  start: { x: Mm; y: Mm };
  end: { x: Mm; y: Mm };
  shiftKey: boolean;
  altKey: boolean;
}

export interface WorkspacePointerContext {
  state: EditorState;
  /** Point sous le pointeur : face et mm dans son repère (null hors des faces). */
  point: { pageId: Id; x: Mm; y: Mm } | null;
  /** Point dans le monde (mm), toujours défini. */
  world: { x: Mm; y: Mm };
}

/** Outil de la barre de gauche. Ordres : Sélection 0, Main 5, Texte 10, Rectangle 20, Ellipse 30,
 *  Ligne 40, Cadre photo 50, Forme 60, Plume 65, Icône 70, QR code 80. */
export interface ToolDefinition {
  id: string;
  label: string;
  icon: LucideIcon;
  order?: number;
  /** Touche seule qui active l'outil (« T ») ; le raccourci est enregistré automatiquement. */
  shortcut?: string;
  cursor?: string;
  /** Création par clic-glisser (le plan de travail trace le cadre) ; renvoie les objets créés. */
  create?(ctx: CreateContext): Id[] | void;
  /** Gestion libre du pointeur (plume, pipette…) ; le plan de travail n'y touche plus. */
  onPointerDown?(e: PointerEvent, ctx: WorkspacePointerContext): void;
  /** Reste actif après une création (sinon retour à la sélection). */
  sticky?: boolean;
  /** Options affichées dans une bulle à côté du bouton (choix de la forme, de l'icône…). */
  options?: ComponentType;
}
export const toolRegistry = createRegistry<ToolDefinition>('outil');
export const registerTool = toolRegistry.register;

// ---------------------------------------------------------------- surcouches du plan de travail

export interface PageOverlayProps {
  doc: LayoutDocument;
  page: Page;
  zoom: number;
}

/**
 * Surcouche du plan de travail (non imprimée).
 * - `page` : dessinée DANS chaque face, en mm (repère de la face, `left: '103mm'`), à l'échelle du zoom,
 *   au-dessus des objets. Pour un trait d'un pixel écran : `${1 / zoom}px`.
 * - `viewport` : dessinée en px écran sur tout le plan de travail (règles, outils) ; se positionner avec
 *   editor/layout.ts (pageToScreen…) et le store (zoom, view).
 * Les surcouches ne captent pas le pointeur (`pointer-events: none`) sauf si elles le rétablissent.
 */
export type OverlayDefinition =
  | { id: string; order?: number; space: 'page'; component: ComponentType<PageOverlayProps> }
  | { id: string; order?: number; space: 'viewport'; component: ComponentType };
export const overlayRegistry = createRegistry<OverlayDefinition>('surcouche');
export const registerOverlay = overlayRegistry.register;

// ---------------------------------------------------------------- barre du haut, barre d'état

/** Action de la barre du haut : un bouton simple (label, icon, run) ou un composant libre. */
export interface TopbarActionDefinition {
  id: string;
  order?: number;
  label: string;
  icon?: LucideIcon;
  run?(state: EditorState): void;
  isActive?(state: EditorState): boolean;
  isDisabled?(state: EditorState): boolean;
  /** Rendu libre (bouton qui ouvre un dialogue, menu…) ; remplace le bouton par défaut. */
  component?: ComponentType;
}
export const topbarRegistry = createRegistry<TopbarActionDefinition>('action de la barre du haut');
export const registerTopbarAction = topbarRegistry.register;

/** Élément de la barre d'état, en bas (pastille du contrôle en amont, coordonnées…). */
export interface StatusbarItemDefinition {
  id: string;
  order?: number;
  align?: 'left' | 'right';
  component: ComponentType;
}
export const statusbarRegistry = createRegistry<StatusbarItemDefinition>("élément de la barre d'état");
export const registerStatusbarItem = statusbarRegistry.register;

// ---------------------------------------------------------------- interactions avec les objets

export interface ObjectInteractionContext {
  state: EditorState;
  /** Objet au niveau de sélection courant (un groupe, par exemple). */
  objectId: Id;
  /** Objet le plus profond sous le pointeur (le texte dans le groupe). */
  deepId: Id;
  event: MouseEvent;
}

/** Réaction au double-clic sur un objet (éditer un texte, recadrer une photo…). La première qui
 *  renvoie `true` l'emporte ; à défaut, un double-clic sur un groupe y entre. */
export interface ObjectInteractionDefinition {
  id: string;
  order?: number;
  onDoubleClick?(ctx: ObjectInteractionContext): boolean;
}
export const interactionRegistry = createRegistry<ObjectInteractionDefinition>('interaction');
export const registerInteraction = interactionRegistry.register;

// ---------------------------------------------------------------- extensions des poignées

export interface TransformerContext {
  state: EditorState;
  /** Racines sélectionnées. */
  ids: Id[];
  /** Boîte de la sélection, en px écran (viewport). */
  screenBox: Box;
}

export interface MoveContext {
  state: EditorState;
  ids: Id[];
  /** Face de la sélection (celle du premier objet). */
  pageId: Id;
  /** Boîte de la sélection au départ du geste, mm, repère de la face. */
  startBox: Box;
  /** Événement pointeur courant (Alt coupe le magnétisme, par exemple). */
  event: PointerEvent | MouseEvent;
}

export interface ResizeContext extends MoveContext {
  /** Poignée tirée : [-1|0|1, -1|0|1] (gauche/droite, haut/bas). */
  direction: [number, number];
}

/**
 * Extension des poignées (Moveable) : magnétisme, rotation, repères… Chaque méthode est facultative.
 * - `moveableProps` : props Moveable ajoutées (rotatable, onRotate…) ;
 * - `adjustMove` / `adjustResize` : corrigent un déplacement (mm) ou une boîte (mm) avant l'aperçu ;
 * - `render` : dessin supplémentaire en px écran pendant la sélection (lignes d'alignement…).
 */
export interface TransformerExtension {
  id: string;
  order?: number;
  moveableProps?(ctx: TransformerContext): Partial<MoveableProps>;
  adjustMove?(delta: { dx: Mm; dy: Mm }, ctx: MoveContext): { dx: Mm; dy: Mm };
  adjustResize?(box: Box, ctx: ResizeContext): Box;
  /** Appelé à la fin d'un geste (nettoyage des lignes d'aide…). */
  onGestureEnd?(): void;
  render?: ComponentType<TransformerContext>;
}
export const transformerRegistry = createRegistry<TransformerExtension>('extension des poignées');
export const registerTransformerExtension = transformerRegistry.register;
