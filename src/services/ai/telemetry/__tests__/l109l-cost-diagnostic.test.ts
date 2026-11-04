/**
 * Lot 109L (ticket P1 « 948 appels », point D, tests §4) — classification des
 * appels non chiffrés et plan de régularisation (purs).
 */
import { describe, it, expect } from 'vitest';
import { classifyCall, isDocumentedPrice } from '../cost-diagnostic';
import { decideEvent, decideRollup, planFingerprint, summarize } from '../cost-regularization';

const AT = '2026-10-20T10:00:00.000Z';
const row = (o: Record<string, unknown>) => ({
  id: 1, created_at: AT, provider: 'gemini', model: 'gemini-3.5-flash-lite', use_case_code: 'SOURCE_ANALYSIS', account_id: 42,
  status: 'success', is_billable: true, input_tokens: 10_000, output_tokens: 1_000, cost_micros: null, trace_id: 't1', thoughts: null,
  st: 'missing', legacy_rule: true, status_now: 'KNOWN', status_reason: null, similar_priced: false, corr_id: null, ...o,
});
const prix = (p: string, o: Record<string, unknown> = {}) => ({
  [`${p}_id`]: 7, [`${p}_source`]: 'public_catalog', [`${p}_verified`]: false, [`${p}_in`]: '0.3', [`${p}_out`]: '2.5', [`${p}_tiers`]: null,
  [`${p}_from`]: '2026-10-01T00:00:00Z', [`${p}_created`]: '2026-10-01T00:00:00Z', [`${p}_inv`]: null, ...o,
});

describe('causes', () => {
  it('tarif valide en base avant l’appel → cache non chargé ; régularisable au tarif de la date', () => {
    const c = classifyCall(row(prix('pv')));
    expect(c).toMatchObject({ cause: 'CACHE_NOT_LOADED', priceMethod: 'valid_at_call', notReconstitutable: null });
    expect(decideEvent(c)).toMatchObject({ decision: 'regularize', correctedCostMicros: 3000 + 2500 });
  });
  it('tarif retiré pour un format non reconnu puis republié à l’identique → invalidé à tort, continuité prouvée', () => {
    const c = classifyCall(row({ ...prix('pi', { pi_inv: '2026-10-15T00:00:00Z' }), ...prix('pa', { pa_id: 9, pa_from: '2026-11-04T00:00:00Z' }), ch_code: 'NO_PRICE_TABLE', ch_reason: 'aucun tableau de prix' }));
    expect(c).toMatchObject({ cause: 'WRONGLY_INVALIDATED', priceMethod: 'continuity' });
    expect(decideEvent(c)).toMatchObject({ decision: 'regularize' });
  });
  it('retrait à tort mais montant différent à la republication → non reconstituable, raison donnée', () => {
    const c = classifyCall(row({ ...prix('pi', { pi_inv: '2026-10-15T00:00:00Z' }), ...prix('pa', { pa_id: 9, pa_in: '0.75', pa_from: '2026-11-04T00:00:00Z' }), ch_code: 'NO_PRICE_TABLE' }));
    expect(c.cause).toBe('WRONGLY_INVALIDATED');
    expect(decideEvent(c)).toMatchObject({ decision: 'keep_unpriced', decisionReason: expect.stringMatching(/non prouvé/) });
  });
  it('retrait car modèle absent de la page, sans republication → tarif absent à la date', () => {
    const c = classifyCall(row({ ...prix('pi', { pi_inv: '2026-10-15T00:00:00Z' }), ch_code: 'ABSENT', ch_reason: 'absent de la page tarifaire officielle' }));
    expect(c).toMatchObject({ cause: 'TARIFF_NOT_IN_GRID', price: null });
  });
  it('identifiant différent d’un modèle tarifé → hors couverture, aucun alias appliqué', () => {
    const c = classifyCall(row({ similar_priced: true, similar_model: 'gemini-3.5-flash-lite' , model: 'gemini-3.5-flash-lite-001' }));
    expect(c).toMatchObject({ cause: 'MODEL_NOT_COVERED', price: null });
    expect(classifyCall(row({ status_now: null })).cause).toBe('MODEL_NOT_COVERED');
  });
  it('coût connu arrondi → faux positif de l’ancienne règle, aucune correction', () => {
    const c = classifyCall(row({ st: 'zero_or_rounded', cost_micros: 0, input_tokens: 3, output_tokens: 0 }));
    expect(c.cause).toBe('ZERO_OR_ROUNDED');
    expect(decideEvent(c)).toMatchObject({ decision: 'no_action' });
  });
  it('consommation manquante', () => {
    expect(classifyCall(row({ st: 'insufficient_usage', input_tokens: 0, output_tokens: 0 }))).toMatchObject({ cause: 'USAGE_MISSING', notReconstitutable: expect.any(String) });
  });
  it('trace ancienne sans preuve : régularisable seulement si un tarif DOCUMENTÉ valide existait', () => {
    expect(decideEvent(classifyCall(row({ st: 'legacy_undetermined', cost_micros: 0 })))).toMatchObject({ decision: 'keep_unpriced' });
    expect(decideEvent(classifyCall(row({ st: 'legacy_undetermined', cost_micros: 0, ...prix('pv') })))).toMatchObject({ decision: 'regularize' });
  });
  it('limite de preuve : grille du compte non validée, saisie non vérifiée → jamais appliquées', () => {
    expect(isDocumentedPrice({ id: 1, source: 'billing_api', verified: true, inputMicros: 1, outputMicros: 1, tiers: null, effectiveFrom: AT, createdAt: AT })).toBe(false);
    const c = classifyCall(row(prix('pv', { pv_source: 'manual', pv_verified: false })));
    expect(decideEvent(c)).toMatchObject({ decision: 'keep_unpriced', decisionReason: expect.stringMatching(/non documenté/) });
  });
  it('saisie manuelle vérifiée à validité rétroactive : tarif absent à la date, régularisable (documenté)', () => {
    const c = classifyCall(row(prix('pv', { pv_source: 'manual', pv_verified: true, pv_created: '2026-11-04T00:00:00Z' })));
    expect(c).toMatchObject({ cause: 'TARIFF_NOT_IN_GRID', priceMethod: 'documented_backdated' });
  });
  it('déjà régularisé : aucune action (idempotence)', () => {
    expect(decideEvent(classifyCall(row({ ...prix('pv'), corr_id: 5 })))).toMatchObject({ decision: 'no_action' });
  });
  it('raisonnement tracé : inclus au coût reconstitué', () => {
    expect(decideEvent(classifyCall(row({ ...prix('pv'), thoughts: 1000 })))).toMatchObject({ correctedCostMicros: 3000 + 2500 + 2500 });
  });
});

