/**
 * Carte #823 (sécurité L53A) — pause de réauthentification et trace
 * AUTH_REAUTH_THROTTLED validées ensemble : règles du limiteur, contrat du
 * journal d'activité, signalement de la dégradation. Aucune base ici (les
 * preuves sur PostgreSQL réel sont dans
 * `src/test/e2e/scenarios/c823-trace-reauth-throttled.e2e.ts` et
 * `l53a-securite-cdc18.e2e.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const insertions: { table: unknown; values: Record<string, unknown>; par: string }[] = [];
const panne: { erreur: Error | null } = { erreur: null };
const executeur = (par: string) => ({
  insert: (table: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      if (panne.erreur) throw panne.erreur;
      insertions.push({ table, values, par });
    },
  }),
});
vi.mock('@/db', () => ({ db: executeur('db'), pgClient: {} }));

const {
  AUTH_LIMITS, AuthRateLimiter, FallbackAuthLimitStore, MemoryAuthLimitStore, authRateLimiterHealth, limitKey,
  setAuthRateLimiterForTests,
} = await import('@/lib/auth/auth-rate-limit');
type AuthLimitStore = import('@/lib/auth/auth-rate-limit').AuthLimitStore;
type AuthLimitTx = import('@/lib/auth/auth-rate-limit').AuthLimitTx;
type LimitRecord = import('@/lib/auth/auth-rate-limit').LimitRecord;
type LimitCommit = import('@/lib/auth/auth-rate-limit').LimitCommit;
type LockTraceContext = import('@/lib/auth/auth-rate-limit').LockTraceContext;
const { insertUserActivity, logUserActivity } = await import('@/lib/audit-logger');
const { recordReauthFailure, reauthBlockedResponse } = await import('@/lib/auth/reauth-throttle');

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const MIN = 60_000;
const TX = executeur('transaction') as unknown as AuthLimitTx;

/**
 * Magasin « partagé » de test, transactionnel : `updateMany` n'applique les
 * écritures que si `beforeCommit` aboutit (sinon : annulation, rien d'écrit).
 */
class MagasinTransactionnel implements AuthLimitStore {
  readonly rows = new Map<string, LimitRecord>();
  horsService = false;
  ecrituresHorsTransaction = 0;
  transactions = 0;
  private verifier() { if (this.horsService) throw new Error('ECONNREFUSED'); }
  async read(keys: string[]) {
    this.verifier();
    const m = new Map<string, LimitRecord>();
    for (const k of keys) { const r = this.rows.get(k); if (r) m.set(k, { ...r }); }
    return m;
  }
  async update(key: string, fn: (rec: LimitRecord | null) => LimitRecord) {
    this.verifier();
    this.ecrituresHorsTransaction++;
    const cur = this.rows.get(key);
    const next = fn(cur ? { ...cur } : null);
    this.rows.set(key, next);
    return next;
  }
  async delete(key: string) { this.verifier(); this.rows.delete(key); }
  async purge() { return 0; }
  async updateMany(
    keys: string[],
    fn: (recs: Map<string, LimitRecord>) => Map<string, LimitRecord>,
    beforeCommit?: (tx: AuthLimitTx) => Promise<void>,
  ): Promise<LimitCommit> {
    this.verifier();
    this.transactions++;
    const ecritures = fn(await this.read(keys));
    if (beforeCommit) await beforeCommit(TX); // lève → rien n'est appliqué
    for (const [k, r] of ecritures) this.rows.set(k, r);
    return 'shared';
  }
}

const entrees = (user: string, ip = '81.2.3.4') => [
  { key: limitKey('reauth', 'user', user), policy: AUTH_LIMITS.reauthUser },
  { key: limitKey('reauth', 'ip', ip), policy: AUTH_LIMITS.reauthIp },
];

let now: number;
let erreurs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now = 50_000_000;
  insertions.length = 0;
  panne.erreur = null;
  erreurs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setAuthRateLimiterForTests(null);
  vi.restoreAllMocks();
});

