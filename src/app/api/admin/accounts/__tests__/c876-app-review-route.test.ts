/**
 * Carte #876 — BO « Compte de revue des stores » : garde de la route.
 *
 * Modification réservée au SUPER_ADMIN (rôle RELU EN BASE), en session de
 * niveau 2, avec une réauthentification FORTE fraîche consommée, un motif et
 * la phrase de confirmation. Un ADMIN, un client, une session de niveau 1 ou
 * une preuve faible sont refusés AVANT toute écriture. Révocation : sessions
 * de l'identité révoquées aussitôt, journal BO écrit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const etat = vi.hoisted(() => ({
  role: 'SUPER_ADMIN' as string | null,
  aal: 2 as 1 | 2,
  reauth: { ok: true as boolean, assurance: 2 as number | undefined },
  consumed: [] as string[],
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  revoked: [] as number[],
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => 7,
  isSessionError: () => false,
  sessionErrorResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/session-service', () => ({
  SessionService: { getSession: async () => ({ userId: 7, role: 'ADMIN', aal: etat.aal, sid: 's7' }) },
}));
vi.mock('@/db', () => ({
  pgClient: Object.assign(async () => (etat.role ? [{ role: etat.role }] : []), {}),
}));
vi.mock('@/lib/auth/reauth', () => ({
  requireFreshReauth: async () => etat.reauth.ok
    ? { ok: true, session: { userId: 7, aal: etat.aal, sid: 's7' }, proof: { id: 'p1', assurance: etat.reauth.assurance } }
    : { ok: false, response: NextResponse.json({ code: 'REAUTH_REQUIRED' }, { status: 403 }) },
  consumeReauthProof: async (id: string, action: string) => { etat.consumed.push(`${id}:${action}`); return true; },
  reauthRequiredResponse: (code: string, opts: { mfa?: boolean } = {}) => NextResponse.json({ code, stepUp: opts.mfa ? 'MFA_STEP_UP_REQUIRED' : undefined }, { status: 403 }),
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: async (e: Record<string, unknown>) => { etat.audits.push(e); } }));
vi.mock('@/lib/auth/mfa/policy', () => ({ readMfaEnforcementSettings: async () => ({ users: null, admins: null }) }));
vi.mock('@/services/admin/account-status.service', () => ({ revokeUserSessionsNow: async (uid: number) => { etat.revoked.push(uid); return new Date(); } }));
vi.mock('@/services/admin/app-review.service', async () => {
  const change = (revokeSessionsOf: number[] = []) => ({ before: {}, after: {}, revokeSessionsOf });
  class AppReviewAdminError extends Error { constructor(public code: string, message: string, public httpStatus = 409) { super(message); } }
  return {
    AppReviewAdminError,
    APP_REVIEW_ACTIONS: ['qualify', 'unqualify', 'grant', 'revoke', 'demo_rights'],
    APP_REVIEW_CONFIRMATION: 'CONFIRMER',
    APP_REVIEW_MANAGER_ROLE: 'SUPER_ADMIN',
    APP_REVIEW_REASON_MIN_LENGTH: 10,
    normalizeReason: (r: unknown) => (typeof r === 'string' && r.trim().length >= 10 ? r.trim() : null),
    loadAppReviewView: async () => ({ account: { id: 3 }, users: [], exemptions: [], events: [] }),
    qualifyAccount: async (...args: unknown[]) => { etat.calls.push({ fn: 'qualify', args }); return change(); },
    unqualifyAccount: async (...args: unknown[]) => { etat.calls.push({ fn: 'unqualify', args }); return change([11, 12]); },
    grantExemption: async (...args: unknown[]) => { etat.calls.push({ fn: 'grant', args }); return change(); },
    revokeExemption: async (...args: unknown[]) => { etat.calls.push({ fn: 'revoke', args }); return change([11]); },
    grantDemoRights: async (...args: unknown[]) => { etat.calls.push({ fn: 'demo_rights', args }); return change(); },
  };
});

const { GET, POST } = await import('../[id]/app-review/route');
const ctx = { params: Promise.resolve({ id: '3' }) };
const post = (body: unknown) => POST(new NextRequest('http://x/api/admin/accounts/3/app-review', { method: 'POST', body: JSON.stringify(body) }), ctx);
const OK = { action: 'grant', userId: 11, reason: 'Revue App Store 1.4.0', confirm: 'CONFIRMER' };

describe('C876-ROUTE garde SUPER_ADMIN + preuve forte', () => {
  beforeEach(() => {
    etat.role = 'SUPER_ADMIN'; etat.aal = 2; etat.reauth = { ok: true, assurance: 2 };
    etat.consumed.length = 0; etat.calls.length = 0; etat.revoked.length = 0; etat.audits.length = 0;
  });

  it('ADMIN (non SUPER_ADMIN) : 403 SUPER_ADMIN_REQUIRED, rien d’écrit, refus journalisé', async () => {
    etat.role = 'ADMIN';
    const r = await post(OK);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('SUPER_ADMIN_REQUIRED');
    expect(etat.calls).toEqual([]);
    expect(etat.audits[0]).toMatchObject({ action: 'APP_REVIEW_UPDATE', result: 'DENIED' });
  });
  it('client (USER) ou rôle introuvable : refusé', async () => {
    for (const role of ['USER', null]) {
      etat.role = role;
      expect((await post(OK)).status).toBe(403);
    }
    expect(etat.calls).toEqual([]);
  });
  it('SUPER_ADMIN en session de niveau 1 : 403 STRONG_AUTH_REQUIRED avant toute confirmation', async () => {
    etat.aal = 1;
    const r = await post(OK);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('STRONG_AUTH_REQUIRED');
    expect(etat.consumed).toEqual([]);
    expect(etat.calls).toEqual([]);
  });
  it('sans réauthentification fraîche : 403 REAUTH_REQUIRED ; preuve faible (mot de passe) : réauthentification forte exigée', async () => {
    etat.reauth = { ok: false, assurance: 2 };
    expect((await (await post(OK)).json()).code).toBe('REAUTH_REQUIRED');
    etat.reauth = { ok: true, assurance: 1 };
    const r = await post(OK);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'REAUTH_REQUIRED', stepUp: 'MFA_STEP_UP_REQUIRED' });
    etat.reauth = { ok: true, assurance: undefined };
    expect((await post(OK)).status).toBe(403);
    expect(etat.calls).toEqual([]);
  });
  it('motif, confirmation, action, identité et qualification validés côté serveur', async () => {
    expect((await (await post({ ...OK, reason: 'court' })).json()).code).toBe('REASON_REQUIRED');
    expect((await (await post({ ...OK, confirm: 'oui' })).json()).code).toBe('CONFIRMATION_REQUIRED');
    expect((await (await post({ ...OK, action: 'disable_mfa' })).json()).code).toBe('INVALID_ACTION');
    expect((await (await post({ ...OK, userId: 'x' })).json()).code).toBe('INVALID_USER_ID');
    expect((await (await post({ ...OK, action: 'qualify', kind: 'AI_QUALIFICATION_CORPUS' })).json()).code).toBe('INVALID_KIND');
    expect(etat.calls).toEqual([]);
  });
  it('autorisation : preuve CONSOMMÉE, service appelé avec l’auteur et le motif, journal BO', async () => {
    const r = await post(OK);
    expect(r.status).toBe(200);
    expect(etat.consumed).toEqual(['p1:app_review:grant']);
    expect(etat.calls).toEqual([{ fn: 'grant', args: [3, 11, 7, 'Revue App Store 1.4.0'] }]);
    expect(etat.audits.at(-1)).toMatchObject({ action: 'APP_REVIEW_UPDATE', targetType: 'ACCOUNT', targetId: 3, result: 'SUCCESS' });
    expect(etat.revoked).toEqual([]);
  });
  it('révocation : sessions de l’identité révoquées aussitôt', async () => {
    const r = await post({ ...OK, action: 'revoke' });
    expect(r.status).toBe(200);
    expect((await r.json()).sessionsRevoked).toBe(1);
    expect(etat.revoked).toEqual([11]);
  });
  it('retour à « Compte client » : sessions de toutes les identités exemptées révoquées', async () => {
    await post({ action: 'unqualify', reason: 'Fin de la revue 1.4.0', confirm: 'CONFIRMER' });
    expect(etat.revoked).toEqual([11, 12]);
  });
  it('lecture : tout administrateur ; modification annoncée seulement pour SUPER_ADMIN en niveau 2', async () => {
    etat.role = 'ADMIN';
    let b = await (await GET(new NextRequest('http://x/api/admin/accounts/3/app-review'), ctx)).json();
    expect(b.viewer).toMatchObject({ role: 'ADMIN', canManage: false });
    etat.role = 'SUPER_ADMIN'; etat.aal = 1;
    b = await (await GET(new NextRequest('http://x/api/admin/accounts/3/app-review'), ctx)).json();
    expect(b.viewer).toMatchObject({ canManage: false, strongSession: false });
    etat.aal = 2;
    b = await (await GET(new NextRequest('http://x/api/admin/accounts/3/app-review'), ctx)).json();
    expect(b.viewer).toMatchObject({ canManage: true });
  });
});
