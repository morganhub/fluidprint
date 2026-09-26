// Mesure du design dans Chrome : chaque élément visible de chaque face, avec sa boîte (en mm, repère
// de la face) et les styles calculés utiles à la conversion. Tout ce qui dépend de la mise en page
// (coupures de ligne, hauteurs de ligne « normal », boîtes des objets flex) est lu ici, jamais deviné.
import type { Page } from 'puppeteer-core';
import { PX_PER_MM } from '../../src/model/units';

export interface MBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MBorder {
  side: 'top' | 'right' | 'bottom' | 'left';
  /** Épaisseur voulue par le design (valeur écrite dans le style), en mm. */
  widthMm: number;
  style: string;
  color: string;
}

export interface MRunStyle {
  color: string;
  fontWeight: number;
  italic: boolean;
  fontSizePx: number;
  letterSpacingPx: number;
  transform: string;
}

export interface MRun extends MRunStyle {
  text: string;
  /** Retour à la ligne forcé (`<br>`). */
  br?: boolean;
}

export interface MParagraph {
  fontSizePx: number;
  /** Interlignage en multiple du corps, « normal » déjà résolu par la mesure. */
  lineHeight: number;
  align: string;
  spaceBeforePx: number;
  runs: MRun[];
}

export interface MText {
  style: MRunStyle & { fontFamily: string; lineHeight: number; align: string; textWrap: string; whiteSpace: string };
  paragraphs: MParagraph[];
  /** Boîtes de ligne distinctes (Range.getClientRects regroupés par ordonnée). */
  lines: number;
}

export interface MSvg {
  attrs: Record<string, string>;
  inner: string;
  /** Tous les éléments descendants, dans l'ordre du document. */
  elements: { tag: string; attrs: Record<string, string> }[];
  color: string;
}

export type MKind = 'box' | 'text' | 'svg' | 'mask' | 'slot' | 'other';

export interface MNode {
  /** Index unique posé sur l'élément (`data-imp`) : sert à le retrouver pour une capture. */
  imp: number;
  tag: string;
  kind: MKind;
  /** Boîte de bordure. */
  box: MBox;
  /** Boîte de contenu (sans bordure ni marge intérieure). */
  content: MBox;
  display: string;
  position: string;
  flexDirection: string;
  background: string;
  /** Rayons calculés des coins hg, hd, bd, bg (px ou %). */
  radius: string[];
  borders: MBorder[];
  opacity: number;
  maskImage?: string;
  attrs?: Record<string, string>;
  text?: MText;
  svg?: MSvg;
  children: MNode[];
}

export interface MFace {
  faceId: string;
  /** Section du design mesurée sur cette face. */
  sectionId: string;
  size: { w: number; h: number };
  /** Couleur de fond de la section elle-même (blanc par défaut, comme le papier). */
  background: string;
  children: MNode[];
}

export interface MeasureResult {
  faces: MFace[];
  /** Éléments écartés pendant la mesure, avec la raison. */
  skipped: { faceId: string; what: string; why: string }[];
}

