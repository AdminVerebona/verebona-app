/**
 * Lot 48 (O10) — « Reconsolider ce compte » (point ouvert du lot 47).
 *
 *   · O10-01 route : garde admin AVANT tout ; motif obligatoire ; 202 / 404 /
 *     500 ; journal d'audit (succès, refus, échec) ; aucune valeur métier ;
 *   · O10-02 service : travail T3 `business_operations` (événement
 *     `admin_reconsolidation`, corrélation) + projection Agenda complète ;
 *     compte inconnu refusé ; T3 arrêté → la demande attend ;
 *   · O10-03 file : déclencheur C4 non soumis à la version effective (code
 *     `manual`), passage COMPLET dans l'exécutant ;
 *   · O10-04 pas une édition d'Opération (décision PO Q9, INV-032).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const etat = vi.hoisted(() => ({
  garde: vi.fn(async () => 7 as number),
  request: vi.fn(async (..._a: unknown[]) => ({ accountId: 5, operationsJobId: 11, agendaJobId: 12, correlationId: 'bo-reconsolidation:5:7:x', waitsForReactivation: false }) as unknown),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: () => etat.garde(),
  getSession: async () => ({ userId: 7, email: 'admin@test.invalid' }),
  isSessionError: (e: unknown) => (e as { session?: boolean })?.session === true,
  sessionErrorResponse: () => new Response(JSON.stringify({ error: 'Accès refusé' }), { status: 403 }),
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (...a: unknown[]) => etat.audit(...a) }));
vi.mock('@/services/business-operations/admin-reconsolidation', async (o) => ({
  ...(await o<object>()),
  requestAccountReconsolidation: (...a: unknown[]) => etat.request(...a),
}));

const route = await import('../route');
const { AccountNotFoundError } = await vi.importActual<typeof import('@/services/business-operations/admin-reconsolidation')>('@/services/business-operations/admin-reconsolidation');

const post = (id: string, body?: unknown) => route.POST(
  new NextRequest(`http://app.test/api/admin/accounts/${id}/operations-reconsolidation`, {
    method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  for (const f of Object.values(etat)) f.mockClear();
  etat.garde.mockReset().mockResolvedValue(7);
});

describe('O10-01 route POST /api/admin/accounts/:id/operations-reconsolidation', () => {
  it('O10-01a garde : non administrateur → refus, aucun service, aucun journal', async () => {
    etat.garde.mockRejectedValueOnce(Object.assign(new Error('non admin'), { session: true }));
    expect((await post('5', { reason: 'Correction livrée' })).status).toBe(403);
    expect(etat.request).not.toHaveBeenCalled();
    expect(etat.audit).not.toHaveBeenCalled();
  });

  it('O10-01b motif obligatoire (5 à 500 caractères), identifiant valide', async () => {
    expect((await post('abc', { reason: 'Correction livrée' })).status).toBe(400);
    for (const body of [undefined, {}, { reason: 42 }, { reason: '  ok ' }, { reason: 'x'.repeat(501) }]) {
      const r = await post('5', body);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'INVALID_REASON' });
    }
    expect(etat.request).not.toHaveBeenCalled();
  });

  it('O10-01c succès : 202, mise en file pour le compte par l’administrateur, journal SUCCESS avec motif et travaux', async () => {
    const r = await post('5', { reason: '  Anomalie dure corrigée en v1.2  ' });
    expect(r.status).toBe(202);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ accountId: 5, operationsJobId: 11, agendaJobId: 12 });
    expect(etat.request).toHaveBeenCalledWith(5, { adminId: 7 });
    expect(etat.audit).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 7, action: 'OPERATIONS_RECONSOLIDATE', targetType: 'ACCOUNT', targetId: 5, result: 'SUCCESS',
      details: expect.objectContaining({ reason: 'Anomalie dure corrigée en v1.2', operationsJobId: 11, agendaJobId: 12 }),
    }));
  });

  it('O10-01d compte inconnu → 404, refus journalisé ; erreur de file → 500, échec journalisé', async () => {
    etat.request.mockRejectedValueOnce(new AccountNotFoundError(9));
    expect((await post('9', { reason: 'Correction livrée' })).status).toBe(404);
    expect(etat.audit).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'DENIED', targetId: 9 }));
    etat.request.mockRejectedValueOnce(new Error('file indisponible'));
    const r = await post('9', { reason: 'Correction livrée' });
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ code: 'RECONSOLIDATION_FAILED' });
    expect(etat.audit).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'FAILURE' }));
  });

  it('O10-04 / F-182 / INV-032 / Q9 — pas une édition : seule la méthode POST, aucun champ métier lu, aucun import d’écriture d’Opération', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/admin/accounts/[id]/operations-reconsolidation/route.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect([...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1])).toEqual(['POST']);
    expect(src).toMatch(/requireAdmin\(request\)/);
    expect(src).not.toMatch(/business-operations\/(write|repository)|withBusinessOperationWrite|pgClient|@\/db'/);
    expect(src).not.toMatch(/body\??\.(type|status|amount|operationId|assetIds|claim)/);
  });
});

describe('O10-02 service requestAccountReconsolidation', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    accountExists: vi.fn(async () => true),
    requestOperations: vi.fn(async () => 31),
    requestAgenda: vi.fn(async () => 32),
    canStartT3: vi.fn(async () => true),
    ...over,
  });

  it('O10-02a travail T3 du compte (événement admin_reconsolidation, corrélation commune) + projection Agenda complète', async () => {
    const d = deps();
    const r = await _realRequest(5, { adminId: 7 }, d as never);
    expect(r).toMatchObject({ accountId: 5, operationsJobId: 31, agendaJobId: 32, waitsForReactivation: false });
    expect(r.correlationId).toMatch(/^bo-reconsolidation:5:7:/);
    expect(d.requestOperations).toHaveBeenCalledWith(5, { trigger: 'admin_reconsolidation', correlationId: r.correlationId });
    expect(d.requestAgenda).toHaveBeenCalledWith(5, { all: true, correlationId: r.correlationId });
  });

  it('O10-02b compte inconnu ou identifiant invalide → AccountNotFoundError, rien en file', async () => {
    const d = deps({ accountExists: vi.fn(async () => false) });
    await expect(_realRequest(5, { adminId: 7 }, d as never)).rejects.toBeInstanceOf(AccountNotFoundError);
    await expect(_realRequest(0, { adminId: 7 }, d as never)).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(d.requestOperations).not.toHaveBeenCalled();
  });

  it('O10-02c T3 arrêté (arrêt d’urgence / coupé) : la demande est acceptée et attend (WF-07)', async () => {
    const r = await _realRequest(5, { adminId: 7 }, deps({ canStartT3: vi.fn(async () => false) }) as never);
    expect(r.waitsForReactivation).toBe(true);
  });
});

describe('O10-03 file T3 : déclencheur admin_reconsolidation', () => {
  it('O10-03a code `manual`, jamais soumis au catalogue de déclencheurs de la version effective ; dédoublonné (append_events)', async () => {
    const q = await import('@/services/business-operations/consolidation/queue');
    expect(q.C4_TRIGGERS).toContain('admin_reconsolidation');
    expect(q.C4_CATALOG_TRIGGER.admin_reconsolidation).toBe('manual');
    const enqueue = vi.fn(async () => ({ decision: 'create' as const, jobId: 44 }));
    const isTriggerActive = vi.fn(async () => false);
    const id = await q.requestOperationsConsolidation(5, { trigger: 'admin_reconsolidation', correlationId: 'c-1' }, { enqueue, isTriggerActive } as never);
    expect(id).toBe(44);
    expect(isTriggerActive).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T3', triggerCode: 'manual', payloadOnDedupe: 'append_events',
      scope: { accountId: 5, targetType: 'business_operations', targetId: '5' },
    }));
    // Les autres déclencheurs restent soumis à la version effective.
    expect(await q.requestOperationsConsolidation(5, { trigger: 'document_moved' }, { enqueue, isTriggerActive } as never)).toBeNull();
  });

  it('O10-03b exécutant : passage complet (tous les biens, attentes réexaminées, chaque Opération active recalculée), bornes', async () => {
    const src = readFileSync(join(process.cwd(), 'src/services/business-operations/consolidation/queue.ts'), 'utf8');
    expect(src).toMatch(/const admin = p\.events\.find\(\(e\) => e\.trigger === 'admin_reconsolidation'\)/);
    expect(src).toMatch(/reevaluateHolds: !!admin \|\|/);
    expect(src).toMatch(/if \(admin\) \{\s*const r = await reconsolidateAllActiveOperations/);
    const q = await import('@/services/business-operations/consolidation/queue');
    expect(q.ADMIN_RECONSOLIDATION_MAX_OPERATIONS).toBe(2000);
    expect(q.ADMIN_RECONSOLIDATION_MAX_ASSETS).toBe(500);
  });
});

async function _realRequest(...a: Parameters<typeof import('@/services/business-operations/admin-reconsolidation').requestAccountReconsolidation>) {
  const m = await vi.importActual<typeof import('@/services/business-operations/admin-reconsolidation')>('@/services/business-operations/admin-reconsolidation');
  return m.requestAccountReconsolidation(...a);
}
