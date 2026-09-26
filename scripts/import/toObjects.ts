// Conversion de la mesure du design en objets du document (décision S2 : objets fins, regroupés par bloc).
//
// Chaque élément mesuré produit ses objets dans l'ordre de peinture du navigateur : son fond, ses
// bordures, puis son contenu. Un bloc composite (carte, étape, chiffre clé, appel à l'action…) devient
// un groupe nommé d'après son texte principal. Les aplats pleine largeur de volet vont sur le calque
// Fonds (décision E1) : ils sortent alors du groupe, qui ne peut porter que des objets de son calque.
// Le format (gabarit ou sur mesure) est choisi avant, par designFormat.ts : rien ici ne suppose un format.
import { faceSize, foldPositions, panelBounds, trimBox } from '../../src/model/format';
import { normalizePath, SHAPE_PRESETS } from '../../src/model/shapes';
import type {
  ColorRef,
  DocObject,
  DocumentFormat,
  FrameObject,
  GroupObject,
  Layer,
  LayoutDocument,
  Page,
  Paragraph,
  ShapeRef,
  TextAlign,
  TextObject,
  TextRun,
  TextStyle,
} from '../../src/model/types';
import { DOC_VERSION } from '../../src/model/types';
import { mmToPt, mmToPx, PX_PER_MM, pxToMm, pxToPt } from '../../src/model/units';
import { GUIDE_COLOR, parseColor, SwatchRegistry, toHex, type ColorUse, type SwatchUsage } from './colors';
import { SIZE_TOLERANCE_MM, type FormatOrigin, type ResolvedFormat } from './designFormat';
import { EDITOR_FONT_FAMILY } from './designPage';
import type { IconMatcher } from './icons';
import type { QrSettings } from './qr';
import type { MBox, MeasureResult, MFace, MNode, MParagraph, MRunStyle, MText } from './measure';

export const LAYERS: Layer[] = [
  { id: 'fonds', name: 'Fonds', visible: true, locked: true, printable: true, color: '#8a94a6' },
  { id: 'contenu', name: 'Contenu', visible: true, locked: false, printable: true, color: '#2563eb' },
  { id: 'reperes', name: 'Repères et notes', visible: true, locked: false, printable: false, color: GUIDE_COLOR },
];

/** Boîte de dessin de la goutte (SHAPE_PRESETS.goutte) : un graphique qui la reprend est nommé « Goutte ». */
const DROP_VIEWBOX = '0 0 100 130';
/** Adresse posée sur un QR code illisible, signalée dans le rapport pour être corrigée. */
export const PLACEHOLDER_QR_URL = 'https://example.com';

/**
 * Nom d'un graphique que le design désigne comme logo (« logo » dans son aria-label, son id ou sa classe),
 * sinon null. Le logo nomme son bloc (« Logo · … », « Coordonnées · … ») : aucun dessin n'est reconnu d'avance.
 */
export function logoName(attrs: Record<string, string>): string | null {
  const label = attrs['aria-label']?.replace(/\s+/g, ' ').trim();
  const marked = [label, attrs.id, attrs.class, attrs['data-name']].some((v) => !!v && /\blogo\b/i.test(v));
  if (!marked) return null;
  return label && /^logo\b/i.test(label) ? label : 'Logo';
}

const isLogo = (obj: DocObject) => obj.type === 'svg' && /^logo\b/i.test(obj.name ?? '');
/** Largeur ajoutée aux textes d'une ligne alignés à gauche : invisible, elle évite une coupure due à l'arrondi du moteur. */
const SINGLE_LINE_SLACK_MM = 0.2;

export interface ImportIssue {
  faceId: string;
  what: string;
  why: string;
}

export interface QrInfo {
  url: string | null;
  error?: string;
  /** Réglages qui redonnent exactement les modules du design (vide : aucun). */
  designSettings?: QrSettings[];
  /** Masque que `qrcode` choisit seul, par niveau de correction. */
  defaultMask?: Partial<Record<string, number>>;
  designMargin?: number;
}

export interface BuildInput {
  measure: MeasureResult;
  /** Format du document (gabarit ou sur mesure), sections rangées sur ses faces, et comment il a été choisi. */
  resolved: ResolvedFormat;
  /** Remarques de lecture du design (taille de page illisible, pli horizontal…). */
  designWarnings?: string[];
  /** Adresses décodées, par `imp` de l'élément svg du QR. */
  qr: Map<number, QrInfo>;
  icons: IconMatcher;
  id: string;
  name: string;
  sourcePath: string;
  importedAt: string;
}

export interface BuildResult {
  doc: LayoutDocument;
  /** Comment le format a été choisi, et quelle section imprime chaque face. */
  format: { origin: FormatOrigin; notes: string[]; faces: ResolvedFormat['faces'] };
  swatches: SwatchUsage[];
  skipped: ImportIssue[];
  warnings: ImportIssue[];
  unknownIcons: ImportIssue[];
  qrCodes: { id: string; faceId: string; url: string; decoded: boolean; box: MBox; info: QrInfo }[];
}

// ---------------------------------------------------------------- nombres

