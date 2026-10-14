/**
 * Lot 37 — C4 : limiteur de tentatives partagé, par compte ET par IP,
 * verrouillage progressif, IP réelle derrière le routeur. CDC 18 §32-§33.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AUTH_LIMITS, AuthRateLimiter, FallbackAuthLimitStore, MemoryAuthLimitStore, applyHit, limitKey, lockDurationMs,
  rateLimitBody, type AuthLimitStore,
} from '@/lib/auth/auth-rate-limit';
import { getClientIp, isInternalAddress } from '@/lib/auth/client-ip';
import { SCHEDULED_TASKS } from '@/services/scheduling/scheduled-tasks.catalog';
import { LOGIN_THROTTLE_POLICIES } from '@/lib/auth/login-throttle';

/**
 * Lot 53A (retour PO D1) : la connexion n'utilise plus la politique « 5 échecs
 * → adresse verrouillée 15/30/60 min pour tous » (`login-throttle.ts`, tests
 * PO-D1-xx). Le MOTEUR (fenêtre, verrou progressif, magasin partagé) est
 * inchangé : il est éprouvé ici avec une politique de même forme.
 */
const GENERIC_5 = { maxAttempts: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000, progressive: true, maxLockMs: 60 * 60_000, levelResetMs: 24 * 60 * 60_000 };
const ORIGIN = LOGIN_THROTTLE_POLICIES.origin;

const MIN = 60_000;
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const h = (o: Record<string, string>) => new Headers(o);

