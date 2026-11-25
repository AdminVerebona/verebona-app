/**
 * Carte #863 (C2, AC17/AC19) — RENDU BO des coûts (`SchemaCompatibilityPanel.tsx`) :
 * trois vues « Analyses », « Réparations », « Toutes les tentatives » ; montants
 * mixtes, zéro prouvé, coût uniquement inconnu, aucun envoi et lecture
 * impossible rendus DISTINCTEMENT (jamais « 0 € » pour un inconnu) ; détail
 * parent / enfant avec le coût individuel de chaque tentative ; anciens
 * indicateurs désignés « analyse seule ». Rendu statique (aucun réseau).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: async () => ({}), post: async () => ({}) } }));

// JSX classique compilé par le harnais : `React` global (même convention que les autres rendus statiques).
(globalThis as { React?: typeof React }).React = React;
const { SchemaCostViewsSection, costLabel } = await import('../SchemaCompatibilityPanel');
type CostViews = import('../SchemaCompatibilityPanel').CostViews;
type CostView = import('../SchemaCompatibilityPanel').CostView;
type CostDetails = import('../SchemaCompatibilityPanel').CostDetails;

const vue = (over: Partial<CostView>): CostView => ({
  calls: 0, providerRequests: 0, finalSuccess: 0, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 0, observedCostMicros: 0,
  costStatus: 'NONE', unknownShare: null, ...over,
});
const analyse = vue({ calls: 4, providerRequests: 5, finalSuccess: 4, attemptsCostObserved: 4, attemptsCostUnknown: 1, observedCostMicros: 12_000, costStatus: 'PARTIAL', unknownShare: 0.2 });
const reparation = vue({ calls: 1, providerRequests: 2, finalSuccess: 1, attemptsCostZero: 2, costStatus: 'ZERO_REPORTED', unknownShare: 0 });
const total = vue({ calls: 5, providerRequests: 7, finalSuccess: 5, attemptsCostObserved: 4, attemptsCostZero: 2, attemptsCostUnknown: 1, observedCostMicros: 12_000, costStatus: 'PARTIAL', unknownShare: 0.1429, attemptsNotSent: 1, callsWithoutDetail: 2 });
const vues: CostViews = { views: { analysis: analyse, repair: reparation, total }, unavailable: null };
const details: CostDetails = {
  page: 0, pageSize: 20, hasMore: true, unavailable: null,
  executions: [{
    traceId: 'abcdef12-3456', operationCode: 't1_analyze_document', createdAt: '2026-11-25T10:00:00.000Z',
    calls: [
      { usageEventId: 1, callKind: 'analysis', parentCallIndex: null, model: 'm-a', status: 'success', costMicros: 12_000, attempts: [
        { attemptId: 'abcdef12-3456:0:1', step: 1, kind: 'initial', phase: 'analysis', parentAttemptId: null, dispatch: 'SENT', outcome: 'FAILED', httpStatus: 400, durationMs: 120, inputTokens: null, outputTokens: null, thoughtsTokens: null, costMicros: null, costStatus: 'UNKNOWN', responseSchemaSent: true },
        { attemptId: 'abcdef12-3456:0:2', step: 2, kind: 'diagnostic_retry', phase: 'analysis', parentAttemptId: 'abcdef12-3456:0:1', dispatch: 'SENT', outcome: 'SUCCESS', httpStatus: null, durationMs: 300, inputTokens: 10, outputTokens: 5, thoughtsTokens: 3, costMicros: 12_000, costStatus: 'OBSERVED', responseSchemaSent: false },
      ] },
      { usageEventId: 2, callKind: 'repair', parentCallIndex: 0, model: 'm-a', status: 'success', costMicros: 0, attempts: [
        { attemptId: 'abcdef12-3456:1:1', step: 1, kind: 'initial', phase: 'repair', parentAttemptId: 'abcdef12-3456:0:2', dispatch: 'SENT', outcome: 'SUCCESS', httpStatus: null, durationMs: 50, inputTokens: 0, outputTokens: 0, thoughtsTokens: null, costMicros: 0, costStatus: 'ZERO_REPORTED', responseSchemaSent: false },
        { attemptId: 'abcdef12-3456:1:2', step: 2, kind: 'initial', phase: 'repair', parentAttemptId: null, dispatch: 'NOT_SENT_GUARD', outcome: 'FAILED', httpStatus: null, durationMs: 0, inputTokens: null, outputTokens: null, thoughtsTokens: null, costMicros: null, costStatus: 'NOT_SENT', responseSchemaSent: false },
      ] },
    ],
  }],
};
const rendre = (props: Parameters<typeof SchemaCostViewsSection>[0]) => renderToStaticMarkup(h(SchemaCostViewsSection, props));
const texte = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/\s+/g, ' ');

describe('C863-BO — vues de coût du panneau Schémas structurés', () => {
  it('C863-BO-01 — trois vues nommées ; « Toutes les tentatives » : requêtes réelles, minimum chiffré, inconnues (nombre et part), zéros prouvés', () => {
    const html = rendre({ costViews: vues, costDetails: details, initialTab: 'total' });
    expect(html).toContain('Analyses');
    expect(html).toContain('Réparations');
    expect(html).toContain('Toutes les tentatives');
    const t = texte(html);
    expect(t).toMatch(/Appels logiques : 5/);
    expect(t).toMatch(/Requêtes réellement envoyées : 7/);
    expect(t).toMatch(/Coût : au moins 0,0120 € \(part inconnue\)/);
    expect(t).toMatch(/Coût inconnu : 1 requête\(s\) · part 14,3 %/);
    expect(t).toMatch(/Zéros prouvés : 2 requête/);
    expect(t).toMatch(/1 tentative\(s\) non envoyée\(s\)/);
    expect(t).toMatch(/2 appel\(s\) historique\(s\) sans détail \(nombre de requêtes inconnu\)/);
    expect(t).toMatch(/indépendamment de la page de détail/);
  });

  it('C863-BO-02 — détail parent / enfant et coût INDIVIDUEL de chaque tentative (inconnu, observé, zéro prouvé, non envoyée)', () => {
    const t = texte(rendre({ costViews: vues, costDetails: details, initialTab: 'total' }));
    expect(t).toMatch(/Réparation \(enfant de l’appel n° 0\)/);
    expect(t).toMatch(/1\. initial \(schéma\) · échec HTTP 400 · 120 ms · jetons \? \/ \? · inconnu/);
    expect(t).toMatch(/2\. diagnostic_retry · réponse · 300 ms · jetons 10 \/ 5 \+ 3 réflexion · 0,0120 €/);
    expect(t).toMatch(/0 € \(prouvé\)/);
    expect(t).toMatch(/non envoyée \(aucun coût\)/);
  });

  it('C863-BO-03 — vue « Réparations » : zéro PROUVÉ ; vue « Analyses » : seulement ses appels', () => {
    const rep = texte(rendre({ costViews: vues, costDetails: details, initialTab: 'repair' }));
    expect(rep).toMatch(/Coût : 0 € \(zéro prouvé par le fournisseur\)/);
    expect(rep).toMatch(/Appels logiques : 1/);
    expect(rep).not.toMatch(/Analyse : m-a/);
    const an = texte(rendre({ costViews: vues, costDetails: details, initialTab: 'analysis' }));
    expect(an).toMatch(/Appels logiques : 4/);
    expect(an).not.toMatch(/Réparation \(enfant/);
  });

  it('C863-BO-04 — coût UNIQUEMENT inconnu : « inconnu », jamais « 0 € » ; aucun envoi ; lecture impossible : trois affichages distincts', () => {
    const inconnu: CostViews = { views: { analysis: vue({ calls: 2, providerRequests: 2, attemptsCostUnknown: 2, costStatus: 'UNKNOWN', unknownShare: 1 }), repair: vue({}), total: vue({ calls: 2, providerRequests: 2, attemptsCostUnknown: 2, costStatus: 'UNKNOWN', unknownShare: 1 }) }, unavailable: null };
    const a = texte(rendre({ costViews: inconnu, initialTab: 'analysis' }));
    expect(a).toMatch(/Coût : inconnu/);
    expect(a).toMatch(/Minimum chiffré : aucun montant chiffrable/);
    expect(a).not.toMatch(/0,0000 €/);
    const r = rendre({ costViews: inconnu, initialTab: 'repair' });
    expect(r).toContain('data-testid="schema-cost-none"');
    expect(texte(r)).toMatch(/Aucune requête envoyée sur la période/);
    const ko = rendre({ costViews: { views: null, unavailable: 'délai dépassé' }, initialTab: 'total' });
    expect(ko).toContain('data-testid="schema-cost-unavailable"');
    expect(texte(ko)).toMatch(/Lecture des coûts indisponible \(délai dépassé\)/);
    expect(ko).not.toContain('schema-cost-none');
    expect(costLabel({ costStatus: 'NO_PRICE', observedCostMicros: 0 })).toBe('inconnu (tarif absent)');
    expect(costLabel({ costStatus: 'OBSERVED', observedCostMicros: 1_000_000 })).toMatch(/1,0000 € \(toutes requêtes chiffrées\)/);
  });

  it('C863-BO-05 — panneau : anciens indicateurs « analyse seule », vues branchées, réservation et mémoire distinctes des refus', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/admin/ai-executions/_components/SchemaCompatibilityPanel.tsx'), 'utf8');
    expect(src).toMatch(/Coût confirmé \(analyse seule\)/);
    expect(src).toMatch(/Requêtes fournisseur réelles \(analyse seule\)/);
    expect(src).toMatch(/<SchemaCostViewsSection costViews=\{data\.costViews\}/);
    expect(src).toMatch(/Sans schéma : réservation ou mémoire/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});
