/**
 * Lot 42 (O3b) — cartes « À traiter » des ambiguïtés de consolidation
 * (CDC Opérations V1 ch. 20, B19, C19 ; P09) : libellés métier, choix
 * fermés, rendu desktop ET mobile par les composants existants, hiérarchie
 * de la mascotte inchangée. Tests C19-xx.
 */
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
(globalThis as { React?: typeof React }).React = React;

const cards = await import('../operation-cards');
const { selectDisplayedProposals } = await import('../action-model');
const { checkRulesCatalog, getRule, RULE_PRODUCERS } = await import('../rules-catalog');
const { ActionCard, ActionRow } = await import('@/components/to-process/ActionCard');
const { buildTodoBlock, todoTitle, MAX_TODO_ITEMS } = await import('@/services/home/mascot/todo-items');

const SANS_OPERATION = /op[ée]ration/i;
const A = { id: 12, label: 'Devis freinage du 03/06/2026' };
const B = { id: 15, label: 'Facture vidange du 10/04/2026' };

describe('C19 — libellés métier (P09 : jamais « Opération » côté utilisateur)', () => {
  it('C19-01 (a) deux rapprochements exacts : « Ce document concerne-t-il la même intervention que … ou que … ? », deux choix', () => {
    const q = cards.matchQuestion('INTERVENTION', 'CERTAIN', [A, B]);
    const p = cards.matchProposals('INTERVENTION', 'CERTAIN', [A, B]);
    expect(q).toBe('Ce document concerne-t-il la même intervention que « Devis freinage du 03/06/2026 » ou que « Facture vidange du 10/04/2026 » ?');
    expect(p.map((x) => x.value)).toEqual(['SAME:12', 'SAME:15']);
    expect(p.every((x) => !x.isCurrentValue)).toBe(true);
    for (const t of [q, ...p.map((x) => x.label)]) expect(t).not.toMatch(SANS_OPERATION);
  });

  it('C19-02 (a) verdict M3 incertain sur une seule réalité : « Oui » / « Non, c’est une autre intervention » (état actuel, lot 56A : « Oui » sans accord)', () => {
    expect(cards.matchQuestion('INTERVENTION', 'M3', [A])).toBe('Ce document concerne-t-il la même intervention que « Devis freinage du 03/06/2026 » ?');
    const p = cards.matchProposals('INTERVENTION', 'M3', [A]);
    expect(p).toEqual([
      { value: 'SAME:12', label: 'Oui', confidence: 0.6 },
      { value: 'DISTINCT', label: 'Non, c’est une autre intervention', confidence: 1, isCurrentValue: true },
    ]);
    // Tout est affiché (deux propositions + l'état actuel).
    expect(selectDisplayedProposals(cards.matchProposals('INTERVENTION', 'M3', [A, B]))).toHaveLength(3);
    // Nature inconnue : « le même événement », jamais « Opération ».
    expect(cards.matchQuestion(null, 'M3', [A])).toMatch(/^Ce document concerne-t-il le même événement que/);
    for (const t of ['CONTRACT', 'CLAIM', 'ACQUISITION', 'FINANCING', 'DISPOSAL', 'OTHER', null]) {
      expect(cards.matchQuestion(t, 'M3', [A, B])).not.toMatch(SANS_OPERATION);
      for (const x of cards.matchProposals(t, 'M3', [A, B])) expect(x.label).not.toMatch(SANS_OPERATION);
    }
  });

  it('C19-03 (b) parent Sinistre ambigu : deux sinistres + « Non, aucun de ces sinistres » (état actuel)', () => {
    const s1 = { id: 4, label: 'Déclaration dégât des eaux du 02/02/2026' };
    const s2 = { id: 6, label: 'Sinistre du 20/02/2026' };
    expect(cards.parentQuestion([s1, s2])).toBe('Cette intervention fait-elle suite au sinistre « Déclaration dégât des eaux du 02/02/2026 » ou au sinistre « Sinistre du 20/02/2026 » ?');
    expect(cards.parentProposals([s1, s2]).map((x) => [x.value, !!x.isCurrentValue])).toEqual([['PARENT:4', false], ['PARENT:6', false], ['NONE', true]]);
  });

  it('C19-04 (c) montant contradictoire : montants formatés en euros, document source, valeur retenue marquée actuelle', () => {
    expect(cards.amountQuestion('REALIZED_COST')).toBe('Ces documents indiquent des montants différents pour la même dépense : lequel est le bon ?');
    const p = cards.amountProposals([
      { amountMinor: 100000, currency: 'EUR', title: 'Facture garage' },
      { amountMinor: 120000, currency: 'EUR', title: 'Facture garage (copie)' },
    ], { amountMinor: 100000, currency: 'EUR' });
    expect(p.map((x) => x.value)).toEqual(['AMOUNT:120000:EUR', 'AMOUNT:100000:EUR']);
    expect(p[0].label).toMatch(/^1\s?200,00\s€ — « Facture garage \(copie\) »$/);
    expect(p[1]).toMatchObject({ isCurrentValue: true });
    expect(cards.formatAmount(1999, 'USD')).toMatch(/19,99/);
  });
});