// 4 décimales en mm (0,1 µm) : le bruit de mesure reste, mais aucune précision utile n'est perdue.
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
// Largeur d'un texte : jamais arrondie vers le bas (0,01 mm de moins peut ajouter une ligne).
const ceil4 = (v: number) => Math.ceil(v * 1e4 - 1e-6) / 1e4;
const r4pt = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Position ou taille mesurée par Chrome, écrite pour que Chrome la retrouve à l'identique.
 * La mise en page de Chrome travaille en 1/64 px ; une valeur en mm reconvertie en px est tronquée à
 * ce pas. Arrondie au plus près à 4 décimales, elle retombe une fois sur deux sur le 1/64 px d'en
 * dessous, et le décalage suffit à faire changer de pixel la ligne de base d'un texte au rendu.
 * On vise donc un poil au-dessus de la valeur exacte (0,002 px, invisible).
 */
const LAYOUT_STEP_PX = 1 / 64;
const lu = (vMm: number): number => {
  const px = vMm * PX_PER_MM;
  const exact = Math.round(px / LAYOUT_STEP_PX) * LAYOUT_STEP_PX;
  // Zéro reste zéro (un trait horizontal doit garder h = 0). Hors grille (boîte transformée, calcul
  // dérivé) ou négatif (sens de la troncature incertain) : rien à retrouver, arrondi simple.
  if (exact === 0 && Math.abs(px) < 0.004) return 0;
  if (exact < 0 || Math.abs(px - exact) > 0.004) return r4(vMm);
  return Math.ceil(((exact + 0.002) / PX_PER_MM) * 1e4) / 1e4;
};

const union = (boxes: MBox[]): MBox => {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: lu(x0), y: lu(y0), w: lu(x1 - x0), h: lu(y1 - y0) };
};

const isTransparent = (color: string | undefined) => !color || (parseColor(color)?.a ?? 0) === 0;

// ---------------------------------------------------------------- texte

const normalizeAlign = (align: string): TextAlign => {
  if (/center/.test(align)) return 'center';
  if (/right|end/.test(align)) return 'right';
  if (/justify/.test(align)) return 'justify';
  return 'left';
};

