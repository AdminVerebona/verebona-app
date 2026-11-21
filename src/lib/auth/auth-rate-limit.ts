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
 *   · LOT 53A (retour PO D1) : pour la CONNEXION, l'adresse n'est plus
 *     verrouillée pour tous (un tiers pouvait bloquer le titulaire) — règles
 *     par origine, origine × adresse, adresse pour les appareils non
 *     reconnus et appareil reconnu : `login-throttle.ts` ;
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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE #823 — PAUSE ET TRACE VALIDÉES ENSEMBLE (réauthentification)
 *
 * `recordFailureWithLockTrace` compte un échec sur TOUTES les clés (utilisateur
 * et IP) dans UNE transaction PostgreSQL. Si la tentative pose un verrou, la
 * trace d'audit fournie par l'appelant est écrite dans la MÊME transaction :
 * la pause et sa trace sont validées par le même COMMIT, ou aucune des deux.
 *   · une tentative ordinaire, ou faite pendant une pause, n'écrit aucune trace
 *     et n'attend donc aucune insertion d'audit ;
 *   · deux tentatives simultanées sont sérialisées par clé (verrou consultatif
 *     transactionnel puis `FOR UPDATE`) : une seule pose le verrou, une seule
 *     trace par entrée en pause, même si les seuils utilisateur et IP sont
 *     franchis par la même tentative ;
 *   · trace impossible (insertion refusée, validation en échec) : RIEN n'est
 *     validé en base (jamais de verrou PostgreSQL sans sa trace) ; la pause est
 *     alors TENUE EN MÉMOIRE par l'instance (`heldLocks`, lue par `check`) et
 *     la dégradation est rendue à l'appelant, qui la signale. La protection
 *     l'emporte toujours sur la journalisation ;
 *   · base totalement indisponible : repli mémoire comme ci-dessus. AUCUNE
 *     trace durable ne peut alors être garantie dans cette base, et la pause
 *     n'est connue que de l'instance qui l'a posée.
 * Les autres méthodes (`check` hors verrou tenu, `recordFailure`, `consume`,
 * `reset`) et donc les autres limiteurs (connexion, MFA, activation, parcours
 * d'e-mail, OAuth) ne passent pas par ce chemin : comportement inchangé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac } from 'node:crypto';
import type { Database } from '@/db';

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
  // Connexion : règles du lot 53A (retour PO D1) dans `login-throttle.ts`
  // (origine, origine × adresse, adresse toutes origines pour les appareils
  // non reconnus, appareil reconnu). Le verrou « 5 échecs → adresse bloquée
  // 15/30/60 min pour tous » du lot 37 est retiré : il permettait à un tiers
  // de bloquer le titulaire.
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
  /**
   * Lot 53A (CDC 18 §33 « Reauth password : même niveau de protection que
   * login + user/session key ») : mot de passe ACTUEL exigé par une action
   * sensible (changement de mot de passe, clôture du compte). Échecs par
   * utilisateur (session requise : aucun tiers ne peut bloquer le titulaire)
   * et par IP.
   */
  reauthUser: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: HOUR, levelResetMs: 24 * HOUR },
  reauthIp: { maxAttempts: 20, windowMs: 15 * MIN, lockMs: 15 * MIN },
  /**
   * Lot 53A (inscription non énumérable) : e-mail « vous avez déjà un compte »
   * — au plus UN par adresse et par heure (silencieux au-delà).
   */
  signupExistingEmail: { maxAttempts: 1, windowMs: HOUR, lockMs: HOUR },
  /**
   * Lot 93 (CDC 18 §33 « OAuth start/callback : limiter abus callback et
   * création de transactions ») : demandes par IP. Un parcours normal = un
   * démarrage + un retour (+ une reprise Apple).
   */
  oauthStartIp: { maxAttempts: 30, windowMs: 15 * MIN, lockMs: 15 * MIN },
  oauthCallbackIp: { maxAttempts: 40, windowMs: 15 * MIN, lockMs: 15 * MIN },
  /** Lot 93 : codes de confirmation d'adresse (inscription Google / Apple) — envois par adresse. */
  socialEmailCodeAccount: { maxAttempts: 5, windowMs: HOUR, lockMs: HOUR },
  /**
   * Lot 96A (CDC 18 Q9, cohérent D1) : mot de passe de l'inscription demandé à
   * l'activation. Seuls les ÉCHECS comptent. Clé par INSCRIPTION (seul le
   * détenteur du lien, donc de la boîte, peut essayer : aucun tiers ne bloque
   * le titulaire) : 5 échecs / 15 min → pause 15, 30, 60 min ; par IP : 20 / 15 min.
   */
  activationUser: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: HOUR, levelResetMs: 24 * HOUR },
  activationIp: { maxAttempts: 20, windowMs: 15 * MIN, lockMs: 15 * MIN },
  /**
   * Lot 96A (CDC 18 Q8) : demandes de changement d'adresse principale — chaque
   * DEMANDE compte, par utilisateur (session + preuve exigées) ; e-mail
   * « adresse déjà utilisée » au plus UN par adresse et par heure.
   */
  emailChangeRequestUser: { maxAttempts: 5, windowMs: HOUR, lockMs: HOUR },
  emailChangeInUseNotice: { maxAttempts: 1, windowMs: HOUR, lockMs: HOUR },
  /**
   * Lot 110B (MFA, ticket §5) : vérification d'un second facteur (TOTP, code
   * de récupération, clé d'accès) — ÉCHECS par compte (5 / 15 min → pause
   * progressive 15, 30, 60 min) et par IP (30 / 15 min). Demande de code de
   * récupération par e-mail : 3 / h par adresse (silencieux), 10 / 15 min par IP.
   */
  mfaUser: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: HOUR, levelResetMs: 24 * HOUR },
  mfaIp: { maxAttempts: 30, windowMs: 15 * MIN, lockMs: 15 * MIN },
  mfaRecoveryAccount: { maxAttempts: 3, windowMs: HOUR, lockMs: HOUR },
  mfaRecoveryIp: { maxAttempts: 10, windowMs: 15 * MIN, lockMs: 15 * MIN },
} as const satisfies Record<string, AuthLimitPolicy>;