/** Exécuté dans la page : pas de fermeture sur le module, tout est passé en argument. */
function measureInPage(opts: { pxPerMm: number; normalLineHeight: number }): MeasureResult {
  const PX = opts.pxPerMm;
  const skipped: MeasureResult['skipped'] = [];
  let counter = 0;

  // Dans un conteneur flex ou grid, un nœud texte nu devient un élément anonyme dont la boîte n'est
  // pas mesurable : on l'enveloppe dans un <div>, qui se comporte exactement comme cet élément anonyme.
  const faces = Array.from(document.querySelectorAll<HTMLElement>('.design-face'));
  for (const face of faces) {
    for (const el of [face, ...Array.from(face.querySelectorAll<HTMLElement>('*'))]) {
      if (el instanceof SVGElement) continue;
      if (!/flex|grid/.test(getComputedStyle(el).display)) continue;
      let run: Text[] = [];
      const flush = () => {
        if (run.some((t) => t.data.trim() !== '')) {
          const wrapper = document.createElement('div');
          wrapper.setAttribute('data-anon-text', '1');
          run[0].before(wrapper);
          for (const t of run) wrapper.append(t);
        }
        run = [];
      };
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) run.push(node as Text);
        else if (node.nodeType === Node.ELEMENT_NODE) flush();
      }
      flush();
    }
  }

  const probeCache = new Map<string, number>();
  const probeNormal = (cs: CSSStyleDeclaration): number => {
    const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.fontStyle}`;
    let ratio = probeCache.get(key);
    if (ratio === undefined) {
      const probe = document.createElement('div');
      probe.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;line-height:normal;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle}`;
      probe.textContent = 'Hg';
      document.body.append(probe);
      const h = probe.getBoundingClientRect().height;
      probe.remove();
      ratio = h > 0 ? h / parseFloat(cs.fontSize) : opts.normalLineHeight;
      probeCache.set(key, ratio);
    }
    return ratio;
  };
  const lineHeightOf = (cs: CSSStyleDeclaration) => (cs.lineHeight === 'normal' ? probeNormal(cs) : parseFloat(cs.lineHeight) / parseFloat(cs.fontSize));

  const runStyle = (el: Element) => {
    const cs = getComputedStyle(el);
    return {
      color: cs.color,
      fontWeight: Number(cs.fontWeight),
      italic: cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'),
      fontSizePx: parseFloat(cs.fontSize),
      letterSpacingPx: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
      transform: cs.textTransform,
    };
  };
  const paraStyle = (el: Element, withMargin: boolean) => {
    const cs = getComputedStyle(el);
    return {
      fontSizePx: parseFloat(cs.fontSize),
      lineHeight: lineHeightOf(cs),
      align: cs.textAlign,
      spaceBeforePx: withMargin ? parseFloat(cs.marginTop) || 0 : 0,
      runs: [] as MRun[],
    };
  };

  const specifiedMm = (el: Element, prop: string): number | null => {
    const value = (el as HTMLElement).style?.getPropertyValue(prop) ?? '';
    const m = /^(-?[\d.]+)(mm|px|pt|cm)$/.exec(value.trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === 'mm' ? n : m[2] === 'cm' ? n * 10 : m[2] === 'pt' ? (n * 25.4) / 72 : n / PX;
  };

  const attrsOf = (el: Element) => {
    const out: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) if (a.name !== 'data-imp') out[a.name] = a.value;
    return out;
  };

  const textContent = (leaf: Element): MText => {
    const cs = getComputedStyle(leaf);
    const paragraphs: MParagraph[] = [];
    let current = paraStyle(leaf, false);
    const flush = () => {
      if (current.runs.length) paragraphs.push(current);
    };
    const walk = (node: Element, owner: Element) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          current.runs.push({ text: (child as Text).data, ...runStyle(node) });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child as Element;
          const tag = el.tagName.toLowerCase();
          if (tag === 'br') {
            current.runs.push({ text: '\n', br: true, ...runStyle(node) });
            continue;
          }
          const display = getComputedStyle(el).display;
          if (display === 'none') continue;
          if (el instanceof SVGElement) {
            skipped.push({ faceId: '', what: `<svg> dans le texte « ${leaf.textContent?.trim().slice(0, 40)} »`, why: 'graphique intégré à un bloc texte' });
            continue;
          }
          if (display.startsWith('inline') && display !== 'inline-block') {
            walk(el, owner);
          } else {
            // Élément bloc dans un texte : un nouveau paragraphe, avec ses propres surcharges.
            flush();
            current = paraStyle(el, true);
            walk(el, el);
            flush();
            const after = parseFloat(getComputedStyle(el).marginBottom) || 0;
            current = paraStyle(owner, false);
            current.spaceBeforePx = after;
          }
        }
      }
    };
    walk(leaf, leaf);
    flush();

    // Lignes : rectangles des nœuds texte, regroupés quand ils partagent la même ligne.
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) rects.push(r);
    }
    rects.sort((a, b) => a.top - b.top || b.height - a.height);
    let lines = 0;
    let lineTop = -Infinity;
    let lineHeight = 0;
    for (const r of rects) {
      if (r.top >= lineTop + lineHeight / 2) {
        lines++;
        lineTop = r.top;
        lineHeight = r.height;
      }
    }

    return {
      style: {
        ...runStyle(leaf),
        fontFamily: cs.fontFamily,
        lineHeight: lineHeightOf(cs),
        align: cs.textAlign,
        textWrap: cs.getPropertyValue('text-wrap-style') || cs.getPropertyValue('text-wrap') || 'wrap',
        whiteSpace: cs.whiteSpace,
      },
      paragraphs,
      lines,
    };
  };

  const measure = (el: Element, faceEl: Element, origin: DOMRect): MNode | null => {
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
      if (tag !== 'style' && tag !== 'script') skipped.push({ faceId: faceEl.getAttribute('data-face-id') ?? '', what: `<${tag}>`, why: 'invisible (display, visibility ou opacité nulle)' });
      return null;
    }
    const imp = ++counter;
    el.setAttribute('data-imp', String(imp));
    const r = el.getBoundingClientRect();
    const toMm = (x: number, y: number, w: number, h: number): MBox => ({ x: (x - origin.left) / PX, y: (y - origin.top) / PX, w: w / PX, h: h / PX });
    const box = toMm(r.left, r.top, r.width, r.height);
    const px = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0;
    const isSvg = el instanceof SVGElement;
    const bl = isSvg ? 0 : px('border-left-width') + px('padding-left');
    const br = isSvg ? 0 : px('border-right-width') + px('padding-right');
    const bt = isSvg ? 0 : px('border-top-width') + px('padding-top');
    const bb = isSvg ? 0 : px('border-bottom-width') + px('padding-bottom');
    const content = toMm(r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);

    const borders: MBorder[] = [];
    if (!isSvg) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const style = cs.getPropertyValue(`border-${side}-style`);
        const width = px(`border-${side}-width`);
        if (style === 'none' || style === 'hidden' || width <= 0) continue;
        borders.push({ side, style, color: cs.getPropertyValue(`border-${side}-color`), widthMm: specifiedMm(el, `border-${side}-width`) ?? width / PX });
      }
    }
    const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');

    const node: MNode = {
      imp,
      tag,
      kind: 'box',
      box,
      content,
      display: cs.display,
      position: cs.position,
      flexDirection: cs.flexDirection,
      background: isSvg ? 'rgba(0, 0, 0, 0)' : cs.backgroundColor,
      radius: isSvg ? [] : ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'].map((p) => cs.getPropertyValue(p)),
      borders,
      opacity: Number(cs.opacity),
      children: [],
    };
    if (!isSvg && cs.backgroundImage && cs.backgroundImage !== 'none') {
      skipped.push({ faceId: faceEl.getAttribute('data-face-id') ?? '', what: `<${tag}> image de fond`, why: 'background-image non pris en charge' });
    }
    if (!isSvg && cs.boxShadow && cs.boxShadow !== 'none') {
      skipped.push({ faceId: faceEl.getAttribute('data-face-id') ?? '', what: `<${tag}> ombre portée`, why: 'box-shadow non pris en charge' });
    }

    if (tag === 'svg') {
      node.kind = 'svg';
      node.svg = {
        attrs: attrsOf(el),
        inner: el.innerHTML,
        elements: Array.from(el.querySelectorAll('*')).map((c) => ({ tag: c.tagName, attrs: attrsOf(c) })),
        color: cs.color,
      };
      return node;
    }
    if (tag === 'image-slot') {
      node.kind = 'slot';
      node.attrs = attrsOf(el);
      return node;
    }
    if (tag === 'img') {
      // Image du design (logo, illustration) : son fichier n'est pas importé, mais sa place l'est, en
      // cadre photo vide légendé par son texte alternatif ou son nom de fichier.
      const src = el.getAttribute('src') ?? '';
      let file = src.split(/[?#]/)[0].split('/').pop() ?? '';
      try {
        file = decodeURIComponent(file);
      } catch {
        // nom mal encodé : gardé tel quel
      }
      node.kind = 'slot';
      node.attrs = { ...attrsOf(el), placeholder: el.getAttribute('alt')?.trim() || (src.startsWith('data:') || !file ? 'image' : file) };
      return node;
    }
    if (mask && mask !== 'none') {
      node.kind = 'mask';
      node.maskImage = mask;
    } else if (Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n as Text).data.trim() !== '')) {
      node.kind = 'text';
      node.text = textContent(el);
      return node;
    } else if (tag !== 'div' && tag !== 'span' && tag !== 'b' && tag !== 'section') {
      node.kind = 'other';
    }
    const kids = Array.from(el.children)
      .map((c) => measure(c, faceEl, origin))
      .filter((c): c is MNode => c !== null);
    // Ordre de peinture : les éléments positionnés (sans z-index) passent au-dessus de leurs frères.
    node.children = [...kids.filter((k) => k.position === 'static'), ...kids.filter((k) => k.position !== 'static')];
    return node;
  };

  return {
    faces: faces.map((face) => {
      const origin = face.getBoundingClientRect();
      const children = Array.from(face.children)
        .map((c) => measure(c, face, origin))
        .filter((c): c is MNode => c !== null);
      return {
        faceId: face.getAttribute('data-face-id') ?? '',
        sectionId: face.getAttribute('data-section-id') ?? '',
        size: { w: origin.width / PX, h: origin.height / PX },
        background: getComputedStyle(face).backgroundColor,
        children,
      };
    }),
    skipped,
  };
}

/** Open Sans : (ascendante 2189 + descendante 600) / 2048, interlignage « normal » de la police. */
export const OPEN_SANS_NORMAL_LINE_HEIGHT = 1.36182;

export async function measureDesign(page: Page): Promise<MeasureResult> {
  // tsx (esbuild, keepNames) insère des appels à `__name` dans les fonctions : la page doit le connaître.
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  return page.evaluate(measureInPage, { pxPerMm: PX_PER_MM, normalLineHeight: OPEN_SANS_NORMAL_LINE_HEIGHT });
}