const firstFamily = (family: string) => family.split(',')[0].trim().replace(/^["']|["']$/g, '') || 'Open Sans';

const emOf = (letterSpacingPx: number, fontSizePx: number) => (fontSizePx ? r4pt(letterSpacingPx / fontSizePx) : 0);

const textWrapOf = (value: string): TextStyle['textWrap'] => (/pretty/.test(value) ? 'pretty' : /balance/.test(value) ? 'balance' : undefined);

/** Texte brut d'un objet texte, sur une ligne. */
export function plainText(obj: TextObject): string {
  return obj.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- construction

interface FaceContext {
  faceId: string;
  prefix: string;
  panels: { name: string; x0: number; x1: number }[];
}

interface Emitted {
  id: string;
  layerId: string;
}

class Builder {
  readonly objects: Record<string, DocObject> = {};
  readonly swatches = new SwatchRegistry();
  readonly skipped: ImportIssue[] = [];
  readonly warnings: ImportIssue[] = [];
  readonly unknownIcons: ImportIssue[] = [];
  readonly qrCodes: BuildResult['qrCodes'] = [];
  private counters = new Map<string, number>();
  private face!: FaceContext;
  private readonly prefixes: Map<string, string>;

  constructor(
    private input: BuildInput,
    private readonly format: DocumentFormat,
  ) {
    // Préfixe des identifiants d'objets : trois lettres de la face (« ext », « rec »), sauf si deux faces
    // les partagent (« page-1 », « page-2 ») : l'identifiant entier de la face évite alors toute collision.
    const ids = format.faces.map((f) => f.id);
    const short = ids.map((id) => id.slice(0, 3));
    const unique = new Set(short).size === short.length;
    this.prefixes = new Map(ids.map((id, i) => [id, unique ? short[i] : id]));
  }

  private nextId(kind: string): string {
    const key = `${this.face.prefix}-${kind}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return `${key}${n}`;
  }

  private add<T extends DocObject>(obj: T): Emitted {
    this.objects[obj.id] = obj;
    return { id: obj.id, layerId: obj.layerId };
  }

  /** Référence de nuance d'une couleur du design ; `use` sert à nommer la nuance par son rôle (colors.ts). */
  private color(value: string, where: string, use?: ColorUse): ColorRef {
    const rgba = parseColor(value);
    if (!rgba) throw new Error(`Couleur illisible « ${value} » (${where})`);
    if (rgba.a < 1) this.warnings.push({ faceId: this.face.faceId, what: where, why: `couleur semi-transparente ${value} importée opaque` });
    return this.swatches.ref(rgba, use);
  }

  private panelOf(box: MBox) {
    const cx = box.x + box.w / 2;
    return this.face.panels.find((p) => cx >= p.x0 && cx < p.x1) ?? this.face.panels[this.face.panels.length - 1];
  }

  // -------------------------------------------------------------- faces

  buildFace(faceId: string, measured: MFace): Page {
    const format = this.format;
    const face = format.faces.find((f) => f.id === faceId);
    if (!face) throw new Error(`La face « ${faceId} » du design n'existe pas dans le format ${format.id}`);
    this.face = { faceId, prefix: this.prefixes.get(faceId)!, panels: panelBounds(format, faceId) };
    const children: string[] = [];
    // Le papier est blanc : un aplat blanc posé directement dessus n'imprime rien.
    let backdrop = '#ffffff';
    if (!isTransparent(measured.background)) {
      const hex = toHex(parseColor(measured.background)!);
      if (hex !== backdrop) {
        // Fond donné à la section elle-même : un aplat de toute la face, fond perdu compris.
        const size = faceSize(format);
        const fill = this.color(measured.background, 'fond de la page');
        children.push(this.add({ id: this.nextId('r'), type: 'rect', name: 'Fond de page', layerId: 'fonds', x: 0, y: 0, w: size.w, h: size.h, fill }).id);
        backdrop = hex;
      }
    }
    for (const node of measured.children) children.push(...this.convert(node, [], 0, backdrop).map((e) => e.id));
    children.push(...this.guides(format, faceId));
    return { id: `p-${faceId}`, faceId, name: face.name, children };
  }

  /** Repères non imprimables tirés du gabarit : trait de coupe et plis (pas des `<sc-if>` du design). */
  private guides(format: DocumentFormat, faceId: string): string[] {
    const ids: string[] = [];
    const size = faceSize(format);
    const trim = trimBox(format);
    const stroke = { color: this.swatches.ref(GUIDE_COLOR, { kind: 'guide' }), width: r4pt(mmToPt(0.3)) };
    ids.push(this.add({ id: this.nextId('rep'), type: 'rect', name: 'Trait de coupe', layerId: 'reperes', locked: true, ...trim, stroke }).id);
    const panels = this.face.panels;
    foldPositions(format, faceId).forEach((x, i) => {
      ids.push(
        this.add({
          id: this.nextId('rep'),
          type: 'line',
          name: `Pli · ${panels[i].name} | ${panels[i + 1].name}`,
          layerId: 'reperes',
          locked: true,
          x,
          y: 0,
          w: 0,
          h: size.h,
          stroke: { color: this.swatches.ref(GUIDE_COLOR, { kind: 'guide' }), width: r4pt(mmToPt(0.3)), dash: [1.5, 1] },
        }).id,
      );
    });
    return ids;
  }

  // -------------------------------------------------------------- éléments

  /**
   * Objets d'un élément et de ses descendants, dans l'ordre de peinture.
   * `siblings` : frères de l'élément (pour reconnaître les blocs répétés), `backdrop` : couleur sur laquelle il est posé.
   */
  private convert(node: MNode, siblings: MNode[], depth: number, backdrop: string): Emitted[] {
    const faceId = this.face.faceId;
    if (node.opacity < 1) this.warnings.push({ faceId, what: `<${node.tag}> #${node.imp}`, why: `opacité ${node.opacity} non reprise` });
    switch (node.kind) {
      case 'svg':
        return this.convertSvg(node);
      case 'mask':
        return this.convertFrame(node, node.children.find((c) => c.kind === 'slot'));
      case 'slot':
        return this.convertFrame(node, node);
      default:
        break;
    }

    const out: Emitted[] = [];
    let ownRect: Emitted | null = null;
    let nextBackdrop = backdrop;
    if (!isTransparent(node.background)) {
      const hex = toHex(parseColor(node.background)!);
      if (hex === backdrop) {
        this.skipped.push({ faceId, what: `aplat ${hex} (${node.box.w.toFixed(1)} × ${node.box.h.toFixed(1)} mm)`, why: 'même couleur que le fond sur lequel il est posé : il n’imprime rien' });
      } else {
        ownRect = this.convertBackground(node);
        out.push(ownRect);
        nextBackdrop = hex;
      }
    }
    const borders = node.borders.map((b) => this.convertBorder(node, b));
    out.push(...borders);

    if (node.kind === 'text' && node.text) {
      const text = this.convertText(node, node.text);
      if (text) out.push(text);
    } else {
      for (const child of node.children) out.push(...this.convert(child, node.children, depth + 1, nextBackdrop));
    }
    if (node.kind === 'text') return out;
    return this.maybeGroup(node, siblings, depth, out, { ownRect: ownRect?.layerId === 'contenu', borders: borders.length > 0 });
  }

  private convertBackground(node: MNode): Emitted {
    const box = node.box;
    const panel = this.panelOf(box);
    // Aplat pleine largeur de volet (fond de la couverture, bandeaux de bas de volet) : calque Fonds.
    const fullWidth = box.w >= panel.x1 - panel.x0 - 1;
    const layerId = fullWidth ? 'fonds' : 'contenu';
    const fill = this.color(node.background, `fond de <${node.tag}>`);
    const common = { layerId, x: lu(box.x), y: lu(box.y), w: lu(box.w), h: lu(box.h), fill };
    const name = fullWidth ? `Aplat · ${panel.name}${box.h < 0.9 * this.faceHeight() ? ` (${box.y > this.faceHeight() / 2 ? 'bas' : 'haut'})` : ''}` : undefined;
    if (node.radius.length && node.radius.every((r) => r.trim() === '50%')) {
      return this.add({ id: this.nextId('e'), type: 'ellipse', ...(name ? { name } : {}), ...common });
    }
    const radius = this.radius(node);
    return this.add({ id: this.nextId('r'), type: 'rect', ...(name ? { name } : {}), ...common, ...(radius !== undefined ? { radius } : {}) });
  }

  private faceHeight(): number {
    return faceSize(this.format).h;
  }

  /** Rayons CSS calculés (px ou %) en mm : une valeur si les quatre coins sont égaux. */
  private radius(node: MNode): number | [number, number, number, number] | undefined {
    const values = node.radius.map((r) => {
      const v = r.trim().split(/\s+/)[0];
      if (v.endsWith('%')) return (parseFloat(v) / 100) * Math.min(node.box.w, node.box.h);
      return pxToMm(parseFloat(v) || 0);
    });
    if (values.every((v) => v === 0)) return undefined;
    const rounded = values.map(r4) as [number, number, number, number];
    return rounded.every((v) => v === rounded[0]) ? rounded[0] : rounded;
  }

  /** Bordure CSS → trait centré sur le milieu de la bordure (contrat de rendu, point 4). */
  private convertBorder(node: MNode, border: MNode['borders'][number]): Emitted {
    const { x, y, w, h } = node.box;
    const half = border.widthMm / 2;
    const geometry =
      border.side === 'left'
        ? { x: x + half, y, w: 0, h }
        : border.side === 'right'
          ? { x: x + w - half, y, w: 0, h }
          : border.side === 'top'
            ? { x, y: y + half, w, h: 0 }
            : { x, y: y + h - half, w, h: 0 };
    const dash = border.style === 'dashed' ? [3 * border.widthMm, 3 * border.widthMm] : border.style === 'dotted' ? [border.widthMm, border.widthMm] : undefined;
    if (border.style !== 'solid' && !dash) this.warnings.push({ faceId: this.face.faceId, what: `bordure ${border.side} <${node.tag}>`, why: `style ${border.style} importé en trait plein` });
    return this.add({
      id: this.nextId('l'),
      type: 'line',
      layerId: 'contenu',
      x: lu(geometry.x),
      y: lu(geometry.y),
      w: lu(geometry.w),
      h: lu(geometry.h),
      stroke: { color: this.color(border.color, `bordure ${border.side}`), width: r4pt(mmToPt(border.widthMm)), ...(dash ? { dash: dash.map(r4) } : {}) },
    });
  }

  // -------------------------------------------------------------- texte

  private convertText(node: MNode, text: MText): Emitted | null {
    const s = text.style;
    const style: TextStyle = {
      fontFamily: firstFamily(s.fontFamily),
      fontWeight: s.fontWeight,
      ...(s.italic ? { italic: true } : {}),
      fontSize: r4pt(pxToPt(s.fontSizePx)),
      lineHeight: r4pt(s.lineHeight),
      letterSpacing: emOf(s.letterSpacingPx, s.fontSizePx),
      color: this.color(s.color, 'texte'),
      align: normalizeAlign(s.align),
      transform: s.transform === 'uppercase' ? 'uppercase' : 'none',
    };
    const wrap = textWrapOf(s.textWrap);
    if (wrap) style.textWrap = wrap;

    const paragraphs = text.paragraphs.map((p) => this.convertParagraph(p, style)).filter((p): p is Paragraph => p !== null);
    if (!paragraphs.length) {
      this.skipped.push({ faceId: this.face.faceId, what: `texte vide <${node.tag}> #${node.imp}`, why: 'aucun caractère visible' });
      return null;
    }
    // Caractères visibles par couleur effective : la nuance qui en porte le plus devient « Texte principal ».
    for (const p of paragraphs) {
      for (const run of p.runs) this.swatches.noteText(run.color ?? style.color, run.text.replace(/\s/g, '').length, run.fontSize ?? p.fontSize ?? style.fontSize);
    }

    const box = node.content;
    let w = Math.max(ceil4(box.w), lu(box.w));
    if (text.lines === 1 && style.align === 'left') {
      w = ceil4(box.w + SINGLE_LINE_SLACK_MM);
      if (s.whiteSpace === 'nowrap') {
        this.warnings.push({ faceId: this.face.faceId, what: `texte « ${paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').slice(0, 40)} »`, why: 'white-space: nowrap du design non repris (le rendu est en white-space normal) : la boîte garde la largeur mesurée + 0,2 mm' });
      }
    }
    const obj: TextObject = {
      id: this.nextId('t'),
      type: 'text',
      layerId: 'contenu',
      x: lu(box.x),
      y: lu(box.y),
      w,
      h: Math.max(ceil4(box.h), lu(box.h)),
      style,
      paragraphs,
      lines: text.lines,
    };
    return this.add(obj);
  }

  private convertParagraph(p: MParagraph, block: TextStyle): Paragraph | null {
    // `white-space: normal` : tout blanc (y compris un saut de ligne du source HTML) vaut une espace ;
    // seul un <br> force une ligne. Un '\n' laissé dans un segment deviendrait un <br> au rendu.
    const runs: TextRun[] = [];
    for (const run of p.runs) {
      const text = run.br ? '\n' : run.text.replace(/[\t\n\r\f ]+/g, ' ');
      const overrides = this.runOverrides(run, block, p);
      const prev = runs[runs.length - 1];
      if (prev && sameRunStyle(prev, overrides)) prev.text += text;
      else runs.push({ text, ...overrides });
    }
    // Espaces de début, de fin, doublés entre segments ou collés à un retour forcé : le navigateur ne les affiche pas.
    let afterBlank = true;
    let previous: TextRun | null = null;
    for (const run of runs) {
      let t = run.text;
      if (afterBlank) t = t.replace(/^ +/, '');
      if (t.startsWith('\n') && previous) previous.text = previous.text.replace(/ +$/, '');
      t = t.replace(/ +\n/g, '\n').replace(/\n +/g, '\n');
      run.text = t;
      if (t) {
        afterBlank = /[ \n]$/.test(t);
        previous = run;
      }
    }
    if (previous) previous.text = previous.text.replace(/ +$/, '');
    const kept = runs.filter((r) => r.text !== '');
    if (!kept.some((r) => r.text.trim())) return null;

    const para: Paragraph = { runs: kept };
    const fontSize = r4pt(pxToPt(p.fontSizePx));
    if (fontSize !== block.fontSize) para.fontSize = fontSize;
    if (Math.abs(p.lineHeight - block.lineHeight) > 1e-3) para.lineHeight = r4pt(p.lineHeight);
    const align = normalizeAlign(p.align);
    if (align !== block.align) para.align = align;
    if (p.spaceBeforePx > 0) para.spaceBefore = r4(pxToMm(p.spaceBeforePx));
    return para;
  }

  private runOverrides(run: MRunStyle, block: TextStyle, p: MParagraph): Omit<TextRun, 'text'> {
    const out: Omit<TextRun, 'text'> = {};
    const color = toHex(parseColor(run.color)!);
    if (color !== this.swatchHex(block.color)) out.color = this.color(run.color, 'segment de texte');
    if (run.fontWeight !== block.fontWeight) out.fontWeight = run.fontWeight;
    if (run.italic !== !!block.italic) out.italic = run.italic;
    const size = r4pt(pxToPt(run.fontSizePx));
    const paraSize = r4pt(pxToPt(p.fontSizePx));
    if (size !== paraSize) out.fontSize = size;
    const em = emOf(run.letterSpacingPx, run.fontSizePx);
    if (Math.abs(em - block.letterSpacing) > 1e-4) out.letterSpacing = em;
    const transform = run.transform === 'uppercase' ? 'uppercase' : 'none';
    if (transform !== block.transform) out.transform = transform;
    return out;
  }

  /** Couleur d'une référence encore provisoire (`hex-rrggbb`, résolue par `finalize`). */
  private swatchHex(ref: ColorRef): string {
    return `#${ref.swatch.replace(/^hex-/, '')}`;
  }

  // -------------------------------------------------------------- graphiques

  private convertSvg(node: MNode): Emitted[] {
    const svg = node.svg!;
    const attrs = svg.attrs;
    const box = { x: lu(node.box.x), y: lu(node.box.y), w: lu(node.box.w), h: lu(node.box.h) };
    const viewBox = (attrs.viewBox ?? attrs.viewbox ?? '').trim().replace(/\s+/g, ' ');
    const faceId = this.face.faceId;

    if (attrs['shape-rendering'] === 'crispEdges') return [this.convertQr(node, box, viewBox)];

    if (viewBox === '0 0 24 24' && attrs.stroke === 'currentColor') {
      const match = this.input.icons.match(svg.elements);
      if (!match) this.unknownIcons.push({ faceId, what: `icône ${box.w} × ${box.h} mm en (${box.x} ; ${box.y})`, why: 'absente de lucide-static' });
      return [
        this.add({
          id: this.nextId('ic'),
          type: 'icon',
          name: `Icône · ${match?.name ?? 'inconnue'}`,
          layerId: 'contenu',
          ...box,
          iconName: match?.name ?? 'inconnue',
          svg: compactSvg(svg.inner),
          color: this.color(svg.color, 'icône'),
          strokeWidth: Number(attrs['stroke-width'] ?? 2) || 2,
        }),
      ];
    }

    const vb = viewBox.split(' ').map(Number);
    const only = svg.elements.length === 1 ? svg.elements[0] : null;
    if (attrs.preserveAspectRatio === 'none' && only?.tag.toLowerCase() === 'path' && (only.attrs.fill ?? '') === 'none' && only.attrs.stroke && vb.length === 4) {
      // Trait de vague : tracé ramené à la boîte 0..1 ; avec non-scaling-stroke, stroke-width est en px CSS.
      const nonScaling = only.attrs['vector-effect'] === 'non-scaling-stroke';
      const widthPx = Number(only.attrs['stroke-width'] ?? 1);
      if (!nonScaling) this.warnings.push({ faceId, what: 'tracé étiré', why: 'épaisseur de trait convertie depuis les unités du viewBox (approximation)' });
      const scale = nonScaling ? 1 : mmToPx(node.box.w) / vb[2];
      return [
        this.add({
          id: this.nextId('p'),
          type: 'path',
          name: 'Trait de vague',
          layerId: 'contenu',
          ...box,
          d: normalizePath(only.attrs.d, { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }),
          stroke: { color: this.color(only.attrs.stroke, 'trait de vague'), width: r4pt(pxToPt(widthPx * scale)) },
          ...(nonScaling ? { nonScalingStroke: true } : {}),
        }),
      ];
    }

    // Logo, gouttes et tout autre graphique : SVG repris tel quel, couleurs passées en currentColor.
    const { content, colors } = recolorSvg(svg.inner, attrs);
    let color: ColorRef | undefined;
    if (colors.length) {
      color = this.color(colors[0], 'graphique');
      if (colors.length > 1) this.warnings.push({ faceId, what: `graphique ${viewBox}`, why: `plusieurs couleurs (${colors.join(', ')}) : toutes ramenées à ${colors[0]}` });
    } else if (/currentColor/i.test(content)) {
      color = this.color(svg.color, 'graphique');
    }
    const name = logoName(attrs) ?? (viewBox === DROP_VIEWBOX ? 'Goutte' : 'Graphique');
    return [
      this.add({
        id: this.nextId('s'),
        type: 'svg',
        name,
        layerId: 'contenu',
        ...box,
        viewBox,
        content,
        ...(color ? { color } : {}),
        ...(attrs.preserveAspectRatio ? { preserveAspectRatio: attrs.preserveAspectRatio } : {}),
      }),
    ];
  }

  private convertQr(node: MNode, box: MBox, viewBox: string): Emitted {
    const svg = node.svg!;
    const info = this.input.qr.get(node.imp) ?? { url: null, error: 'QR non décodé' };
    const path = svg.elements.find((e) => e.tag.toLowerCase() === 'path');
    const bg = svg.elements.find((e) => e.tag.toLowerCase() === 'rect');
    const decoded = !!info.url;
    const url = info.url ?? PLACEHOLDER_QR_URL;
    if (!decoded) this.warnings.push({ faceId: this.face.faceId, what: `QR en (${box.x} ; ${box.y})`, why: `illisible (${info.error ?? 'raison inconnue'}) : adresse provisoire ${url}, à corriger` });
    const id = this.nextId('q');
    this.qrCodes.push({ id, faceId: this.face.faceId, url, decoded, box, info: { ...info, designMargin: -Number(viewBox.split(' ')[0]) || 0 } });
    return this.add({
      id,
      type: 'qr',
      name: `QR · ${url}`,
      layerId: 'contenu',
      ...box,
      url,
      ecc: 'M',
      color: this.color(path?.attrs.fill && path.attrs.fill !== 'currentColor' ? path.attrs.fill : '#000000', 'QR', { kind: 'qr' }),
      background: this.color(bg?.attrs.fill ?? '#ffffff', 'fond du QR'),
      margin: 4,
    });
  }

  /** Zone image : cadre découpé (`mask-image`) ou simple image-slot, sans photo à ce stade. */
  private convertFrame(node: MNode, slot: MNode | undefined): Emitted[] {
    const faceId = this.face.faceId;
    const box = node.box;
    let shape: ShapeRef;
    if (node.kind === 'mask') {
      const mask = parseMaskImage(node.maskImage ?? '');
      if (!mask) {
        this.warnings.push({ faceId, what: `masque <${node.tag}>`, why: `mask-image illisible : cadre rectangulaire à la place (${(node.maskImage ?? '').slice(0, 60)})` });
        shape = { kind: 'rect' };
      } else {
        const d = normalizePath(mask.d, mask.viewBox);
        const preset = d === SHAPE_PRESETS.goutte.d ? 'goutte' : mask.viewBox.w / mask.viewBox.h >= 1.5 ? 'vague' : undefined;
        shape = { kind: 'path', d, ...(preset ? { preset } : {}) };
      }
    } else {
      const kind = slot?.attrs?.shape ?? 'rect';
      if (kind === 'circle' || kind === 'ellipse') shape = { kind: 'ellipse' };
      else if (kind === 'rounded') shape = { kind: 'rect', radius: r4(pxToMm(Number(slot?.attrs?.radius ?? 0))) };
      else shape = { kind: 'rect' };
    }
    const placeholder = slot?.attrs?.placeholder;
    if (!slot) this.warnings.push({ faceId, what: `masque <${node.tag}>`, why: 'aucune image-slot dedans : cadre sans légende' });
    if (slot?.tag === 'img') {
      this.warnings.push({ faceId, what: `image <img> « ${placeholder} »`, why: 'fichier de l’image non importé : cadre photo vide à sa place, à remplir' });
    }
    const frame: FrameObject = {
      id: this.nextId('f'),
      type: 'frame',
      name: `Cadre · ${placeholder ?? slot?.attrs?.id ?? 'photo'}`,
      layerId: 'contenu',
      x: lu(box.x),
      y: lu(box.y),
      w: lu(box.w),
      h: lu(box.h),
      shape,
      ...(!isTransparent(node.background) ? { fill: this.color(node.background, 'fond du cadre') } : {}),
      ...(placeholder ? { placeholder } : {}),
    };
    return [this.add(frame)];
  }

  // -------------------------------------------------------------- groupes

  private maybeGroup(node: MNode, siblings: MNode[], depth: number, out: Emitted[], own: { ownRect: boolean; borders: boolean }): Emitted[] {
    // Un groupe ne porte que des objets de son calque : les aplats du calque Fonds restent dehors, dessous.
    const content = out.filter((e) => e.layerId === 'contenu');
    const others = out.filter((e) => e.layerId !== 'contenu');
    // La face et ses volets ne sont pas des blocs ; un élément qui n'enveloppe qu'un objet non plus.
    if (depth < 2 || content.length < 2) return out;

    const objs = content.map((e) => this.objects[e.id]);
    const deep = this.flatten(objs);
    const texts = deep.filter((o): o is TextObject => o.type === 'text');
    const hasQr = deep.some((o) => o.type === 'qr');
    const logo = deep.find(isLogo);
    const hasLogo = !!logo;
    const bandeau = objs.some((o) => o.type === 'frame' && o.shape.kind === 'path' && o.shape.preset === 'vague') && objs.some((o) => o.type === 'path');
    const panel = this.panelOf(node.box);
    const fullWidth = node.box.w >= panel.x1 - panel.x0 - 1;
    const repeated = !fullWidth && siblings.some((s) => s !== node && s.kind === node.kind && signature(s) === signature(node));
    const visual = (own.ownRect || own.borders) && texts.length > 0;
    if (!(bandeau || hasQr || hasLogo || repeated || visual)) return out;

    const subgroups = objs.filter((o): o is GroupObject => o.type === 'group');
    let type: string;
    let label: string;
    if (bandeau) {
      type = 'Bandeau';
      label = panel.name;
    } else {
      label = mainText(texts);
      const logoGroup = subgroups.find((g) => g.name?.startsWith('Logo'));
      if (hasQr) type = subgroups.length >= 2 ? 'Bloc' : "Appel à l'action";
      else if (hasLogo && !subgroups.length) type = 'Logo';
      else if (logoGroup && subgroups.length >= 3) {
        // Logo et lignes de contact : on nomme le bloc par ses coordonnées, pas par la signature du logo.
        type = 'Coordonnées';
        const inLogo = new Set(this.flatten([logoGroup]).map((o) => o.id));
        label = mainText(texts.filter((t) => !inLogo.has(t.id))) || label;
      } else if (texts.some((t) => /^0\d$/.test(plainText(t)))) type = 'Étape';
      else if (subgroups.length >= 2 && subgroups.every((g) => g.name?.startsWith('Chiffre clé'))) type = 'Chiffres clés';
      else if (isKeyFigure(texts)) type = 'Chiffre clé';
      else if (own.ownRect) type = 'Carte';
      else if (own.borders && !repeated) type = 'Encadré';
      else if (repeated) type = isVertical(objs) ? 'Vignette' : 'Ligne';
      else type = 'Bloc';
      // Un logo sans texte voisin : son propre nom (aria-label du design) nomme le bloc.
      if (!label) label = logo?.name ?? type;
    }
    const group: GroupObject = {
      id: this.nextId('g'),
      type: 'group',
      name: `${type} · ${truncate(label)}`,
      layerId: 'contenu',
      ...union(objs.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }))),
      children: content.map((e) => e.id),
    };
    return [...others, this.add(group)];
  }

  private flatten(objs: DocObject[]): DocObject[] {
    return objs.flatMap((o) => (o.type === 'group' ? [o, ...this.flatten(o.children.map((id) => this.objects[id]))] : [o]));
  }
}

