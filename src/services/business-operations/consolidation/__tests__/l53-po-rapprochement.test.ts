/**
 * Lot 53 (retour PO D5, D6, D7) — rapprochement factures ↔ interventions :
 * faisceau de plausibilité, références fragiles, examen M3 progressif.
 * Règles pures ; le parcours bout en bout est couvert par
 * `src/test/e2e/scenarios/l53c-po-rapprochement.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  applyM3Verdict, decideCandidate, distinctFinalInvoices, isPlausible, natureTokens, operationsMergeable, plausibilityEvidence,
  rankPlausible, referenceProviderMismatch, type ExistingOperation, type MatchContext,
} from '../matching';
import { advanceM3Progress, m3ProgressFor, m3SubjectFingerprint, selectM3Batch } from '../m3-progress';
import type { CandidateIdentity } from '../model';
import { m3ProgressLabel, toM3ProgressView } from '../../diagnostics/model';

function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Remplacement chaudière', provider: 'Garage', providerKey: 'garage',
    assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: '2026-06-02', endDate: null }, hints: [],
    ...over,
  };
}
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.replace(/[^A-Z0-9]/gi, '').toUpperCase() });
const date = (d: string) => ({ plannedDate: null, startDate: null, realizedDate: d, endDate: null });

function op(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 100, typeCode: 'INTERVENTION', status: 'REALIZED', providerKey: 'garage', assetIds: [1], refs: [],
    plannedDate: null, startDate: null, realizedDate: '2026-06-01', endDate: null, ...over,
  };
}
const ctx = (operations: ExistingOperation[], over: Partial<MatchContext> = {}): MatchContext => ({
  operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map(), ...over,
});

describe('PO-D5 — rapprochement automatique seulement à forte confiance (faisceau)', () => {
  it('PO-D5-01 un prestataire identique SEUL ne suffit jamais à rattacher : plausible au plus (M3), jamais MATCH', () => {
    const d = decideCandidate(cand({ assetIds: [], summary: 'Facture' }), ctx([op({ assetIds: [] })]));
    expect(d.outcome).toBe('HOLD_UNRESOLVED');
    expect(d.operationId).toBeNull();
  });

  it('PO-D5-02 sans prestataire, même bien + même nature de travaux + dates proches → plausible (avant : création d\'un doublon)', () => {
    const c = cand({ provider: null, providerKey: null, summary: 'Remplacement chaudière gaz' });
    const o = op({ providerKey: null, label: 'Chaudière : remplacement du corps de chauffe' });
    expect(plausibilityEvidence(c, o).signals).toEqual(expect.arrayContaining(['ASSET_SAME', 'DATE_IN_WINDOW', 'NATURE_COMMON']));
    expect(decideCandidate(c, ctx([o]))).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
    // Même bien et dates proches, mais aucune nature commune ni montant concordant : pas d'ancrage → création.
    expect(isPlausible(cand({ provider: null, providerKey: null, summary: 'Vidange' }), op({ providerKey: null, label: 'Ramonage' }))).toBe(false);
  });

  it('PO-D5-04 montants concordants (± 1 %) = indice ; prestataire DIFFÉRENT = indice contraire fort (jamais plausible seul)', () => {
    const c = cand({ provider: null, providerKey: null, summary: 'Prestation', hints: [{ role: 'REALIZED_COST', amountMinor: 120000, currency: 'EUR' }] });
    const o = op({ providerKey: null, label: null, amounts: [{ kind: 'FORECAST_COST', amountMinor: 120500, currency: 'EUR' }] });
    expect(plausibilityEvidence(c, o).signals).toContain('AMOUNT_COHERENT');
    expect(isPlausible(c, o)).toBe(true);
    expect(isPlausible(cand({ providerKey: 'autre', summary: 'Remplacement chaudière' }), op({ label: 'Remplacement chaudière' }))).toBe(false);
  });

  it('PO-D5-05 sinistre : la fenêtre de 30 j est un indice — même assureur à 60 j → plausible ; au-delà de 3 fenêtres (> 90 j) → non', () => {
    const sinistre = op({ typeCode: 'CLAIM', providerKey: 'assur', realizedDate: '2026-03-01' });
    const c = (over: Partial<CandidateIdentity>) => cand({ type: 'CLAIM', role: 'CLAIM_DOCUMENT', providerKey: 'assur', summary: 'Courrier', dates: date('2026-04-30'), ...over });
    expect(isPlausible(c({}), sinistre)).toBe(true);
    expect(isPlausible(c({ assetIds: [] }), { ...sinistre, assetIds: [] })).toBe(true);
    expect(isPlausible(c({ dates: date('2026-07-01') }), sinistre)).toBe(false);
  });

  it('PO-D5-06 même numéro de facture chez deux prestataires différents : référence fragile → jamais MATCH automatique', () => {
    const c = cand({ providerKey: 'plombier', refs: [ref('INVOICE', '1')] });
    const o = op({ providerKey: 'garage', refs: [ref('INVOICE', '1')] });
    expect(referenceProviderMismatch(c, o)).toBe(true);
    const d = decideCandidate(c, ctx([o]));
    expect(d.outcome).not.toBe('MATCH_AND_ENRICH');
    expect(d.detail.fragile).toEqual([100]);
    // Une référence exacte concurrencée par une référence fragile → arbitrage utilisateur (carte).
    const d2 = decideCandidate(cand({ refs: [ref('INVOICE', '1'), ref('QUOTE', 'D7')] }), ctx([
      op({ id: 1, refs: [ref('QUOTE', 'D7')] }), op({ id: 2, providerKey: 'autre', refs: [ref('INVOICE', '1')] }),
    ]));
    expect(d2).toMatchObject({ outcome: 'ARBITRATION_REQUIRED', arbitration: { basis: 'CERTAIN', operationIds: [1, 2] } });
  });

  it('PO-D5-07 M1 inchangé quand la référence est portée par le même prestataire (ou un prestataire inconnu)', () => {
    expect(decideCandidate(cand({ refs: [ref('QUOTE', 'DV-1')] }), ctx([op({ refs: [ref('QUOTE', 'DV-1')] })]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', matchMethod: 'M1' });
    expect(decideCandidate(cand({ providerKey: null, refs: [ref('QUOTE', 'DV-1')] }), ctx([op({ refs: [ref('QUOTE', 'DV-1')] })]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', matchMethod: 'M1' });
  });

  it('PO-D5-08 natureTokens : mots porteurs seulement (accents, mots vides et nombres ignorés)', () => {
    expect([...natureTokens('Facture n° 1234 — Remplacement de la CHAUDIÈRE gaz')].sort()).toEqual(['chaudiere']);
  });
});

describe('PO-D6 — deux factures finales distinctes ne font plus systématiquement deux interventions', () => {
  it('PO-D6-02 numéros différents = indice contraire (−2), plus une exclusion ; le faisceau fort reste plausible ; natures de travaux différentes en plus → deux interventions', () => {
    const c = cand({ refs: [ref('INVOICE', 'FA2')] });
    const o = op({ refs: [ref('INVOICE', 'FA1')] });
    expect(distinctFinalInvoices(c, o)).toBe(true);
    const e = plausibilityEvidence(c, o);
    expect(e.signals).toContain('INVOICE_NUMBERS_DIFFERENT');
    expect(e.plausible).toBe(true);
    // Même prestataire, même bien, mais travaux différents ET numéros différents : deux réalités (pas de doute).
    const autre = plausibilityEvidence(cand({ summary: 'Batterie', refs: [ref('INVOICE', 'CH-1')] }), op({ label: 'Moteur', refs: [ref('INVOICE', 'CH-2')] }));
    expect(autre.signals).toEqual(expect.arrayContaining(['NATURE_DIFFERENT', 'INVOICE_NUMBERS_DIFFERENT']));
    expect(autre.plausible).toBe(false);
    // « maison », « garage »… désignent le bien, pas la nature des travaux.
    expect(plausibilityEvidence(cand({ summary: 'Toiture maison' }), op({ label: 'Bâchage maison et garage' })).signals).toContain('NATURE_DIFFERENT');
  });

  it('PO-D6-03 verdict M3 certain « même intervention » → une seule intervention ; « distincte » certain → deux ; doute → carte avec les candidats', () => {
    const c = cand({ refs: [ref('INVOICE', 'FA2')] });
    const ops = [op({ refs: [ref('INVOICE', 'FA1')] })];
    const base = decideCandidate(c, ctx(ops));
    const v = (decision: 'SAME_OPERATION' | 'DISTINCT_OPERATION' | 'AMBIGUOUS', confidence: 'certain' | 'probable') =>
      ({ decision, confidence, matchedOperationId: decision === 'SAME_OPERATION' ? 100 : null, concordantSignals: [], contradictions: [], reason: '' });
    expect(applyM3Verdict(c, base, v('SAME_OPERATION', 'certain'), ctx(ops))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 100, matchMethod: 'M3' });
    expect(applyM3Verdict(c, base, v('DISTINCT_OPERATION', 'certain'), ctx(ops)).outcome).toBe('CREATE_NEW');
    expect(applyM3Verdict(c, base, v('SAME_OPERATION', 'probable'), ctx(ops))).toMatchObject({ outcome: 'ARBITRATION_REQUIRED', arbitration: { basis: 'M3', operationIds: [100] } });
  });

  it('PO-D6-04 jamais de fusion automatique de deux interventions au seul motif d\'un même prestataire', () => {
    expect(operationsMergeable(op({ id: 1, refs: [ref('INVOICE', 'FA1')] }), op({ id: 2, refs: [ref('INVOICE', 'FA2')] }))).toBe(false);
    // Deux Opérations du même prestataire, sans référence citée par la source : aucune fusion (pas de M1 multiple).
    const d = decideCandidate(cand(), ctx([op({ id: 1 }), op({ id: 2 })]));
    expect(d.mergeIds).toBeUndefined();
    expect(d.outcome).toBe('HOLD_UNRESOLVED');
  });
});

describe('PO-D7 — examen M3 progressif, jamais d\'abandon au-delà de 5 candidats', () => {
  const ops = Array.from({ length: 12 }, (_, i) => op({ id: 200 + i, realizedDate: `2026-0${1 + (i % 6)}-1${i % 9}` }));

  it('PO-D7-01 classement déterministe : faisceau le plus fort, puis dates les plus proches', () => {
    const c = cand();
    const r = rankPlausible(c, [op({ id: 1, realizedDate: '2026-01-01' }), op({ id: 2, realizedDate: '2026-06-01' }), op({ id: 3, providerKey: null, realizedDate: '2026-06-02' })]);
    expect(r).toEqual([2, 1, 3]);
    expect(rankPlausible(c, ops)).toEqual(rankPlausible(c, [...ops].reverse()));
  });

  it('PO-D7-02 lots de 5 au plus ; les examinés sortent ; reprise jusqu\'au dernier lot ; rien n\'est jamais abandonné', () => {
    const c = cand();
    const ranked = rankPlausible(c, ops);
    let p = m3ProgressFor(null, m3SubjectFingerprint(c));
    const s1 = selectM3Batch(ranked, p, 5);
    expect(s1).toMatchObject({ examined: [], total: 12 });
    expect(s1.batch).toHaveLength(5);
    expect(s1.remaining).toHaveLength(7);
    p = advanceM3Progress(p, s1.batch, '2026-10-13T10:00:00Z');
    const s2 = selectM3Batch(ranked, p, 5);
    expect(s2.examined).toHaveLength(5);
    expect(s2.batch.some((id) => s1.batch.includes(id))).toBe(false);
    p = advanceM3Progress(p, s2.batch, '2026-10-13T11:00:00Z');
    const s3 = selectM3Batch(ranked, p, 5);
    expect(s3.batch).toHaveLength(2);
    expect(s3.remaining).toEqual([]);
    p = advanceM3Progress(p, s3.batch, '2026-10-13T12:00:00Z');
    expect(selectM3Batch(ranked, p, 5).batch).toEqual([]);
    expect(p.rounds).toBe(3);
    expect(p.history.map((h) => h.operationIds.length)).toEqual([5, 5, 2]);
  });

  it('PO-D7-03 un candidat modifié (sujet différent) repart de zéro ; trace illisible → progression vierge', () => {
    const c = cand();
    const p = advanceM3Progress(m3ProgressFor(null, m3SubjectFingerprint(c)), [1, 2], 'x');
    expect(m3ProgressFor(p, m3SubjectFingerprint(c)).distinct).toEqual([1, 2]);
    expect(m3ProgressFor(p, m3SubjectFingerprint(cand({ summary: 'Autre chose' }))).distinct).toEqual([]);
    expect(m3ProgressFor('n importe quoi', 'S').distinct).toEqual([]);
  });

  it('PO-D7-04 BO : état, motif de report, reprise, examinées / restantes lisibles', () => {
    const v = toM3ProgressView(
      { status: 'DEFERRED', detail: 'DAILY_CAP', retryAfter: '2026-10-14T10:00:00Z', at: '2026-10-13T10:00:00Z' },
      [5, 6, 7, 8, 9], { distinct: [1, 2, 3, 4, 10], rounds: 1, total: 12, remaining: 2 }, [1, 2, 3],
    );
    expect(v).toMatchObject({ status: 'DEFERRED', detail: 'DAILY_CAP', examined: 5, remaining: 2, total: 12, rounds: 1, batch: [5, 6, 7, 8, 9] });
    expect(m3ProgressLabel(v)).toBe('reporté (plafond d’appels du jour) · 5 examinée(s), 5 dans le lot courant, 2 restante(s) sur 12');
    expect(m3ProgressLabel(toM3ProgressView(null, null, null, [1, 2]))).toContain('à soumettre');
    expect(m3ProgressLabel(null)).toBe('—');
  });
});