/** Lignes sans verrou actif et sans activité depuis cette durée : purgées. */
const AUTH_LIMIT_RETENTION_MS = 48 * HOUR;

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

/**
 * Carte #823 — transaction ouverte par le magasin partagé : l'appelant y écrit
 * ce qui doit être validé AVEC les compteurs (trace d'audit).
 */
export type AuthLimitTx = Pick<Database, 'insert' | 'execute'>;

/**
 * Carte #823 — où une mise à jour groupée a été appliquée :
 *   · `shared` : validée dans la base partagée, `beforeCommit` compris ;
 *   · `memory` : la base partagée n'a RIEN validé (indisponible, écriture ou
 *     `beforeCommit` en échec) ; appliquée à la mémoire de l'instance, sans
 *     exécuter `beforeCommit`.
 */
export type LimitCommit = 'shared' | 'memory';

/**
 * Carte #823 — sort de la trace d'un verrou :
 *   · `none` : aucun verrou posé par cette tentative, aucune trace à écrire ;
 *   · `committed` : verrou et trace validés par la même transaction ;
 *   · `not_durable` : verrou tenu en mémoire par l'instance, AUCUNE trace
 *     durable en base (à signaler par l'appelant).
 */
export type LockTraceOutcome = 'none' | 'committed' | 'not_durable';

export interface TracedLimitDecision extends LimitDecision {
  lockTrace: LockTraceOutcome;
  /** Cause de la dégradation (message technique tronqué, sans donnée d'entrée) ; `null` sinon. */
  lockTraceError: string | null;
}

/** Contexte remis à l'écriture de la trace, calculé DANS la transaction. */
export interface LockTraceContext {
  /** Durée de la pause posée (la plus longue si plusieurs clés se verrouillent). */
  retryAfterSeconds: number;
  /** Clé qui porte cette pause (diagnostic interne). */
  blockedKey: string;
}

// ── Règles pures ────────────────────────────────────────────────────────────

