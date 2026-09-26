// Lecture et retouche minimales d'un PDF produit par Chrome (Skia) : une seule table xref classique,
// aucun flux d'objets. C'est tout ce qu'il faut pour poser les boîtes de page (MediaBox, BleedBox,
// TrimBox) sans dépendre de Python ; une autre forme de fichier est refusée clairement plutôt que
// réécrite de travers.

export interface PdfObjectSpan {
  num: number;
  /** Octets de l'objet, de « N G obj » jusqu'au début de l'objet suivant (ou de la table xref). */
  start: number;
  end: number;
}

export interface PdfStructure {
  /** Objets en usage, dans l'ordre du fichier. */
  objects: PdfObjectSpan[];
  /** Dictionnaire du trailer, tel qu'écrit (« << … >> »). */
  trailer: string;
  /** Nombre d'entrées de la table xref (/Size). */
  size: number;
  xrefOffset: number;
}

const latin1 = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');

export function readPdfStructure(pdf: Uint8Array): PdfStructure {
  const text = latin1(pdf);
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!tail) throw new Error('PDF sans « startxref » final : fichier tronqué ?');
  const xrefOffset = Number(tail[1]);
  if (!text.startsWith('xref', xrefOffset)) throw new Error('PDF à table xref compressée : forme non prise en charge');

  const offsets = new Map<number, number>();
  const section = /\s*(\d+)\s+(\d+)[ \t]*\r?\n/y;
  const entry = /(\d{10}) (\d{5}) ([nf])[ \t\r\n]{1,2}/y;
  let pos = xrefOffset + 4;
  for (;;) {
    section.lastIndex = pos;
    const head = section.exec(text);
    if (!head) break;
    const [first, count] = [Number(head[1]), Number(head[2])];
    pos = section.lastIndex;
    for (let i = 0; i < count; i++) {
      entry.lastIndex = pos;
      const e = entry.exec(text);
      if (!e) throw new Error(`Table xref illisible à l'octet ${pos}`);
      pos = entry.lastIndex;
      if (e[3] === 'n') offsets.set(first + i, Number(e[1]));
    }
  }
  const trailerAt = text.indexOf('trailer', pos);
  const startxrefAt = text.lastIndexOf('startxref');
  if (trailerAt < 0 || trailerAt > startxrefAt) throw new Error('PDF sans trailer');
  const trailer = text.slice(trailerAt + 'trailer'.length, startxrefAt).trim();
  if (/\/Prev\b/.test(trailer)) throw new Error('PDF à mises à jour incrémentales : forme non prise en charge');
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)?.[1]);
  if (!Number.isInteger(size)) throw new Error('Trailer sans /Size');

  const sorted = [...offsets].sort((a, b) => a[1] - b[1]);
  const objects = sorted.map(([num, start], i) => {
    if (!text.startsWith(`${num} `, start)) throw new Error(`Objet ${num} absent à l'octet ${start} annoncé par la table xref`);
    return { num, start, end: i + 1 < sorted.length ? sorted[i + 1][1] : xrefOffset };
  });
  return { objects, trailer, size, xrefOffset };
}

/** Texte (latin1) d'un objet, sans son flux éventuel s'il est trop long : suffit pour lire un dictionnaire. */
export function objectText(pdf: Uint8Array, span: PdfObjectSpan): string {
  return latin1(pdf.subarray(span.start, span.end));
}

const isPageObject = (body: string) => /\/Type\s*\/Page(?![A-Za-z])/.test(body);

/** Numéros des objets page, dans l'ordre des /Kids de l'arbre des pages (un seul niveau, comme Chrome l'écrit). */
export function pageObjectNumbers(pdf: Uint8Array, structure = readPdfStructure(pdf)): number[] {
  const byNum = new Map(structure.objects.map((o) => [o.num, o]));
  const pages = structure.objects.map((o) => objectText(pdf, o)).find((body) => /\/Type\s*\/Pages\b/.test(body));
  const kids = pages && /\/Kids\s*\[([^\]]*)\]/.exec(pages)?.[1];
  if (!kids) throw new Error('Arbre des pages introuvable');
  const nums = [...kids.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
  for (const num of nums) {
    const span = byNum.get(num);
    if (!span || !isPageObject(objectText(pdf, span))) throw new Error(`Page ${num} : objet page attendu (arbre des pages imbriqué ?)`);
  }
  return nums;
}

