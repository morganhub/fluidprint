// Panneau Calques (tâches 2.4 et 2.13) : arbre calques → faces → groupes → objets, du dessus vers le
// dessous, comme à l'écran. Œil (masquer), cadenas (verrouiller), imprimable ou non, couleur du cadre de
// sélection par calque ; glisser-déposer pour réordonner ou changer de calque ; double-clic pour
// renommer ; recherche par nom. Le panneau suit la sélection faite sur la page.
//
// Le glisser-déposer est fait aux événements de pointeur (pas au glisser natif HTML) : aperçu et
// indicateur de dépôt maîtrisés, et testable à la souris dans Chrome sans fenêtre.
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Group,
  Image,
  Layers,
  Lock,
  LockOpen,
  Minus,
  PenLine,
  Plus,
  Printer,
  PrinterX,
  QrCode,
  Search,
  Shapes,
  Spline,
  Square,
  Star,
  Trash2,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Input, NativeSelect } from '../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Tooltip } from '../components/ui/tooltip';
import { cn } from '../lib/utils';
import type { DocObject, Id, Layer, LayoutDocument } from '../model/types';
import { defaultLayerId, getEditor, useEditor, useEditorShallow } from '../store/documentStore';
import { ancestorsOf, isSelectable, pageIdOf, parentOf } from '../store/tree';
import { setLocked } from '../editor/lock';
import { registerPanel } from '../editor/registry/api';
import { addLayer, canDropObject, LAYER_COLORS, layerRoots, moveLayer, moveObjectTo, removeLayer, updateLayer, type ObjectDropTarget } from './layerCommands';
import { objectLabel } from './PropertiesPanel';

const TYPE_ICONS: Record<DocObject['type'], LucideIcon> = {
  text: Type,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  path: Spline,
  frame: Image,
  icon: Star,
  svg: Shapes,
  qr: QrCode,
  group: Group,
};

const INDENT_PX = 12;
const DRAG_THRESHOLD_PX = 4;

const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// ---------------------------------------------------------------- lignes de l'arbre

type Row =
  | { kind: 'layer'; key: string; layer: Layer; count: number }
  | { kind: 'face'; key: string; layerId: Id; pageId: Id; name: string; count: number }
  | { kind: 'object'; key: string; id: Id; depth: number; hasChildren: boolean; open: boolean; path?: string };

const layerKey = (id: Id) => `L:${id}`;
const faceKey = (layerId: Id, pageId: Id) => `F:${layerId}:${pageId}`;
const objectKey = (id: Id) => `O:${id}`;

function buildRows(doc: LayoutDocument, collapsed: Set<string>, openGroups: Set<Id>): Row[] {
  const rows: Row[] = [];
  const pushObject = (id: Id, depth: number) => {
    const obj = doc.objects[id];
    if (!obj) return;
    const hasChildren = obj.type === 'group' && obj.children.length > 0;
    const open = hasChildren && openGroups.has(id);
    rows.push({ kind: 'object', key: objectKey(id), id, depth, hasChildren, open });
    if (open && obj.type === 'group') for (const child of [...obj.children].reverse()) pushObject(child, depth + 1);
  };
  for (const layer of [...doc.layers].reverse()) {
    const perPage = doc.pages.map((p) => ({ page: p, roots: p.children.filter((id) => doc.objects[id]?.layerId === layer.id) }));
    rows.push({ kind: 'layer', key: layerKey(layer.id), layer, count: perPage.reduce((n, p) => n + p.roots.length, 0) });
    if (collapsed.has(layerKey(layer.id))) continue;
    for (const { page, roots } of perPage) {
      if (!roots.length) continue;
      const fk = faceKey(layer.id, page.id);
      rows.push({ kind: 'face', key: fk, layerId: layer.id, pageId: page.id, name: page.name, count: roots.length });
      if (collapsed.has(fk)) continue;
      for (const id of [...roots].reverse()) pushObject(id, 1);
    }
  }
  return rows;
}