describe('Carte #823 — journal d’activité : primitive qui propage, contrat historique inchangé', () => {
  it('C823-U01 insertUserActivity propage l’erreur d’insertion ; logUserActivity l’absorbe toujours (contrat des autres appelants)', async () => {
    panne.erreur = new Error('insertion refusée');
    await expect(insertUserActivity({ activityType: 'AUTH_REAUTH_THROTTLED', userId: 7, userEmail: '' })).rejects.toThrow('insertion refusée');
    await expect(logUserActivity({ activityType: 'LOGIN_FAILED', userId: 7, userEmail: 'a@x.fr' })).resolves.toBeUndefined();
    // Paramètres invalides : la primitive lève, la fonction historique reste muette.
    await expect(insertUserActivity(null as never)).rejects.toThrow();
    await expect(logUserActivity(null as never)).resolves.toBeUndefined();
    expect(insertions).toHaveLength(0);
  });

  it('C823-U02 même ligne par les deux fonctions ; l’exécuteur fourni (transaction) est utilisé, sinon la base', async () => {
    const request = new NextRequest('http://localhost/api/x', { headers: { 'x-forwarded-for': '81.2.3.4', 'user-agent': 'UA-1' } });
    const params = { activityType: 'AUTH_REAUTH_THROTTLED' as const, userId: 7, userEmail: '', details: { action: 'change_password', retryAfterSeconds: 900 }, request };
    await logUserActivity(params);
    await insertUserActivity(params, executeur('transaction') as never);
    expect(insertions.map((i) => i.par)).toEqual(['db', 'transaction']);
    const sansDates = (v: Record<string, unknown>) => ({ ...v, timestamp: null, createdAt: null });
    expect(sansDates(insertions[1].values)).toEqual(sansDates(insertions[0].values));
    expect(insertions[0].values).toMatchObject({
      userId: 7, userEmail: '', activityType: 'AUTH_REAUTH_THROTTLED', userAgent: 'UA-1',
      details: JSON.stringify({ action: 'change_password', retryAfterSeconds: 900 }),
    });
    expect(insertions[0].values.timestamp).toBeInstanceOf(Date);
    // Valeurs par défaut historiques : identifiant absent → null, détails absents → null.
    await logUserActivity({ activityType: 'LOGIN_FAILED', userEmail: 'a@x.fr' });
    expect(insertions[2].values).toMatchObject({ userId: null, ipAddress: null, userAgent: null, details: null });
  });
});

