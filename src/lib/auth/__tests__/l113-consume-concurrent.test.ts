/**
 * Correctif 113 (CI du 06/11, L53A PO-Q21-E2E-01 : deux e-mails « compte
 * existant » dans l'heure) : `consume` lisait puis écrivait sans revérifier le
 * verrou — deux demandes simultanées passaient toutes deux. Le verrou est
 * maintenant revérifié dans la mise à jour.
 */
import { describe, expect, it } from 'vitest';
import { AUTH_LIMITS, AuthRateLimiter, MemoryAuthLimitStore } from '../auth-rate-limit';

describe('consume : demandes simultanées', () => {
  it('plafond 1 / heure : sur deux demandes simultanées, une seule passe', async () => {
    const l = new AuthRateLimiter(new MemoryAuthLimitStore(), () => 1_000_000);
    const e = [{ key: 'signup:acct:x', policy: AUTH_LIMITS.signupExistingEmail }];
    const [a, b] = await Promise.all([l.consume(e), l.consume(e)]);
    expect([a.allowed, b.allowed].filter(Boolean)).toHaveLength(1);
    expect((await l.consume(e)).allowed).toBe(false);
  });
  it('séquentiel inchangé : la demande qui atteint le plafond passe, la suivante est refusée', async () => {
    const l = new AuthRateLimiter(new MemoryAuthLimitStore(), () => 1_000_000);
    const e = [{ key: 'signup:acct:y', policy: AUTH_LIMITS.signupExistingEmail }];
    expect((await l.consume(e)).allowed).toBe(true);
    const r = await l.consume(e);
    expect(r).toMatchObject({ allowed: false, blockedKey: 'signup:acct:y' });
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });
});