/** Verrou actif ? Rend la durée restante (ms), 0 sinon. */
function remainingLockMs(rec: LimitRecord | null | undefined, now: number): number {
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
  /**
   * Carte #823 (facultatif) — lecture-modification-écriture ATOMIQUE de
   * PLUSIEURS clés. `fn` reçoit l'état courant des clés (lignes verrouillées)
   * et rend les SEULES clés à écrire ; `beforeCommit` s'exécute ensuite dans
   * la même transaction : s'il lève, rien n'est validé dans la base partagée.
   * `fn` peut être appelée deux fois (base partagée, puis mémoire en repli).
   */
  updateMany?(
    keys: string[],
    fn: (recs: Map<string, LimitRecord>) => Map<string, LimitRecord>,
    beforeCommit?: (tx: AuthLimitTx) => Promise<void>,
  ): Promise<LimitCommit>;
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
  /** Carte #823 : aucune base, donc aucune transaction — `beforeCommit` n'est jamais exécuté ici. */
  async updateMany(keys: string[], fn: (recs: Map<string, LimitRecord>) => Map<string, LimitRecord>): Promise<LimitCommit> {
    const cur = new Map<string, LimitRecord>();
    for (const k of keys) { const r = this.rows.get(k); if (r) cur.set(k, { ...r }); }
    for (const [k, r] of fn(cur)) this.rows.set(k, r);
    if (this.rows.size > 50_000) void this.purge(Date.now());
    return 'memory';
  }
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
  /**
   * Carte #823 — toutes les clés dans UNE transaction ; `beforeCommit` (trace
   * d'audit) y est exécuté APRÈS les écritures et AVANT la validation : une
   * erreur, où qu'elle survienne, annule tout.
   *
   * Sérialisation : verrou consultatif transactionnel par clé, pris dans
   * l'ordre trié (aucun interblocage entre deux tentatives qui partagent une
   * clé), puis `FOR UPDATE`. Le verrou consultatif couvre aussi la clé qui
   * n'a pas encore de ligne — `FOR UPDATE` seul ne verrouille rien dans ce
   * cas, et deux premières tentatives simultanées n'en comptaient qu'une.
   * Libéré automatiquement au COMMIT / ROLLBACK.
   */
  async updateMany(
    keys: string[],
    fn: (recs: Map<string, LimitRecord>) => Map<string, LimitRecord>,
    beforeCommit?: (tx: AuthLimitTx) => Promise<void>,
  ): Promise<LimitCommit> {
    const { db } = await import('@/db');
    const { sql } = await import('drizzle-orm');
    const sorted = [...new Set(keys)].sort();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const recs = new Map<string, LimitRecord>();
      for (const key of sorted) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 823))`);
        const rows = (await tx.execute(sql`
          SELECT bucket_key, attempts, window_started_at, locked_until, lock_level, last_locked_at, updated_at
            FROM auth_rate_limits WHERE bucket_key = ${key} FOR UPDATE`)) as unknown as Row[];
        if (rows[0]) recs.set(key, toRecord(rows[0]));
      }
      for (const [key, next] of fn(recs)) {
        await tx.execute(sql`
          INSERT INTO auth_rate_limits (bucket_key, attempts, window_started_at, locked_until, lock_level, last_locked_at, updated_at)
          VALUES (${key}, ${next.attempts}, ${iso(next.windowStartedAt)}, ${iso(next.lockedUntil)}, ${next.lockLevel},
                  ${iso(next.lastLockedAt)}, ${iso(next.updatedAt)})
          ON CONFLICT (bucket_key) DO UPDATE SET
            attempts = EXCLUDED.attempts, window_started_at = EXCLUDED.window_started_at,
            locked_until = EXCLUDED.locked_until, lock_level = EXCLUDED.lock_level,
            last_locked_at = EXCLUDED.last_locked_at, updated_at = EXCLUDED.updated_at`);
      }
      if (beforeCommit) await beforeCommit(tx);
    });
    return 'shared';
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

/**
 * Carte #823 — cause technique d'un échec, pour les journaux et `/api/health`.
 * Drizzle enveloppe l'erreur du pilote dans un message qui reprend la requête
 * ET ses paramètres (adresse IP, agent utilisateur de la trace) : seule la
 * cause d'origine (message du pilote ou de PostgreSQL) est retenue.
 */
function errorSummary(e: unknown): string {
  const cause = (e as { cause?: unknown } | null)?.cause;
  const root = cause instanceof Error ? cause : e;
  const message = (root as Error | null)?.message;
  if (typeof message !== 'string' || message.startsWith('Failed query')) return 'erreur inconnue';
  return message.slice(0, 200);
}

/** Magasin partagé avec repli mémoire si la base ne répond pas. */
export class FallbackAuthLimitStore implements AuthLimitStore {
  degradedSince: number | null = null;
  lastError: string | null = null;
  private lastLog = 0;
  constructor(private readonly primary: AuthLimitStore, private readonly fallback: AuthLimitStore = new MemoryAuthLimitStore()) {}
  private noteFailure(message: string): void {
    const now = Date.now();
    this.degradedSince ??= now;
    this.lastError = message;
    if (now - this.lastLog > MIN) {
      this.lastLog = now;
      console.error('[auth-rate-limit] compteurs partagés indisponibles — repli mémoire de l’instance :', this.lastError);
    }
  }
  private async run<T>(op: (s: AuthLimitStore) => Promise<T>): Promise<T> {
    try {
      const r = await op(this.primary);
      this.degradedSince = null;
      return r;
    } catch (e) {
      this.noteFailure((e as Error)?.message?.slice(0, 200) ?? 'erreur inconnue');
      return op(this.fallback);
    }
  }
  /**
   * Carte #823 — transaction du magasin partagé ; si elle n'aboutit pas (base
   * indisponible, écriture ou `beforeCommit` en échec), elle n'a RIEN validé :
   * la mise à jour est alors appliquée à la mémoire de l'instance, SANS
   * `beforeCommit`. Jamais de nouvelle écriture hors transaction dans la base
   * partagée : un verrou n'y est validé qu'avec ce que `beforeCommit` écrit.
   * Un magasin partagé sans `updateMany` est traité comme indisponible.
   */
  async updateMany(
    keys: string[],
    fn: (recs: Map<string, LimitRecord>) => Map<string, LimitRecord>,
    beforeCommit?: (tx: AuthLimitTx) => Promise<void>,
  ): Promise<LimitCommit> {
    if (this.primary.updateMany) {
      try {
        const r = await this.primary.updateMany(keys, fn, beforeCommit);
        this.degradedSince = null;
        return r;
      } catch (e) {
        this.noteFailure(errorSummary(e));
      }
    }
    if (this.fallback.updateMany) {
      await this.fallback.updateMany(keys, fn);
    } else {
      const cur = await this.fallback.read(keys);
      for (const [k, r] of fn(cur)) await this.fallback.update(k, () => r);
    }
    return 'memory';
  }
  read(keys: string[]) { return this.run((s) => s.read(keys)); }
  update(key: string, fn: (rec: LimitRecord | null) => LimitRecord) { return this.run((s) => s.update(key, fn)); }
  delete(key: string) { return this.run((s) => s.delete(key)); }
  purge(now: number) { return this.primary.purge(now); }
}

// ── Limiteur ────────────────────────────────────────────────────────────────

const ALLOWED: LimitDecision = { allowed: true, retryAfterSeconds: 0, blockedKey: null, lockedNow: false };

export class AuthRateLimiter {
  /**
   * Carte #823 — pauses TENUES EN MÉMOIRE par cette instance : verrous calculés
   * par `recordFailureWithLockTrace` que la base partagée n'a pas validés
   * (trace impossible ou base indisponible). `check` les applique en plus de
   * l'état lu : la protection ne dépend pas de la réussite de la trace. Vide
   * tant qu'aucune dégradation n'a eu lieu — les autres limiteurs n'y écrivent
   * jamais.
   */
  private readonly heldLocks = new Map<string, LimitRecord>();
  /** Carte #823 — état pour `/api/health` : dernière entrée en pause sans trace durable. */
  lockTraceDegradedSince: number | null = null;
  lockTraceFailures = 0;
  lockTraceLastError: string | null = null;

  constructor(readonly store: AuthLimitStore, private readonly clock: () => number = Date.now) {}

  /** État lu, complété par les pauses tenues en mémoire encore actives (carte #823). */
  private withHeldLocks(recs: Map<string, LimitRecord>, keys: string[], now: number): Map<string, LimitRecord> {
    if (this.heldLocks.size === 0) return recs;
    for (const k of keys) {
      const held = this.heldLocks.get(k);
      if (!held) continue;
      if (remainingLockMs(held, now) === 0) { this.heldLocks.delete(k); continue; }
      if (remainingLockMs(held, now) > remainingLockMs(recs.get(k), now)) recs.set(k, { ...held });
    }
    return recs;
  }

  private holdLock(key: string, rec: LimitRecord, now: number): void {
    if (this.heldLocks.size >= 10_000) {
      for (const [k, r] of this.heldLocks) if (remainingLockMs(r, now) === 0) this.heldLocks.delete(k);
    }
    const cur = this.heldLocks.get(key);
    if (!cur || (rec.lockedUntil ?? 0) > (cur.lockedUntil ?? 0)) this.heldLocks.set(key, { ...rec });
  }

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
    const keys = entries.map((e) => e.key);
    const recs = this.withHeldLocks(await this.store.read(keys), keys, now);
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
   * Carte #823 — compte un échec sur chaque clé dans UNE transaction du magasin
   * partagé. Si la tentative pose un verrou, `writeTrace` est exécutée dans la
   * même transaction, avec la durée calculée : pause et trace sont validées
   * ensemble (`lockTrace: 'committed'`), une seule trace par entrée en pause.
   * Sans verrou posé (tentative ordinaire ou pause déjà en cours), `writeTrace`
   * n'est pas appelée.
   *
   * Ne lève jamais et ne laisse jamais tomber la pause : si la base partagée ne
   * valide pas (trace refusée, base indisponible), le verrou calculé est tenu
   * en mémoire par l'instance et `lockTrace` vaut `'not_durable'` — aucune
   * trace durable n'existe alors en base, l'appelant doit le signaler.
   */
  async recordFailureWithLockTrace(
    entries: LimitEntry[],
    writeTrace: (tx: AuthLimitTx, lock: LockTraceContext) => Promise<void>,
  ): Promise<TracedLimitDecision> {
    const now = this.clock();
    const keys = entries.map((e) => e.key);
    type Run = { lockedNow: boolean; retry: number; blockedKey: string | null; locks: Map<string, LimitRecord> };
    const runs: Run[] = [];
    const fn = (recs: Map<string, LimitRecord>): Map<string, LimitRecord> => {
      const cur = this.withHeldLocks(recs, keys, now);
      const run: Run = { lockedNow: false, retry: 0, blockedKey: null, locks: new Map() };
      const writes = new Map<string, LimitRecord>();
      for (const e of entries) {
        const before = cur.get(e.key) ?? null;
        const r = applyHit(before, e.policy, now);
        if (r.record !== before) writes.set(e.key, r.record);
        if (r.lockedNow) {
          run.lockedNow = true;
          run.locks.set(e.key, r.record);
          const s = Math.ceil(remainingLockMs(r.record, now) / 1000);
          if (s > run.retry) { run.retry = s; run.blockedKey = e.key; }
        }
      }
      runs.push(run);
      return writes;
    };
    const beforeCommit = async (tx: AuthLimitTx): Promise<void> => {
      const run = runs[runs.length - 1];
      if (run?.lockedNow && run.blockedKey) await writeTrace(tx, { retryAfterSeconds: run.retry, blockedKey: run.blockedKey });
    };

    let commit: LimitCommit = 'memory';
    let error: string | null = null;
    try {
      if (this.store.updateMany) {
        commit = await this.store.updateMany(keys, fn, beforeCommit);
      } else {
        // Magasin sans transaction groupée (injecté par un test) : mêmes règles, clé par clé.
        const cur = await this.store.read(keys);
        for (const [k, r] of fn(cur)) await this.store.update(k, () => r);
      }
    } catch (e) {
      error = errorSummary(e);
    }

    if (commit === 'shared') {
      const run = runs[runs.length - 1];
      if (run.lockedNow) { this.lockTraceDegradedSince = null; this.lockTraceLastError = null; }
      return {
        allowed: !run.lockedNow, retryAfterSeconds: run.retry, blockedKey: run.blockedKey, lockedNow: run.lockedNow,
        lockTrace: run.lockedNow ? 'committed' : 'none', lockTraceError: null,
      };
    }

    // Rien n'a été validé dans la base partagée. Tout verrou CALCULÉ — à partir
    // de l'état partagé (transaction annulée) ou de la mémoire — est tenu par
    // l'instance : la pause s'applique même si la trace n'a pas pu être écrite.
    let lockedNow = false;
    let retry = 0;
    let blockedKey: string | null = null;
    for (const run of runs) {
      if (!run.lockedNow) continue;
      lockedNow = true;
      for (const [k, rec] of run.locks) this.holdLock(k, rec, now);
      if (run.retry > retry) { retry = run.retry; blockedKey = run.blockedKey; }
    }
    if (lockedNow) {
      // Le magasin à repli absorbe l'erreur de la base partagée : elle est relue ici.
      const absorbed = (this.store as unknown as { lastError?: unknown }).lastError;
      if (error === null && typeof absorbed === 'string') error = absorbed;
      this.lockTraceDegradedSince ??= Date.now();
      this.lockTraceFailures += 1;
      this.lockTraceLastError = error;
    }
    return {
      allowed: !lockedNow, retryAfterSeconds: retry, blockedKey, lockedNow,
      lockTrace: lockedNow ? 'not_durable' : 'none', lockTraceError: lockedNow ? error : null,
    };
  }

  /**
   * Chaque DEMANDE compte (parcours d'e-mail) : refus si une clé est
   * verrouillée ; sinon la demande est comptée sur toutes les clés et
   * admise (la demande qui atteint le plafond passe ; la suivante est refusée).
   */
  async consume(entries: LimitEntry[]): Promise<LimitDecision> {
    const pre = await this.check(entries);
    if (!pre.allowed) return pre;
    // Correctif 113 (CI du 06/11, L53A PO-Q21) : le verrou est RE-VÉRIFIÉ dans la mise à jour
    // (ligne verrouillée, `FOR UPDATE`) — deux demandes simultanées ne passent plus toutes deux
    // entre la lecture et l'écriture (deux e-mails « compte existant » envoyés dans l'heure).
    const now = this.clock();
    let lockedNow = false;
    let refused: LimitDecision | null = null;
    for (const e of entries) {
      await this.store.update(e.key, (cur) => {
        const ms = remainingLockMs(cur ?? undefined, now);
        if (ms > 0 && cur) {
          if (!refused || Math.ceil(ms / 1000) > refused.retryAfterSeconds) {
            refused = { allowed: false, retryAfterSeconds: Math.ceil(ms / 1000), blockedKey: e.key, lockedNow: false };
          }
          return cur;
        }
        const r = applyHit(cur, e.policy, now);
        if (r.lockedNow) lockedNow = true;
        return r.record;
      });
    }
    if (refused) return refused;
    return { ...ALLOWED, lockedNow };
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
export function limitKey(
  flow: 'login' | 'forgot' | 'resend' | 'reset' | 'security-email' | 'reauth' | 'signup' | 'oauth' | 'activation' | 'email-change' | 'mfa',
  kind: 'ip' | 'acct' | 'dev' | 'pair' | 'acctu' | 'user',
  value: string,
): string {
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
export function authRateLimiterHealth(): {
  mode: 'shared' | 'memory-fallback' | 'not_used'; degradedSince: string | null; lastError: string | null;
  /** Carte #823 : la dernière entrée en pause de cette instance n'a pas de trace durable (depuis quand). */
  lockTraceDegradedSince: string | null; lockTraceFailures: number; lockTraceLastError: string | null;
} {
  const trace = {
    lockTraceDegradedSince: instance?.lockTraceDegradedSince ? new Date(instance.lockTraceDegradedSince).toISOString() : null,
    lockTraceFailures: instance?.lockTraceFailures ?? 0,
    lockTraceLastError: instance?.lockTraceLastError ?? null,
  };
  if (!sharedStore) return { mode: 'not_used', degradedSince: null, lastError: null, ...trace };
  return {
    mode: sharedStore.degradedSince ? 'memory-fallback' : 'shared',
    degradedSince: sharedStore.degradedSince ? new Date(sharedStore.degradedSince).toISOString() : null,
    lastError: sharedStore.lastError,
    ...trace,
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
