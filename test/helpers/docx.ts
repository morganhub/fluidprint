// Fichiers Word (.docx) fabriqués dans le code, pour les tests de l'import Word : un écrivain zip minimal
// (en-têtes locaux, répertoire central, fin de répertoire ; CRC32 calculé à la main) et un petit document
// Word complet (styles, numérotation, relations, image).
import { deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Archive zip : entrées compressées (8) par défaut, ou stockées telles quelles (0). */
export function makeZip(files: Record<string, string | Buffer>, { method = 8 }: { method?: 0 | 8 } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const names = Object.keys(files);
  for (const name of names) {
    const content = files[name];
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12); // 1er janvier 1980
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);

    parts.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// ---------------------------------------------------------------- document Word

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS = [
  `xmlns:w="${W}"`,
  `xmlns:r="${REL}"`,
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
].join(' ');
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `${XML_DECL}<Relationships xmlns="${PKG}">
  <Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** Styles d'un Word français récent : noms internes anglais, identifiants localisés (« Titre1 »). */
export const STYLES_XML = `${XML_DECL}<w:styles xmlns:w="${W}">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Titre"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:color w:val="2F5496"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Citation"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Paragraphedeliste"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="character" w:styleId="Lienhypertexte"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="lev"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`;

export const NUMBERING_XML = `${XML_DECL}<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
</w:numbering>`;

const DOC_RELS = `${XML_DECL}<Relationships xmlns="${PKG}">
  <Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>
  <Relationship Id="rId3" Type="${REL}/hyperlink" Target="https://example.com/atelier?a=1&amp;b=2" TargetMode="External"/>
  <Relationship Id="rId4" Type="${REL}/image" Target="media/image1.png"/>
</Relationships>`;

export const t = (text: string) => `<w:t xml:space="preserve">${text}</w:t>`;
export const r = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${t(text)}</w:r>`;
export const p = (content: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
export const pStyle = (id: string) => `<w:pStyle w:val="${id}"/>`;
export const numPr = (numId: number, ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
export const tc = (content: string) => `<w:tc>${p(content)}</w:tc>`;
export const tr = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;
export const tbl = (...rows: string[]) => `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>${rows.join('')}</w:tbl>`;
export const documentXml = (body: string) => `${XML_DECL}<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;

/** Image incorporée (relation rId4 → word/media/image1.png). */
export const IMAGE_RUN = `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="635000"/><wp:docPr id="1" name="Image 1" descr="Atelier en plein air"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
<pic:blipFill><a:blip r:embed="rId4"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

/**
 * Corps du document d'essai : titre, titres 1 et 2, corps en gras / italique / souligné, retour à la ligne,
 * liste à puces sur deux niveaux, liste numérotée sur deux niveaux (et une seconde liste qui repart à 1),
 * citation, tableau, lien, image.
 */
export const SAMPLE_BODY = [
  p(r('Guide de l’atelier'), pStyle('Titre')),
  p(r('Présentation'), pStyle('Titre1')),
  p(
    [
      r('Un texte avec du '),
      r('gras', '<w:b/>'),
      r(', de l\'italique', '<w:i/>'),
      r(' et du '),
      r('souligné', '<w:u w:val="single"/>'),
      r(' ; puis un mot '),
      r('fort', '<w:rStyle w:val="lev"/>'),
      r('.'),
    ].join(''),
  ),
  p(`${r('Première ligne')}<w:r><w:br/></w:r>${r('seconde ligne')}`),
  p(r('Les outils'), pStyle('Titre2')),
  p(r('Scies'), pStyle('Paragraphedeliste') + numPr(1, 0)),
  p(r('Scie à chantourner'), pStyle('Paragraphedeliste') + numPr(1, 1)),
  p(r('Rabots'), pStyle('Paragraphedeliste') + numPr(1, 0)),
  p(r('Préparer le bois'), pStyle('Paragraphedeliste') + numPr(2, 0)),
  p(r('Mesurer'), pStyle('Paragraphedeliste') + numPr(2, 1)),
  p(r('Tracer'), pStyle('Paragraphedeliste') + numPr(2, 1)),
  p(r('Couper'), pStyle('Paragraphedeliste') + numPr(2, 0)),
  p(r('Nouvelle liste'), pStyle('Paragraphedeliste') + numPr(3, 0)),
  p(r('« Le bois se travaille avec patience. »'), pStyle('Citation')),
  tbl(tr(tc(r('Outil')), tc(r('Prix')), tc(r('Niveau'))), tr(tc(r('Scie')), tc(r('25 €')), tc(r('facile', '<w:b/>')))),
  p(`${r('Inscriptions sur ')}<w:hyperlink r:id="rId3"><w:r><w:rPr><w:rStyle w:val="Lienhypertexte"/></w:rPr>${t('notre site')}</w:r></w:hyperlink>${r('.')}`),
  p(IMAGE_RUN),
  p(r('Fin du guide.', '<w:color w:val="FF0000"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>')),
].join('\n');

/** Fichiers d'un .docx complet (le corps et l'image sont remplaçables). */
export function docxFiles(body = SAMPLE_BODY, image?: Buffer): Record<string, string | Buffer> {
  return {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'word/document.xml': documentXml(body),
    'word/styles.xml': STYLES_XML,
    'word/numbering.xml': NUMBERING_XML,
    'word/_rels/document.xml.rels': DOC_RELS,
    ...(image ? { 'word/media/image1.png': image } : {}),
  };
}

/** Un .docx complet. */
export const makeDocx = (body = SAMPLE_BODY, image?: Buffer): Buffer => makeZip(docxFiles(body, image));

/** Texte courant long (paragraphes de corps), pour remplir plusieurs volets. */
export function longBody(paragraphs: number, heading = 'Chapitre'): string {
  const sentence =
    'Chaque séance part de vos usages réels : on installe, on règle et on pratique ensemble, à votre rythme, avec des fiches claires et un contact direct. ';
  const out: string[] = [];
  for (let i = 1; i <= paragraphs; i++) {
    if (i % 6 === 1) out.push(p(r(`${heading} ${Math.ceil(i / 6)}`), pStyle('Titre1')));
    out.push(p(r(`${i}. ${sentence.repeat(3).trim()}`)));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- fichiers refusés

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Conteneur OLE (Word 97-2003) ; `encrypted` : celui d'un .docx protégé par mot de passe (flux EncryptedPackage). */
export function oleFile({ encrypted = false }: { encrypted?: boolean } = {}): Buffer {
  const body = Buffer.alloc(1024);
  if (encrypted) Buffer.from('EncryptedPackage', 'utf16le').copy(body, 200);
  else Buffer.from('WordDocument', 'utf16le').copy(body, 200);
  return Buffer.concat([OLE_SIGNATURE, body]);
}

/**
 * « Bombe de décompression » : un word/document.xml qui se décompresse en `bytes` octets (des espaces),
 * alors que l'archive ne pèse que quelques dizaines de kilo-octets.
 */
export function zipBomb(bytes: number): Buffer {
  return makeZip({ ...docxFiles(), 'word/document.xml': Buffer.alloc(bytes, 0x20) });
}
