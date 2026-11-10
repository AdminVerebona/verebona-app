/**
 * Lot 113AF (Trello #730) — la classification est écrite À LA SOURCE par
 * `recordCallTrace` (colonnes 1610), sans toucher `is_billable` ; absente,
 * rien n'est écrit (la lecture applique la même règle).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserts: Array<Record<string, unknown>> = [];
const updates: Array<{ text: string; params: unknown[] }> = [];
let colonnes1610 = 3;
let comptesTechniques: number[] = [];

vi.mock('@/db', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => { inserts.push(values); return [{ id: 100 + inserts.length }]; },
      }),
    }),
  },
  pgClient: {
    unsafe: async (text: string, params: unknown[] = []) => {
      if (text.includes('information_schema')) return [{ n: text.includes('cost_origin') ? colonnes1610 : 0 }];
      if (text.includes('technical_kind')) return comptesTechniques.map((id) => ({ id }));
      updates.push({ text, params });
      return [];
    },
  },
}));
vi.mock('@/db/schema', () => ({ aiPipelineStep: { id: 'id' }, aiUsageEvent: { id: 'id' } }));

const { recordCallTrace } = await import('../../telemetry/ai-trace.service');
const { __resetCostClassificationStoreForTests } = await import('../cost-classification.store');
const { runWithTechnicalAccount } = await import('../../qualification/technical-context');
const { runInJobContext } = await import('../../queue/job-context');

const trace = (over: Record<string, unknown> = {}) => ({
  traceId: 't', useCaseCode: 'DATA_RECONCILIATION' as const, operationCode: 't3_link_ambiguity', accountId: 12,
  provider: 'gemini', model: 'm', promptVersion: 'v', usedFallback: false, inputTokens: 900, outputTokens: 40,
  costMicros: 321, durationMs: 1, status: 'success' as const, billable: false, shadow: false, ...over,
});
const ecrite = () => updates.find((u) => u.text.includes('cost_origin'));

beforeEach(() => {
  inserts.length = 0; updates.length = 0; colonnes1610 = 3; comptesTechniques = [];
  __resetCostClassificationStoreForTests();
});

describe('113AF — écriture à la source', () => {
  it('t3_link_ambiguity billable:false → is_billable reste faux, origine MÉTIER imputable écrite avec sa preuve', async () => {
    await recordCallTrace(trace());
    expect(inserts[0]).toMatchObject({ isBillable: false, costMicros: 321 });
    const u = ecrite()!;
    expect(u.params.slice(0, 3)).toEqual([101, 'ACCOUNT_SERVICE', true]);
    expect(JSON.parse(String(u.params[3]))).toEqual({ rule: 'couts-ia-v1', reason: 'REGISTRY_OPERATION', source: 'source', legacyBillable: false });
  });

  it('échec après jetons consommés : coût conservé, origine métier', async () => {
    await recordCallTrace(trace({ status: 'error', errorCode: 'INVALID_OUTPUT' }));
    expect(ecrite()!.params.slice(1, 3)).toEqual(['ACCOUNT_SERVICE', true]);
  });

  it('compte technique : marqueur en base OU contexte serveur vérifié → technique', async () => {
    comptesTechniques = [12];
    await recordCallTrace(trace({ operationCode: 't1_analyze_document', useCaseCode: 'SOURCE_ANALYSIS', billable: true }));
    expect(ecrite()!.params.slice(1, 3)).toEqual(['TECHNICAL', false]);
    updates.length = 0; comptesTechniques = []; __resetCostClassificationStoreForTests();
    await runWithTechnicalAccount({ ok: true, accountId: 12 }, 'e2e', () => recordCallTrace(trace()));
    const u = ecrite()!;
    expect(u.params.slice(1, 3)).toEqual(['TECHNICAL', false]);
    expect(JSON.parse(String(u.params[3]))).toMatchObject({ reason: 'TECHNICAL_ACCOUNT', technicalContext: true });
  });

  it('campagne de qualification (déclencheur du contexte) et essai d’amélioration → technique', async () => {
    await runInJobContext({ jobId: null, treatment: 'T2', configVersionId: null, triggerCode: 'qualification' }, () => recordCallTrace(trace()));
    expect(JSON.parse(String(ecrite()!.params[3]))).toMatchObject({ reason: 'TECHNICAL_TRIGGER' });
    updates.length = 0;
    await runInJobContext({ jobId: null, treatment: 'T6', configVersionId: null, improvementAttemptKey: 'k' }, () => recordCallTrace(trace({ operationCode: 't6_formulate' })));
    expect(JSON.parse(String(ecrite()!.params[3]))).toMatchObject({ reason: 'IMPROVEMENT_ATTEMPT' });
  });

  it('sonde sans compte, campagne exemptée, observation → jamais imputées', async () => {
    await recordCallTrace(trace({ accountId: null, operationCode: 'circuit_breaker_probe' }));
    await recordCallTrace(trace({ costCapExempt: true }));
    await recordCallTrace(trace({ shadow: true, billable: false }));
    const lignes = updates.filter((u) => u.text.includes('cost_origin')).map((u) => u.params.slice(1, 3));
    expect(lignes).toEqual([['TECHNICAL', false], ['TECHNICAL', false], ['SHADOW', false]]);
  });

  it('migration 1610 absente : aucune écriture (la lecture applique la même règle), aucune erreur', async () => {
    colonnes1610 = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordCallTrace(trace())).resolves.toBe(101);
    expect(ecrite()).toBeUndefined();
  });
});