describe('C4 — IP réelle derrière le routeur Scalingo', () => {
  it('C4-01 la valeur fournie par le client (à gauche) est ignorée : on lit de droite à gauche', () => {
    expect(getClientIp(h({ 'x-forwarded-for': '6.6.6.6, 81.2.3.4' }))).toBe('81.2.3.4');
    expect(getClientIp(h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 81.2.3.4' }))).toBe('81.2.3.4');
  });
  it('C4-02 sauts internes de l’infrastructure ignorés ; x-real-ip seulement sans x-forwarded-for', () => {
    expect(getClientIp(h({ 'x-forwarded-for': '6.6.6.6, 81.2.3.4, 10.0.0.12' }))).toBe('81.2.3.4');
    expect(getClientIp(h({ 'x-forwarded-for': '81.2.3.4', 'x-real-ip': '9.9.9.9' }))).toBe('81.2.3.4');
    expect(getClientIp(h({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(getClientIp(h({ 'x-forwarded-for': '127.0.0.1' }))).toBe('127.0.0.1'); // développement local
    expect(getClientIp(h({}))).toBe('unknown');
    expect(getClientIp(h({ 'x-forwarded-for': '[2001:db8::1]:443, 81.2.3.4:5555' }))).toBe('81.2.3.4');
  });
  it('C4-03 adresses internes reconnues', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1']) {
      expect(isInternalAddress(ip)).toBe(true);
    }
    for (const ip of ['81.2.3.4', '172.32.0.1', '2001:db8::1']) expect(isInternalAddress(ip)).toBe(false);
  });
  it('C4-04 le journal d’activité et l’ancien getClientIp utilisent la lecture sûre', () => {
    expect(read('src/lib/rate-limiter.ts')).toMatch(/export \{ getClientIp \} from '\.\/auth\/client-ip'/);
    expect(read('src/lib/audit-logger.ts')).toMatch(/getClientIp\(request\.headers\)/);
  });
});

describe('C4 — règles du verrouillage', () => {
  const p = GENERIC_5;
  it('C4-05 cinq échecs dans la fenêtre verrouillent 15 min ; puis 30, puis 60 (plafond)', () => {
    expect(lockDurationMs(p, 0)).toBe(15 * MIN);
    expect(lockDurationMs(p, 1)).toBe(30 * MIN);
    expect(lockDurationMs(p, 2)).toBe(60 * MIN);
    expect(lockDurationMs(p, 5)).toBe(60 * MIN);
    let rec = null;
    let t = 0;
    for (let i = 1; i <= 4; i++) { const r = applyHit(rec, p, t); rec = r.record; expect(r.lockedNow).toBe(false); }
    const r5 = applyHit(rec, p, t);
    expect(r5.lockedNow).toBe(true);
    expect(r5.record.lockedUntil).toBe(15 * MIN);
    // Pendant le verrou, rien n'est compté (pas de prolongation).
    expect(applyHit(r5.record, p, 10 * MIN).record).toEqual(r5.record);
    // Récidive après le verrou : 30 min.
    rec = r5.record; t = 16 * MIN;
    for (let i = 1; i <= 4; i++) rec = applyHit(rec, p, t).record;
    const r10 = applyHit(rec, p, t);
    expect(r10.record.lockedUntil! - t).toBe(30 * MIN);
  });
  it('C4-06 la fenêtre expire ; la récidive est oubliée après 24 h', () => {
    let rec = applyHit(null, p, 0).record;
    rec = applyHit(rec, p, 16 * MIN).record; // fenêtre expirée → repart à 1
    expect(rec.attempts).toBe(1);
    const lock = { attempts: 0, windowStartedAt: 0, lockedUntil: 15 * MIN, lockLevel: 2, lastLockedAt: 0, updatedAt: 0 };
    const after = applyHit(lock, p, 25 * 60 * MIN).record;
    expect(after.lockLevel).toBe(0);
  });
});

describe('C4 — limiteur', () => {
  let now = 1_000_000;
  let store: MemoryAuthLimitStore;
  let lim: AuthRateLimiter;
  beforeEach(() => { now = 1_000_000; store = new MemoryAuthLimitStore(); lim = new AuthRateLimiter(store, () => now); });
  const ip = { key: limitKey('login', 'ip', '81.2.3.4'), policy: ORIGIN };
  const acct = (e: string) => ({ key: limitKey('login', 'acct', e), policy: GENERIC_5 });

  it('C4-07 moteur : une clé commune à plusieurs IP se verrouille après 5 échecs (comptage distribué)', async () => {
    for (let i = 0; i < 5; i++) {
      await lim.recordFailure([{ key: limitKey('login', 'ip', `81.2.3.${i}`), policy: ORIGIN }, acct('cible@x.fr')]);
    }
    const d = await lim.check([{ key: limitKey('login', 'ip', '81.9.9.9'), policy: ORIGIN }, acct('cible@x.fr')]);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(15 * 60);
  });

  it('C4-08 le succès d’UN AUTRE compte ne remet à zéro ni l’IP ni le compte ciblé', async () => {
    for (let i = 0; i < 4; i++) await lim.recordFailure([ip, acct('cible@x.fr')]);
    await lim.reset(acct('attaquant@x.fr').key); // connexion réussie de l'attaquant sur son compte
    await lim.recordFailure([ip, acct('cible@x.fr')]);
    expect((await lim.check([ip, acct('cible@x.fr')])).allowed).toBe(false);
  });

  it('C4-09 IP : 20 échecs tous comptes confondus → verrou de l’IP ; les autres IP passent', async () => {
    for (let i = 0; i < 20; i++) await lim.recordFailure([ip, acct(`u${i}@x.fr`)]);
    expect((await lim.check([ip, acct('nouveau@x.fr')])).allowed).toBe(false);
    expect((await lim.check([{ key: limitKey('login', 'ip', '81.2.3.99'), policy: ORIGIN }, acct('nouveau@x.fr')])).allowed).toBe(true);
  });

  it('C4-10 la remise à zéro ne vise que la clé du compte qui a prouvé son mot de passe', async () => {
    for (let i = 0; i < 3; i++) await lim.recordFailure([ip, acct('moi@x.fr')]);
    await lim.reset(acct('moi@x.fr').key);
    const rows = await store.read([ip.key, acct('moi@x.fr').key]);
    expect(rows.get(acct('moi@x.fr').key)).toBeUndefined();
    expect(rows.get(ip.key)?.attempts).toBe(3);
  });

  it('C4-11 parcours d’e-mail : chaque demande compte ; la 4e par adresse et par heure est refusée', async () => {
    const e = { key: limitKey('forgot', 'acct', 'a@x.fr'), policy: AUTH_LIMITS.forgotAccount };
    for (let i = 0; i < 3; i++) expect((await lim.consume([e])).allowed).toBe(true);
    expect((await lim.consume([e])).allowed).toBe(false);
    now += 61 * MIN;
    expect((await lim.consume([e])).allowed).toBe(true);
  });

  it('C4-12 partagé entre instances : deux limiteurs sur le même magasin voient les mêmes compteurs', async () => {
    const autre = new AuthRateLimiter(store, () => now);
    for (let i = 0; i < 3; i++) await lim.recordFailure([acct('c@x.fr')]);
    for (let i = 0; i < 2; i++) await autre.recordFailure([acct('c@x.fr')]);
    expect((await lim.check([acct('c@x.fr')])).allowed).toBe(false);
  });

  it('C4-13 clés pseudonymisées : ni e-mail ni IP en clair', () => {
    const k = limitKey('login', 'acct', 'jean.dupont@exemple.fr');
    expect(k).toMatch(/^login:acct:[0-9a-f]{40}$/);
    expect(k).not.toContain('jean');
    expect(limitKey('login', 'ip', '81.2.3.4')).not.toContain('81.2.3.4');
  });

  it('C4-14 base indisponible : repli mémoire, signalé, jamais bloquant', async () => {
    const enPanne: AuthLimitStore = {
      read: async () => { throw new Error('ECONNREFUSED'); },
      update: async () => { throw new Error('ECONNREFUSED'); },
      delete: async () => { throw new Error('ECONNREFUSED'); },
      purge: async () => 0,
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fb = new FallbackAuthLimitStore(enPanne);
    const l = new AuthRateLimiter(fb, () => now);
    for (let i = 0; i < 5; i++) await l.recordFailure([acct('p@x.fr')]);
    expect((await l.check([acct('p@x.fr')])).allowed).toBe(false);
    expect(fb.degradedSince).not.toBeNull();
    err.mockRestore();
  });

  it('C4-15 réponse 429 en français, sans indication sur le compte', () => {
    expect(rateLimitBody(900)).toEqual({
      error: 'Trop de tentatives. Réessayez dans 15 minutes.', code: 'RATE_LIMIT_EXCEEDED',
      message: 'Trop de tentatives. Réessayez dans 15 minutes.', retryAfterSeconds: 900,
    });
  });
});

describe('C4 — branchements', () => {
  it('C4-16 purge par tâche interne (lot 25), pas de cron externe', () => {
    const t = SCHEDULED_TASKS.find((x) => x.code === 'auth-rate-limits-purge');
    expect(t?.schedule).toMatchObject({ kind: 'daily', at: [5, 30] });
    expect(read('docs/exploitation/taches-planifiees.md')).toContain('`auth-rate-limits-purge`');
  });
  it('C4-17 migration 0313 idempotente, index CONCURRENTLY dans un fichier séparé', () => {
    const m = read('src/db/migrations/0313_auth_rate_limits.sql');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS auth_rate_limits/);
    expect(m).not.toMatch(/CONCURRENTLY/);
    expect(read('src/db/migrations/0313_auth_rate_limits_idx_1.sql')).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  });
  it('C4-18 plus de limiteur en mémoire dans le middleware ; routes branchées sur le limiteur partagé', () => {
    expect(read('src/middleware.ts')).not.toMatch(/new Map</);
    for (const r of ['login', 'forgot-password', 'resend-verification', 'reset-password']) {
      expect(read(`src/app/api/auth/${r}/route.ts`)).toMatch(/getAuthRateLimiter\(\)/);
    }
    expect(read('src/app/api/auth/login/route.ts')).not.toMatch(/resetAuthRateLimit|checkAuthRateLimit/);
  });
});
