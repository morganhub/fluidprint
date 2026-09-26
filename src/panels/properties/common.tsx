// Briques communes aux sections du panneau Propriétés.
import type { ReactNode } from 'react';
import type { DocObject } from '../../model/types';

/** Valeur commune à tous les objets, ou null si elles diffèrent (affichée « — »). */
export function common<T>(objects: DocObject[], get: (obj: DocObject) => T): T | null {
  if (!objects.length) return null;
  const first = get(objects[0]);
  const key = JSON.stringify(first);
  return objects.every((o) => JSON.stringify(get(o)) === key) ? first : null;
}

/** Comme `common`, mais distingue « valeurs différentes » (`'mixed'`) d'une valeur absente. */
export function commonOrMixed<T>(objects: DocObject[], get: (obj: DocObject) => T): T | 'mixed' {
  if (!objects.length) return 'mixed';
  const first = get(objects[0]);
  const key = JSON.stringify(first ?? null);
  return objects.every((o) => JSON.stringify(get(o) ?? null) === key) ? first : 'mixed';
}

export function Section({ title, children, actions, testId }: { title: string; children: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <section className="border-b border-neutral-200 px-3 py-3" data-section={testId}>
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
        {actions}
      </header>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

/** Ligne étiquetée : libellé à gauche, champ(s) à droite. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-2">
      <span className="truncate text-[12px] text-neutral-600">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** Message d'alerte sous un champ (filet trop fin, QR trop petit…). */
export function Warning({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[12px] text-amber-900">
      {children}
    </p>
  );
}
