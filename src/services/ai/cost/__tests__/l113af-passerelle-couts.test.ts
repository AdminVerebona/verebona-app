/**
 * Lot 113AF (Trello #730) — passerelle avec modèle SIMULÉ et compteur
 * d'appels fournisseur : chaque tentative réellement émise donne UNE trace,
 * classée par la règle unique (critères 1, 3, 4, 7).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); return traces.length; },
}));

const { AiGateway } = await import('../../gateway/ai-gateway');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { setCostCapStoreForTests } = await import('../../gateway/account-cost-cap');
const { classifyCallCost } = await import('../cost-classification');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('../../gateway/__tests__/t1-master-request');

const Schema = t1Schema({ ok: z.boolean() });
let fake: InstanceType<typeof FakeProvider>;
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 31,
  promptVariables: t1TestVariables(), outputSchema: Schema, idempotencyKey: `k-${Math.random()}`, ...over,
});
/** Classe une trace comme `recordCallTrace` le fait (contexte serveur fiable). */
const classer = (t: Record<string, unknown>) => classifyCallCost({
  accountId: t.accountId as number | null, useCaseCode: t.useCaseCode as string, operationCode: t.operationCode as string,
  shadow: t.shadow as boolean, triggerCode: (t.triggerCode as string | undefined) ?? null, costCapExempt: t.costCapExempt === true,
  legacyBillable: t.billable as boolean,
});

beforeEach(() => {
  traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  __setConfigForTests({ versionId: 3, entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: 'm-b', fallback2: null }] });
});
afterEach(() => { __setConfigForTests(null); setCostCapStoreForTests(null); });

describe('113AF — passerelle : une trace par tentative fournisseur, origine métier malgré billable:false', () => {
  it('critère 1 : t1_group_upload réussi → métier imputable ; `billable` (quota) inchangé à faux', async () => {
    fake.on('m-a', () => ({ rawText: t1Out({ ok: true }), inputTokens: 1_000, outputTokens: 50 }));
    await AiGateway.execute(req());
    expect(fake.calls).toHaveLength(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ operationCode: 't1_group_upload', status: 'success', billable: false, costCapExempt: false, inputTokens: 1_000 });
    expect(classer(traces[0])).toMatchObject({ origin: 'ACCOUNT_SERVICE', imputable: true });
  });

  it('critère 4 : échec APRÈS jetons consommés puis repli réussi → deux tentatives, deux traces, chacune comptée une fois', async () => {
    fake.on('m-a', () => { throw Object.assign(new Error('500 INTERNAL'), { status: 500, inputTokens: 800, outputTokens: 20 }); });
    fake.on('m-b', () => ({ rawText: t1Out({ ok: true }), inputTokens: 900, outputTokens: 40 }));
    await AiGateway.execute(req());
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a', 'm-b']);
    expect(traces.map((t) => [t.model, t.status, t.inputTokens])).toEqual([['m-a', 'error', 800], ['m-b', 'success', 900]]);
    for (const t of traces) expect(classer(t).origin).toBe('ACCOUNT_SERVICE');
  });

  it('critère 4 : JSON invalide (jetons consommés) puis repli → la tentative invalide reste une dépense du compte', async () => {
    fake.on('m-a', () => ({ rawText: 'pas du json', inputTokens: 500, outputTokens: 30 }));
    fake.on('m-b', () => ({ rawText: t1Out({ ok: true }), inputTokens: 500, outputTokens: 30 }));
    await AiGateway.execute(req());
    const tentativesFournisseur = fake.calls.length;
    const tracesAvecJetons = traces.filter((t) => Number(t.inputTokens) + Number(t.outputTokens) > 0);
    expect(tracesAvecJetons.length).toBe(tentativesFournisseur);
    expect(tracesAvecJetons[0]).toMatchObject({ model: 'm-a', status: 'error' });
    for (const t of tracesAvecJetons) expect(classer(t).origin).toBe('ACCOUNT_SERVICE');
  });

  it('critère 3 : campagne exemptée et observation → technique / observation, jamais imputées', async () => {
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 1 }));
    await AiGateway.execute(req({ costCapExempt: true }));
    await AiGateway.execute(req({ shadow: true }));
    expect(traces.map((t) => [t.costCapExempt, t.shadow])).toEqual([[true, false], [false, true]]);
    expect(classer(traces[0])).toMatchObject({ origin: 'TECHNICAL', reason: 'COST_CAP_EXEMPT', imputable: false });
    expect(classer(traces[1])).toMatchObject({ origin: 'SHADOW', imputable: false });
  });

  it('critère 7 : plafond du compte atteint → refus AVANT tout contact fournisseur (0 appel payant, aucune trace)', async () => {
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 1 }));
    const raised: unknown[] = [];
    setCostCapStoreForTests({
      planOf: async () => 'standard', overrideOf: async () => 1_000, offerCap: async () => null,
      spent: async () => 1_000, raise: async (a) => { raised.push(a); return true; },
    });
    await expect(AiGateway.execute(req({ operationCode: T1_TEST_OPERATION }))).rejects.toMatchObject({ code: 'COST_CAP_REACHED' });
    expect(fake.calls).toHaveLength(0);
    expect(traces).toHaveLength(0);
    expect(raised).toEqual([expect.objectContaining({ code: 'account_cost_cap_reached' })]);
  });

  it('critère 7 : plafond à 0 = désactivé, aucune lecture du cumul', async () => {
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 1 }));
    let lectures = 0;
    setCostCapStoreForTests({
      planOf: async () => 'standard', overrideOf: async () => 0, offerCap: async () => null,
      spent: async () => { lectures++; return 10 ** 9; }, raise: async () => true,
    });
    await AiGateway.execute(req());
    expect(lectures).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });
});
