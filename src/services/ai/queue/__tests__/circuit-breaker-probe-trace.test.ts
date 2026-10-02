/**
 * Sondes du disjoncteur tracées en coût technique — MOD-013, OPS-026.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (sql: string, p: unknown[]) => unsafe(sql, p) } }));
const recordCallTrace = vi.fn(async (_t: unknown) => {});
vi.mock('../../telemetry/ai-trace.service', () => ({ recordCallTrace: (t: unknown) => recordCallTrace(t) }));

const { runDueProbes } = await import('../circuit-breaker.repository');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { getOperation } = await import('../../registry/operations');

beforeEach(() => {
  unsafe.mockReset();
  unsafe.mockResolvedValue([]);
  recordCallTrace.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('traçage des sondes (MOD-013, OPS-026)', () => {
  it('chaque sonde écrit un appel technique sans compte, non facturable, avec ses jetons', async () => {
    const t4 = getOperation('t4_classify_event');
    const [primary, fb1] = [t4.primaryModel, t4.fallbackModels[0]];
    const fake = new FakeProvider()
      .on(primary, async () => { throw new Error('503 indisponible'); })
      .on(fb1, async () => ({ rawText: 'OK', inputTokens: 7, outputTokens: 1 }));
    setAiProvider(fake);
    unsafe.mockResolvedValueOnce([{ treatment: 'T4', model_failures: {}, probe_attempts: 0 }]);

    const r = await runDueProbes();
    expect(r[0].reactivated).toBe(true);
    expect(recordCallTrace).toHaveBeenCalledTimes(2);
    const [echec, succes] = recordCallTrace.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
    for (const t of [echec, succes]) {
      expect(t.accountId).toBeNull();
      expect(t.billable).toBe(false);
      expect(t.operationCode).toBe('circuit_breaker_probe');
      expect(t.useCaseCode).toBe('AGENDA_INTELLIGENCE');
    }
    expect(echec).toMatchObject({ status: 'error', modelRank: 'primary', model: primary });
    expect(succes).toMatchObject({ status: 'success', modelRank: 'fallback_1', inputTokens: 7, outputTokens: 1 });
  });
});