// ---------------------------------------------------------------- aides

function sameRunStyle(a: TextRun, b: Omit<TextRun, 'text'>): boolean {
  const keys = ['color', 'fontWeight', 'italic', 'fontSize', 'letterSpacing', 'transform'] as const;
  return keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** Structure d'un élément, sans ses couleurs ni ses bordures : deux cartes d'une même liste ont la même. */
function signature(node: MNode, depth = 0): string {
  if (depth > 3 || !node.children.length) return node.kind;
  return `${node.kind}(${node.children.map((c) => signature(c, depth + 1)).join(',')})`;
}

/** Texte principal d'un bloc : le plus gros corps, puis la plus forte graisse, puis le premier. */
function mainText(texts: TextObject[]): string {
  if (!texts.length) return '';
  const size = (t: TextObject) => Math.max(t.style.fontSize, ...t.paragraphs.map((p) => p.fontSize ?? 0));
  const weight = (t: TextObject) => Math.max(t.style.fontWeight, ...t.paragraphs.flatMap((p) => p.runs.map((r) => r.fontWeight ?? 0)));
  let best = texts[0];
  for (const t of texts) if (size(t) > size(best) + 1e-6 || (Math.abs(size(t) - size(best)) < 1e-6 && weight(t) > weight(best))) best = t;
  let label = plainText(best);
  // « 24 » seul ne dit rien : on lui adjoint le texte qui le suit (« 24 ateliers »).
  if (label.length < 6) {
    const next = texts[texts.indexOf(best) + 1];
    if (next) label = `${label} ${plainText(next)}`;
  }
  return label;
}

function isKeyFigure(texts: TextObject[]): boolean {
  return texts.some((t) => /^\d/.test(plainText(t)) && t.style.fontSize >= 10);
}

/** Pictogramme au-dessus du texte (colonne) plutôt qu'à sa gauche (ligne). */
function isVertical(objs: DocObject[]): boolean {
  const pictogram = objs.find((o) => o.type === 'icon' || o.type === 'ellipse' || o.type === 'rect');
  const text = objs.find((o) => o.type === 'text');
  if (!pictogram || !text) return false;
  return pictogram.y + pictogram.h <= text.y + 0.01;
}

export function truncate(label: string, max = 40): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  // Quelques caractères de tolérance plutôt qu'un mot coupé : un libellé à peine trop long reste entier.
  if (clean.length <= max + 5) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : clean.slice(0, max)).replace(/[\s,;:.]+$/, '')}…`;
}

function compactSvg(inner: string): string {
  return inner.replace(/>\s+</g, '><').trim();
}

const PRESENTATION_ATTRS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'stroke-miterlimit'];

/**
 * Contenu SVG avec ses couleurs en dur remplacées par `currentColor` (liste des couleurs retirées).
 * Les attributs de présentation de la racine (`fill="currentColor"` du logo) passent sur un `<g>` :
 * le rendu ne recopie que le viewBox de la racine.
 */
export function recolorSvg(inner: string, rootAttrs: Record<string, string>): { content: string; colors: string[] } {
  const colors: string[] = [];
  const swap = (value: string) => {
    const rgba = parseColor(value);
    if (!rgba) return value;
    const hex = toHex(rgba);
    if (!colors.includes(hex)) colors.push(hex);
    return 'currentColor';
  };
  let content = compactSvg(inner).replace(/\b(fill|stroke|stop-color|color)="([^"]*)"/g, (_, name: string, value: string) => `${name}="${swap(value)}"`);
  const rootPresentation = PRESENTATION_ATTRS.filter((a) => rootAttrs[a] !== undefined).map((a) => `${a}="${a === 'fill' || a === 'stroke' ? swap(rootAttrs[a]) : rootAttrs[a]}"`);
  if (rootPresentation.length) content = `<g ${rootPresentation.join(' ')}>${content}</g>`;
  return { content, colors };
}

/** Relit le viewBox et le tracé d'un `mask-image: url("data:image/svg+xml;utf8,…")`. */
export function parseMaskImage(value: string): { viewBox: { x: number; y: number; w: number; h: number }; d: string } | null {
  const m = /url\(\s*(["']?)(data:image\/svg\+xml[^,]*,)([\s\S]*?)\1\s*\)/.exec(value);
  if (!m) return null;
  let svg = m[3];
  try {
    svg = /;base64$/.test(m[2].slice(0, -1)) ? Buffer.from(svg, 'base64').toString('utf8') : decodeURIComponent(svg);
  } catch {
    return null;
  }
  const vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
  const d = /<path\b[^>]*\bd\s*=\s*["']([^"']+)["']/.exec(svg)?.[1];
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || !d) return null;
  return { viewBox: { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }, d };
}

// ---------------------------------------------------------------- document

/** Avertissement qui porte sur tout le document (format, polices) plutôt que sur une face. */
const WHOLE_DOCUMENT = 'document';

export function buildDocument(input: BuildInput): BuildResult {
  const { resolved } = input;
  const format = structuredClone(resolved.format);
  const builder = new Builder(input, format);
  builder.warnings.push(...[...(input.designWarnings ?? []), ...resolved.warnings].map((why) => ({ faceId: WHOLE_DOCUMENT, what: 'format', why })));
  const pages: Page[] = [];
  const size = faceSize(format);
  for (const face of format.faces) {
    const measured = input.measure.faces.find((f) => f.faceId === face.id);
    if (!measured) throw new Error(`La face « ${face.id} » du format est absente du design (faces mesurées : ${input.measure.faces.map((f) => f.faceId).join(', ')})`);
    if (Math.abs(measured.size.w - size.w) > SIZE_TOLERANCE_MM || Math.abs(measured.size.h - size.h) > SIZE_TOLERANCE_MM) {
      throw new Error(`La face « ${face.id} » du design mesure ${measured.size.w.toFixed(2)} × ${measured.size.h.toFixed(2)} mm, le format attend ${size.w} × ${size.h} mm`);
    }
    pages.push(builder.buildFace(face.id, measured));
  }
  for (const face of input.measure.faces) {
    if (!format.faces.some((f) => f.id === face.faceId)) builder.skipped.push({ faceId: face.faceId, what: `section « ${face.sectionId || face.faceId} »`, why: 'aucune face du format ne l’imprime' });
  }
  // L'éditeur n'a qu'Open Sans : un texte composé dans une autre police y sera dessiné autrement.
  const otherFonts = new Map<string, number>();
  for (const obj of Object.values(builder.objects)) {
    if (obj.type === 'text' && obj.style.fontFamily !== EDITOR_FONT_FAMILY) otherFonts.set(obj.style.fontFamily, (otherFonts.get(obj.style.fontFamily) ?? 0) + 1);
  }
  for (const [family, n] of otherFonts) {
    builder.warnings.push({
      faceId: WHOLE_DOCUMENT,
      what: `police « ${family} » (${n} texte${n > 1 ? 's' : ''})`,
      why: `absente de l'éditeur (seule ${EDITOR_FONT_FAMILY} est installée) : ces textes seront dessinés dans une police de remplacement, coupures de ligne à revérifier`,
    });
  }
  const swatches = builder.swatches.finalize();
  const doc: LayoutDocument = {
    version: DOC_VERSION,
    id: input.id,
    name: input.name,
    createdAt: input.importedAt,
    format,
    pages,
    layers: structuredClone(LAYERS),
    objects: builder.objects,
    swatches: swatches.map((s) => s.swatch),
    styles: { paragraph: [], character: [] },
    assets: [],
    source: { kind: 'claude-design', path: input.sourcePath, importedAt: input.importedAt },
  };
  const skipped = [...input.measure.skipped.map((s) => ({ ...s, faceId: s.faceId || '?' })), ...builder.skipped];
  return {
    doc,
    format: { origin: resolved.origin, notes: resolved.notes, faces: resolved.faces },
    swatches,
    skipped,
    warnings: builder.warnings,
    unknownIcons: builder.unknownIcons,
    qrCodes: builder.qrCodes,
  };
}
