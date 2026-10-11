/**
 * Lot 37 — C5 : le contrôle de santé signale un secret JWT non conforme
 * (sans jamais sa valeur), et l'état du limiteur d'authentification (C4).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/health/probes', () => ({
  probeDatabase: async () => ({ status: 'ok', responseTime: 1, checkedAt: '' }),
  probeS3: async () => ({ status: 'ok', responseTime: 1, checkedAt: '', configured: true, misconfigured: false, configErrors: [], configWarnings: [] }),
  probeSchema: async () => ({ ready: true, phase: 'ready', pendingCritical: 0, pendingOptional: 0, firstFailure: null }),
}));
vi.mock('@/db', async (orig) => ({ ...(await orig<typeof import('@/db')>()), getMigrationFailures: () => [] }));

const { buildHealthReport } = await import('@/lib/health/diagnostic');

afterEach(() => vi.unstubAllEnvs());

describe('C5-07 /api/health — secret des sessions', () => {
  it('secret absent : erreur signalée ; nature du problème réservée au diagnostic autorisé', async () => {
    vi.stubEnv('JWT_SECRET', '');
    const pub = (await buildHealthReport({ detailed: false })).result.checks.jwtSecret;
    expect(pub).toMatchObject({ status: 'error' });
    expect(pub).not.toHaveProperty('problem');
    const diag = (await buildHealthReport({ detailed: true })).result.checks.jwtSecret;
    expect(diag).toMatchObject({ status: 'error', problem: 'missing' });
  });

  it('secret conforme : ok, et la valeur n’apparaît jamais', async () => {
    const secret = 's'.repeat(48);
    vi.stubEnv('JWT_SECRET', secret);
    const { result } = await buildHealthReport({ detailed: true });
    expect(result.checks.jwtSecret).toMatchObject({ status: 'ok' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('C4-24 état du limiteur d’authentification exposé (mode)', async () => {
    const { result } = await buildHealthReport({ detailed: false });
    expect(result.checks.authRateLimiter?.mode).toMatch(/shared|memory-fallback|not_used/);
  });
});
