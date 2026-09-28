/**
 * Aperçu d'une commande proposée : bouton « Annuler » tant que la proposition
 * est en attente et valable ; état lisible une fois close (annulée, expirée,
 * exécutée) — y compris à la reprise d'un fil.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerebonaCommandPlan, planStatusLabel } from '../VerebonaCommandPlan';
import type { VerebonaCommandPlan as Plan } from '@/lib/verebona/useVerebona';

// Le harnais (environnement node) compile le JSX en `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const plan = (over: Partial<Plan> = {}): Plan => ({
  planId: 'p1', summary: 'Confirmez-vous ?', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  actions: [{ actionId: 'a1', label: 'Créer une échéance', preview: 'Créer l’échéance « Vidange » le 3 octobre 2026.', effects: [], dependsOn: [] }],
  status: 'PENDING_CONFIRMATION', ...over,
});
const render = (p: Plan) => renderToStaticMarkup(createElement(VerebonaCommandPlan, { plan: p, onConfirm: () => {}, onCancel: () => {} }));

describe('VerebonaCommandPlan', () => {
  it('en attente : « Confirmer » et « Annuler », avec l’heure de validité', () => {
    const html = render(plan());
    expect(html).toContain('>Confirmer<');
    expect(html).toContain('>Annuler<');
    expect(html).toContain('Rien n’est modifié sans votre confirmation');
    expect(html).toMatch(/valable jusqu’à \d{2}:\d{2}/);
  });

  it('annulée : plus de bouton, « rien n’a été modifié »', () => {
    const html = render(plan({ status: 'CANCELLED' }));
    expect(html).not.toContain('>Annuler<');
    expect(html).toContain('Action annulée — rien n’a été modifié.');
  });

  it('en attente mais échue : affichée comme expirée, sans bouton', () => {
    const html = render(plan({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(html).not.toContain('>Confirmer<');
    expect(html).toContain('Proposition expirée — rien n’a été modifié.');
  });

  it('décision en cours d’envoi : aucun bouton (pas de double décision)', () => {
    expect(render(plan({ status: 'DECIDING' }))).not.toContain('<button');
  });

  it('libellés des états clos', () => {
    expect(planStatusLabel('EXECUTED')).toBe('Action effectuée.');
    expect(planStatusLabel('REFUSED')).toMatch(/rien n’a été modifié/);
    expect(planStatusLabel('EXPIRED')).toMatch(/expirée/);
  });
});
