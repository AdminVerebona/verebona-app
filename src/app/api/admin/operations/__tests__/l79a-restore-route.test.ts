/**
 * Lot 79A — route `POST /api/admin/operations/:id/identity-reviews/:reviewId/restore`
 * (bouton BO « Rétablir » une séparation automatique d'identité économique).
 *
 *   · L79A-R01 droits : sans session 401, non-admin 403 — service jamais appelé, rien journalisé ;
 *   · L79A-R02 motif obligatoire (10 à 500 caractères) et identifiants valides — 400 sans service ;
 *   · L79A-R03 succès : service appelé avec l'admin, l'Opération affichée et le motif ; 200, no-store ;
 *   · L79A-R04 refus explicites (déjà rétablie, source supprimée, fusion, autre compte…) : 404 / 409
 *     avec message clair, journalisés DENIED ; échec technique 500 journalisé FAILURE.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { RESTORE_BLOCK_MESSAGES, type RestoreBlockCode } from '@/services/business-operations/identity-restore.model';

const etat = vi.hoisted(() => ({
  garde: vi.fn(async () => 7 as number),
  revert: vi.fn(async (..._a: unknown[]) => ({ accountId: 3, operationId: 41, fileId: 77, jobId: 12, before: {}, after: {} }) as unknown),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/session-service', () => ({
  SessionService: { requireAdmin: () => etat.garde(), getSession: async () => ({ userId: 7, email: 'admin@test.invalid' }) },
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (...a: unknown[]) => etat.audit(...a) }));
vi.mock('@/services/business-operations/consolidation/identity-review', async () => {
  const { RESTORE_BLOCK_MESSAGES: M } = await import('@/services/business-operations/identity-restore.model');
  class IdentityRestoreRefusedError extends Error {
    constructor(readonly reviewId: number, readonly code: RestoreBlockCode) { super(M[code]); }
  }
  return { IdentityRestoreRefusedError, revertIdentitySeparation: (...a: unknown[]) => etat.revert(...a) };
});

const route = await import('../[id]/identity-reviews/[reviewId]/restore/route');
const { IdentityRestoreRefusedError } = await import('@/services/business-operations/consolidation/identity-review');

const post = (id: string, reviewId: string, body: unknown) => route.POST(
  new NextRequest(`http://app.test/api/admin/operations/${id}/identity-reviews/${reviewId}/restore`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }),
  { params: Promise.resolve({ id, reviewId }) },
);
const MOTIF = 'Vérifié avec le client : même achat.';

beforeEach(() => {
  for (const f of Object.values(etat)) f.mockClear();
  etat.garde.mockReset().mockResolvedValue(7);
});

describe('L79A-R01 droits : administrateur seulement', () => {
  it('non-admin → 403, sans session → 401 ; aucun service, aucun journal', async () => {
    etat.garde.mockRejectedValue(new Error('INSUFFICIENT_PERMISSIONS'));
    expect((await post('41', '5', { reason: MOTIF })).status).toBe(403);
    etat.garde.mockRejectedValue(new Error('AUTH_REQUIRED'));
    expect((await post('41', '5', { reason: MOTIF })).status).toBe(401);
    expect(etat.revert).not.toHaveBeenCalled();
    expect(etat.audit).not.toHaveBeenCalled();
  });
  it('seule méthode exportée : POST', () => {
    for (const v of ['GET', 'PUT', 'PATCH', 'DELETE']) expect((route as Record<string, unknown>)[v]).toBeUndefined();
  });
});

describe('L79A-R02 motif obligatoire et identifiants', () => {
  it.each([[{}], [{ reason: '' }], [{ reason: '  court  ' }], [{ reason: 'x'.repeat(501) }], [{ reason: 42 }], [null]])('%j → 400 INVALID_REASON', async (body) => {
    const r = await post('41', '5', body);
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('INVALID_REASON');
    expect(etat.revert).not.toHaveBeenCalled();
  });
  it('identifiant invalide → 400 INVALID_ID', async () => {
    expect((await post('abc', '5', { reason: MOTIF })).status).toBe(400);
    expect((await post('41', '0', { reason: MOTIF })).status).toBe(400);
    expect(etat.revert).not.toHaveBeenCalled();
  });
});

describe('L79A-R03 succès', () => {
  it('service appelé avec l’admin, l’Opération affichée et le motif normalisé ; 200 no-store', async () => {
    const r = await post('41', '5', { reason: `  ${MOTIF}  ` });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ accountId: 3, operationId: 41, fileId: 77, jobId: 12 });
    expect(etat.revert).toHaveBeenCalledWith(5, { adminId: 7, adminEmail: 'admin@test.invalid', operationId: 41, reason: MOTIF });
    // Le succès est journalisé DANS la transaction du service (pas une seconde fois par la route).
    expect(etat.audit).not.toHaveBeenCalled();
  });
});

describe('L79A-R04 refus explicites et échec', () => {
  it.each(Object.keys(RESTORE_BLOCK_MESSAGES) as RestoreBlockCode[])('%s → message clair, 404/409, DENIED journalisé', async (code) => {
    etat.revert.mockRejectedValueOnce(new IdentityRestoreRefusedError(5, code));
    const r = await post('41', '5', { reason: MOTIF });
    expect(r.status).toBe(code === 'NOT_FOUND' ? 404 : 409);
    expect(await r.json()).toEqual({ error: RESTORE_BLOCK_MESSAGES[code], code });
    expect(etat.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'OPERATION_IDENTITY_RESTORE', targetType: 'OPERATION_IDENTITY_REVIEW', targetId: 5, result: 'DENIED',
      details: expect.objectContaining({ code, reason: MOTIF, operationId: 41 }),
    }));
  });
  it('échec technique → 500 sans détail, FAILURE journalisé', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    etat.revert.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const r = await post('41', '5', { reason: MOTIF });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/relation/);
    expect(etat.audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'FAILURE' }));
  });
});
