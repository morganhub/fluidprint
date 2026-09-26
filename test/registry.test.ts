// Points d'extension : registres (ordre, remplacement, retrait) et lecture des raccourcis clavier.
import { describe, expect, it } from 'vitest';
import { formatCombo, matchesCombo, parseCombo } from '../src/editor/keys';
import { createRegistry } from '../src/editor/registry/core';

const key = (init: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

describe('registres des points d’extension', () => {
  it('trie par ordre puis par enregistrement, remplace un même identifiant, prévient les abonnés', () => {
    const reg = createRegistry<{ id: string; order?: number; label: string }>('essai');
    let calls = 0;
    reg.subscribe(() => calls++);
    reg.register({ id: 'b', order: 20, label: 'B' });
    reg.register({ id: 'a', order: 10, label: 'A' });
    reg.register({ id: 'c', label: 'C' });
    reg.register({ id: 'd', order: 20, label: 'D' });
    expect(reg.list().map((d) => d.id)).toEqual(['a', 'b', 'd', 'c']);
    const off = reg.register({ id: 'b', order: 20, label: 'B2' });
    expect(reg.list().map((d) => d.label)).toEqual(['A', 'B2', 'D', 'C']);
    off();
    expect(reg.get('b')).toBeUndefined();
    expect(calls).toBe(6);
  });
});

describe('raccourcis clavier', () => {
  it('reconnaît Ctrl, Maj et les touches physiques (AZERTY)', () => {
    expect(matchesCombo(key({ key: 'd', code: 'KeyD', ctrlKey: true }), parseCombo('Mod+D'))).toBe(true);
    expect(matchesCombo(key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), parseCombo('Mod+D'))).toBe(false);
    expect(matchesCombo(key({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true }), parseCombo('Mod+Shift+G'))).toBe(true);
    // AZERTY : Ctrl+0 produit « à », la touche physique reste Digit0.
    expect(matchesCombo(key({ key: 'à', code: 'Digit0', ctrlKey: true }), parseCombo('Mod+0'))).toBe(true);
    // « ? » demande Maj sur la plupart des claviers : Maj est ignorée pour ce caractère.
    expect(matchesCombo(key({ key: '?', code: 'Comma', ctrlKey: true, shiftKey: true }), parseCombo('Mod+?'))).toBe(true);
    expect(matchesCombo(key({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }), parseCombo('Shift+ArrowUp'))).toBe(true);
    expect(matchesCombo(key({ key: 'ArrowUp', code: 'ArrowUp' }), parseCombo('Shift+ArrowUp'))).toBe(false);
    expect(parseCombo('Mod++')).toEqual({ mod: true, shift: false, alt: false, key: '+' });
    expect(formatCombo('Mod+Shift+G')).toBe('Ctrl+Maj+G');
    expect(formatCombo('Delete')).toBe('Suppr');
  });
});
