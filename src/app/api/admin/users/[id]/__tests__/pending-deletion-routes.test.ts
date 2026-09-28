/**
 * Désactiver / Réactiver un utilisateur en suppression volontaire : refus 409
 * PENDING_DELETION, journalisé DENIED — CDC Back-Office V1 GDP-008, REC-GDP-05.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => 1,
  isSessionError: () => false,
  sessionErrorResponse: () => NextResponse.json({ error: 'AUTH' }, { status: 401 }),
}));
const logAdminAction = vi.fn(async (_entry: unknown) => {});
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (e: unknown) => logAdminAction(e) }));

const suspendUser = vi.fn();
const reactivateUser = vi.fn();
vi.mock('@/services/admin/user-admin.service', async (orig) => ({
  ...(await orig<typeof import('@/services/admin/user-admin.service')>()),
  suspendUser: (id: number) => suspendUser(id),
  reactivateUser: (id: number) => reactivateUser(id),
}));
vi.mock('@/services/admin/account-status.service', () => ({ revokeUserSessionsNow: vi.fn() }));
vi.mock('@/db', () => ({ db: {} }));

const { POST: suspend } = await import('../suspend/route');
const { POST: reactivate } = await import('../reactivate/route');
const { UserAdminError, PENDING_DELETION_ADMIN_MESSAGE } = await import('@/services/admin/user-admin.service');

const call = (handler: typeof suspend, action: string) =>
  handler(
    new NextRequest(`http://localhost/api/admin/users/7/${action}`, { method: 'POST', body: '{}' }),
    { params: Promise.resolve({ id: '7' }) },
  );

beforeEach(() => {
  logAdminAction.mockClear();
  suspendUser.mockReset();
  reactivateUser.mockReset();
});

describe.each([
  ['reactivate', reactivate, reactivateUser, 'USER_REACTIVATE'],
  ['suspend', suspend, suspendUser, 'USER_SUSPEND'],
] as const)('POST /api/admin/users/[id]/%s', (action, handler, service, auditAction) => {
  it('409 PENDING_DELETION avec un message clair, action journalisée DENIED', async () => {
    service.mockRejectedValue(new UserAdminError('PENDING_DELETION', PENDING_DELETION_ADMIN_MESSAGE));
    const r = await call(handler, action);
    expect(r.status).toBe(409);
    await expect(r.json()).resolves.toEqual({
      error: 'PENDING_DELETION',
      code: 'PENDING_DELETION',
      message: PENDING_DELETION_ADMIN_MESSAGE,
    });
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: auditAction,
      targetId: 7,
      result: 'DENIED',
      details: expect.objectContaining({ error: 'PENDING_DELETION' }),
    }));
  });
});