/**
 * Réécrit le PDF en remplaçant le texte de certains objets (sans flux), puis refait la table xref.
 * Les autres objets sont recopiés octet pour octet.
 */
export function rewritePdfObjects(pdf: Uint8Array, edits: Map<number, (body: string) => string>, structure = readPdfStructure(pdf)): Buffer {
  const parts: Buffer[] = [];
  const first = structure.objects[0]?.start ?? structure.xrefOffset;
  parts.push(Buffer.from(pdf.subarray(0, first)));
  let offset = first;
  const newOffsets = new Map<number, number>();
  for (const span of structure.objects) {
    const edit = edits.get(span.num);
    const chunk = edit ? Buffer.from(edit(objectText(pdf, span)), 'latin1') : Buffer.from(pdf.subarray(span.start, span.end));
    if (edit && /\bstream\b/.test(objectText(pdf, span))) throw new Error(`Objet ${span.num} : un objet à flux ne se retouche pas ainsi`);
    newOffsets.set(span.num, offset);
    parts.push(chunk);
    offset += chunk.length;
  }
  const rows = ['xref', `0 ${structure.size}`];
  for (let num = 0; num < structure.size; num++) {
    const at = newOffsets.get(num);
    // Entrées libres toutes chaînées vers 0 : aucun lecteur ne s'en sert pour un fichier neuf.
    rows.push(at === undefined ? '0000000000 65535 f ' : `${String(at).padStart(10, '0')} 00000 n `);
  }
  parts.push(Buffer.from(`${rows.join('\n')}\ntrailer\n${structure.trailer}\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** Rectangle PDF [x0 y0 x1 y1], en points. */
export type PdfBox = [number, number, number, number];

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const boxText = (box: PdfBox) => `[${box.map(fmt).join(' ')}]`;

export function readBox(body: string, name: 'MediaBox' | 'CropBox' | 'BleedBox' | 'TrimBox'): PdfBox | undefined {
  const m = new RegExp(`/${name}\\s*\\[([^\\]]+)\\]`).exec(body);
  return m ? (m[1].trim().split(/\s+/).map(Number) as PdfBox) : undefined;
}

/**
 * Pose les boîtes de chaque page. `boxes` reçoit la MediaBox écrite par Chrome et renvoie les boîtes
 * voulues ; les boîtes absentes du résultat ne sont pas écrites (une ancienne est retirée).
 */
export function setPageBoxes(pdf: Uint8Array, boxes: (chromeMediaBox: PdfBox, pageIndex: number) => { media: PdfBox; bleed?: PdfBox; trim?: PdfBox }): Buffer {
  const structure = readPdfStructure(pdf);
  const pages = pageObjectNumbers(pdf, structure);
  const edits = new Map<number, (body: string) => string>();
  pages.forEach((num, index) =>
    edits.set(num, (body) => {
      const chrome = readBox(body, 'MediaBox');
      if (!chrome) throw new Error(`Page ${index + 1} sans MediaBox`);
      const wanted = boxes(chrome, index);
      const cleaned = body.replace(/\/(?:MediaBox|CropBox|BleedBox|TrimBox|ArtBox)\s*\[[^\]]*\]\s*/g, '');
      const extra = [`/MediaBox ${boxText(wanted.media)}`];
      if (wanted.bleed) extra.push(`/BleedBox ${boxText(wanted.bleed)}`);
      if (wanted.trim) extra.push(`/TrimBox ${boxText(wanted.trim)}`);
      // Les boîtes s'ajoutent en tête du dictionnaire de la page : « N 0 obj\n<<… ».
      const open = cleaned.indexOf('<<');
      if (open < 0) throw new Error(`Page ${index + 1} : dictionnaire introuvable`);
      return `${cleaned.slice(0, open + 2)}${extra.join('\n')}\n${cleaned.slice(open + 2)}`;
    }),
  );
  return rewritePdfObjects(pdf, edits, structure);
}
