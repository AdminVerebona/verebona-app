/**
 * Limiteur de tentatives d'authentification PARTAGÉ — lot 37 (C4), CDC 18
 * §32 et §33.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST CORRIGÉ
 *
 * Le limiteur de connexion était un `Map` en mémoire, par IP seule, remis à
 * zéro par N'IMPORTE QUELLE connexion réussie depuis cette IP :
 *   · une instance de plus = un quota de plus ; un redémarrage = remise à zéro ;
 *   · un attaquant alternait une connexion réussie sur son propre compte et
 *     cinq essais sur le compte visé : le compteur ne bloquait jamais ;
 *   · une IP distribuée contournait totalement le contrôle (aucune clé par
 *     compte) ;
 *   · l'IP lue était la valeur la plus à gauche de `x-forwarded-for`,
 *     fournie par le client.
 *
 * Désormais :
 *   · compteurs en base (`auth_rate_limits`, migration 0313), communs à toutes
 *     les instances ; purge par la tâche interne `auth-rate-limits-purge` ;
 *   · DEUX clés par parcours : l'IP réelle (`client-ip.ts`) ET le compte visé
 *     (adresse e-mail normalisée) — la réinitialisation, dont le compte n'est
 *     désigné que par un lien signé non authentifié, est limitée par IP.
 *     Les valeurs sont PSEUDONYMISÉES (HMAC) : ni e-mail ni IP en clair ;
 *   · une connexion réussie ne remet à zéro QUE la clé du compte qui a prouvé
 *     son mot de passe — jamais la clé IP, jamais celle d'un autre compte ;
 *   · verrouillage progressif : 15 min, puis 30, puis 60 (plafond) en cas de
 *     récidive dans les 24 h ;
 *   · la clé « compte » est calculée sur l'adresse SAISIE : une adresse sans
 *     compte se verrouille exactement comme une adresse inscrite (aucune
 *     énumération par le verrouillage).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BASE INDISPONIBLE
 *
 * Repli sur un magasin en mémoire du processus (mêmes règles), alerte dans
 * les journaux (une fois par minute) et dans `/api/health`
 * (`authRateLimiter`). La connexion elle-même a besoin de la base : le repli
 * ne fait que garder un contrôle pendant une coupure brève.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac } from 'node:crypto';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface AuthLimitPolicy {
  /** Tentatives admises dans la fenêtre ; la suivante est refusée (verrouillage). */
  maxAttempts: number;
  windowMs: number;
  /** Durée du premier verrouillage. */
  lockMs: number;
  /** Récidive : durée doublée à chaque verrouillage (plafond `maxLockMs`). */
  progressive?: boolean;
  maxLockMs?: number;
  /** Récidives oubliées après cette durée sans verrouillage. */
  levelResetMs?: number;
}

/**
 * Politiques (CDC 18 §33). Connexion : seuls les ÉCHECS comptent (un foyer
 * ou un bureau derrière une même IP n'est pas pénalisé par ses connexions
 * réussies). Parcours d'e-mail : chaque DEMANDE compte.
 */
export const AUTH_LIMITS = {
  /** Échecs de connexion par adresse saisie. */
  loginAccount: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: HOUR, levelResetMs: 24 * HOUR },
  /** Échecs de connexion par IP (tous comptes confondus). */
  loginIp: { maxAttempts: 20, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: HOUR, levelResetMs: 24 * HOUR },
  /** « Mot de passe oublié » : demandes par IP (429) et par adresse (silencieux). */
  forgotIp: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: 15 * MIN },
  forgotAccount: { maxAttempts: 3, windowMs: HOUR, lockMs: HOUR },
  /** Renvoi de l'e-mail de vérification : demandes par IP (429) et par adresse (silencieux). */
  resendIp: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: 15 * MIN },
  resendAccount: { maxAttempts: 3, windowMs: HOUR, lockMs: HOUR },
  /**
   * Réinitialisation : demandes par IP. Aucun verrou « par compte » : le
   * compte n'y est désigné que par le lien, non authentifié (un tiers pourrait
   * bloquer la réinitialisation d'un utilisateur) ; la signature du lien rend
   * la force brute vaine.
   */
  resetIp: { maxAttempts: 10, windowMs: 15 * MIN, lockMs: 15 * MIN },
  /**
   * Lot 38 (volet B) : e-mail de sécurité « appareils déconnectés » — au plus
   * UN par utilisateur et par heure (le premier passe et pose le verrou).
   */
  securityEmailUser: { maxAttempts: 1, windowMs: HOUR, lockMs: HOUR },
} as const satisfies Record<string, AuthLimitPolicy>;

/** Lignes sans verrou actif et sans activité depuis cette durée : purgées. */
export const AUTH_LIMIT_RETENTION_MS = 48 * HOUR;

