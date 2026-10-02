/**
 * D-L (lot 21) — routes de notifications du BO : garde administrateur
 * commune et journal (`logAdminAction`) des recherches, réémissions et
 * renvois — réussis, refusés ou en échec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({ admin: true as boolean }));
const audit = vi.fn(async (_e: Record<string, unknown>) => {});
const reemettre = vi.fn();
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: vi.fn(async () => { if (!h.admin) throw new Error('FORBIDDEN'); return 5; }),
    getSession: vi.fn(async () => ({ userId: 5, email: 'admin@test.invalid' })),
    handleSessionError: vi.fn(() => NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })),
  },
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (e: Record<string, unknown>) => audit(e) }));
vi.mock('@/db', () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const k of ['from', 'where', 'orderBy', 'limit', 'groupBy']) c[k] = () => c;
    c.then = (res: (v: unknown[]) => unknown) => Promise.resolve(rows).then(res);
    return c;
  };
  return { ensureMigrations: vi.fn(async () => {}), db: { select: () => chain([{ id: 'u1', eventType: 'doc_ready', status: 'sent' }]), execute: async () => [] } };
});
vi.mock('@/services/notifications/notification-health.service', () => ({
  getNotificationHealth: vi.fn(async () => ({ sain: true })),
  rechercherNotifications: vi.fn(async () => [{ id: 'u1' }]),
}));
vi.mock('@/lib/notifications/metrics', () => ({ getNotificationHealth: vi.fn(async () => ({ windowDays: 30 })) }));
vi.mock('@/services/notifications/notification-reemission.service', () => {
  class ReemissionError extends Error { constructor(readonly code: string, m: string) { super(m); } }
  return { ReemissionError, reemettreNotification: (i: unknown) => reemettre(i), apercuReemission: vi.fn(async () => ({ eventType: 'x' })) };
});

const health = await import('../health/route');
const metrics = await import('../metrics/route');
const search = await import('../search/route');
const reemit = await import('../reemit/route');
const resend = await import('../[outboxId]/resend/route');
const { ReemissionError } = await import('@/services/notifications/notification-reemission.service');

const get = (u: string) => new NextRequest(`http://x${u}`);
const post = (u: string, body: unknown) => new NextRequest(`http://x${u}`, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => { h.admin = true; audit.mockClear(); reemettre.mockReset(); });

describe('notifications du BO', () => {
  it('contrôle d’accès administrateur sur les cinq routes', async () => {
    h.admin = false;
    for (const r of [
      await health.GET(get('/h')), await metrics.GET(get('/m')), await search.GET(get('/s')),
      await reemit.POST(post('/r', { outboxId: 'u1', confirme: true })),
      await resend.POST(post('/x', { confirme: true }), { params: Promise.resolve({ outboxId: 'u1' }) }),
    ]) expect(r.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it('recherches journalisées ; agrégats de santé non nominatifs, non journalisés', async () => {
    expect((await health.GET(get('/h?heures=24'))).status).toBe(200);
    expect((await metrics.GET(get('/m?days=30'))).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
    await health.GET(get('/h?userId=42'));
    await search.GET(get('/s?userId=42&type=doc_ready'));
    expect(audit.mock.calls.map(([e]) => e.action)).toEqual(['NOTIFICATION_SEARCH', 'NOTIFICATION_SEARCH']);
    expect(audit.mock.calls[1][0]).toMatchObject({ adminId: 5, targetType: 'NOTIFICATION', result: 'SUCCESS', details: { criteres: { userId: 42, type: 'doc_ready', limit: 50 }, resultats: 1 } });
  });

  it('réémission : confirmation transmise ; refus et échecs journalisés', async () => {
    reemettre.mockResolvedValueOnce({ nouvelleId: 'n1' });
    expect((await reemit.POST(post('/r', { outboxId: 'u1', confirme: true }))).status).toBe(200);
    expect(reemettre).toHaveBeenCalledWith(expect.objectContaining({ outboxId: 'u1', confirme: true, actorUserId: 5 }));
    reemettre.mockRejectedValueOnce(new ReemissionError('CONSENTEMENT_RETIRE', 'non'));
    expect((await reemit.POST(post('/r', { outboxId: 'u1', confirme: true }))).status).toBe(409);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'NOTIFICATION_REEMIT', result: 'DENIED', details: { origine: 'u1', code: 'CONSENTEMENT_RETIRE' } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reemettre.mockRejectedValueOnce(new Error('panne'));
    expect((await reemit.POST(post('/r', { outboxId: 'u1', confirme: true }))).status).toBe(500);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'FAILURE' }));
  });

  it('renvoi : passe par la réémission §20.3 (confirmation exigée) et est journalisé', async () => {
    reemettre.mockResolvedValueOnce({ nouvelleId: 'n2' });
    const r = await resend.POST(post('/x', { confirme: true, motif: 'échec SMTP' }), { params: Promise.resolve({ outboxId: 'u9' }) });
    expect(r.status).toBe(200);
    expect(reemettre).toHaveBeenCalledWith(expect.objectContaining({ outboxId: 'u9', confirme: true, motif: 'échec SMTP' }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'NOTIFICATION_RESEND', result: 'SUCCESS', details: { origine: 'u9', nouvelle: 'n2' } }));
  });
});
