import { create as createQr } from 'qrcode';
import { z } from 'zod';
import { parsePath } from './shapes';
import { DOC_VERSION, type LayoutDocument } from './types';

// ---------------------------------------------------------------- schéma

const id = z.string().min(1);
const mm = z.number().finite();
const hex = z.string().regex(/^#[0-9a-f]{6}$/, 'couleur attendue au format #rrggbb (minuscules)');

const guide = z.object({ id, axis: z.enum(['x', 'y']), at: mm, locked: z.boolean().optional() }).strict();
const colorRef = z.object({ swatch: id, tint: z.number().min(0).max(1).optional() }).strict();
const stroke = z.object({ color: colorRef, width: z.number().nonnegative(), dash: z.array(z.number().nonnegative()).optional() }).strict();
const radius = z.union([z.number().nonnegative(), z.tuple([mm, mm, mm, mm])]);
const textTransform = z.enum(['none', 'uppercase']);
const textAlign = z.enum(['left', 'center', 'right', 'justify']);

const textStyle = z
  .object({
    fontFamily: z.string().min(1),
    fontWeight: z.number().int().min(100).max(900),
    italic: z.boolean().optional(),
    fontSize: z.number().positive(),
    lineHeight: z.number().positive(),
    letterSpacing: z.number(),
    color: colorRef,
    align: textAlign,
    transform: textTransform,
    textWrap: z.enum(['wrap', 'pretty', 'balance']).optional(),
    spaceBefore: z.number().nonnegative().optional(),
    spaceAfter: z.number().nonnegative().optional(),
  })
  .strict();

const textRun = z
  .object({
    text: z.string(),
    color: colorRef.optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    italic: z.boolean().optional(),
    fontSize: z.number().positive().optional(),
    letterSpacing: z.number().optional(),
    transform: textTransform.optional(),
    characterStyleId: id.optional(),
  })
  .strict();

const paragraph = z
  .object({
    runs: z.array(textRun),
    fontSize: z.number().positive().optional(),
    lineHeight: z.number().positive().optional(),
    align: textAlign.optional(),
    spaceBefore: mm.optional(),
  })
  .strict();

const base = {
  id,
  name: z.string().optional(),
  layerId: id,
  x: mm,
  y: mm,
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  wrap: z.object({ margin: z.number().nonnegative(), invert: z.boolean().optional() }).strict().optional(),
};

const shapeRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rect'), radius: radius.optional() }).strict(),
  z.object({ kind: z.literal('ellipse') }).strict(),
  z
    .object({
      kind: z.literal('path'),
      d: z.string().min(1),
      preset: z.string().optional(),
      polygon: z
        .object({ sides: z.number().int().min(3).max(12), inset: z.number().min(0).max(99), rounding: z.number().min(0).max(100) })
        .strict()
        .optional(),
    })
    .strict(),
]);

const docObject = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('text'),
      style: textStyle,
      paragraphs: z.array(paragraph).min(1),
      verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
      paragraphStyleId: id.optional(),
      autoHeight: z.boolean().optional(),
      lines: z.number().int().nonnegative().optional(),
      nextId: id.optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('rect'), fill: colorRef.optional(), stroke: stroke.optional(), radius: radius.optional() }).strict(),
  z.object({ ...base, type: z.literal('ellipse'), fill: colorRef.optional(), stroke: stroke.optional() }).strict(),
  z.object({ ...base, type: z.literal('line'), stroke, flip: z.boolean().optional() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('path'),
      d: z.string().min(1),
      fill: colorRef.optional(),
      stroke: stroke.optional(),
      nonScalingStroke: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('frame'),
      shape: shapeRef,
      fill: colorRef.optional(),
      stroke: stroke.optional(),
      image: z
        .object({
          assetId: id,
          fit: z.enum(['fill', 'fit', 'center', 'custom']),
          x: mm,
          y: mm,
          w: z.number().positive(),
          h: z.number().positive(),
          cover: z.boolean().optional(),
        })
        .strict()
        .optional(),
      placeholder: z.string().optional(),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal('icon'), iconName: z.string().min(1), svg: z.string().min(1), color: colorRef, strokeWidth: z.number().positive() })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('svg'),
      viewBox: z.string().min(1),
      content: z.string().min(1),
      color: colorRef.optional(),
      preserveAspectRatio: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('qr'),
      url: z.string().min(1),
      ecc: z.enum(['L', 'M', 'Q', 'H']),
      color: colorRef,
      background: colorRef.optional(),
      margin: z.number().int().min(0),
    })
    .strict(),
  z.object({ ...base, type: z.literal('group'), children: z.array(id) }).strict(),
]);

