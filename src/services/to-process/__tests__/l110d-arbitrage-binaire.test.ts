/**
 * Lot 110D — arbitrage « même réalité » : une question Oui / Non par
 * Opération candidate (ticket « Arbitrage Opération : Oui / Non au lieu de
 * « A ou B ? » »).
 *
 *   L110D-U-01 question : libellé métier depuis le TYPE de l'Opération
 *              (achat, intervention, contrat, sinistre, financement, vente),
 *              repli « le même événement de référence » ; documents /
 *              événements ; jamais « opération » ; aucun titre dans la question ;
 *   L110D-U-02 propositions : exactement Oui / Non, aucune par référence, aucune
 *              présélectionnée ;
 *   L110D-U-03 réponses : YES / NO sur l'Opération affichée ; autre Opération,
 *              ancien DISTINCT → CHANGED ; ancienne valeur SAME sur la même → Oui ;
 *              anciennes cartes toujours lues par l'ancien analyseur ;
 *   L110D-U-04 contexte : operationId / candidateOperationId, références
 *              structurées triées et bornées, empreinte stable, autres candidates
 *              non présentées ;
 *   L110D-U-05 carte (web et mobile, même composant) : références cliquables
 *              (titre complet, type · date) AVANT les boutons, Oui / Non seuls,
 *              pas de « Autre » ; anciennes cartes inchangées ;
 *   L110D-U-06 lecture : références listées retirées des liens directs ; contrôle
 *              de cohérence : ancienne forme encore ouverte → réparable.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));
(globalThis as { React?: typeof React }).React = React;

const B = await import('@/services/to-process/operation-match-binary');
const cards = await import('@/services/to-process/operation-cards');
const { ActionCard } = await import('@/components/to-process/ActionCard');
const { withoutListedReferences } = await import('@/services/to-process/to-process-query.service');
const { operationCardAnomaly } = await import('@/services/coherence/registry/checks/to-process-families');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const SANS_OPERATION = /op[ée]ration/i;
const doc = (id: number, title: string, date: string | null, typeLabel: string | null = 'Facture') => ({ kind: 'document' as const, id, title, typeLabel, date });
const evt = (id: number, title: string, date: string | null) => ({ kind: 'event' as const, id, title, typeLabel: 'Événement', date });

describe('L110D-U-01 — une question binaire, libellé métier fiable', () => {
  it('types variés (achat, réparation / travaux = intervention, assurance / abonnement = contrat, sinistre, financement, vente) ; aucun codage immobilier', () => {
    const refs = [doc(1, 'Compromis de vente', '2026-01-10'), doc(2, 'Attestation de propriété', '2026-03-02')];
    expect(B.binaryMatchQuestion('ACQUISITION', refs)).toBe('Ce document concerne-t-il le même achat que les documents suivants ?');
    expect(B.binaryMatchQuestion('INTERVENTION', refs)).toBe('Ce document concerne-t-il la même intervention que les documents suivants ?');
    expect(B.binaryMatchQuestion('CONTRACT', refs)).toBe('Ce document concerne-t-il le même contrat que les documents suivants ?');
    expect(B.binaryMatchQuestion('CLAIM', refs)).toMatch(/le même sinistre/);
    expect(B.binaryMatchQuestion('FINANCING', refs)).toMatch(/le même financement/);
    expect(B.binaryMatchQuestion('DISPOSAL', refs)).toMatch(/la même vente/);
    const code = lire('src/services/to-process/operation-match-binary.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/IMMOBILIER|compromis|notaire|attestation/i);
  });

  it('repli conforme à la règle permanente : « le même événement de référence » (jamais « la même opération »)', () => {
    for (const t of [null, 'OTHER', 'INCONNU']) {
      const q = B.binaryMatchQuestion(t, [doc(1, 'A', null)]);
      expect(q).toBe('Ce document concerne-t-il le même événement de référence que le document suivant ?');
      expect(q).not.toMatch(SANS_OPERATION);
    }
  });

  it('documents, événements de l’Agenda, ou les deux ; aucune référence : désignation persistée, jamais un titre inventé', () => {
    expect(B.binaryMatchQuestion('INTERVENTION', [evt(9, 'Entretien chaudière', '2026-02-01')])).toBe('Ce document concerne-t-il la même intervention que l’événement suivant ?');
    expect(B.binaryMatchQuestion('INTERVENTION', [doc(1, 'Devis', null), evt(9, 'RDV', null)])).toBe('Ce document concerne-t-il la même intervention que les documents et événements suivants ?');
    expect(B.binaryMatchQuestion('INTERVENTION', [], { provider: 'Garage Martin', date: '2026-06-03' })).toBe('Ce document concerne-t-il la même intervention (« Garage Martin » du 03/06/2026) ?');
    expect(B.binaryMatchQuestion(null, [])).not.toMatch(SANS_OPERATION);
    // Aucun titre de document dans la question (les références sont listées à part, sans troncature).
    expect(B.binaryMatchQuestion('ACQUISITION', [doc(1, 'Un titre très long qui ne doit jamais apparaître dans la question', null)])).not.toContain('titre');
  });
});

describe('L110D-U-02 — deux boutons : Oui / Non', () => {
  it('exactement deux propositions, aucune « Oui, [nom] », aucune valeur actuelle présélectionnée', () => {
    const p = B.binaryMatchProposals(42);
    expect(p.map((x) => [x.value, x.label])).toEqual([['YES:42', 'Oui'], ['NO:42', 'Non']]);
    expect(p.some((x) => x.isCurrentValue)).toBe(false);
  });
});

describe('L110D-U-03 — réponse liée à l’Opération affichée', () => {
  const ctx = B.buildBinaryMatchContext({ candidateKey: 'op1', basis: 'CERTAIN', operationId: 12, others: [15], operationType: 'ACQUISITION', references: [] });
  it('YES / NO valides ; autre Opération ou ancien DISTINCT → CHANGED (refusé STALE, jamais réinterprété) ; ancienne valeur SAME même Opération → Oui', () => {
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'YES:12', ctx)).toEqual({ kind: 'SAME', operationId: 12 });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'NO:12', ctx)).toEqual({ kind: 'NOT_SAME', operationId: 12 });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'SAME:12', ctx)).toEqual({ kind: 'SAME', operationId: 12 });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'YES:15', ctx)).toEqual({ kind: 'CHANGED' });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'SAME:15', ctx)).toEqual({ kind: 'CHANGED' });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'DISTINCT', ctx)).toEqual({ kind: 'CHANGED' });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'AUTRE', ctx)).toBeNull();
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 12, ctx)).toBeNull();
  });
  it('ancienne carte « A ou B ? » : toujours répondable avec ses anciennes valeurs', () => {
    const ancien = { kind: 'operation_match', candidateKey: 'op1', basis: 'CERTAIN', operationIds: [12, 15] };
    expect(B.isBinaryMatchContext(ancien)).toBe(false);
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'SAME:15', ancien)).toEqual({ kind: 'SAME', operationId: 15 });
    expect(cards.parseOperationCardChoice('OPERATION-MATCH', 'YES:15', ancien)).toBeNull();
  });
});

describe('L110D-U-04 — contexte de l’action', () => {
  it('operationId / candidateOperationId, références triées (chronologie) et bornées, empreinte stable, autres candidates non présentées', () => {
    const refs = Array.from({ length: B.OPERATION_MATCH_MAX_REFERENCES + 3 }, (_, i) => doc(100 + i, `Pièce ${i}`, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`));
    const c = B.buildBinaryMatchContext({ candidateKey: 'k', basis: 'M3', operationId: 7, others: [7, 8, 9], operationType: 'CONTRACT', references: [...refs].reverse() });
    expect(c).toMatchObject({ kind: 'operation_match', form: 'BINARY', version: 2, operationId: 7, candidateOperationId: 7, operationIds: [7], otherCandidateOperationIds: [8, 9], operationType: 'CONTRACT' });
    expect(c.references).toHaveLength(B.OPERATION_MATCH_MAX_REFERENCES);
    expect(c.referenceCount).toBe(refs.length);
    expect(c.references.map((r) => r.date)).toEqual([...c.references.map((r) => r.date)].sort());
    expect(c.contextFingerprint).toBe(B.binaryMatchFingerprint(7, 'CONTRACT', refs));
    expect(B.binaryMatchFingerprint(7, 'CONTRACT', refs)).toBe(B.binaryMatchFingerprint(7, 'CONTRACT', [...refs].reverse()));
    expect(B.binaryMatchFingerprint(7, 'CONTRACT', refs)).not.toBe(B.binaryMatchFingerprint(7, 'CONTRACT', refs.slice(1)));
    expect(B.binaryMatchFingerprint(7, 'CONTRACT', refs)).not.toBe(B.binaryMatchFingerprint(8, 'CONTRACT', refs));
    expect(B.isBinaryMatchContext(c)).toBe(true);
  });
  it('vue : type · date (format français), compteur au-delà du plafond, document de la carte exclu', () => {
    expect(B.referenceMeta(doc(1, 'x', '2026-03-12'))).toBe('Facture · 12/03/2026');
    expect(B.referenceMeta(doc(1, 'x', null, null))).toBe('Document');
    expect(B.referenceMeta(evt(2, 'x', '2026-04-01'))).toBe('Événement · 01/04/2026');
    const v = B.referencesView(Array.from({ length: B.OPERATION_MATCH_MAX_REFERENCES + 2 }, (_, i) => doc(i + 1, `P${i}`, null)));
    expect(v.items).toHaveLength(B.OPERATION_MATCH_MAX_REFERENCES);
    expect(v.hidden).toBe(2);
    const all = new Map([[5, [doc(1, 'A', null), doc(2, 'C', null), evt(3, 'E', null)]]]);
    expect(B.referencesForCard(all, 5, 2).map((r) => `${r.kind}:${r.id}`)).toEqual(['document:1', 'event:3']);
    expect(B.referencesForCard(all, 6, 2)).toEqual([]);
  });
});

describe('L110D-U-05 — carte web / mobile (même composant)', () => {
  const vue = (over: Record<string, unknown> = {}) => ({
    publicId: 'aaaaaaaa-0000-4000-8000-000000000001', targetType: 'DOCUMENT' as const, targetId: 3, fieldKey: null, relationKey: 'operationMatch:op1',
    actionKind: 'ARBITRATE' as const, priority: 'DO_NEXT' as const, ruleCode: 'OPERATION-MATCH',
    question: 'Ce document concerne-t-il le même achat que les documents suivants ?',
    proposals: [{ value: 'YES:12', label: 'Oui' }, { value: 'NO:12', label: 'Non' }],
    target: { label: 'Acte de vente' },
    choiceMode: 'BINARY' as const,
    references: B.referencesView([doc(1, 'Compromis de vente — un titre long qui doit rester entier et lisible sur mobile', '2026-01-10', 'Compromis de vente'), evt(9, 'Signature chez le notaire', '2026-03-02')]),
    ...over,
  });
  it('références cliquables avant les boutons, titres entiers, type · date ; Oui / Non seulement, pas de « Autre »', () => {
    const html = renderToStaticMarkup(React.createElement(ActionCard, { action: vue(), onChoose: () => {}, onOpenTarget: () => {}, visual: true }));
    expect(html).toContain('data-card-references');
    expect(html).toContain('Compromis de vente — un titre long qui doit rester entier et lisible sur mobile');
    expect(html).toContain('Compromis de vente · 10/01/2026');
    expect(html).toContain('Événement · 02/03/2026');
    expect(html).toContain('data-link-kind="document"');
    expect(html).toContain('data-link-kind="echeance"');
    expect(html.indexOf('data-card-references')).toBeLessThan(html.indexOf('data-proposals'));
    const choix = html.slice(html.indexOf('data-proposals'));
    expect(choix).toContain('>Oui<');
    expect(choix).toContain('>Non<');
    expect(html).not.toContain('>Autre<');
    expect(html).not.toMatch(/Oui, «/);
    expect(html).not.toContain('(actuelle)');
  });
  it('ancienne carte (sans forme binaire) : rendu inchangé, « Autre » présent', () => {
    const html = renderToStaticMarkup(React.createElement(ActionCard, {
      action: vue({ choiceMode: undefined, references: undefined, proposals: [{ value: 'SAME:12', label: 'Oui, « A »' }, { value: 'SAME:15', label: 'Oui, « B »' }] }),
      onChoose: () => {}, onOpenTarget: () => {},
    }));
    expect(html).toContain('>Autre<');
    expect(html).not.toContain('data-card-references');
  });
  it('charte : jetons seulement ; aucune règle métier dans le composant', () => {
    const src = lire('src/components/to-process/ActionCard.tsx');
    const bloc = src.slice(src.indexOf('export function OperationReferences'), src.indexOf('/** Source affichée'));
    expect(bloc).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|blue|green|gray|slate|zinc|neutral)-\d{2,3}\b/i);
    expect(bloc).not.toMatch(/ACQUISITION|INTERVENTION|operationId|fetch\(/);
  });
});

describe('L110D-U-06 — lecture et reprise', () => {
  it('les références listées ne sont pas répétées dans les liens directs', () => {
    const links = {
      object: { kind: 'document' as const, id: 3, label: 'C' }, objectUnavailable: null,
      related: [{ kind: 'reference' as const, id: 9, label: 'Signature' }, { kind: 'echeance' as const, id: 77, label: 'Autre' }],
      documents: [], cardDocuments: [1, 4], proposals: [], unavailable: 0,
    };
    const out = withoutListedReferences(links, B.referencesView([doc(1, 'A', null), evt(9, 'Signature', null)]));
    expect(out.cardDocuments).toEqual([4]);
    expect(out.related.map((r) => r.id)).toEqual([77]);
    expect(withoutListedReferences(links, undefined)).toBe(links);
  });
  it('COH-TODO-OPERATION-CARDS : question encore justifiée sous l’ancienne forme → LEGACY_EXCLUSIVE_CHOICE (réparable) ; forme binaire : rien', () => {
    const base = { documentAlive: true, lastSeenAt: new Date(), rule: 'OPERATION-MATCH', candidate: { status: 'ACTIVE', pending: false, outcome: 'ARBITRATION_REQUIRED' }, offeredGone: [] };
    expect(operationCardAnomaly({ ...base, form: 'LEGACY' })).toEqual({ anomaly: 'LEGACY_EXCLUSIVE_CHOICE', verdict: 'REPAIRABLE' });
    expect(operationCardAnomaly({ ...base, form: 'BINARY' })).toBeNull();
    // Consolidation en attente : jamais réparée pendant l'attente (la reconduction convertira).
    expect(operationCardAnomaly({ ...base, form: 'LEGACY', candidate: { status: 'ACTIVE', pending: true, outcome: null } })).toBeNull();
  });
});
