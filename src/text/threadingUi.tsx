// Texte chaîné (tâche 4.12), côté éditeur : section « Chaînage » du panneau Propriétés et liens entre
// blocs dessinés sur le plan de travail (écran seulement). Deux blocs texte sélectionnés l'un après
// l'autre se chaînent dans l'ordre du clic ; un bloc chaîné peut rompre le lien qui le suit ou quitter
// la chaîne. Le texte ne se perd jamais : il reste dans l'article, porté par le premier bloc.
import { Link2, Unlink } from 'lucide-react';
import { Button } from '../components/ui/button';
import { registerOverlay, registerPropertySection, type PageOverlayProps, type PropertySectionProps } from '../editor/registry/api';
import { chainFrames, isChained, linkFrames, linkRefusal, LINK_REFUSAL_MESSAGES, removeFromChain, unlinkAfter } from '../model/threading';
import type { DocObject, TextObject } from '../model/types';
import { PX_PER_MM } from '../model/units';
import { getEditor, useEditor, useEditorShallow } from '../store/documentStore';
import { pageIdOf } from '../store/tree';
import { Section, Warning } from '../panels/properties/common';

/** Chaîne `fromId` → `toId` (une étape d'annulation) ; renvoie le message de refus, ou null. */
export function linkTextFrames(fromId: string, toId: string): string | null {
  const s = getEditor();
  if (!s.doc) return 'Aucun document';
  const refusal = linkRefusal(s.doc, fromId, toId);
  if (refusal) return LINK_REFUSAL_MESSAGES[refusal];
  s.apply('Chaîner le texte', (d) => linkFrames(d, fromId, toId), { select: [toId] });
  return null;
}

function ChainSection({ objects, doc }: PropertySectionProps) {
  const selection = useEditorShallow((s) => s.selection);
  if (objects.length === 2) {
    // Ordre du clic : le premier sélectionné est celui dont le texte déborde.
    const [a, b] = selection.length === 2 ? selection : objects.map((o) => o.id);
    const refusal = linkRefusal(doc, a, b);
    return (
      <Section title="Chaînage" testId="text-chain">
        <Button variant="outline" size="sm" data-action="chain-link" disabled={!!refusal} onClick={() => linkTextFrames(a, b)}>
          <Link2 />
          Chaîner : le texte continue dans le 2ᵉ bloc
        </Button>
        {refusal && <Warning>{LINK_REFUSAL_MESSAGES[refusal]}</Warning>}
      </Section>
    );
  }
  const obj = objects[0] as TextObject;
  if (!isChained(doc, obj.id)) {
    return (
      <Section title="Chaînage" testId="text-chain">
        <p className="text-[12px] leading-snug text-neutral-500">Sélectionner ce bloc puis, avec Maj, le bloc où le texte doit continuer.</p>
      </Section>
    );
  }
  const frames = chainFrames(doc, obj.id);
  const rank = frames.indexOf(obj.id);
  return (
    <Section title="Chaînage" testId="text-chain">
      <p className="text-[12px] text-neutral-700" data-chain-rank={`${rank + 1}/${frames.length}`}>
        Bloc {rank + 1} sur {frames.length}
        {rank > 0 ? ' : le texte vient du bloc précédent.' : ' : le texte continue dans le bloc suivant.'}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {obj.nextId && (
          <Button variant="outline" size="sm" data-action="chain-unlink" onClick={() => getEditor().apply('Rompre le chaînage', (d) => unlinkAfter(d, obj.id))}>
            <Unlink />
            Rompre après ce bloc
          </Button>
        )}
        <Button variant="ghost" size="sm" data-action="chain-remove" onClick={() => getEditor().apply('Retirer de la chaîne', (d) => removeFromChain(d, obj.id))}>
          Retirer de la chaîne
        </Button>
      </div>
    </Section>
  );
}

const textsOnly = (objects: DocObject[]) => objects.length >= 1 && objects.length <= 2 && objects.every((o) => o.type === 'text');

registerPropertySection({ id: 'text-chain', title: 'Chaînage', order: 37, appliesTo: textsOnly, component: ChainSection });

// ---------------------------------------------------------------- liens à l'écran

/** Pour les blocs chaînés sélectionnés : un trait du coin bas-droit de chaque bloc au coin haut-gauche du suivant. */
function ChainLinks({ doc, page, zoom }: PageOverlayProps) {
  const selection = useEditorShallow((s) => s.selection);
  const mode = useEditor((s) => s.mode);
  if (mode) return null;
  const shown = new Set<string>();
  for (const id of selection) if (isChained(doc, id)) chainFrames(doc, id).forEach((f) => shown.add(f));
  if (!shown.size) return null;
  const px = 1 / (PX_PER_MM * zoom);
  const port = 7 * px;
  const links: { from: TextObject; to: TextObject }[] = [];
  const frames = [...shown].map((id) => doc.objects[id] as TextObject);
  for (const f of frames) if (f.nextId && shown.has(f.nextId)) links.push({ from: f, to: doc.objects[f.nextId] as TextObject });
  const here = (o: TextObject) => pageIdOf(doc, o.id) === page.id;
  return (
    <svg data-chain-links style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible' }} viewBox={`0 0 ${doc.format.trim.w + 2 * doc.format.bleed} ${doc.format.trim.h + 2 * doc.format.bleed}`}>
      {links.filter((l) => here(l.from) && here(l.to)).map((l) => (
        <line
          key={l.from.id}
          data-chain-link={`${l.from.id}>${l.to.id}`}
          x1={l.from.x + l.from.w}
          y1={l.from.y + l.from.h}
          x2={l.to.x}
          y2={l.to.y}
          stroke="#1f7ae0"
          strokeWidth={1.5 * px}
          strokeDasharray={`${4 * px} ${3 * px}`}
        />
      ))}
      {frames.filter(here).map((f) => (
        <g key={f.id} fill="#ffffff" stroke="#1f7ae0" strokeWidth={px}>
          {chainFrames(doc, f.id)[0] !== f.id && <rect x={f.x - port / 2} y={f.y - port / 2} width={port} height={port} />}
          {f.nextId && <rect x={f.x + f.w - port / 2} y={f.y + f.h - port / 2} width={port} height={port} fill="#1f7ae0" />}
        </g>
      ))}
    </svg>
  );
}

registerOverlay({ id: 'chain-links', order: 45, space: 'page', component: ChainLinks });
