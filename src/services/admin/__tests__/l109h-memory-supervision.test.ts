/**
 * Lot 109H — Supervision mémoire : alerte de pression et absence de worker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportAnomaly = vi.fn(async (_i: Record<string, unknown>) => 1);
const autoResolveAnomaly = vi.fn(async (_f: string, _o: Record<string, unknown>) => true);
vi.mock('@/services/admin/anomaly.service', () => ({
  reportAnomaly: (i: Record<string, unknown>) => reportAnomaly(i),
  autoResolveAnomaly: (f: string, o: Record<string, unknown>) => autoResolveAnomaly(f, o),
  buildFingerprint: (...p: string[]) => p.join(':'),
}));
vi.mock('@/services/ai/queue/worker-heartbeat', () => ({
  listWorkerHeartbeats: async () => [],
  isWorkerAlive: (r: { lastTickAt: Date }, now: Date) => now.getTime() - r.lastTickAt.getTime() <= 90_000,
}));

import { checkBackgroundWorkerPresence, NO_WORKER_FINGERPRINT, reportMemoryPressure, resolveMemoryPressure } from '../memory-supervision';

const sample = { at: 0, rssMb: 700, heapUsedMb: 300, heapTotalMb: 320, heapLimitMb: 614, externalMb: 5, arrayBuffersMb: 1, containerUsedMb: 900, containerLimitMb: 1024, limitSource: 'CONTAINER_MEMORY' as const };
const ctx = { processType: 'web', activeTasks: ['export:v12'], topPeaks: [{ kind: 'export:v12', runs: 2, maxPeakUsedMb: 950, maxDeltaMb: 400, maxPeakRssMb: 700, lastPeakUsedMb: 900, lastDeltaMb: 300, lastAt: '' }], percent: 88 };

beforeEach(() => { reportAnomaly.mockClear(); autoResolveAnomaly.mockClear(); });

describe('L109H — alerte de pression mémoire', () => {
  it('anomalie « Autres traitements techniques » par type de processus, détail sans secret', async () => {
    await reportMemoryPressure(sample, ctx, 'web-1');
    const arg = reportAnomaly.mock.calls[0][0] as { domain: string; fingerprint: string; title: string; detail: Record<string, unknown> };
    expect(arg).toMatchObject({ domain: 'other', fingerprint: 'other:memory:web' });
    expect(arg.title).toBe('Mémoire du conteneur web à 88 % de sa limite');
    expect(arg.detail).toMatchObject({ container: 'web-1', usedMb: 900, limitMb: 1024, measuredOn: 'conteneur (cgroup)', activeTasks: ['export:v12'] });
    expect(JSON.stringify(arg.detail)).not.toMatch(/DATABASE_URL|SECRET|postgres:\/\//i);
    await resolveMemoryPressure(sample, ctx);
    expect(autoResolveAnomaly).toHaveBeenCalledWith('other:memory:web', expect.objectContaining({ origin: 'memory_monitor' }));
  });
});

describe('L109H — séparation activée sans worker vivant', () => {
  const now = () => new Date('2026-11-04T12:00:00Z');
  it('aucun battement vivant → anomalie ; battement récent → résolution', async () => {
    expect(await checkBackgroundWorkerPresence({ list: async () => [{ lastTickAt: new Date('2026-11-04T11:00:00Z'), intervalMs: 15_000 }], now })).toBe('missing');
    expect(reportAnomaly.mock.calls[0][0]).toMatchObject({ fingerprint: NO_WORKER_FINGERPRINT });
    expect(await checkBackgroundWorkerPresence({ list: async () => [{ lastTickAt: new Date('2026-11-04T11:59:50Z'), intervalMs: 15_000 }], now })).toBe('ok');
    expect(autoResolveAnomaly).toHaveBeenCalledWith(NO_WORKER_FINGERPRINT, expect.anything());
  });

  it('table de battements illisible → état inconnu, rien signalé', async () => {
    expect(await checkBackgroundWorkerPresence({ list: async () => null, now })).toBe('unknown');
    expect(reportAnomaly).not.toHaveBeenCalled();
  });
});
