/**
 * Lot 24 — #10 : mesures du pool PostgreSQL dans le diagnostic PROTÉGÉ de
 * /api/health (en-tête `x-health-token`). Sans jeton valide : rien.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', () => ({
  db: { execute: async () => [] }, getMigrationFailures: () => [],
  getSchemaReadiness: async () => ({ ready: true, phase: 'ready', pendingCritical: 0, pendingOptional: 0, firstFailure: null }),
}));
vi.mock('@/services/ai/config/prompt-architecture', () => ({ promptArchitectureWarnings: async () => [] }));
vi.mock('@/services/verebona-assistant/core/help-corpus.service', () => ({
  loadHelpCorpus: async () => null, helpCorpusHealth: () => ({ status: 'ok', source: 'live' }),
}));

const { GET } = await import('../route');
const { getPoolMetrics } = await import('@/db/pool-metrics');
const JETON = 'jeton-diagnostic-de-test-0123456789';
const req = (token?: string) => new NextRequest('http://localhost/api/health', { headers: token ? { 'x-health-token': token } : {} });

afterEach(() => { vi.unstubAllEnvs(); });

describe('GET /api/health — pool PostgreSQL', () => {
  it('diagnostic autorisé : attente d’acquisition et temps SQL agrégés, sans requête ni URL', async () => {
    vi.stubEnv('HEALTH_DIAGNOSTIC_TOKEN', JETON);
    vi.stubEnv('DB_POOL_MAX', '4');
    const j = getPoolMetrics().debut(); j.prise(); j.fin(false);
    const body = await (await GET(req(JETON))).json();
    expect(body.checks.dbPool).toMatchObject({
      status: 'ok', max: 4, maxSource: expect.any(String),
      poolWait: expect.objectContaining({ count: expect.any(Number) }),
      sql: expect.objectContaining({ p95Ms: expect.anything() }),
      inFlight: expect.any(Number), waiting: expect.any(Number),
    });
    expect(JSON.stringify(body.checks.dbPool)).not.toMatch(/postgres:\/\//);
  });

  it('sans jeton (ou jeton faux) : non exposé', async () => {
    vi.stubEnv('HEALTH_DIAGNOSTIC_TOKEN', JETON);
    expect((await (await GET(req())).json()).checks.dbPool).toBeUndefined();
    expect((await (await GET(req('mauvais-jeton-0123456789'))).json()).checks.dbPool).toBeUndefined();
  });
});