/** Résultats d'une recherche par nom : objets de tout niveau, avec leur chemin. */
function searchRows(doc: LayoutDocument, query: string): Row[] {
  const q = normalize(query.trim());
  const rows: Row[] = [];
  const visit = (id: Id, trail: string[]) => {
    const obj = doc.objects[id];
    if (!obj) return;
    const label = objectLabel(obj);
    if (normalize(`${label} ${obj.name ?? ''} ${obj.id}`).includes(q)) {
      rows.push({ kind: 'object', key: objectKey(id), id, depth: 0, hasChildren: false, open: false, path: trail.join(' › ') });
    }
    if (obj.type === 'group') for (const child of [...obj.children].reverse()) visit(child, [...trail, label]);
  };
  for (const layer of [...doc.layers].reverse()) {
    for (const page of doc.pages) {
      for (const id of [...page.children].reverse()) if (doc.objects[id]?.layerId === layer.id) visit(id, [layer.name, page.name]);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- actions

/** Retire de la sélection ce qui n'est plus attrapable (calque masqué ou verrouillé, objet masqué). */
function pruneSelection() {
  const s = getEditor();
  if (!s.doc) return;
  const keep = s.selection.filter((id) => isSelectable(s.doc!, id));
  if (keep.length !== s.selection.length) {
    if (keep.length) s.select(keep);
    else s.clearSelection();
  }
}

function toggleLayer(layer: Layer, field: 'visible' | 'locked' | 'printable') {
  const labels = {
    visible: layer.visible ? `Masquer le calque « ${layer.name} »` : `Afficher le calque « ${layer.name} »`,
    locked: layer.locked ? `Déverrouiller le calque « ${layer.name} »` : `Verrouiller le calque « ${layer.name} »`,
    printable: layer.printable ? `Calque « ${layer.name} » non imprimable` : `Calque « ${layer.name} » imprimable`,
  };
  getEditor().apply(labels[field], (d) => updateLayer(d, layer.id, { [field]: !layer[field] }));
  pruneSelection();
}

function toggleHidden(obj: DocObject) {
  getEditor().update([obj.id], { hidden: obj.hidden ? undefined : true }, obj.hidden ? 'Afficher' : 'Masquer');
  pruneSelection();
}

function selectFromRow(id: Id, additive: boolean) {
  const s = getEditor();
  const doc = s.doc;
  if (!doc || !isSelectable(doc, id)) return;
  const current = s.selection;
  if (additive && current.length && parentOf(doc, current[0]) === parentOf(doc, id)) s.select([id], { mode: 'toggle' });
  else s.select([id]);
}

// ---------------------------------------------------------------- petites briques

function IconToggle({ on, onLabel, offLabel, onIcon, offIcon, onClick, toggle, subtle }: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  onIcon: ReactNode;
  offIcon: ReactNode;
  onClick(): void;
  toggle: string;
  /** Affiché seulement au survol de la ligne quand il est dans son état par défaut. */
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={on ? onLabel : offLabel}
      title={on ? onLabel : offLabel}
      data-toggle={toggle}
      aria-pressed={!on}
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 [&_svg]:size-3.5',
        subtle && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}

function RenameInput({ value, onCommit, onCancel }: { value: string; onCommit(v: string): void; onCancel(): void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') onCommit(draft);
    else if (e.key === 'Escape') onCancel();
  };
  return (
    <input
      ref={ref}
      name="layerRename"
      aria-label="Nouveau nom"
      className="h-5 min-w-0 flex-1 rounded border border-sky-500 bg-white px-1 text-[12px] focus:outline-none"
      value={draft}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={onKeyDown}
    />
  );
}

function LayerColorPicker({ layer }: { layer: Layer }) {
  const set = (color: string) => getEditor().apply('Couleur du calque', (d) => updateLayer(d, layer.id, { color }), { coalesce: `layer-color:${layer.id}` });
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Couleur de sélection du calque"
        title="Couleur du cadre de sélection"
        className="size-3.5 shrink-0 rounded-sm border border-black/20"
        style={{ background: layer.color }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        data-layer-color={layer.id}
      />
      <PopoverContent className="w-44" onClick={(e) => e.stopPropagation()}>
        <p className="mb-1.5 text-[11px] font-medium text-neutral-500">Cadre de sélection</p>
        <div className="grid grid-cols-5 gap-1">
          {LAYER_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} className={cn('size-6 rounded border border-black/15', c === layer.color && 'ring-2 ring-sky-500 ring-offset-1')} style={{ background: c }} onClick={() => set(c)} />
          ))}
          <input type="color" aria-label="Autre couleur" className="size-6 cursor-pointer rounded border border-neutral-300 p-0" value={layer.color} onChange={(e) => set(e.target.value)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeleteLayerButton({ doc, layer }: { doc: LayoutDocument; layer: Layer }) {
  const roots = layerRoots(doc, layer.id);
  const others = doc.layers.filter((l) => l.id !== layer.id);
  const [target, setTarget] = useState<string>(() => {
    const i = doc.layers.findIndex((l) => l.id === layer.id);
    return (doc.layers[i - 1] ?? doc.layers[i + 1])?.id ?? '';
  });
  const [open, setOpen] = useState(false);
  const remove = (targetId?: Id) => {
    getEditor().apply(`Supprimer le calque « ${layer.name} »`, (d) => removeLayer(d, layer.id, targetId));
    if (getEditor().activeLayerId === layer.id) getEditor().setActiveLayer(null);
    setOpen(false);
  };
  if (!others.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Supprimer le calque"
        title="Supprimer le calque"
        className="flex size-5 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 hover:bg-red-50 hover:text-red-700 focus-visible:opacity-100 group-hover/row:opacity-100 [&_svg]:size-3.5"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <Trash2 />
      </PopoverTrigger>
      <PopoverContent className="w-60" onClick={(e) => e.stopPropagation()}>
        <p className="mb-2 text-[12px] font-medium">Supprimer le calque « {layer.name} » ?</p>
        {roots.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[12px] text-neutral-600">
              Il contient {roots.length} objet{roots.length > 1 ? 's' : ''}. Les déplacer vers :
            </p>
            <NativeSelect aria-label="Calque de destination" value={target} onChange={(e) => setTarget(e.target.value)}>
              {others.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => remove()}>
                Supprimer aussi les objets
              </Button>
              <Button size="sm" onClick={() => remove(target)}>
                Déplacer et supprimer
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button variant="destructive" size="sm" onClick={() => remove()}>
              Supprimer
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- glisser-déposer

type DragSource = { kind: 'layer'; id: Id } | { kind: 'object'; id: Id };
type DropPosition = 'above' | 'below' | 'inside';
interface DropHint {
  key: string;
  position: DropPosition;
}
interface DragState {
  source: DragSource;
  label: string;
  x: number;
  y: number;
  hint: DropHint | null;
}

/** Ligne sous le pointeur et position de dépôt, ou null si le dépôt n'a pas de sens. */
function dropAt(doc: LayoutDocument, source: DragSource, clientX: number, clientY: number): { hint: DropHint; target: ObjectDropTarget | { type: 'layer-order'; toIndex: number } } | null {
  const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-row-key]');
  if (!el) return null;
  const key = el.dataset.rowKey!;
  const rect = el.getBoundingClientRect();
  const rel = (clientY - rect.top) / Math.max(1, rect.height);
  const [kind, a, b] = key.split(':');
  if (source.kind === 'layer') {
    if (kind !== 'L' || a === source.id) return null;
    const position: DropPosition = rel < 0.5 ? 'above' : 'below';
    const rest = doc.layers.filter((l) => l.id !== source.id);
    const i = rest.findIndex((l) => l.id === a);
    // Liste affichée du dessus vers le dessous : « au-dessus » = rang plus élevé.
    return { hint: { key, position }, target: { type: 'layer-order', toIndex: position === 'above' ? i + 1 : i } };
  }
  let target: ObjectDropTarget;
  let position: DropPosition = 'inside';
  if (kind === 'L') target = { type: 'layer', layerId: a };
  else if (kind === 'F') target = { type: 'layer', layerId: a, pageId: b };
  else {
    const obj = doc.objects[a];
    if (!obj || a === source.id) return null;
    if (obj.type === 'group' && rel > 0.3 && rel < 0.7) target = { type: 'group', groupId: a };
    else {
      position = rel < 0.5 ? 'above' : 'below';
      target = { type: 'object', targetId: a, position };
    }
  }
  if (!canDropObject(doc, source.id, target)) return null;
  return { hint: { key, position }, target };
}

// ---------------------------------------------------------------- le panneau

interface RowHandlers {
  startDrag(e: ReactPointerEvent, source: DragSource, label: string): void;
  consumeClick(): boolean;
  toggleCollapsed(key: string): void;
  toggleGroup(id: Id): void;
  setRenaming(key: string | null): void;
}

const ObjectRow = memo(function ObjectRow({
  obj,
  rowKey,
  depth,
  hasChildren,
  open,
  path,
  selected,
  withinSelection,
  selectable,
  layerColor,
  hint,
  renaming,
  handlers,
}: {
  obj: DocObject;
  rowKey: string;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  path?: string;
  selected: boolean;
  withinSelection: boolean;
  selectable: boolean;
  layerColor: string;
  hint: DropPosition | null;
  renaming: boolean;
  handlers: RowHandlers;
}) {
  const Icon = TYPE_ICONS[obj.type];
  const label = objectLabel(obj);
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      data-row-key={rowKey}
      data-object-row={obj.id}
      data-selected={selected || undefined}
      className={cn(
        'group/row relative flex h-6 cursor-default items-center gap-1 pr-2 text-[12px]',
        selected ? 'bg-sky-100 text-sky-950' : withinSelection ? 'bg-sky-50' : 'hover:bg-neutral-100',
        !selectable && 'text-neutral-400',
        hint === 'inside' && 'bg-sky-100 outline outline-1 -outline-offset-1 outline-sky-500',
      )}
      style={{ paddingLeft: 6 + depth * INDENT_PX }}
      onPointerDown={(e) => handlers.startDrag(e, { kind: 'object', id: obj.id }, label)}
      onClick={(e) => {
        if (handlers.consumeClick()) return;
        selectFromRow(obj.id, e.shiftKey || e.ctrlKey || e.metaKey);
      }}
      onDoubleClick={() => handlers.setRenaming(rowKey)}
    >
      {hint === 'above' && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-sky-500" />}
      {hint === 'below' && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-sky-500" />}
      {hasChildren ? (
        <button
          type="button"
          aria-label={open ? 'Replier' : 'Déplier'}
          className="flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 hover:text-neutral-800"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            handlers.toggleGroup(obj.id);
          }}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <span className="h-3 w-0.5 shrink-0 rounded" style={{ background: selected ? layerColor : 'transparent' }} />
      <Icon className="size-3.5 shrink-0 text-neutral-400" />
      {renaming ? (
        <RenameInput
          value={obj.name ?? label}
          onCancel={() => handlers.setRenaming(null)}
          onCommit={(v) => {
            handlers.setRenaming(null);
            const name = v.trim();
            if (name !== (obj.name ?? label)) getEditor().update([obj.id], { name: name || undefined }, 'Renommer');
          }}
        />
      ) : (
        <span className={cn('min-w-0 flex-1 truncate', obj.hidden && 'italic line-through decoration-neutral-300')}>
          {label}
          {path && <span className="ml-1.5 text-[11px] text-neutral-400">{path}</span>}
        </span>
      )}
      <IconToggle
        toggle="hidden"
        on={!obj.hidden}
        subtle={!obj.hidden}
        onLabel="Masquer"
        offLabel="Afficher"
        onIcon={<Eye />}
        offIcon={<EyeOff />}
        onClick={() => toggleHidden(obj)}
      />
      <IconToggle
        toggle="locked"
        on={!obj.locked}
        subtle={!obj.locked}
        onLabel="Verrouiller"
        offLabel="Déverrouiller"
        onIcon={<LockOpen />}
        offIcon={<Lock />}
        onClick={() => setLocked([obj.id], !obj.locked)}
      />
    </div>
  );
});

export function LayersPanel() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditorShallow((s) => s.selection);
  const activeLayer = useEditor((s) => (s.doc ? defaultLayerId(s.doc, s.activeLayerId) : null));
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [openGroups, setOpenGroups] = useState<Set<Id>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Le panneau suit la sélection : calque, face et groupes parents dépliés, ligne ramenée à la vue.
  useEffect(() => {
    if (!doc || !selection.length) return;
    const groups = new Set(openGroups);
    const unfold = new Set(collapsed);
    let changed = false;
    for (const id of selection) {
      const obj = doc.objects[id];
      const page = pageIdOf(doc, id);
      if (!obj || !page) continue;
      for (const key of [layerKey(obj.layerId), faceKey(obj.layerId, page)]) if (unfold.delete(key)) changed = true;
      for (const a of ancestorsOf(doc, id)) {
        if (!groups.has(a)) {
          groups.add(a);
          changed = true;
        }
      }
    }
    if (changed) {
      setOpenGroups(groups);
      setCollapsed(unfold);
    }
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-object-row="${CSS.escape(selection[0])}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }, [selection]);

  const rows = useMemo(() => (doc ? (query.trim() ? searchRows(doc, query) : buildRows(doc, collapsed, openGroups)) : []), [doc, query, collapsed, openGroups]);

  const handlers = useRef<RowHandlers>(null as unknown as RowHandlers);
  handlers.current = {
    consumeClick() {
      const v = suppressClick.current;
      suppressClick.current = false;
      return v;
    },
    toggleCollapsed(key) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    },
    toggleGroup(id) {
      setOpenGroups((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    },
    setRenaming,
    startDrag(e, source, label) {
      if (e.button !== 0 || (e.target as HTMLElement).closest('input')) return;
      const start = { x: e.clientX, y: e.clientY };
      let started = false;
      let last: ReturnType<typeof dropAt> = null;
      const move = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD_PX) return;
          started = true;
        }
        const d = getEditor().doc;
        last = d ? dropAt(d, source, ev.clientX, ev.clientY) : null;
        setDrag({ source, label, x: ev.clientX, y: ev.clientY, hint: last?.hint ?? null });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        setDrag(null);
        if (!started) return;
        // Le clic qui suit le relâcher ne doit pas changer la sélection.
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        const d = getEditor().doc;
        if (ev.type === 'pointercancel' || !d) return;
        const drop = dropAt(d, source, ev.clientX, ev.clientY);
        if (!drop) return;
        if (drop.target.type === 'layer-order') {
          const toIndex = drop.target.toIndex;
          getEditor().apply('Réordonner les calques', (draft) => moveLayer(draft, source.id, toIndex));
          return;
        }
        const target = drop.target;
        const moved = getEditor().apply(target.type === 'layer' ? 'Changer de calque' : 'Réordonner', (draft) => moveObjectTo(draft, source.id, target));
        const after = getEditor();
        if (moved && after.doc && isSelectable(after.doc, source.id)) after.select([source.id]);
        else pruneSelection();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
  };
  const stableHandlers = useMemo<RowHandlers>(
    () => ({
      startDrag: (...a) => handlers.current.startDrag(...a),
      consumeClick: () => handlers.current.consumeClick(),
      toggleCollapsed: (k) => handlers.current.toggleCollapsed(k),
      toggleGroup: (id) => handlers.current.toggleGroup(id),
      setRenaming: (k) => handlers.current.setRenaming(k),
    }),
    [],
  );

  if (!doc) return null;
  const selected = new Set(selection);
  const withinSelection = (id: Id) => ancestorsOf(doc, id).some((a) => selected.has(a));
  const layerOf = (id: Id) => doc.layers.find((l) => l.id === doc.objects[id]?.layerId);

  const newLayer = () => {
    const id = getEditor().apply('Nouveau calque', (d) => addLayer(d));
    if (id) {
      getEditor().setActiveLayer(id);
      setRenaming(layerKey(id));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col select-none" data-layers-panel>
      <div className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-neutral-400" />
          <Input name="layerSearch" aria-label="Rechercher un objet par son nom" placeholder="Rechercher…" className="pl-7" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" aria-label="Effacer la recherche" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-800" onClick={() => setQuery('')}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Tooltip content="Nouveau calque">
          <Button variant="ghost" size="icon-sm" aria-label="Nouveau calque" data-action="add-layer" onClick={newLayer}>
            <Plus />
          </Button>
        </Tooltip>
      </div>
      <div ref={listRef} role="tree" aria-label="Calques" className="min-h-0 flex-1 overflow-y-auto pb-6">
        {query.trim() && !rows.length && <p className="px-3 py-3 text-[12px] text-neutral-500">Aucun objet ne porte ce nom.</p>}
        {rows.map((row) => {
          const hint = drag?.hint?.key === row.key ? drag.hint.position : null;
          if (row.kind === 'layer') {
            const { layer } = row;
            const isCollapsed = collapsed.has(row.key);
            return (
              <div
                key={row.key}
                role="treeitem"
                aria-expanded={!isCollapsed}
                data-row-key={row.key}
                data-layer-row={layer.id}
                className={cn(
                  'group/row relative mt-px flex h-7 cursor-default items-center gap-1.5 border-y border-neutral-100 bg-neutral-50 pl-1.5 pr-2 text-[12px] font-medium hover:bg-neutral-100',
                  !layer.visible && 'text-neutral-400',
                  hint === 'inside' && 'bg-sky-100 outline outline-1 -outline-offset-1 outline-sky-500',
                )}
                onPointerDown={(e) => stableHandlers.startDrag(e, { kind: 'layer', id: layer.id }, layer.name)}
                onClick={() => {
                  if (stableHandlers.consumeClick()) return;
                  getEditor().setActiveLayer(layer.id);
                }}
                onDoubleClick={() => setRenaming(row.key)}
              >
                {hint === 'above' && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-sky-500" />}
                {hint === 'below' && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-sky-500" />}
                <button
                  type="button"
                  aria-label={isCollapsed ? 'Déplier le calque' : 'Replier le calque'}
                  className="flex size-4 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-800"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    stableHandlers.toggleCollapsed(row.key);
                  }}
                >
                  {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                </button>
                <LayerColorPicker layer={layer} />
                {renaming === row.key ? (
                  <RenameInput
                    value={layer.name}
                    onCancel={() => setRenaming(null)}
                    onCommit={(v) => {
                      setRenaming(null);
                      if (v.trim() && v.trim() !== layer.name) getEditor().apply('Renommer le calque', (d) => updateLayer(d, layer.id, { name: v }));
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate" data-layer-name>
                    {layer.name}
                  </span>
                )}
                {activeLayer === layer.id && (
                  <span title="Calque actif : les nouveaux objets y sont créés" data-active-layer className="text-sky-700">
                    <PenLine className="size-3" />
                  </span>
                )}
                <span className="w-5 text-right text-[11px] font-normal tabular-nums text-neutral-400">{row.count || ''}</span>
                <DeleteLayerButton doc={doc} layer={layer} />
                <IconToggle toggle="printable" on={layer.printable} onLabel="Ne pas imprimer ce calque" offLabel="Imprimer ce calque" onIcon={<Printer />} offIcon={<PrinterX className="text-amber-600" />} onClick={() => toggleLayer(layer, 'printable')} />
                <IconToggle toggle="visible" on={layer.visible} onLabel="Masquer le calque" offLabel="Afficher le calque" onIcon={<Eye />} offIcon={<EyeOff />} onClick={() => toggleLayer(layer, 'visible')} />
                <IconToggle toggle="locked" on={!layer.locked} onLabel="Verrouiller le calque" offLabel="Déverrouiller le calque" onIcon={<LockOpen />} offIcon={<Lock />} onClick={() => toggleLayer(layer, 'locked')} />
              </div>
            );
          }
          if (row.kind === 'face') {
            const isCollapsed = collapsed.has(row.key);
            return (
              <div
                key={row.key}
                data-row-key={row.key}
                data-face-row={`${row.layerId}:${row.pageId}`}
                className={cn('relative flex h-6 items-center gap-1 pl-4 pr-2 text-[11px] text-neutral-500', hint && 'bg-sky-100 outline outline-1 -outline-offset-1 outline-sky-500')}
              >
                <button
                  type="button"
                  aria-label={isCollapsed ? 'Déplier la face' : 'Replier la face'}
                  className="flex size-4 items-center justify-center text-neutral-400 hover:text-neutral-800"
                  onClick={() => stableHandlers.toggleCollapsed(row.key)}
                >
                  {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                </button>
                <span className="flex-1 truncate uppercase tracking-wide">{row.name}</span>
                <span className="tabular-nums text-neutral-400">{row.count}</span>
              </div>
            );
          }
          const obj = doc.objects[row.id];
          if (!obj) return null;
          return (
            <ObjectRow
              key={row.key}
              obj={obj}
              rowKey={row.key}
              depth={row.depth}
              hasChildren={row.hasChildren}
              open={row.open}
              path={row.path}
              selected={selected.has(row.id)}
              withinSelection={withinSelection(row.id)}
              selectable={isSelectable(doc, row.id)}
              layerColor={layerOf(row.id)?.color ?? '#2563eb'}
              hint={hint}
              renaming={renaming === row.key}
              handlers={stableHandlers}
            />
          );
        })}
      </div>
      {drag && (
        <div
          className="pointer-events-none fixed z-50 max-w-56 truncate rounded bg-neutral-900/85 px-2 py-0.5 text-[11px] text-white shadow"
          style={{ left: drag.x + 12, top: drag.y + 8 }}
          data-layers-drag
        >
          {drag.label}
        </div>
      )}
    </div>
  );
}

registerPanel({ id: 'layers', title: 'Calques', icon: Layers, order: 20, component: LayersPanel });
