// Rapport d'import lisible (import-report.md) : ce qui a été créé, ce qui a été laissé de côté et pourquoi.
// `summarizeImport` en donne l'essentiel en JSON, pour l'interface (route d'import).
import { describeTemplate } from '../../src/model/templates';
import type { DocObject, GroupObject, LayoutDocument } from '../../src/model/types';
import type { FormatOrigin } from './designFormat';
import type { BuildResult, ImportIssue, QrInfo } from './toObjects';

const ORIGIN_LABELS: Record<FormatOrigin, string> = {
  template: 'gabarit imposé',
  detected: 'gabarit reconnu',
  custom: 'format sur mesure',
};

const TYPE_LABELS: Record<DocObject['type'], string> = {
  text: 'Textes',
  rect: 'Rectangles',
  ellipse: 'Ellipses',
  line: 'Traits',
  path: 'Tracés',
  frame: 'Cadres photo',
  icon: 'Icônes',
  svg: 'Graphiques SVG (logo, gouttes)',
  qr: 'QR codes',
  group: 'Groupes',
};

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(head: string[], rows: (string | number)[][]): string {
  if (!rows.length) return '_Aucun._\n';
  return [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => esc(String(c))).join(' | ')} |`)].join('\n') + '\n';
}

function issues(list: ImportIssue[]): string {
  return table(
    ['Face', 'Élément', 'Raison'],
    list.map((i) => [i.faceId, i.what, i.why]),
  );
}

/** Niveau et masque du design, comparés au masque que `qrcode` choisira en régénérant le code. */
function qrSettings(info: QrInfo): string {
  if (!info.designSettings) return '?';
  if (!info.designSettings.length) return 'aucun réglage de `qrcode` ne le reproduit';
  return info.designSettings
    .map(({ ecc, mask }) => {
      const auto = info.defaultMask?.[ecc];
      return `${ecc}, masque ${mask}${auto === mask ? ' (identique au code régénéré)' : ` (\`qrcode\` choisit le masque ${auto} : modules différents)`}`;
    })
    .join(' ; ');
}

export function countObjects(doc: LayoutDocument): { byType: Map<string, number>; byLayer: Map<string, number>; total: number } {
  const byType = new Map<string, number>();
  const byLayer = new Map<string, number>();
  for (const obj of Object.values(doc.objects)) {
    byType.set(obj.type, (byType.get(obj.type) ?? 0) + 1);
    byLayer.set(obj.layerId, (byLayer.get(obj.layerId) ?? 0) + 1);
  }
  return { byType, byLayer, total: Object.keys(doc.objects).length };
}

export function renderReport(result: BuildResult, info: { documentFile: string; durationMs: number }): string {
  const { doc } = result;
  const { byType, byLayer, total } = countObjects(doc);
  const out: string[] = [];
  out.push(`# Rapport d'import — ${doc.name}\n`);
  out.push(`- Source : \`${doc.source?.path}\``);
  out.push(`- Importé le : ${doc.source?.importedAt}`);
  out.push(`- Document : \`${info.documentFile}\` (identifiant \`${doc.id}\`)`);
  out.push(`- Pages : ${doc.pages.map((p) => `${p.name} (\`${p.id}\`)`).join(', ')}`);
  out.push(`- Objets : **${total}** · durée de l'import : ${(info.durationMs / 1000).toFixed(1)} s\n`);

  out.push('## Format\n');
  out.push(`- ${doc.format.name} (\`${doc.format.id}\`) : ${describeTemplate(doc.format)}, ${ORIGIN_LABELS[result.format.origin]}`);
  for (const note of result.format.notes) out.push(`- ${note}`);
  out.push(`- Faces : ${result.format.faces.map((f) => `${f.name} (\`${f.faceId}\`) ← section \`${f.sectionId}\``).join(' ; ')}\n`);

  out.push('## Objets par type\n');
  out.push(table(['Type', 'Nombre'], [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => [`${TYPE_LABELS[t as DocObject['type']] ?? t} (\`${t}\`)`, n])));

  out.push('\n## Objets par calque\n');
  out.push(
    table(
      ['Calque', 'Verrouillé', 'Imprimable', 'Objets'],
      doc.layers.map((l) => [`${l.name} (\`${l.id}\`)`, l.locked ? 'oui' : 'non', l.printable ? 'oui' : 'non', byLayer.get(l.id) ?? 0]),
    ),
  );

  out.push('\n## QR codes\n');
  out.push(
    'Adresses relues en décodant chaque code du design (capture à 8 px par px CSS, jsQR). Les codes sont régénérés en vecteur, niveau de correction M, marge de 4 modules (décision I4).\n',
  );
  out.push(
    table(
      ['Objet', 'Face', 'Position (mm)', 'Adresse', 'Décodé', 'Codage du design', 'Marge du design'],
      result.qrCodes.map((q) => [
        `\`${q.id}\``,
        q.faceId,
        `${q.box.x.toFixed(1)} ; ${q.box.y.toFixed(1)} · ${q.box.w.toFixed(1)} mm`,
        q.url,
        q.decoded ? 'oui' : `**non** (${q.info.error ?? '?'})`,
        qrSettings(q.info),
        `${q.info.designMargin ?? '?'} modules`,
      ]),
    ),
  );

  out.push('\n## Groupes\n');
  for (const page of doc.pages) {
    const names: string[] = [];
    const walk = (ids: string[], depth: number) => {
      for (const id of ids) {
        const obj = doc.objects[id];
        if (obj?.type !== 'group') continue;
        names.push(`${'  '.repeat(depth)}- ${obj.name} (${(obj as GroupObject).children.length} objets)`);
        walk(obj.children, depth + 1);
      }
    };
    walk(page.children, 0);
    out.push(`### ${page.name}\n`);
    out.push(names.length ? names.join('\n') + '\n' : '_Aucun groupe._\n');
  }

  out.push('\n## Éléments ignorés\n');
  out.push(issues(result.skipped));

  out.push('\n## Avertissements\n');
  out.push(issues(result.warnings));

  out.push('\n## Icônes non reconnues\n');
  out.push(result.unknownIcons.length ? issues(result.unknownIcons) : '_Aucune : toutes les icônes ont été retrouvées dans lucide-static._\n');

  out.push('\n## Nuances\n');
  out.push('Une nuance par couleur du design, nommée par rôle (texte principal, titres, QR codes, repères) ou par teinte ; les quasi-doublons (ΔE00 < 1) sont fusionnés.\n');
  out.push(
    table(
      ['Nuance', 'Identifiant', 'RVB', 'Usages', 'Couleurs fusionnées'],
      result.swatches.map((s) => [s.swatch.name, `\`${s.swatch.id}\``, s.swatch.rgb, s.uses, s.merged.join(', ') || '—']),
    ),
  );
  return out.join('\n');
}

