// Analyseur XML maison, sans dépendance, qui construit un arbre léger { name, attrs, children, text }.
// Repris du lecteur .docx de fluidplan.
//
// Le texte d'un élément est la concaténation de ses nœuds texte directs : WordprocessingML ne mélange pas
// texte et balises dans un même élément (le texte vit dans w:t, w:instrText, m:t).
//
// Les préfixes habituels (w:, r:, a:…) sont une convention, pas une garantie : un fichier réécrit par un
// outil tiers peut écrire ns0:p. Chaque espace de noms connu est donc ramené à son préfixe canonique.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const CANONICAL_PREFIX = new Map<string, string>([
  ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'w'],
  ['http://purl.oclc.org/ooxml/wordprocessingml/main', 'w'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r'],
  ['http://purl.oclc.org/ooxml/officeDocument/relationships', 'r'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'a'],
  ['http://purl.oclc.org/ooxml/drawingml/main', 'a'],
  ['http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'wp'],
  ['http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing', 'wp'],
  ['http://schemas.openxmlformats.org/markup-compatibility/2006', 'mc'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/math', 'm'],
  ['http://purl.oclc.org/ooxml/officeDocument/math', 'm'],
  ['urn:schemas-microsoft-com:vml', 'v'],
  ['http://schemas.openxmlformats.org/package/2006/relationships', ''],
]);

type Namespaces = Record<string, string>;

const BASE_NAMESPACES: Namespaces = Object.assign(Object.create(null) as Namespaces, { xml: 'http://www.w3.org/XML/1998/namespace' });
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body) ?? match;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : match;
  });
}

const isNameChar = (c: number) => (c >= 48 && c <= 58) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 46 || c >= 0x80;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

function qualify(raw: string, ns: Namespaces, isAttribute: boolean): string {
  const colon = raw.indexOf(':');
  // Un attribut sans préfixe n'appartient à aucun espace de noms, même sous un xmlns par défaut.
  if (colon === -1 && isAttribute) return raw;
  const uri = ns[colon === -1 ? '' : raw.slice(0, colon)];
  const canonical = uri === undefined ? undefined : CANONICAL_PREFIX.get(uri);
  if (canonical === undefined) return raw;
  const local = colon === -1 ? raw : raw.slice(colon + 1);
  return canonical ? `${canonical}:${local}` : local;
}

/** Arbre d'un XML, au mieux : un XML abîmé est lu tel quel et `warn` reçoit un avertissement. */
export function parseXml(source: string | undefined, warn: (message: string) => void = () => {}): XmlNode {
  const src = String(source ?? '').replace(/^﻿/, '');
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: { node: XmlNode; raw: string; ns: Namespaces }[] = [{ node: root, raw: '', ns: BASE_NAMESPACES }];
  const n = src.length;
  const after = (index: number, length: number) => (index === -1 ? n : index + length);
  let anomalies = 0;
  let i = 0;

  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) top.node.text += decodeEntities(src.slice(i, textEnd));
    if (lt === -1) break;
    i = lt;
    const next = src.charCodeAt(i + 1);

    if (next === 33 /* ! */) {
      if (src.startsWith('<!--', i)) {
        i = after(src.indexOf('-->', i + 4), 3);
      } else if (src.startsWith('<![CDATA[', i)) {
        const close = src.indexOf(']]>', i + 9);
        top.node.text += src.slice(i + 9, close === -1 ? n : close);
        i = after(close, 3);
      } else {
        // <!DOCTYPE …> et semblables, avec un sous-ensemble interne facultatif entre crochets.
        let depth = 0;
        let j = i + 2;
        for (; j < n; j++) {
          const c = src[j];
          if (c === '[') depth++;
          else if (c === ']') depth--;
          else if (c === '>' && depth <= 0) break;
        }
        i = j + 1;
      }
      continue;
    }
    if (next === 63 /* ? */) {
      i = after(src.indexOf('?>', i + 2), 2);
      continue;
    }
    if (next === 47 /* / */) {
      const close = src.indexOf('>', i + 2);
      const raw = src.slice(i + 2, close === -1 ? n : close).trim();
      i = after(close, 1);
      let k = stack.length - 1;
      while (k > 0 && stack[k].raw !== raw) k--;
      if (k === 0) anomalies++;
      else {
        if (k !== stack.length - 1) anomalies++;
        stack.length = k;
      }
      continue;
    }

    let j = i + 1;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    if (j === i + 1) {
      top.node.text += '<';
      i++;
      continue;
    }
    const raw = src.slice(i + 1, j);
    const rawAttrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      if (j >= n) {
        anomalies++;
        break;
      }
      const c = src.charCodeAt(j);
      if (c === 62 /* > */) {
        j++;
        break;
      }
      if (c === 47 /* / */) {
        j++;
        if (src.charCodeAt(j) === 62) {
          selfClosing = true;
          j++;
          break;
        }
        continue;
      }
      let k = j;
      while (k < n && isNameChar(src.charCodeAt(k))) k++;
      if (k === j) {
        anomalies++;
        j++;
        continue;
      }
      const name = src.slice(j, k);
      j = k;
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      let value = '';
      if (src.charCodeAt(j) === 61 /* = */) {
        j++;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        const quote = src[j];
        if (quote === '"' || quote === "'") {
          const close = src.indexOf(quote, j + 1);
          value = src.slice(j + 1, close === -1 ? n : close);
          j = after(close, 1);
        } else {
          let e = j;
          while (e < n && !isSpace(src.charCodeAt(e)) && src.charCodeAt(e) !== 62) e++;
          value = src.slice(j, e);
          j = e;
        }
      }
      rawAttrs.push([name, decodeEntities(value)]);
    }
    i = j;

    let ns = top.ns;
    for (const [name, value] of rawAttrs) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
      if (ns === top.ns) ns = Object.assign(Object.create(null) as Namespaces, top.ns);
      ns[name === 'xmlns' ? '' : name.slice(6)] = value;
    }
    const attrs: Record<string, string> = {};
    for (const [name, value] of rawAttrs) attrs[name === 'xmlns' || name.startsWith('xmlns:') ? name : qualify(name, ns, true)] = value;
    const node: XmlNode = { name: qualify(raw, ns, false), attrs, children: [], text: '' };
    top.node.children.push(node);
    if (!selfClosing) stack.push({ node, raw, ns });
  }

  if (stack.length > 1) anomalies++;
  if (anomalies) warn(`XML irrégulier (${anomalies} anomalie(s) de balisage) : lu au mieux.`);
  return root;
}

/** Texte d'une partie XML (UTF-8, ou UTF-16 avec marque d'ordre des octets). */
export function decodeXml(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  return bytes.toString('utf8');
}

export const child = (node: XmlNode | undefined, name: string): XmlNode | undefined => node?.children.find((c) => c.name === name);
export const kids = (node: XmlNode | undefined, name: string): XmlNode[] => (node ? node.children.filter((c) => c.name === name) : []);
export const val = (node: XmlNode | undefined, attr = 'w:val'): string | undefined => node?.attrs[attr];

/** Premier descendant de ce nom, en profondeur d'abord. */
export function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return undefined;
}

/** Propriété « bascule » de WordprocessingML : présente sans valeur = vrai, val="0|false|off" = faux, absente = undefined. */
export function onOff(node: XmlNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const value = node.attrs['w:val'];
  return value === undefined || !/^(0|false|off|none)$/i.test(value);
}
