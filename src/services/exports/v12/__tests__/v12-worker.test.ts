/**
 * Worker de génération : délai global par exécution (une génération bloquée
 * ne bloque pas la file) et battement de cœur plafonné.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claimed: unknown[] = [];
const claimMock = vi.fn(async () => (claimed.length ? claimed.shift() : null));
const renewMock = vi.fn(async () => true);
vi.mock('../generation/repository', () => ({
  LEASE_SECONDS: 120,
  claimNextGeneration: () => claimMock(),
  renewGenerationLease: () => renewMock(),
}));
const signals: Array<AbortSignal | undefined> = [];
const runMock = vi.fn((_row: unknown, _w: string, opts: { signal?: AbortSignal }) => {
  signals.push(opts.signal);
  return new Promise<never>(() => {}); // exécution bloquée pour toujours
});
const failMock = vi.fn(async () => true);
vi.mock('../generation/job', () => ({
  runGeneration: (row: unknown, w: string, opts: { signal?: AbortSignal }) => runMock(row, w, opts),
  failTimedOutGeneration: () => failMock(),
  jobTimeoutMs: () => 30_000,
}));

const { drainExportQueue } = await import('../generation/worker');

beforeEach(() => {
  vi.useFakeTimers();
  claimMock.mockClear(); renewMock.mockClear(); runMock.mockClear(); failMock.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); });

describe('drainExportQueue', () => {
  it('délai global : génération close en échec, signal levé, file poursuivie', async () => {
    claimed.push({ id: 1 }, { id: 2 });
    const drained = drainExportQueue('w1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(failMock).toHaveBeenCalledTimes(1);
    // La seconde génération est prise sans attendre la première.
    expect(runMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failMock).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(true);
    expect(await drained).toBe(2);
    // Battement de cœur actif pendant l'exécution (toutes les 40 s au plus), arrêté ensuite.
    const renewed = renewMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renewMock.mock.calls.length).toBe(renewed);
  });
});