describe('Carte #823 — limiteur : pause et trace dans la même transaction', () => {
  it('C823-U03 la trace est écrite UNE fois, au franchissement, avec la durée calculée ; jamais pour une tentative ordinaire ou pendant la pause', async () => {
    const magasin = new MagasinTransactionnel();
    const l = new AuthRateLimiter(new FallbackAuthLimitStore(magasin), () => now);
    const traces: LockTraceContext[] = [];
    const ecrire = async (tx: AuthLimitTx, pause: LockTraceContext) => { expect(tx).toBe(TX); traces.push(pause); };
    for (let i = 0; i < 4; i++) {
      expect(await l.recordFailureWithLockTrace(entrees('7'), ecrire)).toMatchObject({ allowed: true, lockedNow: false, lockTrace: 'none' });
    }
    expect(traces).toHaveLength(0);
    const d = await l.recordFailureWithLockTrace(entrees('7'), ecrire);
    expect(d).toMatchObject({ allowed: false, lockedNow: true, lockTrace: 'committed', lockTraceError: null, retryAfterSeconds: 900 });
    expect(traces).toEqual([{ retryAfterSeconds: 900, blockedKey: limitKey('reauth', 'user', '7') }]);
    // Pendant la pause : rien n'est compté, aucune trace, aucune écriture.
    const avant = JSON.stringify([...magasin.rows]);
    expect(await l.recordFailureWithLockTrace(entrees('7', '81.9.9.9'), ecrire)).toMatchObject({ lockedNow: false, lockTrace: 'none' });
    expect(traces).toHaveLength(1);
    expect(magasin.rows.get(limitKey('reauth', 'user', '7'))).toEqual(new Map(JSON.parse(avant)).get(limitKey('reauth', 'user', '7')));
    // Une seule transaction par tentative, aucune écriture hors transaction dans le magasin partagé.
    expect(magasin.transactions).toBe(6);
    expect(magasin.ecrituresHorsTransaction).toBe(0);
    expect((await l.check(entrees('7'))).allowed).toBe(false);
  });

  it('C823-U04 récidive : la durée transmise à la trace est celle de la pause posée (15, 30, 60 min)', async () => {
    const l = new AuthRateLimiter(new FallbackAuthLimitStore(new MagasinTransactionnel()), () => now);
    const durees: number[] = [];
    for (let pause = 0; pause < 3; pause++) {
      for (let i = 0; i < 5; i++) await l.recordFailureWithLockTrace(entrees('8', `81.4.${pause}.${i}`), async (_tx, p) => { durees.push(p.retryAfterSeconds); });
      now += 61 * MIN;
    }
    expect(durees).toEqual([900, 1800, 3600]);
  });

  it('C823-U05 seuils utilisateur et IP franchis par la même tentative : une seule trace, durée la plus longue', async () => {
    const magasin = new MagasinTransactionnel();
    const l = new AuthRateLimiter(new FallbackAuthLimitStore(magasin), () => now);
    const traces: LockTraceContext[] = [];
    const ecrire = async (_tx: AuthLimitTx, p: LockTraceContext) => { traces.push(p); };
    // 15 échecs d'autres utilisateurs depuis la même IP, puis 4 de l'utilisateur 9 : IP à 19, utilisateur à 4.
    for (let i = 0; i < 15; i++) await l.recordFailureWithLockTrace(entrees(`autre-${i}`, '81.7.7.7'), ecrire);
    for (let i = 0; i < 4; i++) await l.recordFailureWithLockTrace(entrees('9', '81.7.7.7'), ecrire);
    expect(traces).toHaveLength(0);
    const d = await l.recordFailureWithLockTrace(entrees('9', '81.7.7.7'), ecrire);
    expect(d).toMatchObject({ lockedNow: true, lockTrace: 'committed', retryAfterSeconds: 900 });
    expect(traces).toHaveLength(1);
    expect(magasin.rows.get(limitKey('reauth', 'user', '9'))?.lockedUntil).toBe(now + 15 * MIN);
    expect(magasin.rows.get(limitKey('reauth', 'ip', '81.7.7.7'))?.lockedUntil).toBe(now + 15 * MIN);
  });

  it('C823-U06 trace impossible : RIEN de validé dans le magasin partagé, pause tenue en mémoire (check refuse), dégradation rendue ; la pause expire à son terme', async () => {
    const magasin = new MagasinTransactionnel();
    const repli = new MemoryAuthLimitStore();
    const l = new AuthRateLimiter(new FallbackAuthLimitStore(magasin, repli), () => now);
    for (let i = 0; i < 4; i++) await l.recordFailureWithLockTrace(entrees('10'), async () => undefined);
    const enveloppe = Object.assign(new Error('Failed query: insert into "user_activity_log" …\nparams: 10,,81.2.3.4,UA-secret'), { cause: new Error('relation en lecture seule') });
    const d = await l.recordFailureWithLockTrace(entrees('10'), async () => { throw enveloppe; });
    expect(d).toMatchObject({ allowed: false, lockedNow: true, lockTrace: 'not_durable', retryAfterSeconds: 900 });
    // Cause technique sans la requête ni ses paramètres (adresse IP, agent utilisateur).
    expect(d.lockTraceError).toBe('relation en lecture seule');
    // Aucun verrou validé sans trace dans le magasin partagé : le compteur y est resté à 4.
    expect(magasin.rows.get(limitKey('reauth', 'user', '10'))).toMatchObject({ attempts: 4, lockedUntil: null });
    expect(magasin.ecrituresHorsTransaction).toBe(0);
    // Protection maintenue : la pause s'applique alors que la lecture partagée ne la montre pas.
    expect(await l.check(entrees('10'))).toMatchObject({ allowed: false, retryAfterSeconds: 900 });
    expect(await l.check(entrees('11'))).toMatchObject({ allowed: true });
    // Pendant la pause tenue, un nouvel échec n'est pas compté et ne trace rien.
    let appels = 0;
    expect(await l.recordFailureWithLockTrace(entrees('10'), async () => { appels++; })).toMatchObject({ lockedNow: false, lockTrace: 'none' });
    expect(appels).toBe(0);
    expect(l.lockTraceFailures).toBe(1);
    expect(l.lockTraceDegradedSince).not.toBeNull();
    // Terme de la pause : l'accès est rendu ; une nouvelle entrée en pause tracée lève l'état dégradé.
    now += 15 * MIN + 1;
    expect((await l.check(entrees('10'))).allowed).toBe(true);
    now += 1;
    const traces: number[] = [];
    for (let i = 0; i < 5; i++) await l.recordFailureWithLockTrace(entrees('12'), async (_tx, p) => { traces.push(p.retryAfterSeconds); });
    expect(traces).toEqual([900]);
    expect(l.lockTraceDegradedSince).toBeNull();
    expect(l.lockTraceFailures).toBe(1);
  });

  it('C823-U07 base totalement indisponible : repli mémoire, pause appliquée, trace NON durable (jamais d’appel à l’écriture de trace), aucune écriture partagée au retour', async () => {
    const magasin = new MagasinTransactionnel();
    magasin.horsService = true;
    const fb = new FallbackAuthLimitStore(magasin);
    const l = new AuthRateLimiter(fb, () => now);
    let appels = 0;
    const ecrire = async () => { appels++; };
    for (let i = 0; i < 4; i++) expect(await l.recordFailureWithLockTrace(entrees('13'), ecrire)).toMatchObject({ lockedNow: false, lockTrace: 'none' });
    const d = await l.recordFailureWithLockTrace(entrees('13'), ecrire);
    expect(d).toMatchObject({ allowed: false, lockedNow: true, lockTrace: 'not_durable', lockTraceError: 'ECONNREFUSED', retryAfterSeconds: 900 });
    expect(appels).toBe(0);
    expect(fb.degradedSince).not.toBeNull();
    expect((await l.check(entrees('13'))).allowed).toBe(false);
    // La base revient : rien n'y a été écrit, et la pause reste appliquée par l'instance.
    magasin.horsService = false;
    expect(magasin.rows.size).toBe(0);
    expect(magasin.ecrituresHorsTransaction).toBe(0);
    expect((await l.check(entrees('13'))).allowed).toBe(false);
    expect((await l.check(entrees('14'))).allowed).toBe(true);
  });

  it('C823-U08 magasin partagé sans transaction groupée : traité comme indisponible pour ce chemin (jamais de verrou partagé sans trace)', async () => {
    const magasin = new MagasinTransactionnel();
    const sansGroupe: AuthLimitStore = {
      read: (k) => magasin.read(k), update: (k, fn) => magasin.update(k, fn), delete: (k) => magasin.delete(k), purge: async () => 0,
    };
    const l = new AuthRateLimiter(new FallbackAuthLimitStore(sansGroupe), () => now);
    let d = await l.recordFailureWithLockTrace(entrees('15'), async () => undefined);
    for (let i = 0; i < 4; i++) d = await l.recordFailureWithLockTrace(entrees('15'), async () => undefined);
    expect(d).toMatchObject({ lockedNow: true, lockTrace: 'not_durable' });
    expect(magasin.ecrituresHorsTransaction).toBe(0);
    expect((await l.check(entrees('15'))).allowed).toBe(false);
  });

  it('C823-U09 les autres limiteurs ne passent pas par ce chemin : recordFailure, consume, check et reset n’ouvrent aucune transaction groupée et gardent leurs décisions', async () => {
    const magasin = new MagasinTransactionnel();
    const l = new AuthRateLimiter(new FallbackAuthLimitStore(magasin), () => now);
    const mfa = [{ key: limitKey('mfa', 'user', '1'), policy: AUTH_LIMITS.mfaUser }, { key: limitKey('mfa', 'ip', '81.2.3.4'), policy: AUTH_LIMITS.mfaIp }];
    for (let i = 0; i < 4; i++) expect(await l.recordFailure(mfa)).toEqual({ allowed: true, retryAfterSeconds: 0, blockedKey: null, lockedNow: false });
    expect(await l.recordFailure(mfa)).toEqual({ allowed: false, retryAfterSeconds: 900, blockedKey: mfa[0].key, lockedNow: true });
    expect(await l.check(mfa)).toEqual({ allowed: false, retryAfterSeconds: 900, blockedKey: mfa[0].key, lockedNow: false });
    const mail = [{ key: limitKey('forgot', 'acct', 'a@x.fr'), policy: AUTH_LIMITS.forgotAccount }];
    for (let i = 0; i < 3; i++) expect((await l.consume(mail)).allowed).toBe(true);
    expect((await l.consume(mail)).allowed).toBe(false);
    await l.reset(mfa[0].key);
    expect((await l.check(mfa)).allowed).toBe(true);
    expect(magasin.transactions).toBe(0);
    // Politiques inchangées (seuils et durées de la réauthentification, de la MFA et de l'activation).
    expect(AUTH_LIMITS.reauthUser).toEqual({ maxAttempts: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: 60 * MIN, levelResetMs: 24 * 60 * MIN });
    expect(AUTH_LIMITS.reauthIp).toEqual({ maxAttempts: 20, windowMs: 15 * MIN, lockMs: 15 * MIN });
    expect(AUTH_LIMITS.mfaUser).toEqual(AUTH_LIMITS.reauthUser);
    expect(AUTH_LIMITS.activationUser).toEqual(AUTH_LIMITS.reauthUser);
  });
});