export interface LimitRecord {
  attempts: number;
  windowStartedAt: number;
  lockedUntil: number | null;
  lockLevel: number;
  lastLockedAt: number | null;
  updatedAt: number;
}

export interface LimitEntry { key: string; policy: AuthLimitPolicy }

export interface LimitDecision {
  allowed: boolean;
  /** Secondes avant nouvel essai (0 si permis). */
  retryAfterSeconds: number;
  /** Clé qui refuse (diagnostic interne, jamais renvoyée au client). */
  blockedKey: string | null;
  /** Cette tentative vient de déclencher un verrouillage. */
  lockedNow: boolean;
}

// ── Règles pures ────────────────────────────────────────────────────────────

/** Verrou actif ? Rend la durée restante (ms), 0 sinon. */
export function remainingLockMs(rec: LimitRecord | null | undefined, now: number): number {
  if (!rec?.lockedUntil) return 0;
  return Math.max(0, rec.lockedUntil - now);
}

/** Durée du verrouillage pour un niveau de récidive donné. */
export function lockDurationMs(policy: AuthLimitPolicy, level: number): number {
  if (!policy.progressive) return policy.lockMs;
  const d = policy.lockMs * 2 ** Math.max(0, level);
  return Math.min(d, policy.maxLockMs ?? d);
}

/**
 * Compte une tentative. Pendant un verrou actif, rien n'est compté (le verrou
 * n'est pas prolongé par les essais refusés).
 */
export function applyHit(rec: LimitRecord | null, policy: AuthLimitPolicy, now: number): { record: LimitRecord; lockedNow: boolean } {
  if (rec && remainingLockMs(rec, now) > 0) return { record: rec, lockedNow: false };
  let level = rec?.lockLevel ?? 0;
  const lastLock = rec?.lastLockedAt ?? null;
  if (level > 0 && (lastLock == null || now - lastLock > (policy.levelResetMs ?? 0))) level = 0;
  const windowExpired = !rec || now - rec.windowStartedAt >= policy.windowMs;
  const attempts = windowExpired ? 1 : rec.attempts + 1;
  const windowStartedAt = windowExpired ? now : rec.windowStartedAt;
  if (attempts >= policy.maxAttempts) {
    return {
      record: {
        attempts: 0, windowStartedAt: now,
        lockedUntil: now + lockDurationMs(policy, level),
        lockLevel: policy.progressive ? level + 1 : level,
        lastLockedAt: now, updatedAt: now,
      },
      lockedNow: true,
    };
  }
  return { record: { attempts, windowStartedAt, lockedUntil: null, lockLevel: level, lastLockedAt: lastLock, updatedAt: now }, lockedNow: false };
}

// ── Magasins ────────────────────────────────────────────────────────────────

export interface AuthLimitStore {
  read(keys: string[]): Promise<Map<string, LimitRecord>>;
  /** Lecture-modification-écriture ATOMIQUE d'une clé. */
  update(key: string, fn: (rec: LimitRecord | null) => LimitRecord): Promise<LimitRecord>;
  delete(key: string): Promise<void>;
  purge(now: number): Promise<number>;
}

export class MemoryAuthLimitStore implements AuthLimitStore {
  private readonly rows = new Map<string, LimitRecord>();
  async read(keys: string[]) {
    const m = new Map<string, LimitRecord>();
    for (const k of keys) { const r = this.rows.get(k); if (r) m.set(k, { ...r }); }
    return m;
  }
  async update(key: string, fn: (rec: LimitRecord | null) => LimitRecord) {
    const cur = this.rows.get(key);
    const next = fn(cur ? { ...cur } : null);
    this.rows.set(key, next);
    if (this.rows.size > 50_000) void this.purge(Date.now());
    return next;
  }
  async delete(key: string) { this.rows.delete(key); }
  async purge(now: number) {
    let n = 0;
    for (const [k, r] of this.rows) {
      if (now - r.updatedAt > AUTH_LIMIT_RETENTION_MS && remainingLockMs(r, now) === 0) { this.rows.delete(k); n++; }
    }
    return n;
  }
  size() { return this.rows.size; }
}

type Row = {
  bucket_key: string; attempts: number; window_started_at: Date; locked_until: Date | null;
  lock_level: number; last_locked_at: Date | null; updated_at: Date;
};
const toRecord = (r: Row): LimitRecord => ({
  attempts: Number(r.attempts),
  windowStartedAt: new Date(r.window_started_at).getTime(),
  lockedUntil: r.locked_until ? new Date(r.locked_until).getTime() : null,
  lockLevel: Number(r.lock_level),
  lastLockedAt: r.last_locked_at ? new Date(r.last_locked_at).getTime() : null,
  updatedAt: new Date(r.updated_at).getTime(),
});
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

