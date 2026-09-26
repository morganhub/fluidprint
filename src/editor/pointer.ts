// Suivi d'un geste au pointeur (glisser, tracer, déplacer la vue) : les mouvements sont écoutés sur la
// fenêtre, pour ne rien perdre quand le pointeur sort du plan de travail.

export function trackPointer(
  start: PointerEvent,
  handlers: { move(ev: PointerEvent): void; end(ev: PointerEvent, cancelled: boolean): void },
  captureTarget?: Element | null,
): () => void {
  const pointerId = start.pointerId;
  try {
    captureTarget?.setPointerCapture(pointerId);
  } catch {
    // Pointeur déjà relâché : le geste se terminera au prochain pointerup.
  }
  const move = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) handlers.move(ev);
  };
  const finish = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    stop();
    handlers.end(ev, ev.type === 'pointercancel');
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  return stop;
}

/** Touches de modification tenues en ce moment (Maj pour les proportions, Alt pour dupliquer…). */
export const modifiers = { shift: false, alt: false, space: false };

if (typeof window !== 'undefined') {
  const sync = (e: KeyboardEvent | PointerEvent) => {
    modifiers.shift = e.shiftKey;
    modifiers.alt = e.altKey;
  };
  window.addEventListener('keydown', sync, true);
  window.addEventListener('keyup', sync, true);
  window.addEventListener('pointermove', sync, true);
  window.addEventListener('blur', () => {
    modifiers.shift = modifiers.alt = modifiers.space = false;
  });
}
