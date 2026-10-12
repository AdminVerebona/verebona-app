/**
 * Lot 47A — O9 : routes `/api/admin/operations/**` (BO diagnostic des
 * Opérations, CDC Opérations V1 C25, C26 ; décisions PO Q8, Q9).
 *
 *   · O9-R01 droits : sans session 401, non-admin 403 — AUCUN service appelé ;
 *   · O9-R02 aucune écriture possible : seules des fonctions GET exportées,
 *     garde `requireAdmin` dans chaque route, aucun import d'écriture ;
 *   · O9-R03 réponses : filtres transmis, 400 / 404, délai base → 503,
 *     jamais en cache.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const etat = vi.hoisted(() => ({
  garde: vi.fn(async () => 7 as number),
  list: vi.fn(async (..._a: unknown[]) => ({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 })),
  holds: vi.fn(async (..._a: unknown[]) => ({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1, reasons: [], pendingT3: 0 })),
  detail: vi.fn(async (..._a: unknown[]) => null as unknown),
  indicators: vi.fn(async (..._a: unknown[]) => ({ indicators: [], anomalies: [] }) as unknown),
}));

vi.mock('@/lib/session-service', () => ({ SessionService: { requireAdmin: () => etat.garde() } }));
vi.mock('@/services/business-operations/diagnostics/service', () => ({
  OperationDiagnosticsService: class {
    list(...a: unknown[]) { return etat.list(...a); }
    holds(...a: unknown[]) { return etat.holds(...a); }
    detail(...a: unknown[]) { return etat.detail(...a); }
    indicators(...a: unknown[]) { return etat.indicators(...a); }
  },
}));

const list = await import('../route');
const holds = await import('../holds/route');
const indicators = await import('../indicators/route');
const detail = await import('../[id]/route');

const get = (url: string) => new NextRequest(`http://app.test${url}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const appels = () => [etat.list, etat.holds, etat.detail, etat.indicators].reduce((n, f) => n + f.mock.calls.length, 0);

beforeEach(() => {
  for (const f of Object.values(etat)) f.mockClear();
  etat.garde.mockReset().mockResolvedValue(7);
});

describe('O9-R01 / C25 droits : administrateur seulement', () => {
  const routes: Array<[string, () => Promise<Response>]> = [
    ['GET liste', () => list.GET(get('/api/admin/operations'))],
    ['GET holds', () => holds.GET(get('/api/admin/operations/holds'))],
    ['GET indicateurs', () => indicators.GET(get('/api/admin/operations/indicators'))],
    ['GET détail', () => detail.GET(get('/api/admin/operations/1'), ctx('1'))],
  ];
  it.each(routes)('%s : non-admin → 403, sans session → 401, aucun service appelé', async (_n, appel) => {
    etat.garde.mockRejectedValue(new Error('INSUFFICIENT_PERMISSIONS'));
    expect((await appel()).status).toBe(403);
    etat.garde.mockRejectedValue(new Error('AUTH_REQUIRED'));
    expect((await appel()).status).toBe(401);
    expect(appels()).toBe(0);
  });
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) return n === '__tests__' ? [] : routeFiles(f);
    return n === 'route.ts' ? [f] : [];
  });
}

describe('O9-R02 / F-182 / INV-032 : aucune écriture possible via ces routes', () => {
  const root = join(process.cwd(), 'src/app/api/admin/operations');
  const files = routeFiles(root);
  it('quatre routes, GET seulement, garde admin, aucun import d’écriture', () => {
    expect(files.map((f) => relative(root, f).split(sep).join('/')).sort()).toEqual(['[id]/route.ts', 'holds/route.ts', 'indicators/route.ts', 'route.ts']);
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const methods = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
      expect(methods, f).toEqual(['GET']);
      expect(src).toMatch(/requireAdmin\(request\)/);
      expect(src).not.toMatch(/business-operations\/(write|repository)|pgClient|@\/db/);
    }
  });

  it('les méthodes d’écriture répondent 405 (aucun handler exporté)', () => {
    for (const m of [list, holds, indicators, detail]) {
      for (const verbe of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((m as Record<string, unknown>)[verbe]).toBeUndefined();
    }
  });
});

describe('O9-R03 réponses', () => {
  it('liste : filtres transmis au service, no-store', async () => {
    const r = await list.GET(get('/api/admin/operations?accountId=5&type=NULL&state=invalidated&page=2'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(etat.list).toHaveBeenCalledWith(expect.objectContaining({ accountId: 5, type: 'NULL', state: 'invalidated', page: 2 }));
  });

  it('candidats en attente : motif et issue transmis', async () => {
    await holds.GET(get('/api/admin/operations/holds?accountId=5&reason=M3_REQUIRED&outcome=HOLD_UNRESOLVED'));
    expect(etat.holds).toHaveBeenCalledWith(expect.objectContaining({ accountId: 5, reason: 'M3_REQUIRED', outcome: 'HOLD_UNRESOLVED' }));
  });

  it('indicateurs : période résolue et compte', async () => {
    await indicators.GET(get('/api/admin/operations/indicators?accountId=8&from=2026-09-01&to=2026-09-30'));
    expect(etat.indicators).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-30', days: 30 }, 8);
  });

  it('détail : identifiant invalide 400, inconnu 404', async () => {
    expect((await detail.GET(get('/api/admin/operations/abc'), ctx('abc'))).status).toBe(400);
    expect(etat.detail).not.toHaveBeenCalled();
    expect((await detail.GET(get('/api/admin/operations/9'), ctx('9'))).status).toBe(404);
    expect(etat.detail).toHaveBeenCalledWith(9);
  });

  it('délai dépassé côté base (57014) → 503 explicite ; autre erreur → 500 sans détail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    etat.indicators.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    const r = await indicators.GET(get('/api/admin/operations/indicators'));
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('DIAGNOSTICS_TIMEOUT');
    etat.list.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const r2 = await list.GET(get('/api/admin/operations'));
    expect(r2.status).toBe(500);
    expect(JSON.stringify(await r2.json())).not.toMatch(/relation/);
  });
});