/** Magasin PostgreSQL (`auth_rate_limits`, migration 0313). */
export class PgAuthLimitStore implements AuthLimitStore {
  private async sql() {
    const { pgClient } = await import('@/db');
    return pgClient;
  }
  async read(keys: string[]) {
    const sql = await this.sql();
    const rows = keys.length === 0 ? [] : await sql<Row[]>`
      SELECT bucket_key, attempts, window_started_at, locked_until, lock_level, last_locked_at, updated_at
        FROM auth_rate_limits WHERE bucket_key = ANY(${keys})`;
    return new Map(rows.map((r) => [r.bucket_key, toRecord(r)]));
  }
  async update(key: string, fn: (rec: LimitRecord | null) => LimitRecord) {
    const sql = await this.sql();
    return sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '3s'`;
      const [cur] = await tx<Row[]>`
        SELECT bucket_key, attempts, window_started_at, locked_until, lock_level, last_locked_at, updated_at
          FROM auth_rate_limits WHERE bucket_key = ${key} FOR UPDATE`;
      const next = fn(cur ? toRecord(cur) : null);
      await tx`
        INSERT INTO auth_rate_limits (bucket_key, attempts, window_started_at, locked_until, lock_level, last_locked_at, updated_at)
        VALUES (${key}, ${next.attempts}, ${iso(next.windowStartedAt)}, ${iso(next.lockedUntil)}, ${next.lockLevel},
                ${iso(next.lastLockedAt)}, ${iso(next.updatedAt)})
        ON CONFLICT (bucket_key) DO UPDATE SET
          attempts = EXCLUDED.attempts, window_started_at = EXCLUDED.window_started_at,
          locked_until = EXCLUDED.locked_until, lock_level = EXCLUDED.lock_level,
          last_locked_at = EXCLUDED.last_locked_at, updated_at = EXCLUDED.updated_at`;
      return next;
    }) as Promise<LimitRecord>;
  }
  async delete(key: string) {
    const sql = await this.sql();
    await sql`DELETE FROM auth_rate_limits WHERE bucket_key = ${key}`;
  }
  async purge(now: number) {
    const sql = await this.sql();
    const rows = await sql<{ n: number }[]>`
      WITH d AS (
        DELETE FROM auth_rate_limits
         WHERE updated_at < ${iso(now - AUTH_LIMIT_RETENTION_MS)}
           AND (locked_until IS NULL OR locked_until < ${iso(now)})
        RETURNING 1)
      SELECT count(*)::int AS n FROM d`;
    return rows[0]?.n ?? 0;
  }
}

/** Magasin partagé avec repli mémoire si la base ne répond pas. */
export class FallbackAuthLimitStore implements AuthLimitStore {
  degradedSince: number | null = null;
  lastError: string | null = null;
  private lastLog = 0;
  constructor(private readonly primary: AuthLimitStore, private readonly fallback: AuthLimitStore = new MemoryAuthLimitStore()) {}
  private async run<T>(op: (s: AuthLimitStore) => Promise<T>): Promise<T> {
    try {
      const r = await op(this.primary);
      this.degradedSince = null;
      return r;
    } catch (e) {
      const now = Date.now();
      this.degradedSince ??= now;
      this.lastError = (e as Error)?.message?.slice(0, 200) ?? 'erreur inconnue';
      if (now - this.lastLog > MIN) {
        this.lastLog = now;
        console.error('[auth-rate-limit] compteurs partagés indisponibles — repli mémoire de l’instance :', this.lastError);
      }
      return op(this.fallback);
    }
  }
  read(keys: string[]) { return this.run((s) => s.read(keys)); }
  update(key: string, fn: (rec: LimitRecord | null) => LimitRecord) { return this.run((s) => s.update(key, fn)); }
  delete(key: string) { return this.run((s) => s.delete(key)); }
  purge(now: number) { return this.primary.purge(now); }
}

// ── Limiteur ────────────────────────────────────────────────────────────────

const ALLOWED: LimitDecision = { allowed: true, retryAfterSeconds: 0, blockedKey: null, lockedNow: false };

export class AuthRateLimiter {
  constructor(readonly store: AuthLimitStore, private readonly clock: () => number = Date.now) {}

  private blocked(recs: Map<string, LimitRecord>, entries: LimitEntry[], now: number): LimitDecision | null {
    let worst: LimitDecision | null = null;
    for (const e of entries) {
      const ms = remainingLockMs(recs.get(e.key), now);
      if (ms > 0 && (!worst || ms / 1000 > worst.retryAfterSeconds)) {
        worst = { allowed: false, retryAfterSeconds: Math.ceil(ms / 1000), blockedKey: e.key, lockedNow: false };
      }
    }
    return worst;
  }

  /** Une clé est-elle verrouillée ? Ne compte rien (connexion : avant le contrôle du mot de passe). */
  async check(entries: LimitEntry[]): Promise<LimitDecision> {
    const now = this.clock();
    const recs = await this.store.read(entries.map((e) => e.key));
    return this.blocked(recs, entries, now) ?? ALLOWED;
  }

  /** Compte un échec sur chaque clé. `lockedNow` : un verrou vient d'être posé. */
  async recordFailure(entries: LimitEntry[]): Promise<LimitDecision> {
    const now = this.clock();
    let lockedNow = false;
    let blockedKey: string | null = null;
    let retry = 0;
    for (const e of entries) {
      let locked = false;
      const rec = await this.store.update(e.key, (cur) => {
        const r = applyHit(cur, e.policy, now);
        locked = r.lockedNow;
        return r.record;
      });
      if (locked) {
        lockedNow = true;
        const s = Math.ceil(remainingLockMs(rec, now) / 1000);
        if (s > retry) { retry = s; blockedKey = e.key; }
      }
    }
    return { allowed: !lockedNow, retryAfterSeconds: retry, blockedKey, lockedNow };
  }

  /**
   * Chaque DEMANDE compte (parcours d'e-mail) : refus si une clé est
   * verrouillée ; sinon la demande est comptée sur toutes les clés et
   * admise (la demande qui atteint le plafond passe ; la suivante est refusée).
   */
  async consume(entries: LimitEntry[]): Promise<LimitDecision> {
    const pre = await this.check(entries);
    if (!pre.allowed) return pre;
    const r = await this.recordFailure(entries);
    return { ...ALLOWED, lockedNow: r.lockedNow };
  }

  /** Remise à zéro d'UNE clé (compte qui a prouvé son mot de passe). */
  async reset(key: string): Promise<void> {
    await this.store.delete(key);
  }
}

// ── Clés pseudonymisées ─────────────────────────────────────────────────────

function keySecret(): string {
  return `verebona/auth-rate-limit/v1/${process.env.JWT_SECRET || 'dev'}`;
}

/** Adresse e-mail normalisée (trim + minuscules), comme à l'inscription. */
export function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Clé de compteur : `<parcours>:<ip|acct>:<HMAC tronqué>`. Jamais la valeur
 * en clair (e-mail, IP) dans la table.
 */
export function limitKey(flow: 'login' | 'forgot' | 'resend' | 'reset' | 'security-email', kind: 'ip' | 'acct', value: string): string {
  const h = createHmac('sha256', keySecret()).update(`${flow}:${kind}:${value}`).digest('hex').slice(0, 40);
  return `${flow}:${kind}:${h}`;
}

/** Le limiteur est actif (désactivé seulement en développement local, comme avant). */
export function authRateLimitEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'development';
}

// ── Instance du processus ───────────────────────────────────────────────────

let sharedStore: FallbackAuthLimitStore | null = null;
let instance: AuthRateLimiter | null = null;

export function getAuthRateLimiter(): AuthRateLimiter {
  if (!instance) {
    sharedStore = new FallbackAuthLimitStore(new PgAuthLimitStore());
    instance = new AuthRateLimiter(sharedStore);
  }
  return instance;
}

/** Tests : limiteur injecté (`null` : retour à l'instance partagée). */
export function setAuthRateLimiterForTests(l: AuthRateLimiter | null): void {
  instance = l;
  if (!l) sharedStore = null;
}

/** État pour `/api/health` (mémoire seulement, aucune requête). */
export function authRateLimiterHealth(): { mode: 'shared' | 'memory-fallback' | 'not_used'; degradedSince: string | null; lastError: string | null } {
  if (!sharedStore) return { mode: 'not_used', degradedSince: null, lastError: null };
  return {
    mode: sharedStore.degradedSince ? 'memory-fallback' : 'shared',
    degradedSince: sharedStore.degradedSince ? new Date(sharedStore.degradedSince).toISOString() : null,
    lastError: sharedStore.lastError,
  };
}

/** Purge planifiée (tâche interne `auth-rate-limits-purge`). */
export async function purgeAuthRateLimits(now = Date.now()): Promise<number> {
  return new PgAuthLimitStore().purge(now);
}

/** Réponse 429 commune (message en français, aucune indication sur le compte). */
export function rateLimitBody(retryAfterSeconds: number): { error: string; code: 'RATE_LIMIT_EXCEEDED'; message: string; retryAfterSeconds: number } {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const message = `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`;
  return { error: message, code: 'RATE_LIMIT_EXCEEDED', message, retryAfterSeconds };
}
