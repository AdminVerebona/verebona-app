/**
 * Revue L16b-3 — disjoncteur : les échecs complets répétés d'une MÊME cible
 * (un document relancé depuis le tiroir, repris par la file) ne comptent
 * qu'une fois par fenêtre ; des cibles distinctes comptent chacune.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as string[], count: 0 }));
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async (q: string) => {
      h.calls.push(q);
      if (q.includes('consecutive_chain_failures + 1')) { h.count += 1; return [{ consecutive_chain_failures: h.count, state: 'ENABLED' }]; }
      if (q.includes("SET state = 'SUSPENDED'")) return [{ treatment: 'T1' }];
      return [];
    }),
  },
}));
vi.mock('../runnable-guard', async (orig) => ({ ...(await orig<object>()), invalidateRuntimeGuardCache: () => {} }));

const { recordChainOutcome, __resetSameTargetMemoryForTests, CHAIN_FAILURE_SUSPEND_THRESHOLD, SAME_TARGET_WINDOW_MS } =
  await import('../circuit-breaker.repository');

const increments = () => h.calls.filter((q) => q.includes('consecutive_chain_failures + 1')).length;

beforeEach(() => {
  h.calls = []; h.count = 0;
  __resetSameTargetMemoryForTests();
  vi.useRealTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordChainOutcome — une fois par cible', () => {
  it('le même document en échec dix fois : un seul échec compté, jamais de suspension', async () => {
    for (let i = 0; i < 10; i++) expect(await recordChainOutcome('T1', false, 'sources:42')).toBe(false);
    expect(increments()).toBe(1);
    expect(h.calls.some((q) => q.includes("SET state = 'SUSPENDED'"))).toBe(false);
  });

  it('cinq documents distincts : chacun compte, le seuil suspend comme avant', async () => {
    let ouvert = false;
    for (let i = 0; i < CHAIN_FAILURE_SUSPEND_THRESHOLD; i++) ouvert = await recordChainOutcome('T1', false, `sources:${i}`);
    expect(increments()).toBe(CHAIN_FAILURE_SUSPEND_THRESHOLD);
    expect(ouvert).toBe(true);
  });

  it('sans cible (appel sans sources) : comportement inchangé, chaque échec compte', async () => {
    await recordChainOutcome('T2', false);
    await recordChainOutcome('T2', false);
    expect(increments()).toBe(2);
  });

  it('fenêtre écoulée : la cible compte de nouveau', async () => {
    vi.useFakeTimers({ now: Date.now() });
    await recordChainOutcome('T1', false, 'sources:42');
    vi.setSystemTime(Date.now() + SAME_TARGET_WINDOW_MS + 1000);
    await recordChainOutcome('T1', false, 'sources:42');
    expect(increments()).toBe(2);
  });
});
