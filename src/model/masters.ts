// Pages types (tâche 4.11). Une page type porte des objets communs (fond, filets, logo, numéro…) ; chaque
// face qui l'utilise (`Page.masterId`) les affiche sous ses propres objets, calque par calque, comme dans
// InDesign. On ne les modifie qu'à un seul endroit : en mode d'édition de la page type. Les objets d'une
// page type vivent dans `doc.objects` comme les autres : toutes les commandes de l'éditeur s'y appliquent.
import type { DocObject, Id, LayoutDocument, MasterPage, Page } from './types';

/** Page ou page type par identifiant (les deux ont la même forme : faceId, children, guides). */
export function findPageOrMaster(doc: Pick<LayoutDocument, 'pages' | 'masters'>, id: Id): Page | MasterPage | undefined {
  return doc.pages.find((p) => p.id === id) ?? doc.masters?.find((m) => m.id === id);
}

export function findMaster(doc: Pick<LayoutDocument, 'masters'>, id: Id | null | undefined): MasterPage | undefined {
  return id ? doc.masters?.find((m) => m.id === id) : undefined;
}

export const isMasterId = (doc: Pick<LayoutDocument, 'masters'>, id: Id | null | undefined): boolean => !!findMaster(doc, id);

/** Page type appliquée à une page (undefined sans page type, ou pour une page type elle-même). */
export function masterOf(doc: Pick<LayoutDocument, 'masters'>, page: Page | MasterPage): MasterPage | undefined {
  return 'masterId' in page ? findMaster(doc, page.masterId) : undefined;
}

/** Faces qui utilisent une page type. */
export function pagesUsingMaster(doc: Pick<LayoutDocument, 'pages'>, masterId: Id): Page[] {
  return doc.pages.filter((p) => p.masterId === masterId);
}

/** Objets de premier niveau de la page type d'une page (dans l'ordre de la page type). */
export function masterObjects(doc: LayoutDocument, page: Page | MasterPage): DocObject[] {
  const master = masterOf(doc, page);
  return master ? master.children.map((id) => doc.objects[id]).filter((o): o is DocObject => !!o) : [];
}

/** Identifiant libre, lisible (« pt-a », « pt-b »…). */
function newMasterId(doc: LayoutDocument): Id {
  const taken = new Set([...doc.pages.map((p) => p.id), ...(doc.masters ?? []).map((m) => m.id)]);
  for (let i = 0; ; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : String(i);
    if (!taken.has(`pt-${suffix}`)) return `pt-${suffix}`;
  }
}

/** Nom par défaut, comme InDesign : « A-Page type », « B-Page type »… */
export function defaultMasterName(doc: Pick<LayoutDocument, 'masters'>): string {
  const n = doc.masters?.length ?? 0;
  return `${n < 26 ? String.fromCharCode(65 + n) : n + 1}-Page type`;
}

// ---------------------------------------------------------------- modifications (sur un brouillon)

export function addMaster(doc: LayoutDocument, input: { name?: string; faceId?: Id } = {}): Id {
  const id = newMasterId(doc);
  const faceId = input.faceId ?? doc.format.faces[0].id;
  const master: MasterPage = { id, faceId, name: input.name?.trim() || defaultMasterName(doc), children: [] };
  (doc.masters ??= []).push(master);
  return id;
}

export function renameMaster(doc: LayoutDocument, id: Id, name: string): void {
  const master = findMaster(doc, id);
  if (master && name.trim()) master.name = name.trim();
}

/** Applique (ou retire, avec null) une page type à une page. */
export function applyMaster(doc: LayoutDocument, pageId: Id, masterId: Id | null): void {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return;
  if (masterId && findMaster(doc, masterId)) page.masterId = masterId;
  else delete page.masterId;
}

/** Supprime une page type et ses objets ; les pages qui l'utilisaient n'en ont plus. */
export function removeMaster(doc: LayoutDocument, id: Id): void {
  const master = findMaster(doc, id);
  if (!master) return;
  const doomed: Id[] = [];
  const collect = (objId: Id) => {
    doomed.push(objId);
    const obj = doc.objects[objId];
    if (obj?.type === 'group') obj.children.forEach(collect);
  };
  master.children.forEach(collect);
  for (const objId of doomed) delete doc.objects[objId];
  for (const page of doc.pages) if (page.masterId === id) delete page.masterId;
  doc.masters = doc.masters!.filter((m) => m.id !== id);
  if (!doc.masters.length) delete doc.masters;
}

/**
 * Déplace des objets de premier niveau d'une face vers une page type (« Déplacer vers la page type »),
 * à la même position et dans le même ordre d'empilement. Renvoie les objets déplacés.
 */
export function moveToMaster(doc: LayoutDocument, ids: Id[], masterId: Id): Id[] {
  const master = findMaster(doc, masterId);
  if (!master) return [];
  const moved: Id[] = [];
  for (const page of doc.pages) {
    const mine = page.children.filter((id) => ids.includes(id));
    if (!mine.length) continue;
    page.children = page.children.filter((id) => !mine.includes(id));
    master.children.push(...mine);
    moved.push(...mine);
  }
  return moved;
}
