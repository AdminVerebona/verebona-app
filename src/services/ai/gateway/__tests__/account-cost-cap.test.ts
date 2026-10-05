/**
 * Plafond mensuel de coût IA par compte — lot 22, chantier A.
 *
 *   · période : mois civil Europe/Paris (changement d'heure, décembre) ;
 *   · plafond effectif : dérogation prioritaire, puis offre ; 0 / absent = aucun ;
 *   · aucune valeur posée : aucun plafond, cumul jamais lu ;
 *   · 80 % : une alerte par compte et par période ; 100 % : refus daté + alerte ;
 *   · exemptions : T5, appels sans compte, campagnes de mesure ;
 *   · base illisible : échec ouvert ;
 *   · passerelle : refus AVANT tout appel fournisseur, résultat en cache servi.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  costCapPeriod, resumeLabel, costCapAnalysisReason, effectiveCap, costCapLevel, isCostCapped,
  assertAccountCostCap, costCapReachedFor, getAccountCostCapStatus, setCostCapStoreForTests,
  type CostCapStore, type CostCapPlan,
} from '../account-cost-cap';
import { AiCostCapReachedError, isCostCapReached, costCapResumeAt } from '../errors';
import type { AlertInput } from '../../alerts/alerts.repository';

function fakeStore(o: {
  plan?: CostCapPlan; override?: number | null; offer?: Partial<Record<CostCapPlan, number | null>>; spent?: number;
  failSpent?: boolean;
} = {}) {
  const alerts: AlertInput[] = [];
  const spentCalls: Array<[number, Date, Date]> = [];
  const store: CostCapStore = {
    planOf: async () => o.plan ?? 'premium',
    overrideOf: async () => o.override ?? null,
    offerCap: async (p) => o.offer?.[p] ?? null,
    spent: async (a, s, e) => {
      spentCalls.push([a, s, e]);
      if (o.failSpent) throw new Error('base injoignable');
      return o.spent ?? 0;
    },
    raise: async (a) => { alerts.push(a); return true; },
  };
  return { store, alerts, spentCalls };
}

afterEach(() => setCostCapStoreForTests(null));

describe('période : mois civil Europe/Paris', () => {
  it('octobre 2026 : du 1er à 00:00 (CEST) au 1er novembre 00:00 (CET)', () => {
    const p = costCapPeriod(new Date('2026-10-05T10:00:00Z'));
    expect(p.key).toBe('2026-10');
    expect(p.start.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });
  it('31 octobre 23:30 UTC = 1er novembre à Paris : période suivante', () => {
    expect(costCapPeriod(new Date('2026-10-31T23:30:00Z')).key).toBe('2026-11');
    expect(costCapPeriod(new Date('2026-10-31T22:59:59Z')).key).toBe('2026-10');
  });
  it('décembre → janvier de l’année suivante', () => {
    const p = costCapPeriod(new Date('2026-12-15T12:00:00Z'));
    expect(p.end.toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(costCapPeriod(p.end).key).toBe('2027-01');
  });
  it('libellés de reprise', () => {
    const fin = costCapPeriod(new Date('2026-10-05T10:00:00Z')).end;
    expect(resumeLabel(fin)).toBe('1er novembre');
    expect(costCapAnalysisReason(fin)).toMatch(/^Plafond IA du mois atteint, reprise le 1er novembre/);
  });
});

describe('résolution (pur)', () => {
  it('dérogation prioritaire sur l’offre ; dérogation 0 = sans plafond', () => {
    expect(effectiveCap({ offerCapMicros: 5_000_000, overrideMicros: 9_000_000 })).toEqual({ capMicros: 9_000_000, source: 'override' });
    expect(effectiveCap({ offerCapMicros: 5_000_000, overrideMicros: 0 })).toEqual({ capMicros: null, source: 'override' });
    expect(effectiveCap({ offerCapMicros: 5_000_000, overrideMicros: null })).toEqual({ capMicros: 5_000_000, source: 'offer' });
  });
  it('aucune valeur posée (ou 0) : aucun plafond', () => {
    expect(effectiveCap({ offerCapMicros: null, overrideMicros: null })).toEqual({ capMicros: null, source: null });
    expect(effectiveCap({ offerCapMicros: 0, overrideMicros: null })).toEqual({ capMicros: null, source: null });
  });
  it('niveaux', () => {
    expect(costCapLevel(10, null)).toBe('none');
    expect(costCapLevel(79, 100)).toBe('ok');
    expect(costCapLevel(80, 100)).toBe('threshold');
    expect(costCapLevel(100, 100)).toBe('reached');
  });
  it('exemptions : T5, sans compte, campagne de mesure', () => {
    expect(isCostCapped({ accountId: 3, useCaseCode: 'SOURCE_ANALYSIS' })).toBe(true);
    expect(isCostCapped({ accountId: 3, useCaseCode: 'HOME_MASCOT' })).toBe(true);
    expect(isCostCapped({ accountId: 3, useCaseCode: 'AI_GOVERNANCE' })).toBe(false);
    expect(isCostCapped({ accountId: 0, useCaseCode: 'SOURCE_ANALYSIS' })).toBe(false);
    expect(isCostCapped({ accountId: null, useCaseCode: 'SOURCE_ANALYSIS' })).toBe(false);
    expect(isCostCapped({ accountId: 3, useCaseCode: 'SOURCE_ANALYSIS', exempt: true })).toBe(false);
  });
});

describe('contrôle de la passerelle', () => {
  const NOW = new Date('2026-10-05T10:00:00Z');
  const appel = (accountId = 7) => assertAccountCostCap({ accountId, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 't1_analyze_document', now: NOW });

  it('aucune valeur posée : passe, cumul jamais lu, aucune alerte', async () => {
    const f = fakeStore({ spent: 999_000_000 });
    setCostCapStoreForTests(f.store);
    await expect(appel()).resolves.toBeUndefined();
    expect(f.spentCalls).toHaveLength(0);
    expect(f.alerts).toHaveLength(0);
  });

  it('cumul lu sur le mois Europe/Paris, hors T5 côté requête', async () => {
    const f = fakeStore({ offer: { premium: 10_000_000 }, spent: 1 });
    setCostCapStoreForTests(f.store);
    await appel();
    expect(f.spentCalls[0][1].toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(f.spentCalls[0][2].toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });

  it('80 % : passe, UNE alerte de seuil par compte et par période', async () => {
    const f = fakeStore({ offer: { premium: 10_000_000 }, spent: 8_500_000 });
    setCostCapStoreForTests(f.store);
    await appel();
    await appel();
    await appel();
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]).toMatchObject({
      kind: 'budget', code: 'account_cost_cap_threshold', accountId: 7, severity: 'warning',
      dedupeKey: 'account_cost_cap:threshold:7:2026-10:10000000',
    });
  });

  it('100 % : refus daté (reprise le 1er), alerte critique une fois', async () => {
    const f = fakeStore({ offer: { premium: 10_000_000 }, spent: 10_000_000 });
    setCostCapStoreForTests(f.store);
    const e = await appel().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiCostCapReachedError);
    expect(isCostCapReached(e)).toBe(true);
    expect((e as AiCostCapReachedError).recoverable).toBe(false);
    expect(costCapResumeAt(e)?.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    await appel().catch(() => undefined);
    expect(f.alerts.filter((a) => a.code === 'account_cost_cap_reached')).toHaveLength(1);
  });

  it('dérogation prioritaire : relevée → passe ; 0 → sans plafond', async () => {
    setCostCapStoreForTests(fakeStore({ offer: { premium: 1_000_000 }, override: 50_000_000, spent: 2_000_000 }).store);
    await expect(appel()).resolves.toBeUndefined();
    setCostCapStoreForTests(fakeStore({ offer: { premium: 1_000_000 }, override: 0, spent: 2_000_000 }).store);
    await expect(appel()).resolves.toBeUndefined();
    setCostCapStoreForTests(fakeStore({ offer: { premium: 100_000_000 }, override: 1_000_000, spent: 2_000_000 }).store);
    await expect(appel()).rejects.toMatchObject({ code: 'COST_CAP_REACHED' });
  });

  it('plafond de l’offre du compte seulement', async () => {
    setCostCapStoreForTests(fakeStore({ plan: 'standard', offer: { premium: 1_000_000 }, spent: 2_000_000 }).store);
    await expect(appel()).resolves.toBeUndefined();
  });

  it('T5 et appels sans compte jamais plafonnés', async () => {
    setCostCapStoreForTests(fakeStore({ offer: { premium: 1 }, spent: 10 }).store);
    await expect(assertAccountCostCap({ accountId: 7, useCaseCode: 'AI_GOVERNANCE', operationCode: 't5', now: NOW })).resolves.toBeUndefined();
    await expect(assertAccountCostCap({ accountId: null, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'x', now: NOW })).resolves.toBeUndefined();
  });

  it('plafond modifié en cours de mois : nouvelle alerte (valeur du plafond dans la clé)', async () => {
    const f = fakeStore({ offer: { premium: 10_000_000 }, spent: 9_000_000 });
    setCostCapStoreForTests(f.store);
    await appel();
    f.store.offerCap = async () => 11_000_000;
    const { resetCostCapCache } = await import('../account-cost-cap');
    resetCostCapCache(7);
    await appel();
    expect(f.alerts.map((a) => a.dedupeKey)).toEqual([
      'account_cost_cap:threshold:7:2026-10:10000000', 'account_cost_cap:threshold:7:2026-10:11000000',
    ]);
  });

  it('compte technique des campagnes (CORPUS_ACCOUNT_ID) : jamais plafonné, opérations comme pipeline', async () => {
    vi.stubEnv('CORPUS_ACCOUNT_ID', '7');
    setCostCapStoreForTests(fakeStore({ offer: { premium: 1 }, spent: 10 }).store);
    expect(isCostCapped({ accountId: 7, useCaseCode: 'SOURCE_ANALYSIS' })).toBe(false);
    await expect(appel()).resolves.toBeUndefined();
    expect(await costCapReachedFor(7, NOW)).toBeNull();
    expect(isCostCapped({ accountId: 8, useCaseCode: 'SOURCE_ANALYSIS' })).toBe(true);
    vi.unstubAllEnvs();
  });

  it('mêmes bornes pour le réglage d’offre et la dérogation', async () => {
    const { COST_CAP_MAX_MICROS, COST_CAP_SETTING_KEYS } = await import('../account-cost-cap');
    const { assistantSettingDef } = await import('@/services/verebona-assistant/config/assistant-settings');
    for (const key of Object.values(COST_CAP_SETTING_KEYS)) {
      expect(assistantSettingDef(key)).toMatchObject({ type: 'usd_micros', default: 0, min: 0, max: COST_CAP_MAX_MICROS });
    }
  });

  it('base illisible : échec ouvert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCostCapStoreForTests(fakeStore({ offer: { premium: 1 }, failSpent: true }).store);
    await expect(appel()).resolves.toBeUndefined();
    expect(await costCapReachedFor(7, NOW)).toBeNull();
    vi.restoreAllMocks();
  });

  it('état BO : cumul lu même sans plafond (withSpent)', async () => {
    setCostCapStoreForTests(fakeStore({ spent: 1_234 }).store);
    const s = await getAccountCostCapStatus(7, { withSpent: true, now: NOW });
    expect(s).toMatchObject({ capMicros: null, spentMicros: 1_234, level: 'none', periodKey: '2026-10', plan: 'premium' });
  });

  it('sous NODE_ENV=test sans accès posé : aucun plafond (tests existants intacts)', async () => {
    setCostCapStoreForTests(null);
    await expect(appel()).resolves.toBeUndefined();
  });
});

describe('passerelle : refus avant tout appel fournisseur', () => {
  let fake: import('../providers').FakeProvider;
  beforeEach(async () => {
    const { FakeProvider, setAiProvider } = await import('../providers');
    fake = new FakeProvider();
    setAiProvider(fake);
  });

  it('plafond atteint : COST_CAP_REACHED, aucun appel fournisseur', async () => {
    const { AiGateway } = await import('../ai-gateway');
    const { T1_TEST_OPERATION, t1TestVariables, t1Schema } = await import('./t1-master-request');
    setCostCapStoreForTests(fakeStore({ offer: { premium: 1_000 }, spent: 5_000 }).store);
    fake.onAny(() => ({ rawText: '{}', inputTokens: 1, outputTokens: 1 }));
    await expect(AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: 7,
      promptVariables: t1TestVariables('facture'), outputSchema: t1Schema({ title: z.string() }),
      idempotencyKey: `cap-${Math.random()}`,
    })).rejects.toMatchObject({ code: 'COST_CAP_REACHED' });
    expect(fake.calls).toHaveLength(0);
  });
});
