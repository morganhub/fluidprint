import { createStore } from 'zustand/vanilla';

/** Forme posée par l'outil Forme (identifiant de `SHAPE_PRESETS`), réglée dans ses options. */
export const shapeToolStore = createStore<{ preset: string }>(() => ({ preset: 'goutte' }));
