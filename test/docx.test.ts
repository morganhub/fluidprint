// Lecteur .docx (server/docx) : structure lue d'un document Word fabriqué dans le code, et refus clairs.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DocxError } from '../server/docx/errors';
import { readDocx } from '../server/docx/read';
import { openZip } from '../server/docx/zip';
import type { WordParagraph, WordTable, WordText } from '../src/word/types';
import { crc32, documentXml, docxFiles, IMAGE_RUN, makeDocx, makeZip, oleFile, p, pStyle, r, zipBomb } from './helpers/docx';

const PNG = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#3a7a4a' } }).png().toBuffer();

const paragraphs = (blocks: { type: string }[]) => blocks.filter((b): b is WordParagraph => b.type === 'paragraph');
const textOf = (para: WordParagraph) => para.content.map((c) => (c.type === 'text' ? c.text : `[${c.image}]`)).join('');

/** Refus attendu : une DocxError de ce code, au message donné. */
function refusal(input: Buffer, options: Parameters<typeof readDocx>[1] = {}): DocxError {
  try {
    readDocx(input, { label: 'essai.docx', ...options });
  } catch (error) {
    if (error instanceof DocxError) return error;
    throw error;
  }
  throw new Error('fichier accepté');
}

describe('lecteur .docx : structure', () => {
  it('le CRC32 de l’écrivain zip des tests est juste', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('titres, corps, gras / italique / souligné, retours, listes imbriquées, tableau, lien, image, polices et couleurs', () => {
    const { document, media } = readDocx(makeDocx(undefined, PNG), { label: 'guide.docx' });
    const paras = paragraphs(document.blocks);

    // Titre du document et titres : style Word (identifiant et nom interne), niveau.
    expect(paras[0]).toMatchObject({ styleId: 'Titre', styleName: 'Title', title: true });
    expect(paras[1]).toMatchObject({ styleId: 'Titre1', styleName: 'heading 1', heading: 1 });
    expect(textOf(paras[1])).toBe('Présentation');
    const h2 = paras.find((x) => textOf(x) === 'Les outils')!;
    expect(h2).toMatchObject({ styleName: 'heading 2', heading: 2 });

    // Corps : paragraphe « Normal » (style par défaut), mise en forme directe et style de caractère.
    const body = paras[2];
    expect(body).toMatchObject({ styleId: 'Normal', styleName: 'Normal' });
    const texts = body.content as WordText[];
    expect(texts.find((x) => x.text === 'gras')).toMatchObject({ bold: true });
    expect(texts.find((x) => x.text.includes('italique'))).toMatchObject({ italic: true });
    expect(texts.find((x) => x.text === 'souligné')).toMatchObject({ underline: true });
    expect(texts.find((x) => x.text === 'fort')).toMatchObject({ bold: true });
    expect(texts.find((x) => x.text === ' et du ')?.bold).toBeUndefined();
    expect(textOf(paras[3])).toBe('Première ligne\nseconde ligne');

    // Listes : puce ou numéro, niveau, numéro de Word (les sous-niveaux repartent, une liste neuve aussi).
    const list = (text: string) => paras.find((x) => textOf(x) === text)!.list;
    expect(list('Scies')).toEqual({ kind: 'bullet', level: 0, marker: '•' });
    expect(list('Scie à chantourner')).toEqual({ kind: 'bullet', level: 1, marker: '•' });
    expect(list('Préparer le bois')).toMatchObject({ kind: 'number', level: 0, number: 1, format: 'decimal', marker: '1.' });
    expect(list('Mesurer')).toMatchObject({ kind: 'number', level: 1, number: 1, format: 'lowerLetter', marker: 'a)' });
    expect(list('Tracer')).toMatchObject({ number: 2, marker: 'b)' });
    expect(list('Couper')).toMatchObject({ number: 2, marker: '2.' });
    expect(list('Nouvelle liste')).toMatchObject({ number: 1, marker: '1.' });
    expect(paras.find((x) => textOf(x) === 'Scies')).toMatchObject({ styleName: 'List Paragraph' });

    // Citation : alignement du style Word.
    expect(paras.find((x) => x.styleName === 'Quote')).toMatchObject({ align: 'center' });

    // Tableau : lignes et cellules.
    const table = document.blocks.find((b): b is WordTable => b.type === 'table')!;
    expect(table.index).toBe(1);
    expect(table.rows.map((row) => row.map((cell) => cell.paragraphs.map(textOf).join(' ')))).toEqual([
      ['Outil', 'Prix', 'Niveau'],
      ['Scie', '25 €', 'facile'],
    ]);

    // Lien : texte gardé, adresse sur les segments ; le soulignement du style « Lien hypertexte » ne compte pas.
    const linkPara = paras.find((x) => textOf(x).startsWith('Inscriptions'))!;
    const link = (linkPara.content as WordText[]).find((x) => x.link);
    expect(link).toMatchObject({ text: 'notre site', link: 'https://example.com/atelier?a=1&b=2' });
    expect(link?.underline).toBeUndefined();

    // Image : à sa place dans le flux, fichier lu dans l'archive.
    const imagePara = paras.find((x) => x.content.some((c) => c.type === 'image'))!;
    expect(imagePara.content).toEqual([{ type: 'image', image: 'img1' }]);
    expect(document.images).toEqual([{ id: 'img1', part: 'word/media/image1.png', name: 'image1.png', alt: 'Atelier en plein air' }]);
    expect(media).toHaveLength(1);
    expect(media[0].bytes.equals(PNG)).toBe(true);

    // Styles employés, polices et couleurs relevées (pour le rapport), aucun avertissement de lecture.
    expect(document.styles.Titre1).toEqual({ id: 'Titre1', name: 'heading 1', heading: 1 });
    expect(document.styles.Citation).toMatchObject({ name: 'Quote', italic: true });
    expect(document.fonts).toEqual(['Arial', 'Calibri']);
    expect(document.colors).toEqual(expect.arrayContaining(['#ff0000', '#2f5496', '#0563c1']));
    expect(document.warnings).toEqual([]);
  });

  it('champs, texte masqué, suivi des modifications, notes, tableau fusionné, préfixes d’espace de noms inhabituels', () => {
    const body = [
      p(`${r('Version ')}<w:del w:id="1" w:author="X"><w:r><w:delText>ancienne</w:delText></w:r></w:del><w:ins w:id="2" w:author="X">${r('revue')}</w:ins>`),
      p(`${r('visible')}${r(' caché', '<w:vanish/>')}<w:r><w:footnoteReference w:id="1"/></w:r>`),
      p(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('Entrée du sommaire')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`),
      p(`${r('Voir ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.org/page" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('la page')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`),
      `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p(r('Large'))}</w:tc><w:tc>${p(r('C'))}</w:tc></w:tr></w:tbl>`,
    ].join('');
    const { document } = readDocx(makeZip({ ...docxFiles(body) }));
    const paras = paragraphs(document.blocks);
    expect(paras.map(textOf)).toEqual(['Version revue', 'visible', 'Voir la page']);
    expect((paras[2].content as WordText[]).find((x) => x.link)).toMatchObject({ text: 'la page', link: 'https://example.org/page' });
    const table = document.blocks.find((b): b is WordTable => b.type === 'table')!;
    expect(table.rows[0].map((c) => c.paragraphs.map(textOf).join(''))).toEqual(['Large', '', 'C']);
    expect(document.warnings).toEqual([expect.stringMatching(/Tableau 1 : cellules fusionnées/), expect.stringMatching(/1 appel\(s\) de note/)]);

    const ns0 = `<ns0:document xmlns:ns0="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><ns0:body><ns0:p><ns0:r><ns0:t>Réécrit par un outil tiers</ns0:t></ns0:r></ns0:p></ns0:body></ns0:document>`;
    const rewritten = readDocx(makeZip({ 'word/document.xml': ns0 }, { method: 0 }));
    expect(paragraphs(rewritten.document.blocks).map(textOf)).toEqual(['Réécrit par un outil tiers']);
  });

  it('image dans un format que l’éditeur n’affiche pas : lue quand même (le serveur la signale)', () => {
    const { document, media } = readDocx(makeZip({ ...docxFiles(p(IMAGE_RUN)), 'word/media/image1.png': Buffer.from('pas une image') }));
    expect(document.images).toHaveLength(1);
    expect(media[0].bytes.toString()).toBe('pas une image');
    // Image référencée mais absente de l'archive : signalée, pas d'échec.
    const missing = readDocx(makeZip(docxFiles(p(IMAGE_RUN))));
    expect(missing.media).toEqual([]);
    expect(missing.document.warnings).toEqual([expect.stringMatching(/image1\.png.*non importée/)]);
  });
});

describe('lecteur .docx : refus clairs', () => {
  it('.doc (Word 97-2003) et .docx protégé par mot de passe', () => {
    const doc = refusal(oleFile());
    expect(doc.code).toBe('legacy-doc');
    expect(doc.message).toMatch(/« essai\.docx » est un document Word 97-2003 \(\.doc\).*enregistrez-le au format \.docx/);
    const encrypted = refusal(oleFile({ encrypted: true }));
    expect(encrypted.code).toBe('encrypted');
    expect(encrypted.message).toMatch(/protégé par un mot de passe/);
  });

  it('fichier qui n’est pas un zip, zip tronqué, zip qui n’est pas un Word, fichier vide', () => {
    expect(refusal(Buffer.from('ceci n’est pas un zip'))).toMatchObject({ code: 'not-zip', message: expect.stringMatching(/n'est pas un fichier \.docx lisible/) });
    expect(refusal(makeDocx().subarray(0, 300)).code).toMatch(/not-zip|corrupt/);
    expect(refusal(makeZip({ 'lisez-moi.txt': 'bonjour' }))).toMatchObject({ code: 'not-word', message: expect.stringMatching(/pas un document Word : word\/document\.xml est absent/) });
    expect(refusal(Buffer.alloc(0)).code).toBe('empty');
  });

  it('bombe de décompression : refusée sans tout décompresser', () => {
    const bomb = zipBomb(3 * 1024 * 1024);
    // L'archive est minuscule, son contenu énorme.
    expect(bomb.length).toBeLessThan(40_000);
    const error = refusal(bomb, { limits: { inputBytes: 10 * 1024 * 1024, entryBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 } });
    expect(error.code).toBe('too-large');
    expect(error.message).toMatch(/word\/document\.xml dépasse les limites de décompression.*bombe de décompression/);
    // Plafond de l'archive entière : plusieurs entrées moyennes.
    const many = makeZip({ ...docxFiles(p(r('x')).repeat(1)), 'word/styles.xml': Buffer.alloc(900 * 1024, 0x20), 'word/numbering.xml': Buffer.alloc(900 * 1024, 0x20) });
    expect(refusal(many, { limits: { inputBytes: 10 * 1024 * 1024, entryBytes: 1024 * 1024, totalBytes: 1024 * 1024 } }).code).toBe('too-large');
    // Le fichier lui-même trop lourd.
    expect(refusal(makeDocx(), { limits: { inputBytes: 100, entryBytes: 1024, totalBytes: 1024 } }).code).toBe('too-large');
    // Les limites par défaut s'appliquent à la lecture d'une entrée.
    expect(() => openZip(bomb, { inputBytes: 1e9, entryBytes: 1024, totalBytes: 1e9 }).read('word/document.xml')).toThrow(/entrée de plus de/);
  });

  it('document.xml sans rien d’exploitable : document vide, avertissement', () => {
    const { document } = readDocx(makeZip({ ...docxFiles(), 'word/document.xml': documentXml('') }));
    expect(document.blocks).toEqual([]);
    const empty = readDocx(makeZip({ ...docxFiles(), 'word/document.xml': '<rien/>' }));
    expect(empty.document.warnings).toEqual([expect.stringMatching(/pas de w:body/)]);
    expect(p(r('x'), pStyle('Normal'))).toContain('Normal');
  });
});
