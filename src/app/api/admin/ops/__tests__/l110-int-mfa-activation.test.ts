/**
 * Intégration lot 110 — l'obligation de double authentification ne peut pas
 * être activée sans configuration permettant aux comptes d'enrôler un facteur
 * (sinon tous seraient bloqués). Le retrait reste toujours possible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const etat = vi.hoisted(() => ({ writes: [] as Array<{ scope: string; at: Date | null }> }));
vi.mock('@/lib/session-service', () => ({ SessionService: { requireAdmin: async () => 7 } }));
vi.mock('@/lib/auth/mfa/policy', () => ({
  readMfaEnforcementSettings: async () => ({ users: null, admins: null }),
  writeMfaEnforcementSetting: async (scope: string, at: Date | null) => { etat.writes.push({ scope, at }); },
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: async () => undefined }));
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: async () => undefined }));

const { PUT } = await import('../mfa/route');
const put = (body: unknown) => PUT(new NextRequest('http://x/api/admin/ops/mfa', { method: 'PUT', body: JSON.stringify(body) }));
const KEY = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
const env = { ...process.env };

describe('L110-INT — activation MFA protégée par la configuration', () => {
  beforeEach(() => { etat.writes.length = 0; });
  afterEach(() => { process.env = { ...env }; });

  it('production sans trousseau ni WebAuthn : 409 MFA_NOT_CONFIGURED, rien d’écrit', async () => {
    Object.assign(process.env, { NODE_ENV: 'production' });
    delete process.env.MFA_ENCRYPTION_KEYS; delete process.env.WEBAUTHN_RP_ID; delete process.env.WEBAUTHN_ORIGINS;
    const r = await put({ scope: 'admins', enforcedFrom: new Date().toISOString(), confirm: 'ACTIVER' });
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.code).toBe('MFA_NOT_CONFIGURED');
    expect(b.message).toContain('MFA_ENCRYPTION_KEYS');
    expect(b.message).toContain('WEBAUTHN_RP_ID');
    expect(etat.writes).toEqual([]);
  });

  it('production configurée : activation acceptée', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', MFA_ENCRYPTION_KEYS: KEY, WEBAUTHN_RP_ID: 'app.preprod.verebona.fr', WEBAUTHN_ORIGINS: 'https://app.preprod.verebona.fr' });
    const r = await put({ scope: 'users', enforcedFrom: new Date().toISOString(), confirm: 'ACTIVER' });
    expect(r.status).toBe(200);
    expect(etat.writes).toHaveLength(1);
  });

  it('retrait (null) toujours possible, même sans configuration', async () => {
    Object.assign(process.env, { NODE_ENV: 'production' });
    delete process.env.MFA_ENCRYPTION_KEYS; delete process.env.WEBAUTHN_RP_ID; delete process.env.WEBAUTHN_ORIGINS;
    const r = await put({ scope: 'users', enforcedFrom: null });
    expect(r.status).toBe(200);
    expect(etat.writes).toEqual([{ scope: 'users', at: null }]);
  });
});
