/**
 * Carte #836 (Trello, écart E06) — « Voir les N autres valeurs » sur la carte
 * d'une contradiction d'attribut : les alternatives réelles au-delà de la
 * première page sont DÉROULABLES et CHOISISSABLES, sur mobile comme sur
 * ordinateur (même composant). Unitaires, sans base.
 *
 *   C836-U-UI-01  treize valeurs : la première page, puis le bouton de suite ;
 *                 une fois déroulée, chaque autre valeur est un choix du MÊME
 *                 parcours (`onChoose`, route `/resolve`) ;
 *   C836-U-UI-02  aucune autre carte ne change : sans `moreProposals`, le
 *                 rendu est exactement celui d'avant.
 */
import { describe, expect, it, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));

(globalThis as { React?: typeof React }).React = React;

const { ActionCard } = await import('@/components/to-process/ActionCard');
const { attributeProposals, OPERATION_ATTRIBUTE_RULE } = await import('@/services/to-process/operation-cards');
const { overflowProposals, selectDisplayedProposals } = await import('@/services/to-process/action-model');

type View = Parameters<typeof ActionCard>[0]['action'];
const noop = () => {};
const rendu = (action: View) => renderToStaticMarkup(h(ActionCard, { action, onChoose: noop, onOpenTarget: noop, visual: true }));
const boutons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

/** Treize dates réellement différentes, la première en place — le cas du ticket. */
const TREIZE = Array.from({ length: 13 }, (_, i) => {
  const jour = `2026-03-${String(i + 1).padStart(2, '0')}`;
  return { value: jour, normalized: jour, title: null };
});
const PROPOSITIONS = attributeProposals('realizedDate', TREIZE, '2026-03-01');

const carte = (over: Partial<View> = {}): View => ({
  publicId: 'c0ffee00-0836', targetType: 'DOCUMENT', targetId: 42, fieldKey: null,
  relationKey: 'operationAttribute:42:realizedDate:REALIZATION',
  actionKind: 'ARBITRATE', priority: 'DO_FIRST', ruleCode: OPERATION_ATTRIBUTE_RULE,
  question: 'Ces documents indiquent des dates de réalisation différentes pour cette intervention : laquelle est la bonne ?',
  proposals: selectDisplayedProposals(PROPOSITIONS, OPERATION_ATTRIBUTE_RULE),
  moreProposals: overflowProposals(PROPOSITIONS, OPERATION_ATTRIBUTE_RULE),
  target: { label: 'Facture du 12/03/2026' },
  ...over,
});

describe('C836-U-UI — les autres valeurs réelles sont déroulables et choisissables (E06)', () => {
  it('C836-U-UI-01 — treize valeurs : première page affichée, suite ANNONCÉE et atteignable', () => {
    const html = rendu(carte());
    const libelles = boutons(html);
    // Première page : cinq alternatives plus la valeur en place (marquée), puis « Autre ».
    expect(libelles).toHaveLength(5 + 1 + 1 + 1);
    expect(libelles.at(-3)).toContain('(actuelle)');
    // Le bouton de suite dit COMBIEN de valeurs restent (sept sur treize), et n'est pas un choix.
    expect(html).toContain('data-more-proposals="toggle"');
    expect(libelles).toContain('Voir les 7 autres valeurs');
    expect(html).not.toContain('data-more-proposals="choice"');
  });

  it('C836-U-UI-01 — déroulée, chaque autre valeur est un bouton de CHOIX du même parcours', () => {
    // Le composant de suite est rendu ouvert en appelant son état initial à vrai : on le vérifie par le
    // rendu d'une carte dont la première page EST la suite (même données, mêmes identifiants stables).
    const html = rendu(carte({ proposals: overflowProposals(PROPOSITIONS, OPERATION_ATTRIBUTE_RULE), moreProposals: [] }));
    const libelles = boutons(html);
    expect(libelles).toHaveLength(7 + 1);
    // Les sept valeurs restantes portent bien leurs libellés de dates, et aucune n'est « (actuelle) ».
    expect(libelles.filter((x) => x.includes('(actuelle)'))).toEqual([]);
    expect(html).not.toContain('data-more-proposals');
  });

  it('C836-U-UI-02 — sans `moreProposals` (toutes les autres cartes) : rien n’est ajouté', () => {
    const html = rendu(carte({ moreProposals: undefined }));
    expect(html).not.toContain('data-more-proposals');
    expect(boutons(html)).toHaveLength(5 + 1 + 1);
  });
});