const documentSchema = z
  .object({
    version: z.literal(DOC_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    name: z.string().min(1),
    createdAt: z.string().min(1),
    editedAt: z.string().optional(),
    format: z
      .object({
        id: id,
        name: z.string(),
        trim: z.object({ w: z.number().positive(), h: z.number().positive() }).strict(),
        bleed: z.number().nonnegative(),
        safety: z.number().nonnegative(),
        faces: z
          .array(z.object({ id, name: z.string(), panels: z.array(z.object({ name: z.string(), w: z.number().positive() }).strict()).min(1) }).strict())
          .min(1),
      })
      .strict(),
    pages: z
      .array(
        z
          .object({
            id,
            faceId: id,
            name: z.string(),
            children: z.array(id),
            guides: z.array(guide).optional(),
            masterId: id.optional(),
          })
          .strict(),
      )
      .min(1),
    masters: z.array(z.object({ id, faceId: id, name: z.string(), children: z.array(id), guides: z.array(guide).optional() }).strict()).optional(),
    layers: z
      .array(z.object({ id, name: z.string(), visible: z.boolean(), locked: z.boolean(), printable: z.boolean(), color: z.string() }).strict())
      .min(1),
    objects: z.record(z.string(), docObject),
    swatches: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1),
            rgb: hex,
            cmyk: z.tuple([z.number().min(0).max(100), z.number().min(0).max(100), z.number().min(0).max(100), z.number().min(0).max(100)]).optional(),
            sourceRgb: hex.optional(),
            smallTextException: z.boolean().optional(),
          })
          .strict(),
      ),
    styles: z
      .object({
        paragraph: z.array(z.object({ id, name: z.string(), style: textStyle }).strict()),
        character: z.array(z.object({ id, name: z.string(), style: textRun.omit({ text: true, characterStyleId: true }).partial() }).strict()),
      })
      .strict(),
    assets: z.array(
      z
        .object({
          id,
          kind: z.literal('image'),
          name: z.string(),
          original: z.string().min(1),
          preview: z.string().optional(),
          print: z.string().min(1).optional(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          placeholder: z.boolean().optional(),
        })
        .strict(),
    ),
    source: z.object({ kind: z.literal('claude-design'), path: z.string(), importedAt: z.string() }).strict().optional(),
    shapes: z.array(z.object({ id, name: z.string().min(1), d: z.string().min(1), aspect: z.number().positive() }).strict()).optional(),
  })
  .strict();

// ---------------------------------------------------------------- migrations

// Version 1 : couleurs écrites en hexadécimal directement dans les objets, sans nuancier.
// Version 2 : toute couleur référence une nuance ; la migration crée une nuance par valeur rencontrée.
const COLOR_KEYS = new Set(['fill', 'color', 'background']);

function migrateV1(input: Record<string, unknown>): Record<string, unknown> {
  const swatches = new Map<string, { id: string; name: string; rgb: string }>();
  const toRef = (value: string) => {
    const rgb = value.toLowerCase();
    if (!swatches.has(rgb)) swatches.set(rgb, { id: `c-${rgb.slice(1)}`, name: rgb, rgb });
    return { swatch: swatches.get(rgb)!.id };
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = COLOR_KEYS.has(key) && typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? toRef(value) : walk(value);
    }
    return out;
  };
  // Seuls les objets portent des couleurs d'impression ; `layers[].color` est une couleur d'interface.
  const objects = walk(input.objects ?? {});
  return { ...input, objects, version: 2, swatches: [...((input.swatches as unknown[]) ?? []), ...swatches.values()] };
}

export function migrate(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  let doc = input as Record<string, unknown>;
  if (doc.version === 1) doc = migrateV1(doc);
  return doc;
}

// ---------------------------------------------------------------- validation

export interface ValidationError {
  /** Chemin exact de l'erreur, ex. `objects.t12.fill.swatch`. */
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; doc: LayoutDocument } | { ok: false; errors: ValidationError[] };

const joinPath = (path: readonly PropertyKey[]) => path.map(String).join('.');

/** Migre si besoin, vérifie la forme puis la cohérence (références, arborescence, calques). */
export function validateDocument(input: unknown): ValidationResult {
  const parsed = documentSchema.safeParse(migrate(input));
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => ({ path: joinPath(issue.path), message: issue.message })) };
  }
  const doc = parsed.data as LayoutDocument;
  const errors = checkIntegrity(doc);
  return errors.length ? { ok: false, errors } : { ok: true, doc };
}

export function assertValidDocument(input: unknown): LayoutDocument {
  const result = validateDocument(input);
  if (!result.ok) {
    const detail = result.errors.slice(0, 20).map((e) => `  ${e.path || '(racine)'} : ${e.message}`).join('\n');
    throw new Error(`Document invalide (${result.errors.length} erreur(s)) :\n${detail}`);
  }
  return result.doc;
}

