/**
 * Lot 37 — C3 : aucune énumération de comptes (connexion, renvoi de
 * vérification, mot de passe oublié) et C4 au niveau des routes.
 * CDC 18 §9.1, §9.4, §10.4, §11.2, §28, §30, §40 (tests anti-énumération).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';

type U = { id: number; email: string; password_hash: string; status: string; is_active: boolean; role: string };
const users = new Map<string, U>();
const writes: string[] = [];

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  const $client = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('SELECT id, email')) {
      const [raw, norm] = values as string[];
      const u = users.get(raw) ?? users.get(norm);
      return Promise.resolve(u ? [{
        ...u, first_name: 'A', last_name: 'B', username: null, company: null, plan_type: 'STANDARD', locale: 'fr-FR',
      }] : []);
    }
    writes.push(q.trim());
    return Promise.resolve([]);
  };
  const db = { $client, delete: () => ({ where: async () => {} }) };
  return { ...actual, db };
});
vi.mock('@/services/account-service', () => ({ AccountService: {
  getUserDefaultAccount: async () => ({ id: 9, isActive: true, subscriptionStatus: 'ACTIVE' }),
  getUserSessionAccounts: async () => [{ account: { id: 9, isActive: true, subscriptionStatus: 'ACTIVE' }, membershipId: 1, role: 'owner' }],
} }));
vi.mock('@/lib/audit-logger', () => ({ logUserActivity: () => Promise.resolve() }));

const startPasswordReset = vi.fn();
vi.mock('@/services/auth/password-reset.service', () => ({ startPasswordReset: (e: string) => startPasswordReset(e) }));
const resendVerification = vi.fn();
vi.mock('@/services/auth/resend-verification.service', () => ({ resendVerification: (e: string) => resendVerification(e) }));

const { AuthRateLimiter, MemoryAuthLimitStore, setAuthRateLimiterForTests } = await import('@/lib/auth/auth-rate-limit');
const { settleDetachedAuthTasks, DUMMY_BCRYPT_HASH } = await import('@/lib/auth/anti-enumeration');
const { INVALID_CREDENTIALS_MESSAGE, FORGOT_PASSWORD_NEUTRAL_MESSAGE, RESEND_VERIFICATION_NEUTRAL_MESSAGE, EMAIL_NOT_VERIFIED_MESSAGE } = await import('@/lib/auth/auth-messages');
const { POST: login } = await import('../login/route');
const { POST: forgot } = await import('../forgot-password/route');
const { POST: resend } = await import('../resend-verification/route');

const PASSWORD = 'BonMotDePasse1!';
let HASH = '';
beforeAll(async () => { HASH = await bcrypt.hash(PASSWORD, 4); });

function addUser(email: string, over: Partial<U> = {}) {
  users.set(email, { id: users.size + 1, email, password_hash: HASH, status: 'ACTIVE', is_active: true, role: 'USER', ...over });
}
const post = (path: string, body: unknown, ip = '81.2.3.4') => new NextRequest(`http://localhost:3000${path}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
});
async function snap(res: Response) {
  return { status: res.status, body: await res.json(), retry: res.headers.get('retry-after') };
}

beforeEach(() => {
  users.clear(); writes.length = 0;
  startPasswordReset.mockReset(); resendVerification.mockReset();
  setAuthRateLimiterForTests(new AuthRateLimiter(new MemoryAuthLimitStore()));
  addUser('actif@x.fr');
  addUser('suspendu@x.fr', { status: 'SUSPENDED' });
  addUser('nonverifie@x.fr', { is_active: false });
  addUser('supprime@x.fr', { status: 'DELETED', is_active: false });
});

describe('C3 — connexion', () => {
  it('C3-01 adresse inconnue et mot de passe faux : même statut, même corps (CDC §28)', async () => {
    const inconnu = await snap(await login(post('/api/auth/login', { email: 'personne@x.fr', password: 'Faux123!' }, '81.0.0.1')));
    const faux = await snap(await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux123!' }, '81.0.0.2')));
    expect(inconnu).toEqual(faux);
    expect(inconnu).toEqual({ status: 401, retry: null, body: { error: INVALID_CREDENTIALS_MESSAGE, code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE } });
  });

  it('C3-02 aucun état du compte avant la preuve du mot de passe (suspendu, non vérifié, supprimé)', async () => {
    const ref = await snap(await login(post('/api/auth/login', { email: 'personne@x.fr', password: 'Faux123!' }, '81.0.1.1')));
    let n = 2;
    for (const email of ['suspendu@x.fr', 'nonverifie@x.fr', 'supprime@x.fr']) {
      expect(await snap(await login(post('/api/auth/login', { email, password: 'Faux123!' }, `81.0.1.${n++}`)))).toEqual(ref);
    }
  });

  it('C3-03 temps égalisé : bcrypt est exécuté aussi pour une adresse inconnue (empreinte factice de même coût)', async () => {
    const spy = vi.spyOn(bcrypt, 'compare');
    await login(post('/api/auth/login', { email: 'personne@x.fr', password: 'Faux123!' }));
    expect(spy).toHaveBeenCalledWith('Faux123!', DUMMY_BCRYPT_HASH);
    expect(DUMMY_BCRYPT_HASH.startsWith('$2b$10$')).toBe(true); // coût des empreintes réelles
    spy.mockRestore();
  });

  it('C3-04 compte non vérifié avec le BON mot de passe : EMAIL_NOT_VERIFIED + renvoi proposé (après preuve)', async () => {
    const r = await snap(await login(post('/api/auth/login', { email: 'nonverifie@x.fr', password: PASSWORD })));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED', message: EMAIL_NOT_VERIFIED_MESSAGE, canResendVerification: true });
  });

  it('C3-05 messages utiles conservés après preuve : suspendu (403 ACCOUNT_SUSPENDED), connexion normale (200 + cookies)', async () => {
    expect((await snap(await login(post('/api/auth/login', { email: 'suspendu@x.fr', password: PASSWORD })))).body.code).toBe('ACCOUNT_SUSPENDED');
    const ok = await login(post('/api/auth/login', { email: 'actif@x.fr', password: PASSWORD }));
    expect(ok.status).toBe(200);
    expect(ok.cookies.get('access_token')?.value).toBeTruthy();
    expect(ok.cookies.get('refresh_token')?.value).toBeTruthy();
  });

  it('C3-06 adresse saisie avec majuscules/espaces : retrouvée (normalisation), même clé de limiteur', async () => {
    expect((await login(post('/api/auth/login', { email: '  Actif@X.fr ', password: PASSWORD }))).status).toBe(200);
  });
});

describe('C3 — mot de passe oublié', () => {
  it('C3-07 réponse identique : adresse inconnue, compte existant, échec d’envoi (plus de 500 révélateur)', async () => {
    startPasswordReset.mockResolvedValueOnce({ status: 'unknown_email' });
    const a = await snap(await forgot(post('/api/auth/forgot-password', { email: 'personne@x.fr' }, '81.1.0.1')));
    startPasswordReset.mockResolvedValueOnce({ status: 'sent', userId: 1 });
    const b = await snap(await forgot(post('/api/auth/forgot-password', { email: 'actif@x.fr' }, '81.1.0.2')));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    startPasswordReset.mockResolvedValueOnce({ status: 'send_failed', userId: 1, error: 'boom' });
    const c = await snap(await forgot(post('/api/auth/forgot-password', { email: 'actif@x.fr' }, '81.1.0.3')));
    await settleDetachedAuthTasks();
    err.mockRestore();
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual({ status: 200, retry: null, body: { success: true, message: FORGOT_PASSWORD_NEUTRAL_MESSAGE } });
  });

  it('C3-08 la réponse n’attend pas le traitement dépendant du compte (envoi après la réponse)', async () => {
    let fin!: () => void;
    startPasswordReset.mockImplementationOnce(() => new Promise<void>((r) => { fin = r; }));
    const res = await forgot(post('/api/auth/forgot-password', { email: 'actif@x.fr' }));
    expect(res.status).toBe(200); // rendu alors que l'envoi n'est pas terminé
    expect(startPasswordReset).toHaveBeenCalledWith('actif@x.fr');
    fin();
    await settleDetachedAuthTasks();
  });

  it('C4-19 plafond par adresse : réponse neutre IDENTIQUE, sans envoi ; plafond par IP : 429', async () => {
    startPasswordReset.mockResolvedValue({ status: 'sent', userId: 1 });
    for (let i = 0; i < 3; i++) await forgot(post('/api/auth/forgot-password', { email: 'actif@x.fr' }, `81.1.1.${i}`));
    await settleDetachedAuthTasks();
    expect(startPasswordReset).toHaveBeenCalledTimes(3);
    const quatrieme = await snap(await forgot(post('/api/auth/forgot-password', { email: 'actif@x.fr' }, '81.1.1.9')));
    await settleDetachedAuthTasks();
    expect(quatrieme).toEqual({ status: 200, retry: null, body: { success: true, message: FORGOT_PASSWORD_NEUTRAL_MESSAGE } });
    expect(startPasswordReset).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 5; i++) await forgot(post('/api/auth/forgot-password', { email: `x${i}@x.fr` }, '81.1.2.1'));
    const r = await forgot(post('/api/auth/forgot-password', { email: 'y@x.fr' }, '81.1.2.1'));
    expect(r.status).toBe(429);
    expect((await r.json()).message).toMatch(/^Trop de tentatives/);
    await settleDetachedAuthTasks();
  });
});

describe('C3 — renvoi de l’e-mail de vérification', () => {
  it('C3-09 réponse identique quel que soit l’état (inconnu, vérifié, non vérifié, échec d’envoi)', async () => {
    const etats = ['skipped', 'skipped', 'sent', 'failed'] as const;
    const emails = ['personne@x.fr', 'actif@x.fr', 'nonverifie@x.fr', 'nonverifie2@x.fr'];
    const reps = [];
    for (let i = 0; i < 4; i++) {
      resendVerification.mockResolvedValueOnce(etats[i]);
      reps.push(await snap(await resend(post('/api/auth/resend-verification', { email: emails[i] }, `81.2.0.${i}`))));
    }
    await settleDetachedAuthTasks();
    for (const r of reps) expect(r).toEqual({ status: 200, retry: null, body: { success: true, message: RESEND_VERIFICATION_NEUTRAL_MESSAGE } });
    expect(JSON.stringify(reps)).not.toMatch(/alreadyVerified|cause|remede/);
  });

  it('C3-10 la réponse n’attend pas l’envoi', async () => {
    let fin!: (v: 'sent') => void;
    resendVerification.mockImplementationOnce(() => new Promise((r) => { fin = r; }));
    expect((await resend(post('/api/auth/resend-verification', { email: 'nonverifie@x.fr' }))).status).toBe(200);
    fin('sent');
    await settleDetachedAuthTasks();
  });
});

describe('C4 — limiteur au niveau de la connexion', () => {
  it('C4-20 cinq échecs sur un compte : la 6e tentative est refusée (429) même avec le bon mot de passe et depuis une autre IP', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux' }, `81.3.0.${i}`))).status).toBe(401);
    }
    const r = await login(post('/api/auth/login', { email: 'actif@x.fr', password: PASSWORD }, '81.3.0.99'));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
  });

  it('C4-21 une connexion réussie d’un autre compte depuis la même IP ne remet pas les compteurs à zéro', async () => {
    addUser('attaquant@x.fr');
    for (let i = 0; i < 4; i++) await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux' }));
    expect((await login(post('/api/auth/login', { email: 'attaquant@x.fr', password: PASSWORD }))).status).toBe(200);
    await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux' }));
    expect((await login(post('/api/auth/login', { email: 'actif@x.fr', password: PASSWORD }))).status).toBe(429);
  });

  it('C4-22 le verrou d’une adresse inconnue est indiscernable de celui d’un compte existant (pas d’énumération)', async () => {
    for (let i = 0; i < 5; i++) {
      await login(post('/api/auth/login', { email: 'personne@x.fr', password: 'Faux' }, `81.4.0.${i}`));
      await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux' }, `81.4.1.${i}`));
    }
    const a = await snap(await login(post('/api/auth/login', { email: 'personne@x.fr', password: 'Faux' }, '81.4.2.1')));
    const b = await snap(await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux' }, '81.4.2.2')));
    expect(a).toEqual(b);
    expect(a.status).toBe(429);
  });

  it('C4-23 un succès remet à zéro le compteur de CE compte (les erreurs de frappe ne s’accumulent pas)', async () => {
    for (let i = 0; i < 4; i++) await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux' }, `81.5.0.${i}`));
    expect((await login(post('/api/auth/login', { email: 'actif@x.fr', password: PASSWORD }, '81.5.1.1'))).status).toBe(200);
    for (let i = 0; i < 4; i++) await login(post('/api/auth/login', { email: 'actif@x.fr', password: 'Faux' }, `81.5.2.${i}`));
    expect((await login(post('/api/auth/login', { email: 'actif@x.fr', password: PASSWORD }, '81.5.3.1'))).status).toBe(200);
  });
});
