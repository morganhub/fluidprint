import { useStore } from 'zustand';
import { SHAPE_PRESETS } from '../../model/shapes';
import { Button } from '../../components/ui/button';
import { shapeToolStore } from './shapeToolStore';

/** Choix de la forme posée par l'outil Forme (les formes de `SHAPE_PRESETS`). */
export function ShapeToolOptions() {
  const preset = useStore(shapeToolStore, (s) => s.preset);
  return (
    <div className="flex w-48 flex-col gap-1">
      <div className="px-1 text-[11px] font-medium text-neutral-500">Forme à poser</div>
      {Object.values(SHAPE_PRESETS).map((p) => (
        <Button
          key={p.id}
          variant="toggle"
          size="sm"
          className="justify-start"
          aria-pressed={preset === p.id}
          onClick={() => shapeToolStore.setState({ preset: p.id })}
        >
          <svg viewBox="0 0 1 1" className="size-4" preserveAspectRatio="xMidYMid meet" aria-hidden>
            <path d={p.d} fill="currentColor" />
          </svg>
          {p.name}
        </Button>
      ))}
    </div>
  );
}