describe('C19 — choix fermés (une requête forgée ne désigne rien hors de la carte)', () => {
  it('C19-05 choix valides seulement parmi ceux de la carte', () => {
    const m = { kind: 'operation_match', candidateKey: 'op1', basis: 'CERTAIN', operationIds: [12, 15] };
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'SAME:12', m)).toEqual({ kind: 'SAME', operationId: 12 });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'SAME:99', m)).toBeNull();
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'DISTINCT', m)).toBeNull();
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'DISTINCT', { ...m, basis: 'M3' })).toEqual({ kind: 'DISTINCT' });
    const p = { kind: 'operation_parent', operationId: 3, claimIds: [4, 6] };
    expect(cards.parseOperationCardChoice('OPERATION-CLAIM-PARENT', 'PARENT:6', p)).toEqual({ kind: 'PARENT', operationId: 6 });
    expect(cards.parseOperationCardChoice('OPERATION-CLAIM-PARENT', 'PARENT:7', p)).toBeNull();
    expect(cards.parseOperationCardChoice('OPERATION-CLAIM-PARENT', 'NONE', p)).toEqual({ kind: 'NONE' });
    const a = { kind: 'operation_amount', operationId: 3, fingerprint: 'f', options: [{ amountMinor: 100, currency: 'EUR' }] };
    expect(cards.parseOperationCardChoice('OPERATION-AMOUNT', 'AMOUNT:100:EUR', a)).toEqual({ kind: 'AMOUNT', amountMinor: 100, currency: 'EUR' });
    expect(cards.parseOperationCardChoice('OPERATION-AMOUNT', 'AMOUNT:101:EUR', a)).toBeNull();
    expect(cards.parseOperationCardChoice('OPERATION-AMOUNT', 42, a)).toBeNull();
  });

  it('C19-06 catalogue : trois règles « À traiter » pilotées par leur producteur, jamais « Non applicable », relation par problème', () => {
    expect(checkRulesCatalog()).toEqual([]);
    for (const code of ['OPERATION-MATCH', 'OPERATION-CLAIM-PARENT', 'OPERATION-AMOUNT']) {
      expect(getRule(code)).toMatchObject({ targetType: 'DOCUMENT', producer: 'T3_OPERATIONS', arbitratePriority: 'DO_NEXT', completePriority: null, allowNotApplicable: false });
      expect(getRule(code)!.question).not.toMatch(SANS_OPERATION);
    }
    expect(RULE_PRODUCERS.T3_OPERATIONS.module).toBe('src/services/to-process/operation-cards.ts');
    expect(cards.matchRelationKey('op2')).toBe('operationMatch:op2');
    expect(cards.parentRelationKey(9)).toBe('operationParent:9');
    expect(cards.amountRelationKey(9, 'abcdef0123456789zz')).toBe('operationAmount:9:abcdef0123456789');
  });
});

