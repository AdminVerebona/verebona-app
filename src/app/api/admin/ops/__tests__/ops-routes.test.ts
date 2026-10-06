/**
 * Page BO « Exploitation » (lot 25, chantier B) — routes `/api/admin/ops/**`
 * (hors tâches planifiées, chantier A) :
 *   · garde admin : sans session 401, non-admin 403, AUCUN service appelé ;
 *   · santé : rendue à l'admin sans en-tête `x-health-token` ;
 *   · rattrapages : demande invalide 400 (motif obligatoire), 409 si un
 *     rattrapage tourne déjà, 202 au lancement ;
 *   · CSRF : une écriture d'une autre origine est refusée par le middleware.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const etat = vi.hoisted(() => ({
  garde: vi.fn(async () => 7 as number),
  health: vi.fn(async () => ({ health: { status: 'ok' } })),
  config: vi.fn(async () => ({ sections: [] })),
  state: vi.fn(async () => ({ active: null, history: [], recoveredOrphans: 0 })),
  start: vi.fn(async () => ({ id: 'r1', status: 'running' })),
  run: vi.fn(async () => null as unknown),
  report: vi.fn(async () => null as unknown),
}));

vi.mock('@/lib/session-service', () => ({ SessionService: { requireAdmin: () => etat.garde() } }));
vi.mock('@/services/admin/ops/health-admin.service', () => ({ getAdminHealth: () => etat.health() }));
vi.mock('@/services/admin/ops/env-catalog', () => ({ getConfigReport: () => etat.config() }));
vi.mock('@/services/admin/ops/backfill/runner', async () => {
  class BackfillBusyError extends Error { code = 'BACKFILL_BUSY'; constructor(public active: unknown) { super('déjà en cours'); } }
  class BackfillUnavailableError extends Error { code = 'BACKFILL_UNAVAILABLE'; }
  return {
    BackfillBusyError, BackfillUnavailableError,
    getBackfillState: () => etat.state(),
    startBackfill: (...a: unknown[]) => (etat.start as (...x: unknown[]) => unknown)(...a),
    getBackfillRun: () => etat.run(),
    getBackfillReport: () => etat.report(),
  };
});

const health = await import('../health/route');
const config = await import('../config/route');
const backfills = await import('../backfills/route');
const backfill = await import('../backfills/[id]/route');
const report = await import('../backfills/[id]/report/route');
const { BackfillBusyError } = await import('@/services/admin/ops/backfill/runner');

const get = (url: string, headers: Record<string, string> = {}) => new NextRequest(`http://app.test${url}`, { headers });
const post = (body: unknown) => new NextRequest('http://app.test/api/admin/ops/backfills', { method: 'POST', body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) };

const appels = () => [etat.health, etat.config, etat.state, etat.start, etat.run, etat.report].reduce((n, f) => n + f.mock.calls.length, 0);

beforeEach(() => {
  for (const f of Object.values(etat)) f.mockClear();
  etat.garde.mockReset().mockResolvedValue(7);
});

describe('garde admin sur toutes les routes /api/admin/ops (chantier B)', () => {
  const routes: Array<[string, () => Promise<Response>]> = [
    ['GET health', () => health.GET(get('/api/admin/ops/health'))],
    ['GET config', () => config.GET(get('/api/admin/ops/config'))],
    ['GET backfills', () => backfills.GET(get('/api/admin/ops/backfills'))],
    ['POST backfills', () => backfills.POST(post({ script: 'merge-rooms', action: 'simulate' }))],
    ['GET backfills/:id', () => backfill.GET(get('/api/admin/ops/backfills/x'), params)],
    ['GET backfills/:id/report', () => report.GET(get('/api/admin/ops/backfills/x/report'), params)],
  ];

  it.each(routes)('%s : non-admin → 403, sans session → 401, aucun service appelé', async (_n, appel) => {
    etat.garde.mockRejectedValue(new Error('INSUFFICIENT_PERMISSIONS'));
    expect((await appel()).status).toBe(403);
    etat.garde.mockRejectedValue(new Error('AUTH_REQUIRED'));
    expect((await appel()).status).toBe(401);
    expect(appels()).toBe(0);
  });

  it('santé : rendue à l’admin SANS en-tête de jeton, jamais mise en cache', async () => {
    const r = await health.GET(get('/api/admin/ops/health'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(etat.health).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/admin/ops/backfills', () => {
  it('appliquer sans motif → 400 REASON_REQUIRED ; script ou action inconnus → 400', async () => {
    const r = await backfills.POST(post({ script: 'merge-rooms', action: 'apply', reason: ' ' }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('REASON_REQUIRED');
    expect((await backfills.POST(post({ script: 'rm -rf', action: 'apply', reason: 'motif long' }))).status).toBe(400);
    expect((await (await backfills.POST(post({ script: 'document-asset-links', action: 'simulate' }))).json()).code).toBe('ACTION_NOT_SUPPORTED');
    expect(etat.start).not.toHaveBeenCalled();
  });

  it('lancement → 202 ; rattrapage déjà en cours → 409 BACKFILL_BUSY', async () => {
    const ok = await backfills.POST(post({ script: 'merge-rooms', action: 'apply', reason: 'Reprise D-G préprod' }));
    expect(ok.status).toBe(202);
    expect(etat.start).toHaveBeenCalledWith(
      expect.objectContaining({ script: 'merge-rooms', action: 'apply', reason: 'Reprise D-G préprod' }), { id: 7 },
    );
    etat.start.mockRejectedValueOnce(new BackfillBusyError({ id: 'actif' } as never));
    const occupe = await backfills.POST(post({ script: 'cdc15', action: 'simulate' }));
    expect(occupe.status).toBe(409);
    expect(await occupe.json()).toMatchObject({ code: 'BACKFILL_BUSY', active: { id: 'actif' } });
  });
});

describe('CSRF (middleware) sur les écritures /api/admin/ops', () => {
  it('origine étrangère refusée, même origine acceptée', async () => {
    const { verifyRequestOrigin } = await import('@/lib/csrf');
    const req = (origin?: string) => new NextRequest('http://app.test/api/admin/ops/backfills', {
      method: 'POST', headers: origin ? { origin } : {},
    });
    expect(verifyRequestOrigin(req('https://evil.example')).allowed).toBe(false);
    expect(verifyRequestOrigin(req()).allowed).toBe(false);
    expect(verifyRequestOrigin(req('http://app.test')).allowed).toBe(true);
  });
});
