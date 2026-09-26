import { describe, expect, it } from 'vitest';
import { mmToPx, pxToMm, ptToMm, mmToPt, effectivePpi } from '../src/model/units';
import { validateDocument } from '../src/model/validate';
import { minimalDoc } from './fixtures/minimal-doc';

describe('unités', () => {
  it('mm → px → mm revient à l’identique à 0,001 mm près, à tout zoom', () => {
    for (const zoom of [0.25, 1, 4]) {
      for (const mm of [0, 0.1, 3, 97, 303.333]) {
        expect(Math.abs(pxToMm(mmToPx(mm, zoom), zoom) - mm)).toBeLessThan(0.001);
      }
    }
  });

  it('pt ↔ mm', () => {
    expect(ptToMm(72)).toBeCloseTo(25.4, 10);
    expect(mmToPt(ptToMm(6.3))).toBeCloseTo(6.3, 10);
  });

  it('résolution effective : 1 200 px sur 103 mm ≈ 296 ppi', () => {
    expect(Math.round(effectivePpi(1200, 103))).toBe(296);
  });
});

describe('validation du document', () => {
  it('accepte un document cohérent', () => {
    const result = validateDocument(minimalDoc());
    expect(result.ok).toBe(true);
  });

  it('refuse une nuance inconnue avec le chemin exact de l’erreur', () => {
    const doc = minimalDoc();
    (doc.objects.r1 as { fill: { swatch: string } }).fill = { swatch: 'inconnue' };
    const result = validateDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.path)).toContain('objects.r1.fill.swatch');
  });

  it('refuse une forme invalide avec le chemin exact', () => {
    const doc = minimalDoc() as unknown as { objects: { t1: { style: { fontSize: number } } } };
    doc.objects.t1.style.fontSize = -3;
    const result = validateDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].path).toBe('objects.t1.style.fontSize');
  });

  it('refuse un tracé que le rendu ne sait pas lire (arc) et un QR trop long, avec le chemin exact', () => {
    const doc = minimalDoc();
    const arc = 'M0 0.5A0.5 0.5 0 0 1 1 0.5L1 1L0 1Z';
    doc.objects.cadre = {
      id: 'cadre',
      type: 'frame',
      layerId: 'contenu',
      x: 10,
      y: 10,
      w: 20,
      h: 20,
      shape: { kind: 'path', d: arc },
      stroke: { color: { swatch: 'bleu' }, width: 1 },
    };
    doc.objects.trace = { id: 'trace', type: 'path', layerId: 'contenu', x: 40, y: 10, w: 20, h: 20, d: 'M0 0 X 1 1' };
    doc.objects.qr = { id: 'qr', type: 'qr', layerId: 'contenu', x: 70, y: 10, w: 20, h: 20, url: `https://example.com/${'a'.repeat(3000)}`, ecc: 'M', color: { swatch: 'gris' }, margin: 2 };
    doc.pages[1].children.push('cadre', 'trace', 'qr');
    const result = validateDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byPath = new Map(result.errors.map((e) => [e.path, e.message]));
    expect(byPath.get('objects.cadre.shape.d')).toMatch(/arcs/);
    expect(byPath.get('objects.trace.d')).toMatch(/Commande de tracé inconnue/);
    expect(byPath.get('objects.qr.url')).toMatch(/QR code impossible au niveau M/);
    expect(result.errors).toHaveLength(3);
  });

  it('refuse un objet orphelin et un objet rattaché deux fois', () => {
    const doc = minimalDoc();
    doc.pages[1].children.push('r1');
    doc.objects.r2 = { ...(doc.objects.r1 as object), id: 'r2' } as never;
    const result = validateDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const messages = result.errors.map((e) => `${e.path} ${e.message}`).join('\n');
      expect(messages).toMatch(/pages\.1\.children\.0 .*déjà rattaché/);
      expect(messages).toMatch(/objects\.r2 .*inaccessible/);
    }
  });

  it('migre un document de version 1 (couleurs en hexadécimal) sans perte', () => {
    const v2 = minimalDoc();
    const v1 = structuredClone(v2) as unknown as Record<string, unknown>;
    v1.version = 1;
    v1.swatches = [];
    const objects = v1.objects as Record<string, Record<string, unknown>>;
    objects.r1.fill = '#2A5FA3';
    const t1 = objects.t1 as { style: { color: unknown }; paragraphs: { runs: { color?: unknown }[] }[] };
    t1.style.color = '#4b4d55';
    t1.paragraphs[0].runs[1].color = '#2a5fa3';

    const result = validateDocument(v1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.doc.swatches.map((s) => [s.id, s.rgb]));
    const r1 = result.doc.objects.r1 as { fill: { swatch: string } };
    expect(byId.get(r1.fill.swatch)).toBe('#2a5fa3');
    const t = result.doc.objects.t1 as typeof t1 & { style: { color: { swatch: string } } };
    expect(byId.get(t.style.color.swatch)).toBe('#4b4d55');
    expect(result.doc.swatches).toHaveLength(2);
    expect(result.doc.version).toBe(2);
  });
});
