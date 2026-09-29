/**
 * CDC 15 §25 (VALUE_CONFLICT), T3-06, U2, P-T3-01 — arbitrage d'une valeur
 * par le master T3 : données serveur (autorité calculée, dates, origine,
 * protection), ordre neutre, protection USER/ADMIN revérifiée par le serveur,
 * chemin `steps` inchangé.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { resolveAmbiguity } = await import('../../ambiguity-resolver');
const { valueConflictVariables, translateValueConflict, isProtectedValue } = await import('../value-conflict');
const { decide } = await import('../../decision/decision-matrix');
const { FakeProvider, setAiProvider } = await import('../../../gateway/providers');
const { __setConfigForTests } = await import('../../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../../config/config-types');
import type { EvidenceCandidate, ReconciliationDecision } from '../../types';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'p-t3-01-valeur-user-protegee.json'), 'utf8'));

const cand = (c: Record<string, unknown>): EvidenceCandidate => ({
  ...(c as unknown as EvidenceCandidate), documentDate: c.documentDate ? new Date(String(c.documentDate)) : null,
});
const CANDS: EvidenceCandidate[] = FIXTURE.context.candidates.map(cand);
const DECISION: ReconciliationDecision = {
  fieldKey: 'livingArea', currentValue: null, proposedValue: '78.4', action: 'request_ai_review',
  reasonCode: 'AMBIGUOUS_EVIDENCE', confidence: 'probable', evidenceIds: [4213, 4214], deterministic: true,
};
const base = { accountId: 1, assetId: 5, decision: DECISION, candidates: CANDS, currentValue: null, currentOrigin: 'AI' };

let fake: InstanceType<typeof FakeProvider>;
const repond = (o: unknown) => fake.onAny(() => ({ rawText: JSON.stringify(o), inputTokens: 1, outputTokens: 1 }));
const T3 = (arch: 'steps' | 'master') => __setConfigForTests({
  versionId: 31, entries: [{ ...emptyTreatmentConfig('T3'), primaryModel: 'm-a', promptArchitecture: arch }],
});

beforeEach(() => { traces.length = 0; fake = new FakeProvider(); setAiProvider(fake); });
afterEach(() => __setConfigForTests(null));

describe('variables du master (T3-06, U3)', () => {
  it('preuves triées par identifiant, autorité calculée par le code, protection explicite', () => {
    const v = valueConflictVariables({ ...base, currentValue: '82', currentOrigin: 'USER' });
    const ev = v.EVIDENCES as Array<Record<string, unknown>>;
    expect(ev.map((e) => e.id)).toEqual([4213, 4214]);
    expect(ev[0]).toMatchObject({ value: '78.4', authorityScore: 95, documentDate: '2026-03-12', origin: 'TEXT_EXTRACTION' });
    expect(v.CURRENT_STATE).toMatchObject({ value: '82', origin: 'USER', protected: true });
    expect(v).toMatchObject({ FIELD: 'livingArea', SUBJECT_CONTEXT: null, CANDIDATES: null, RELATION_TYPE: null });
  });

  it('le master ne porte aucune hiérarchie documentaire en dur (T3-06)', () => {
    const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
    expect(texte).not.toMatch(/acte notarié|compromis|carte grise|avis d.échéance/i);
    expect(texte).toMatch(/U3 — AUTORITÉ SERVEUR/);
  });
});

describe('translateValueConflict', () => {
  const out = (o: Record<string, unknown>) => ({ task: 'VALUE_CONFLICT' as const, reason: 'r', confidence: 'certain' as const, decision: 'choose' as const, ...o });

  it('abstention → conflit utilisateur', () => {
    expect(translateValueConflict(base, out({ decision: 'abstain', chosenEvidenceId: null })).decision)
      .toMatchObject({ action: 'create_conflict', deterministic: false });
  });

  it('U1 : preuve hors liste → conflit, avertissement', () => {
    const r = translateValueConflict(base, out({ chosenEvidenceId: 1 }));
    expect(r.decision.action).toBe('create_conflict');
    expect(r.warnings).toEqual(['UNKNOWN_EVIDENCE_ID:1']);
  });

  it('certain sur champ vide → apply, rétrogradé en probable ; probable → proposition', () => {
    expect(translateValueConflict(base, out({ chosenEvidenceId: 4213 })).decision)
      .toMatchObject({ action: 'apply', proposedValue: '78.4', confidence: 'probable', evidenceIds: [4213], sourcePriority: 95 });
    expect(translateValueConflict(base, out({ chosenEvidenceId: 4213, confidence: 'probable' })).decision)
      .toMatchObject({ action: 'create_conflict', proposedValue: '78.4' });
  });

  it('P-T3-01 : valeur USER/ADMIN non vide jamais écrasée, même sur choix certain', () => {
    for (const origin of ['USER', 'ADMIN']) {
      const r = translateValueConflict(
        { ...base, decision: { ...DECISION, currentValue: '82' }, currentValue: '82', currentOrigin: origin },
        FIXTURE.recording.output,
      );
      expect(r.decision.action).toBe(FIXTURE.expected.action);
      expect(FIXTURE.expected.neverActions).not.toContain(r.decision.action);
      expect(r.warnings).toContain('PROTECTED_VALUE');
    }
    expect(isProtectedValue(null, 'USER')).toBe(false);
    expect(isProtectedValue('', 'ADMIN')).toBe(false);
  });

  it('P-T3-01 côté matrice : une valeur USER contredite part en conflit sans appel modèle', () => {
    const d = decide({ fieldKey: 'livingArea', current: { ...FIXTURE.context.current, updatedAt: null }, candidates: CANDS, isCritical: false });
    expect(d.action).toBe('create_conflict');
    expect(['apply', 'update', 'request_ai_review']).not.toContain(d.action);
  });
});

describe('branchement selon l’architecture T3', () => {
  it('master : opération t3_value_conflict, TASK tracée, master versionné', async () => {
    T3('master');
    repond({ task: 'VALUE_CONFLICT', decision: 'choose', chosenEvidenceId: 4213, confidence: 'certain', reason: 'score 95' });
    const d = await resolveAmbiguity(base);
    expect(d).toMatchObject({ action: 'apply', proposedValue: '78.4', confidence: 'probable' });
    expect(fake.calls[0].prompt).toContain('TASK = VALUE_CONFLICT');
    expect(fake.calls[0].prompt).toContain('"authorityScore":95');
    expect(traces[0]).toMatchObject({ operationCode: 't3_value_conflict', task: 'VALUE_CONFLICT', masterPromptCode: 't3_master_v1' });
  });

  it('master : sortie de l’autre branche → erreur de validation, repli conflit', async () => {
    T3('master');
    repond({ task: 'LINK_AMBIGUITY', matches: [] });
    expect(await resolveAmbiguity(base)).toMatchObject({ action: 'create_conflict' });
  });

  it('steps : resolve_ambiguity historique, format historique, aucune TASK', async () => {
    T3('steps');
    repond({ chosenEvidenceId: 4213, confidence: 'certain', reason: 'acte' });
    const d = await resolveAmbiguity(base);
    expect(d).toMatchObject({ action: 'apply', proposedValue: '78.4' });
    expect(traces[0]).toMatchObject({ operationCode: 'resolve_ambiguity', task: null, masterPromptCode: null });
    expect(fake.calls[0].prompt).toContain('R3 — RESPECTE L\'AUTORITÉ DOCUMENTAIRE');
  });

  it('sans version de configuration : steps', async () => {
    repond({ chosenEvidenceId: null, confidence: 'conflictual', reason: 'égalité' });
    await resolveAmbiguity(base);
    expect(traces[0].operationCode).toBe('resolve_ambiguity');
    expect(z.string().safeParse(traces[0].promptVersion).success).toBe(true);
  });
});