type View = Parameters<typeof ActionCard>[0]['action'];
const vue = (ruleCode: string, question: string, proposals: View['proposals'], priority: View['priority'] = 'DO_NEXT'): View => ({
  publicId: `a1b2c3d4-${ruleCode.length}`, targetType: 'DOCUMENT', targetId: 42, fieldKey: null, relationKey: 'operationMatch:op1',
  actionKind: 'ARBITRATE', priority, ruleCode, question, proposals, target: { label: 'Facture freinage', assetName: 'Clio' },
});
const noop = () => {};

describe('C19 — rendu desktop ET mobile (composants et tokens existants)', () => {
  const props = cards.matchProposals('INTERVENTION', 'M3', [A, B]).map((p) => ({ value: p.value, label: p.label, ...(p.isCurrentValue ? { isCurrentValue: true } : {}) }));
  const action = vue('OPERATION-MATCH', cards.matchQuestion('INTERVENTION', 'M3', [A, B]), props);

  it('C19-07 vue Cartes (desktop et mobile : mêmes classes adaptatives `sm:`) : question dominante, tous les choix cliquables, état actuel signalé', () => {
    const html = renderToStaticMarkup(h(ActionCard, { action, onChoose: noop, onOpenTarget: noop, visual: true }));
    expect(html).toContain('<h3 class="text-sm font-medium leading-snug">Ce document concerne-t-il la même intervention que');
    expect(html).toContain('Oui, « Devis freinage du 03/06/2026 »');
    expect(html).toContain('Oui, « Facture vidange du 10/04/2026 »');
    expect(html).toContain('Non, c’est une autre intervention');
    expect(html).toContain('(actuelle)');
    // Mise en page mobile (vignette réduite) puis desktop (`sm:`), boutons qui passent à la ligne (zone tactile 36 px).
    expect(html).toMatch(/flex items-start gap-3 sm:gap-4/);
    expect(html).toMatch(/class="[^"]*h-9 max-w-full whitespace-normal/);
    expect(html).not.toMatch(SANS_OPERATION);
  });

  it('C19-08 vue Liste (densité mobile) : mêmes capacités, aucun libellé technique', () => {
    const html = renderToStaticMarkup(h(ActionRow, { action, onChoose: noop, onOpenTarget: noop }));
    expect(html).toContain('Non, c’est une autre intervention');
    expect(html).toMatch(/flex flex-col gap-2[^"]*sm:flex-row/);
    expect(html).not.toMatch(SANS_OPERATION);
  });
});

describe('C19 / MASC3 — mascotte : hiérarchie inchangée', () => {
  it('C19-09 cartes « À faire ensuite » : jamais dans la mascotte (DO_FIRST seulement, deux au plus) ; titres métier', () => {
    const view = (id: string, ruleCode: string, priority: 'DO_FIRST' | 'DO_NEXT') => ({
      ...vue(ruleCode, 'q', [{ value: 'SAME:1', label: 'a' }, { value: 'SAME:2', label: 'b' }], priority), publicId: id, activeSince: new Date().toISOString(),
      allowNotApplicable: false, inputType: null, target: { label: 'Facture' },
    });
    const block = buildTodoBlock([
      view('m', 'OPERATION-MATCH', 'DO_NEXT'), view('p', 'OPERATION-CLAIM-PARENT', 'DO_NEXT'), view('a', 'OPERATION-AMOUNT', 'DO_NEXT'),
      view('x', 'DOC-RUB', 'DO_FIRST'), view('y', 'DATA-CONTRACT-END', 'DO_FIRST'), view('z', 'LINK-ASSET', 'DO_FIRST'),
    ] as never, 6)!;
    expect(block.items.map((i) => i.todoId)).toEqual(['x', 'y']);
    expect(block.items.length).toBeLessThanOrEqual(MAX_TODO_ITEMS);
    expect(block.total).toBe(6);
    expect(todoTitle('OPERATION-MATCH', 'ARBITRATE')).toBe('Document à rapprocher');
    expect(todoTitle('OPERATION-CLAIM-PARENT', 'ARBITRATE')).toBe('Lien avec un sinistre à confirmer');
    expect(todoTitle('OPERATION-AMOUNT', 'ARBITRATE')).toBe('Montant à confirmer');
    expect(getRule('OPERATION-MATCH')!.dueSoonDays).toBeUndefined();
  });
});