describe('Carte #823 — réauthentification : contexte transmis, écriture détachée supprimée, dégradation signalée', () => {
  const requete = (ip = '81.2.3.4') => new NextRequest('http://localhost/api/users/me/change-password', {
    method: 'POST', headers: { 'x-forwarded-for': ip, 'user-agent': 'UA-secret' },
  });
  const signalements = () => erreurs.mock.calls.map((c) => c[0]).filter((a): a is string => typeof a === 'string' && a.includes('security.reauth_throttle_trace_degraded'));

  it('C823-U10 pause posée : trace écrite DANS la transaction (action, durée calculée, aucune adresse e-mail), aucun signalement', async () => {
    const magasin = new MagasinTransactionnel();
    setAuthRateLimiterForTests(new AuthRateLimiter(new FallbackAuthLimitStore(magasin)));
    for (const action of ['change_password', 'account_deletion', 'reauth'] as const) {
      insertions.length = 0;
      const userId = { change_password: 21, account_deletion: 22, reauth: 23 }[action];
      for (let i = 0; i < 5; i++) await recordReauthFailure(requete(`81.5.${userId}.${i}`), userId, action);
      expect(insertions).toHaveLength(1);
      expect(insertions[0].par).toBe('transaction');
      expect(insertions[0].values).toMatchObject({
        activityType: 'AUTH_REAUTH_THROTTLED', userId, userEmail: '', userAgent: 'UA-secret',
        details: JSON.stringify({ action, retryAfterSeconds: 900 }),
      });
      const blocage = await reauthBlockedResponse(requete(), userId);
      expect(blocage?.status).toBe(429);
      expect(Number(blocage?.headers.get('Retry-After'))).toBeGreaterThan(0);
    }
    expect(signalements()).toHaveLength(0);
    expect(authRateLimiterHealth()).toMatchObject({ lockTraceDegradedSince: null, lockTraceFailures: 0 });
  });

  it('C823-U11 trace en échec : la fonction ne lève pas, la pause reste appliquée (429), le signalement ne contient aucune donnée sensible', async () => {
    const magasin = new MagasinTransactionnel();
    setAuthRateLimiterForTests(new AuthRateLimiter(new FallbackAuthLimitStore(magasin)));
    for (let i = 0; i < 4; i++) await recordReauthFailure(requete(`81.6.0.${i}`), 31, 'change_password');
    panne.erreur = Object.assign(new Error('Failed query: insert …\nparams: 31,,81.6.0.4,UA-secret'), { cause: new Error('disque plein') });
    await expect(recordReauthFailure(requete('81.6.0.4'), 31, 'change_password')).resolves.toBeUndefined();
    expect(insertions).toHaveLength(0);
    expect(magasin.rows.get(limitKey('reauth', 'user', '31'))).toMatchObject({ attempts: 4, lockedUntil: null });
    expect((await reauthBlockedResponse(requete('81.6.0.9'), 31))?.status).toBe(429);
    expect(await reauthBlockedResponse(requete('81.6.0.9'), 32)).toBeNull();
    const lignes = signalements();
    expect(lignes).toHaveLength(1);
    expect(JSON.parse(lignes[0])).toEqual({
      event: 'security.reauth_throttle_trace_degraded', userId: 31, action: 'change_password', retryAfterSeconds: 900,
      protection: 'pause tenue en mémoire par cette instance', trace: 'AUTH_REAUTH_THROTTLED non enregistrée en base', cause: 'disque plein',
    });
    for (const interdit of ['81.6.0.4', 'UA-secret', 'Failed query', '@']) expect(lignes[0]).not.toContain(interdit);
  });

  it('C823-U12 limiteur en mémoire seule (aucune base partagée) : pause appliquée, trace non durable signalée — jamais présentée comme enregistrée', async () => {
    setAuthRateLimiterForTests(new AuthRateLimiter(new MemoryAuthLimitStore()));
    for (let i = 0; i < 5; i++) await recordReauthFailure(requete(`81.8.0.${i}`), 41, 'reauth');
    expect(insertions).toHaveLength(0);
    expect((await reauthBlockedResponse(requete(), 41))?.status).toBe(429);
    expect(signalements()).toHaveLength(1);
    expect(JSON.parse(signalements()[0])).toMatchObject({ userId: 41, action: 'reauth', cause: null });
  });

  it('C823-U13 garde de source : plus aucune écriture détachée ni journal absorbant dans la réauthentification ; codes HTTP des appelants inchangés', () => {
    const src = read('src/lib/auth/reauth-throttle.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bvoid\s+\w/);
    expect(code).not.toMatch(/logUserActivity/);
    expect(code).toMatch(/recordFailureWithLockTrace\(/);
    expect(code).toMatch(/insertUserActivity\(\{[\s\S]*?\}, tx\)/);
    expect(code).toMatch(/status: 429, headers: \{ 'Retry-After': String\(d\.retryAfterSeconds\) \}/);
    const route = read('src/app/api/users/me/change-password/route.ts');
    expect(route).toMatch(/await recordReauthFailure\(request, session\.userId, 'change_password'\);[\s\S]{0,400}\{ status: 401 \}/);
    expect(read('src/app/api/users/me/deletion/close-account.ts')).toContain("await recordReauthFailure(request, userId, 'account_deletion')");
    expect(read('src/lib/auth/reauth.ts')).toContain("await recordReauthFailure(request, userId, 'reauth')");
    // Les autres limiteurs gardent leur chemin (clé par clé) : aucun n'appelle le chemin transactionnel.
    for (const f of ['src/lib/auth/login-throttle.ts', 'src/lib/auth/mfa/throttle.ts', 'src/app/api/auth/verify-email/route.ts']) {
      expect(read(f)).toMatch(/\.recordFailure\(/);
      expect(read(f)).not.toMatch(/recordFailureWithLockTrace/);
    }
  });
});
