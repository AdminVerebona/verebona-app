/**
 * Bouton « Annuler l’action » d'un plan EXÉCUTÉ : visible 15 minutes avec
 * le temps restant, absent pour un plan irréversible, absent une fois le
 * délai passé ou l'action annulée.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerebonaCommandPlan, planStatusLabel, undoRemainingMs, formatUndoRemaining } from '../VerebonaCommandPlan';
import type { VerebonaCommandPlan as Plan } from '@/lib/verebona/useVerebona';

(globalThis as { React?: typeof React }).React = React;

const dans = (ms: number) => new Date(Date.now() + ms).toISOString();
const plan = (over: Partial<Plan> = {}): Plan => ({
  planId: 'p1', summary: 'Confirmez-vous ?', expiresAt: dans(-60_000),
  actions: [{ actionId: 'a1', label: 'Créer une échéance', preview: 'Créer l’échéance « Vidange ».', effects: [], dependsOn: [] }],
  status: 'EXECUTED', undoUntil: dans(10 * 60_000), ...over,
});
const render = (p: Plan, withUndo = true) => renderToStaticMarkup(createElement(VerebonaCommandPlan, {
  plan: p, onConfirm: () => {}, onCancel: () => {}, ...(withUndo ? { onUndo: () => {} } : {}),
}));

describe('temps restant', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const at = (iso: string | null, status: Plan['status'] = 'EXECUTED') => undoRemainingMs({ status, undoUntil: iso }, now);

  it('exécuté (ou en partie) et dans la fenêtre : temps restant', () => {
    expect(at('2026-09-28T10:15:00Z')).toBe(15 * 60_000);
    expect(at('2026-09-28T10:00:30Z', 'PARTIAL')).toBe(30_000);
  });

  it('pas de bouton : irréversible, délai passé, date illisible, plan non exécuté ou déjà annulé', () => {
    expect(at(null)).toBeNull();
    expect(at('2026-09-28T10:00:00Z')).toBeNull();
    expect(at('pas une date')).toBeNull();
    for (const s of ['PENDING_CONFIRMATION', 'FAILED', 'UNDONE', 'CANCELLED', 'DECIDING'] as const) {
      expect(at('2026-09-28T10:15:00Z', s)).toBeNull();
    }
  });

  it('affichage : minutes arrondies au-dessus, secondes la dernière minute', () => {
    expect(formatUndoRemaining(15 * 60_000)).toBe('15 min');
    expect(formatUndoRemaining(14 * 60_000 + 1)).toBe('15 min');
    expect(formatUndoRemaining(60_000)).toBe('1 min');
    expect(formatUndoRemaining(59_000)).toBe('59 s');
    expect(formatUndoRemaining(200)).toBe('1 s');
  });
});

describe('VerebonaCommandPlan — action exécutée', () => {
  it('réversible, dans la fenêtre : « Annuler l’action » avec le temps restant', () => {
    const html = render(plan());
    expect(html).toContain('Action effectuée.');
    expect(html).toContain('>Annuler l’action<');
    expect(html).toMatch(/Encore (10|9) min pour annuler\./);
    expect(html).not.toContain('>Confirmer<');
  });

  it('irréversible (pas de fenêtre) : aucun bouton', () => {
    const html = render(plan({ undoUntil: null }));
    expect(html).toContain('Action effectuée.');
    expect(html).not.toContain('<button');
  });

  it('délai de 15 minutes passé : le bouton a disparu', () => {
    expect(render(plan({ undoUntil: dans(-1000) }))).not.toContain('<button');
  });

  it('sans gestionnaire (surface qui ne propose pas l’annulation) : aucun bouton', () => {
    expect(render(plan(), false)).not.toContain('<button');
  });

  it('annulée : état lisible, plus de bouton', () => {
    const html = render(plan({ status: 'UNDONE' }));
    expect(html).toContain('Action annulée — les modifications ont été défaites.');
    expect(html).not.toContain('<button');
    expect(planStatusLabel('UNDONE')).toMatch(/défaites/);
  });

  it('proposition en attente : inchangée (Confirmer / Annuler, sans annulation d’action)', () => {
    const html = render(plan({ status: 'PENDING_CONFIRMATION', expiresAt: dans(10 * 60_000) }));
    expect(html).toContain('>Confirmer<');
    expect(html).toContain('>Annuler<');
    expect(html).not.toContain('Annuler l’action');
  });
});