describe('agrégats journaliers et plan', () => {
  const rc = { id: 3, day: '2026-07-01', provider: 'gemini', model: 'gemini-2.5-flash', useCaseCode: null, accountId: 1, calls: 4, unpricedCalls: 4, inputTokens: 1_000_000, outputTokens: 0, costMicros: 0,
    price: { id: 2, source: 'public_catalog', verified: false, inputMicros: 0.3, outputMicros: 2.5, tiers: null, effectiveFrom: '2026-06-01', createdAt: '2026-06-01' }, regularizable: true, reason: 'ok', corrected: false };
  it('agrégat entièrement non tarifé avec tarif documenté toute la journée : une correction, à part', () => {
    expect(decideRollup(rc)).toMatchObject({ targetKind: 'rollup', decision: 'regularize', correctedCostMicros: 300_000, calls: 4 });
    expect(decideRollup({ ...rc, regularizable: false, price: null, reason: 'agrégat mêlant appels tarifés et non tarifés' })).toMatchObject({ decision: 'keep_unpriced' });
  });
  it('empreinte stable, résumé sans double comptage', () => {
    const items = [decideEvent(classifyCall(row(prix('pv')))), decideRollup(rc), decideEvent(classifyCall(row({ id: 2, st: 'insufficient_usage', input_tokens: 0, output_tokens: 0 })))];
    expect(planFingerprint(items)).toBe(planFingerprint([...items].reverse()));
    const s = summarize(items);
    expect(s.regularize).toMatchObject({ calls: 5, rows: 2, micros: 5500 + 300_000 });
    expect(s.keepUnpriced.calls).toBe(1);
    expect(s.rollups).toMatchObject({ rows: 1, regularize: 1 });
  });
});
