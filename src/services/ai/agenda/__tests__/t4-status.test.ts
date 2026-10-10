/**
 * CDC 15 T4-12 à T4-14, P-T4-02, P-T4-03 — réalisation d'une échéance :
 * quatre états, preuve par type documentaire (completionProofs), fenêtre
 * d'occurrence, protection des événements manuels. Lot 16b-2 : décision à
 * quatre états et branche VERIFY_COMPLETION du master seules (`decideStatus`
 * historique et AI_T4_EFFECTS retirés).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { decideCompletion, matchOccurrence } = await import('../status-reconciler');
const { reconcileStatus } = await import('../status-reconciliation.service');
const { translateVerifyCompletion } = await import('../master/verify-completion');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
import type { ExistingAgendaItem } from '../types';
import type { CompletionEvidence } from '../status-reconciler';

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', 'master', '__fixtures__', f), 'utf8'));
const P2 = fx('p-t4-02-facture-ambigue.json');
const P3 = fx('p-t4-03-autre-occurrence.json');
const ev = (e: Record<string, unknown>): CompletionEvidence => ({ ...(e as unknown as CompletionEvidence), documentDate: e.documentDate ? new Date(String(e.documentDate)) : null });
const ITEM: ExistingAgendaItem = P2.context.item;

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => { traces.length = 0; fake = new FakeProvider(); setAiProvider(fake); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('T4-14 : fenêtre d’occurrence', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  it('exacte ±7 j ; récurrente : ± demi-période ; ponctuelle : dès 90 j avant', () => {
    expect(matchOccurrence('2026-10-15', d('2026-10-10'))).toBe('exact');
    expect(matchOccurrence('2026-10-15', d('2025-10-14'), { frequency: 'yearly', interval: 1 })).toBe('none');
    expect(matchOccurrence('2026-10-15', d('2026-08-01'), { frequency: 'yearly', interval: 1 })).toBe('probable');
    expect(matchOccurrence('2026-10-15', d('2026-06-01'))).toBe('none');
    expect(matchOccurrence('2026-10-15', d('2027-02-01'))).toBe('probable');
    expect(matchOccurrence('2026-10-15', null)).toBe('ambiguous');
  });
});

describe('T4-12 / T4-13 : décision déterministe à quatre états', () => {
  it('aucune preuve : not_proven (une date passée ne prouve rien)', () => {
    expect(decideCompletion({ ...ITEM, date: '2020-01-01' }, null)).toMatchObject({ status: 'not_proven', decision: 'keep' });
  });

  it('facture simple → not_proven ; facture acquittée → completed', () => {
    const e = ev(P2.context.evidence);
    expect(decideCompletion(ITEM, { ...e, proofCode: 'FACTURE_SIMPLE' })).toMatchObject({ status: 'not_proven', reasonCode: 'PROOF_FORM_NOT_PROBATIVE' });
    expect(decideCompletion(ITEM, { ...e, proofCode: 'FACTURE_ACQUITTEE_PRESTATION_DATEE' })).toMatchObject({ status: 'completed', decision: 'mark_done' });
  });

  it('facture sans forme identifiée → unknown, à vérifier par le modèle', () => {
    expect(decideCompletion(ITEM, ev(P2.context.evidence))).toMatchObject({ status: 'unknown', reasonCode: 'PROOF_FORM_UNDETERMINED', needsModel: true });
  });

  it('PV de contrôle favorable et facture simple : statuts différents', () => {
    const insp = { ...ITEM, businessType: 'inspection', title: 'Contrôle technique' };
    const base = { excerpt: 'x', confidence: 'certain' as const, documentDate: new Date('2026-10-14') };
    expect(decideCompletion(insp, { ...base, documentType: 'CONTROLE_TECHNIQUE', proofCode: 'PV_CONTROLE_FAVORABLE' }).status).toBe('completed');
    expect(decideCompletion(insp, { ...base, documentType: 'FACTURE', proofCode: 'FACTURE_SIMPLE' }).status).toBe('not_proven');
  });

  it('devis : ne prouve jamais ; type inconnu : not_proven', () => {
    const base = { excerpt: 'x', confidence: 'certain' as const, documentDate: new Date('2026-10-14') };
    expect(decideCompletion(ITEM, { ...base, documentType: 'DEVIS' }).status).toBe('not_proven');
    expect(decideCompletion(ITEM, { ...base, documentType: 'XYZ' })).toMatchObject({ status: 'not_proven', reasonCode: 'DOCUMENT_TYPE_UNKNOWN' });
  });

  it('P-T4-03 : preuve 2025 pour l’occurrence 2026 → not_proven, jamais clos', () => {
    const r = decideCompletion(P3.context.item, ev(P3.context.evidence));
    expect(r).toMatchObject({ status: P3.expected.status, occurrenceMatch: P3.expected.occurrenceMatch });
    expect(r.decision).not.toBe(P3.expected.neverDecision);
  });

  it('confiance probable → proposition ; événement manuel → jamais modifié', () => {
    const e = { ...ev(P2.context.evidence), proofCode: 'FACTURE_ACQUITTEE_PRESTATION_DATEE', confidence: 'probable' as const };
    expect(decideCompletion(ITEM, e).decision).toBe('propose_done');
    expect(decideCompletion({ ...ITEM, manual: true }, { ...e, confidence: 'certain' }))
      .toMatchObject({ status: 'completed', decision: 'keep', reasonCode: 'MANUAL_ITEM_PROTECTED' });
  });
});

describe('VERIFY_COMPLETION : traduction serveur', () => {
  const det = decideCompletion(ITEM, ev(P2.context.evidence));

  it('P-T4-02 : insufficient → not_proven, jamais not_completed', () => {
    const r = translateVerifyCompletion(ITEM, ev(P2.context.evidence), det, P2.recording.output);
    expect(r).toMatchObject({ status: P2.expected.status, decision: P2.expected.decision });
    expect(r.status).not.toBe(P2.expected.neverStatus);
  });

  it('P-T4-03 : le modèle dit « exact », la fenêtre serveur dit non → not_proven', () => {
    const r = translateVerifyCompletion(P3.context.item, ev(P3.context.evidence), det, P3.recording.output);
    expect(r).toMatchObject({ status: 'not_proven', occurrenceMatch: 'none' });
  });

  it('proves_not_completed → proposé, jamais écrit ; conflictual → unknown', () => {
    const out = (evidenceStatus: string) => ({ task: 'VERIFY_COMPLETION' as const, evidenceStatus: evidenceStatus as never, occurrenceMatch: 'exact' as const, confidence: 'certain' as const, evidence: {}, reason: 'r' });
    expect(translateVerifyCompletion(ITEM, ev(P2.context.evidence), det, out('proves_not_completed'))).toMatchObject({ status: 'not_completed', decision: 'propose_not_done' });
    expect(translateVerifyCompletion(ITEM, ev(P2.context.evidence), det, out('conflictual'))).toMatchObject({ status: 'unknown', decision: 'keep' });
    expect(translateVerifyCompletion(ITEM, ev(P2.context.evidence), det, out('proves_completed'))).toMatchObject({ status: 'completed', decision: 'mark_done' });
  });
});

describe('reconcileStatus', () => {
  const e = ev(P2.context.evidence);

  it('cas tranché par la décision déterministe : aucun appel modèle', async () => {
    const r = await reconcileStatus(ITEM, null, { accountId: 1 });
    expect(r).toMatchObject({ engine: 'completion_v2', status: 'not_proven' });
    expect(fake.calls).toHaveLength(0);
  });

  it('cas indéterminé → t4_verify_completion (P-T4-02)', async () => {
    fake.onAny(() => ({ rawText: JSON.stringify(P2.recording.output), inputTokens: 1, outputTokens: 1 }));
    const r = await reconcileStatus(ITEM, e, { accountId: 1 });
    expect(r).toMatchObject({ engine: 'completion_v2', status: 'not_proven', reasonCode: 'MODEL_INSUFFICIENT' });
    // Lot 34D : contexte structuré — la TASK passe par EXECUTION_CONTEXT.
    expect(fake.calls[0].prompt).toContain('"task":"VERIFY_COMPLETION"');
    expect(fake.calls[0].prompt).toContain('FACTURE_ACQUITTEE_PRESTATION_DATEE');
    expect(traces[0]).toMatchObject({ operationCode: 't4_verify_completion', task: 'VERIFY_COMPLETION' });
  });

  it('modèle indisponible : décision déterministe conservée', async () => {
    fake.onAny(() => { throw new Error('503'); });
    expect(await reconcileStatus(ITEM, e, { accountId: 1 })).toMatchObject({ status: 'unknown', decision: 'keep' });
  });

  it('événement manuel : jamais d’appel modèle', async () => {
    const r = await reconcileStatus({ ...ITEM, manual: true }, e, { accountId: 1 });
    expect(r.decision).toBe('keep');
    expect(fake.calls).toHaveLength(0);
  });
});
