/**
 * Circuit breaker branché au runtime — MOD-007 à MOD-014, OPS-019 à OPS-026.
 *
 * `pgClient` est simulé : on vérifie les écritures demandées, pas PostgreSQL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { GatewayOutcome } from '../circuit-breaker.repository';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (sql: string, p: unknown[]) => unsafe(sql, p) } }));

const {
  recordChainOutcome, recordModelAttempt, runDueProbes, getModelAlerts,
  setGatewayOutcomeRecorder, CHAIN_FAILURE_SUSPEND_THRESHOLD,
} = await import('../circuit-breaker.repository');
const { nextProbeDelay } = await import('../circuit-breaker');
const { AiGateway } = await import('../../gateway/ai-gateway');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { getOperation } = await import('../../registry/operations');

const sqls = () => unsafe.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  unsafe.mockReset();
  unsafe.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('compteurs par modèle (MOD-007, MOD-008)', () => {
  it('échec : incrément atomique du compteur du modèle', async () => {
    await recordModelAttempt('T1', 'gemini-a', false);
    expect(sqls()[0]).toMatch(/model_failures \|\| jsonb_build_object/);
    expect(unsafe.mock.calls[0][1]).toEqual(['T1', 'gemini-a']);
  });
  it('succès : efface SON compteur, et seulement s’il existe', async () => {
    await recordModelAttempt('T1', 'gemini-a', true);
    expect(sqls()[0]).toMatch(/model_failures - \$2::text/);
    expect(sqls()[0]).toMatch(/model_failures \? \$2::text/);
  });
  it('alertes : modèles à dix échecs ou plus, par traitement', async () => {
    unsafe.mockResolvedValueOnce([
      { treatment: 'T1', model_failures: { a: 10, b: 3 } },
      { treatment: 'T2', model_failures: { a: 2 } },
    ]);
    await expect(getModelAlerts()).resolves.toEqual([{ treatment: 'T1', model: 'a', consecutiveFailures: 10 }]);
  });
});

describe('ouverture du disjoncteur (OPS-022, MOD-011)', () => {
  it('sous le seuil : compte, ne suspend pas', async () => {
    unsafe.mockResolvedValueOnce([{ consecutive_chain_failures: CHAIN_FAILURE_SUSPEND_THRESHOLD - 1, state: 'ENABLED' }]);
    await expect(recordChainOutcome('T3', false)).resolves.toBe(false);
    expect(sqls().some((s) => /'SUSPENDED'/.test(s))).toBe(false);
  });

  it('au seuil : SUSPENDED avec prochaine sonde, SANS remise en file', async () => {
    unsafe
      .mockResolvedValueOnce([{ consecutive_chain_failures: CHAIN_FAILURE_SUSPEND_THRESHOLD, state: 'ENABLED' }])
      .mockResolvedValueOnce([{ treatment: 'T3' }]);
    await expect(recordChainOutcome('T3', false)).resolves.toBe(true);
    const suspend = unsafe.mock.calls[1];
    expect(String(suspend[0])).toMatch(/state = 'SUSPENDED'/);
    expect(String(suspend[0])).toMatch(/suspended_by_breaker = TRUE/);
    // Jamais par-dessus une désactivation manuelle.
    expect(String(suspend[0])).toMatch(/AND state = 'ENABLED'/);
    expect(suspend[1]).toContain(nextProbeDelay(0));
    // MOD-011 : aucune écriture sur la file, aucun requeue.
    expect(sqls().some((s) => /ai_job_queue/.test(s))).toBe(false);
  });

  it('un succès remet la série d’échecs complets à zéro', async () => {
    await recordChainOutcome('T3', true);
    expect(sqls()[0]).toMatch(/consecutive_chain_failures = 0/);
  });

  it('le module n’importe ni requeueRunning ni abortLocalExecutions', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/ai/queue/circuit-breaker.repository.ts'), 'utf8');
    expect(src).not.toMatch(/import[^;]*requeueRunning/);
    expect(src).not.toMatch(/abortLocalExecutions\(/);
  });
});

describe('sondes (WF-09, MOD-013, MOD-014)', () => {
  const t4 = getOperation('classify_event');

  it('premier succès (repli 1) : réactive, n’efface que le compteur du modèle qui a répondu', async () => {
    const [primary, fb1] = [t4.primaryModel, t4.fallbackModels[0]];
    unsafe.mockResolvedValueOnce([
      { treatment: 'T4', model_failures: { [primary]: 12, [fb1]: 4 }, probe_attempts: 2 },
    ]);
    const probe = vi.fn(async (m: string) => m === fb1);
    const r = await runDueProbes(probe);
    expect(r).toEqual([{ treatment: 'T4', reactivated: true, recoveredWith: fb1 }]);
    // Principal d'abord (MOD-002), arrêt au premier succès.
    expect(probe.mock.calls.map(([m]) => m)).toEqual([primary, fb1]);
    const upd = unsafe.mock.calls[1];
    expect(String(upd[0])).toMatch(/state = 'ENABLED'/);
    expect(String(upd[0])).toMatch(/suspended_by_breaker = TRUE/); // condition : décision admin prioritaire
    expect(JSON.parse(String(upd[1][1]))).toEqual({ [primary]: 13 });
  });

  it('aucun succès : sonde suivante repoussée selon le planning progressif', async () => {
    unsafe.mockResolvedValueOnce([{ treatment: 'T4', model_failures: {}, probe_attempts: 1 }]);
    const r = await runDueProbes(async () => false);
    expect(r[0].reactivated).toBe(false);
    const upd = unsafe.mock.calls[1];
    expect(String(upd[0])).toMatch(/probe_attempts = probe_attempts \+ 1/);
    expect(upd[1][2]).toBe(nextProbeDelay(2));
  });
});

describe('câblage gateway → disjoncteur', () => {
  const outcomes: GatewayOutcome[] = [];
  let fake: InstanceType<typeof FakeProvider>;
  const op = getOperation('classify_document');
  const Schema = z.object({ title: z.string(), amountCents: z.number() });
  const req = (over: Record<string, unknown> = {}) => ({
    useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: 'classify_document', accountId: 1,
    promptVariables: {}, outputSchema: Schema, idempotencyKey: `cb-${Math.random()}`, ...over,
  });

  beforeEach(() => {
    outcomes.length = 0;
    setGatewayOutcomeRecorder(async (o) => { outcomes.push(o); });
    fake = new FakeProvider();
    setAiProvider(fake);
  });
  afterEach(() => setGatewayOutcomeRecorder(null));

  it('repli réussi : échec du principal compté (MOD-009), chaîne réussie', async () => {
    fake.on(op.primaryModel, () => { throw new Error('503'); });
    fake.onAny(() => ({ rawText: '{"title":"a","amountCents":1}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    expect(outcomes).toEqual([{
      treatment: 'T1',
      attempts: [{ model: op.primaryModel, succeeded: false }, { model: op.fallbackModels[0], succeeded: true }],
      chainSucceeded: true,
    }]);
  });

  it('tous en échec : échec complet de la chaîne', async () => {
    fake.onAny(() => { throw new Error('503'); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(outcomes[0].chainSucceeded).toBe(false);
    expect(outcomes[0].attempts).toHaveLength(1 + op.fallbackModels.length);
  });

  it('chaîne tronquée par un budget d’appelant : pas un échec complet', async () => {
    fake.onAny(() => { throw new Error('503'); });
    await expect(AiGateway.execute(req({ maxModelAttempts: 1 }))).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(outcomes[0].chainSucceeded).toBeNull();
  });
});
