// Conversions d'unités. Le CSS fixe 96 px par pouce : 1 mm CSS = 96 / 25,4 px, à zoom 1.
export const MM_PER_INCH = 25.4;
export const PX_PER_INCH = 96;
export const PT_PER_INCH = 72;

export const PX_PER_MM = PX_PER_INCH / MM_PER_INCH;

export const mmToPx = (mm: number, zoom = 1): number => mm * PX_PER_MM * zoom;
export const pxToMm = (px: number, zoom = 1): number => px / (PX_PER_MM * zoom);

export const ptToMm = (pt: number): number => (pt * MM_PER_INCH) / PT_PER_INCH;
export const mmToPt = (mm: number): number => (mm * PT_PER_INCH) / MM_PER_INCH;

export const ptToPx = (pt: number, zoom = 1): number => (pt * PX_PER_INCH * zoom) / PT_PER_INCH;
export const pxToPt = (px: number, zoom = 1): number => (px * PT_PER_INCH) / (PX_PER_INCH * zoom);

/** Pixels nécessaires pour `mm` à une résolution donnée (ppi). */
export const mmToDevicePx = (mm: number, ppi: number): number => (mm / MM_PER_INCH) * ppi;

/** Résolution effective (ppi) d'une image de `px` pixels imprimée sur `mm` millimètres. */
export const effectivePpi = (px: number, mm: number): number => (px * MM_PER_INCH) / mm;

/** Arrondi au centième de mm : bruit de mesure du navigateur éliminé, précision d'impression gardée. */
export const roundMm = (mm: number, step = 0.01): number => Math.round(mm / step) * step;