/** L'essentiel du rapport, pour l'interface : réponse de POST /api/import/claude-design. */
export interface ImportSummary {
  id: string;
  name: string;
  format: { id: string; name: string; origin: FormatOrigin; originLabel: string; description: string; notes: string[] };
  pages: { id: string; name: string; sectionId: string }[];
  objects: { total: number; byType: Record<string, number> };
  /** Avertissements et icônes non reconnues : ce qui mérite un coup d'œil avant de travailler. */
  warnings: ImportIssue[];
  /** Éléments laissés de côté (invisibles, doublons de fond…), détaillés dans le rapport. */
  skipped: number;
  unknownIcons: number;
  qrCodes: { id: string; faceId: string; url: string; decoded: boolean }[];
  durationMs: number;
}

export function summarizeImport(result: BuildResult, durationMs: number): ImportSummary {
  const { doc } = result;
  const { byType, total } = countObjects(doc);
  return {
    id: doc.id,
    name: doc.name,
    format: {
      id: doc.format.id,
      name: doc.format.name,
      origin: result.format.origin,
      originLabel: ORIGIN_LABELS[result.format.origin],
      description: describeTemplate(doc.format),
      notes: result.format.notes,
    },
    pages: doc.pages.map((p) => ({ id: p.id, name: p.name, sectionId: result.format.faces.find((f) => f.faceId === p.faceId)?.sectionId ?? p.faceId })),
    objects: { total, byType: Object.fromEntries(byType) },
    warnings: [...result.warnings, ...result.unknownIcons],
    skipped: result.skipped.length,
    unknownIcons: result.unknownIcons.length,
    qrCodes: result.qrCodes.map((q) => ({ id: q.id, faceId: q.faceId, url: q.url, decoded: q.decoded })),
    durationMs,
  };
}