function checkIntegrity(doc: LayoutDocument): ValidationError[] {
  const errors: ValidationError[] = [];
  const swatchIds = new Set(doc.swatches.map((s) => s.id));
  const layerIds = new Set(doc.layers.map((l) => l.id));
  const assetIds = new Set(doc.assets.map((a) => a.id));
  const faceIds = new Set(doc.format.faces.map((f) => f.id));
  const parents = new Map<string, string>();

  const dup = (list: { id: string }[], what: string, at: string) => {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      if (seen.has(item.id)) errors.push({ path: `${at}.${i}.id`, message: `${what} en double : ${item.id}` });
      seen.add(item.id);
    });
  };
  dup(doc.swatches, 'nuance', 'swatches');
  dup(doc.layers, 'calque', 'layers');
  dup(doc.pages, 'page', 'pages');
  dup(doc.assets, 'image', 'assets');
  if (doc.shapes) dup(doc.shapes, 'forme', 'shapes');

  const claim = (childId: string, parent: string, at: string) => {
    if (!doc.objects[childId]) errors.push({ path: at, message: `objet inconnu : ${childId}` });
    else if (parents.has(childId)) errors.push({ path: at, message: `objet ${childId} déjà rattaché à ${parents.get(childId)}` });
    else parents.set(childId, parent);
  };

  doc.pages.forEach((page, p) => {
    if (!faceIds.has(page.faceId)) errors.push({ path: `pages.${p}.faceId`, message: `face inconnue : ${page.faceId}` });
    page.children.forEach((childId, i) => claim(childId, `page ${page.id}`, `pages.${p}.children.${i}`));
  });

  // Pages types (tâche 4.11) : identifiants distincts de ceux des pages, face connue, références valides.
  const masterIds = new Set((doc.masters ?? []).map((m) => m.id));
  if (doc.masters) dup(doc.masters, 'page type', 'masters');
  doc.masters?.forEach((master, m) => {
    if (doc.pages.some((p) => p.id === master.id)) errors.push({ path: `masters.${m}.id`, message: `identifiant déjà pris par une page : ${master.id}` });
    if (!faceIds.has(master.faceId)) errors.push({ path: `masters.${m}.faceId`, message: `face inconnue : ${master.faceId}` });
    master.children.forEach((childId, i) => claim(childId, `page type ${master.id}`, `masters.${m}.children.${i}`));
  });
  doc.pages.forEach((page, p) => {
    if (page.masterId && !masterIds.has(page.masterId)) errors.push({ path: `pages.${p}.masterId`, message: `page type inconnue : ${page.masterId}` });
  });

  const refColor = (ref: { swatch: string } | undefined, at: string) => {
    if (ref && !swatchIds.has(ref.swatch)) errors.push({ path: `${at}.swatch`, message: `nuance inconnue : ${ref.swatch}` });
  };
  // Un tracé que le rendu ne sait pas lire (arc, commande inconnue) ferait planter la face entière :
  // il est refusé ici, avec son chemin exact, plutôt qu'à l'impression.
  const checkPath = (d: string, at: string) => {
    try {
      parsePath(d);
    } catch (error) {
      errors.push({ path: at, message: (error as Error).message });
    }
  };

  doc.shapes?.forEach((shape, i) => checkPath(shape.d, `shapes.${i}.d`));

  // Styles de texte (tâche 2.21) : identifiants uniques, nuances connues.
  dup(doc.styles.paragraph, 'style de paragraphe', 'styles.paragraph');
  dup(doc.styles.character, 'style de caractère', 'styles.character');
  const paragraphStyleIds = new Set(doc.styles.paragraph.map((s) => s.id));
  const characterStyleIds = new Set(doc.styles.character.map((s) => s.id));
  doc.styles.paragraph.forEach((style, i) => refColor(style.style.color, `styles.paragraph.${i}.style.color`));
  doc.styles.character.forEach((style, i) => refColor(style.style.color, `styles.character.${i}.style.color`));

  const chainPrev = new Map<string, string>();
  for (const [key, obj] of Object.entries(doc.objects)) {
    const at = `objects.${key}`;
    if (obj.id !== key) errors.push({ path: `${at}.id`, message: `l'identifiant ${obj.id} ne correspond pas à sa clé ${key}` });
    if (!layerIds.has(obj.layerId)) errors.push({ path: `${at}.layerId`, message: `calque inconnu : ${obj.layerId}` });
    switch (obj.type) {
      case 'text':
        refColor(obj.style.color, `${at}.style.color`);
        obj.paragraphs.forEach((para, p) => para.runs.forEach((run, r) => refColor(run.color, `${at}.paragraphs.${p}.runs.${r}.color`)));
        if (obj.paragraphStyleId && !paragraphStyleIds.has(obj.paragraphStyleId)) {
          errors.push({ path: `${at}.paragraphStyleId`, message: `style de paragraphe inconnu : ${obj.paragraphStyleId}` });
        }
        if (obj.nextId !== undefined) {
          // Chaînage (tâche 4.12) : vers un autre bloc texte, un seul prédécesseur, sans boucle.
          const next = doc.objects[obj.nextId];
          if (obj.nextId === key) errors.push({ path: `${at}.nextId`, message: 'un bloc ne peut pas se chaîner à lui-même' });
          else if (next?.type !== 'text') errors.push({ path: `${at}.nextId`, message: `bloc suivant inconnu ou qui n'est pas un texte : ${obj.nextId}` });
          else if (chainPrev.has(obj.nextId)) errors.push({ path: `${at}.nextId`, message: `le bloc ${obj.nextId} suit déjà ${chainPrev.get(obj.nextId)}` });
          else chainPrev.set(obj.nextId, key);
        }
        obj.paragraphs.forEach((para, p) =>
          para.runs.forEach((run, r) => {
            if (run.characterStyleId && !characterStyleIds.has(run.characterStyleId)) {
              errors.push({ path: `${at}.paragraphs.${p}.runs.${r}.characterStyleId`, message: `style de caractère inconnu : ${run.characterStyleId}` });
            }
          }),
        );
        break;
      case 'rect':
      case 'ellipse':
        refColor(obj.fill, `${at}.fill`);
        refColor(obj.stroke?.color, `${at}.stroke.color`);
        break;
      case 'path':
        refColor(obj.fill, `${at}.fill`);
        refColor(obj.stroke?.color, `${at}.stroke.color`);
        checkPath(obj.d, `${at}.d`);
        break;
      case 'line':
        refColor(obj.stroke.color, `${at}.stroke.color`);
        break;
      case 'frame':
        refColor(obj.fill, `${at}.fill`);
        refColor(obj.stroke?.color, `${at}.stroke.color`);
        if (obj.image && !assetIds.has(obj.image.assetId)) errors.push({ path: `${at}.image.assetId`, message: `image inconnue : ${obj.image.assetId}` });
        if (obj.shape.kind === 'path') checkPath(obj.shape.d, `${at}.shape.d`);
        break;
      case 'icon':
        refColor(obj.color, `${at}.color`);
        break;
      case 'svg':
        refColor(obj.color, `${at}.color`);
        break;
      case 'qr':
        refColor(obj.color, `${at}.color`);
        refColor(obj.background, `${at}.background`);
        // Une adresse trop longue pour un QR au niveau de correction choisi ne peut pas être dessinée.
        try {
          createQr(obj.url, { errorCorrectionLevel: obj.ecc });
        } catch (error) {
          errors.push({ path: `${at}.url`, message: `QR code impossible au niveau ${obj.ecc} : ${(error as Error).message}` });
        }
        break;
      case 'group':
        obj.children.forEach((childId, i) => {
          claim(childId, `groupe ${key}`, `${at}.children.${i}`);
          const child = doc.objects[childId];
          if (child && child.layerId !== obj.layerId) {
            errors.push({ path: `${at}.children.${i}`, message: `l'enfant ${childId} n'est pas sur le calque du groupe (${obj.layerId})` });
          }
        });
        break;
    }
  }

  // Chaîne qui se referme sur elle-même : aucun bloc n'en serait le premier, le texte n'aurait pas de source.
  for (const start of chainPrev.keys()) {
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      cur = chainPrev.get(cur);
    }
    if (cur === start) {
      errors.push({ path: `objects.${start}.nextId`, message: 'chaînage en boucle' });
      break;
    }
  }

  // Accessible depuis une page : attrape aussi bien les orphelins que les groupes qui se contiennent en boucle.
  const reachable = new Set<string>();
  const visit = (objId: string) => {
    if (reachable.has(objId) || !doc.objects[objId]) return;
    reachable.add(objId);
    const obj = doc.objects[objId];
    if (obj.type === 'group') obj.children.forEach(visit);
  };
  doc.pages.forEach((page) => page.children.forEach(visit));
  doc.masters?.forEach((master) => master.children.forEach(visit));
  for (const key of Object.keys(doc.objects)) {
    if (!reachable.has(key)) errors.push({ path: `objects.${key}`, message: `objet inaccessible depuis une page (orphelin ou groupe en boucle)` });
  }
  return errors;
}
