// Lecture d'un PDF de Chrome pour les tests : boîtes de page et aplats peints, en points, dans le repère
// de la page. Un petit interpréteur de flux de contenu suffit : Skia n'écrit que des chemins simples.
import { inflateSync } from 'node:zlib';
import { objectText, pageObjectNumbers, readBox, readPdfStructure, type PdfBox, type PdfObjectSpan } from '../../server/pdf';

type Matrix = [number, number, number, number, number, number];

export interface PaintedFill {
  /** Couleur de remplissage (composantes 0-1, RVB ou gris). */
  color: number[];
  /** Boîte englobante du chemin rempli, en points, repère de la page. */
  box: PdfBox;
}

export interface PdfPageInfo {
  mediaBox?: PdfBox;
  bleedBox?: PdfBox;
  trimBox?: PdfBox;
  cropBox?: PdfBox;
  fills: PaintedFill[];
  /** Rectangles de découpe (« re W n »), en points, repère de la page. */
  clips: PdfBox[];
}

const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function tokenize(content: string): string[] {
  // Chaînes et tableaux de texte ignorés : seuls les chemins et l'état graphique comptent ici.
  return content
    .replace(/\((?:\\.|[^\\)])*\)/g, ' ')
    .replace(/<[0-9a-fA-F\s]*>/g, ' ')
    .match(/\/[^\s/<>[\](){}%]+|[-+]?(?:\d*\.\d+|\d+\.?)|[A-Za-z'"*]+|<<|>>|\[|\]/g) ?? [];
}

export function readPdfPages(pdf: Buffer): PdfPageInfo[] {
  const structure = readPdfStructure(pdf);
  const byNum = new Map<number, PdfObjectSpan>(structure.objects.map((o) => [o.num, o]));
  const text = (num: number) => objectText(pdf, byNum.get(num)!);

  const streamOf = (num: number): string => {
    const span = byNum.get(num)!;
    const body = text(num);
    const dictEnd = body.indexOf('stream');
    const dict = body.slice(0, dictEnd);
    let length = Number(/\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1]);
    const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (indirect) length = Number(/obj\s*(\d+)/.exec(text(Number(indirect[1])))?.[1]);
    let start = span.start + dictEnd + 'stream'.length;
    if (pdf[start] === 0x0d) start++;
    if (pdf[start] === 0x0a) start++;
    const raw = pdf.subarray(start, start + length);
    return (/\/FlateDecode/.test(dict) ? inflateSync(raw) : raw).toString('latin1');
  };

  /** Dictionnaire des XObjects d'un objet (page ou forme), direct ou indirect. */
  const xobjects = (body: string): Map<string, number> => {
    const map = new Map<string, number>();
    let dict = /\/XObject\s*<<([^>]*)>>/.exec(body)?.[1];
    const ref = /\/XObject\s+(\d+)\s+\d+\s+R/.exec(body);
    if (!dict && ref) dict = /<<([\s\S]*)>>/.exec(text(Number(ref[1])))?.[1];
    for (const m of (dict ?? '').matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)) map.set(m[1], Number(m[2]));
    return map;
  };

  return pageObjectNumbers(pdf, structure).map((pageNum) => {
    const page = text(pageNum);
    const info: PdfPageInfo = {
      mediaBox: readBox(page, 'MediaBox'),
      bleedBox: readBox(page, 'BleedBox'),
      trimBox: readBox(page, 'TrimBox'),
      cropBox: readBox(page, 'CropBox'),
      fills: [],
      clips: [],
    };
    const contents = /\/Contents\s*(?:\[([^\]]*)\]|(\d+)\s+\d+\s+R)/.exec(page);
    const streams = contents?.[1] ? [...contents[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])) : [Number(contents?.[2])];

    const run = (content: string, resources: Map<string, number>, start: Matrix) => {
      let ctm: Matrix = start;
      let color: number[] = [0];
      const stack: { ctm: Matrix; color: number[] }[] = [];
      let path: [number, number][] = [];
      let rects: PdfBox[] = [];
      let args: string[] = [];
      const nums = () => args.map(Number);
      const pathBox = (): PdfBox | undefined => {
        if (!path.length) return undefined;
        const xs = path.map((p) => p[0]);
        const ys = path.map((p) => p[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      };
      for (const tok of tokenize(content)) {
        if (/^[-+.\d]/.test(tok) || tok.startsWith('/') || tok === '[' || tok === ']' || tok === '<<' || tok === '>>') {
          args.push(tok);
          continue;
        }
        const a = nums();
        switch (tok) {
          case 'q':
            stack.push({ ctm, color });
            break;
          case 'Q':
            ({ ctm, color } = stack.pop() ?? { ctm, color });
            break;
          case 'cm':
            ctm = multiply(a as Matrix, ctm);
            break;
          case 'rg':
          case 'g':
          case 'k':
          case 'sc':
          case 'scn':
            if (a.every(Number.isFinite)) color = a;
            break;
          case 're': {
            const [x, y, w, h] = a;
            const corners = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
            path.push(...corners);
            const xs = corners.map((p) => p[0]);
            const ys = corners.map((p) => p[1]);
            rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
            break;
          }
          case 'm':
          case 'l':
            path.push(apply(ctm, a[0], a[1]));
            break;
          case 'c':
            path.push(apply(ctm, a[0], a[1]), apply(ctm, a[2], a[3]), apply(ctm, a[4], a[5]));
            break;
          case 'v':
          case 'y':
            path.push(apply(ctm, a[0], a[1]), apply(ctm, a[2], a[3]));
            break;
          case 'f':
          case 'F':
          case 'f*':
          case 'B':
          case 'B*':
          case 'b':
          case 'b*': {
            const box = pathBox();
            if (box) info.fills.push({ color, box });
            path = [];
            rects = [];
            break;
          }
          case 'W':
          case 'W*':
            if (rects.length === 1) info.clips.push(rects[0]);
            break;
          case 'n':
          case 'S':
          case 's':
            path = [];
            rects = [];
            break;
          case 'Do': {
            const name = args[0]?.slice(1);
            const num = name ? resources.get(name) : undefined;
            if (num !== undefined && /\/Subtype\s*\/Form/.test(text(num).slice(0, 2000))) {
              const body = text(num);
              const matrix = /\/Matrix\s*\[([^\]]+)\]/.exec(body)?.[1].trim().split(/\s+/).map(Number) as Matrix | undefined;
              run(streamOf(num), xobjects(body.slice(0, body.indexOf('stream'))), multiply(matrix ?? [1, 0, 0, 1, 0, 0], ctm));
            }
            break;
          }
        }
        args = [];
      }
    };
    for (const num of streams) run(streamOf(num), xobjects(page), [1, 0, 0, 1, 0, 0]);
    return info;
  });
}
