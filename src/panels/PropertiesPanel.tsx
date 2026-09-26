// Panneau Propriétés (tâche 2.7) : un assemblage de sections enregistrées (panels/properties/registry.ts),
// chacune décidant si elle s'applique à la sélection. En sélection multiple, une valeur qui diffère
// d'un objet à l'autre s'affiche « — » ; la saisir l'applique à tous.
import { SlidersHorizontal } from 'lucide-react';
import type { DocObject } from '../model/types';
import { selectedObjects, useEditor, useEditorShallow } from '../store/documentStore';
import { propertySectionRegistry, registerPanel } from '../editor/registry/api';
import './properties/registry';

const TYPE_LABELS: Record<DocObject['type'], string> = {
  text: 'Texte',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Ligne',
  path: 'Tracé',
  frame: 'Cadre',
  icon: 'Icône',
  svg: 'Graphique',
  qr: 'QR code',
  group: 'Groupe',
};

/** Nom lisible d'un objet : son nom, sinon le début de son texte, sinon son type. */
export function objectLabel(obj: DocObject): string {
  if (obj.name) return obj.name;
  if (obj.type === 'text') {
    const text = obj.paragraphs
      .map((p) => p.runs.map((r) => r.text).join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }
  return TYPE_LABELS[obj.type];
}

export function describeSelection(objects: DocObject[]): string {
  if (objects.length === 0) return 'Aucune sélection';
  if (objects.length === 1) return objectLabel(objects[0]);
  return `${objects.length} objets`;
}

export function PropertiesPanel() {
  const doc = useEditor((s) => s.doc);
  const objects = useEditorShallow((s) => selectedObjects(s));
  const sections = propertySectionRegistry.use();
  if (!doc) return null;

  if (!objects.length) {
    return (
      <div className="px-3 py-4 text-[13px] text-neutral-500" data-properties-empty>
        <p className="font-medium text-neutral-700">Aucune sélection</p>
        <p className="mt-1">
          Cliquez sur un objet, ou tracez un lasso autour de plusieurs. Double-cliquez sur un groupe pour atteindre ses éléments.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-neutral-400">Format fini</dt>
          <dd>
            {doc.format.trim.w} × {doc.format.trim.h} mm
          </dd>
          <dt className="text-neutral-400">Fond perdu</dt>
          <dd>{doc.format.bleed} mm</dd>
          <dt className="text-neutral-400">Faces</dt>
          <dd>{doc.pages.length}</dd>
        </dl>
      </div>
    );
  }

  const types = new Set(objects.map((o) => o.type));
  const kind = types.size === 1 ? TYPE_LABELS[objects[0].type] : 'Sélection mixte';
  return (
    <div data-properties-panel>
      <div className="border-b border-neutral-200 px-3 py-2">
        <div className="truncate text-[13px] font-semibold text-neutral-900" data-selection-name>
          {describeSelection(objects)}
        </div>
        <div className="text-[11px] text-neutral-500">{kind}</div>
      </div>
      {sections
        .filter((s) => s.appliesTo(objects, doc))
        .map((s) => (
          <s.component key={s.id} objects={objects} ids={objects.map((o) => o.id)} doc={doc} />
        ))}
    </div>
  );
}

registerPanel({ id: 'properties', title: 'Propriétés', icon: SlidersHorizontal, order: 10, component: PropertiesPanel });
