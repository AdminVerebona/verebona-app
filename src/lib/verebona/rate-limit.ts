/**
 * Limitation de débit de l'assistant — CDC §6.6, §31.10, §43 ; décision PO
 * D-J2 (lot 21) : limiteur PARTAGÉ en PostgreSQL.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PARTAGÉ ENTRE INSTANCES
 *
 * Le limiteur en mémoire multipliait le plafond par le nombre d'instances.
 * Les compteurs vivent désormais dans `verebona_rate_limit_counters`
 * (migration 0230, table UNLOGGED) : un compteur PAR MINUTE et par clé —
 * utilisateur, compte, adresse IP — par famille de routes (questions,
 * lectures, écritures par famille).
 *
 * UNE requête atomique par appel (CTE chaînées) : la clé utilisateur est
 * toujours comptée ; la clé compte ne l'est que si l'utilisateur passe, la
 * clé IP que si le compte passe. Un utilisateur au-delà de son plafond ne
 * consomme donc pas le quota de son compte. Les tentatives refusées restent
 * comptées sur la clé qui refuse ; le compteur repart à chaque minute.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NE BLOQUE JAMAIS SUR LA BASE
 *
 * Base indisponible ou lente (`SHARED_TIMEOUT_MS`, posé côté base par
 * `SET LOCAL statement_timeout` dans une transaction courte) : repli sur le
 * limiteur en mémoire du processus (fenêtre glissante, comme avant), alerte
 * dans les journaux (une fois par minute) et dans `/api/health`
 * (`rateLimiterHealth`). L'assistant n'est jamais refusé parce que le
 * compteur partagé est illisible.
 *
 * Purge : les fenêtres de plus de 10 minutes sont supprimées au fil de l'eau
 * (≈ 1 appel sur 200, hors du chemin de la réponse) et par la purge
 * quotidienne de l'assistant.
 *
 * Plafonds administrés dans le BO (D-J1, `assistant-settings.ts`) :
 * questions, lectures, écritures par utilisateur ; multiplicateurs par compte
 * (3 par défaut) et par adresse IP (5 par défaut).
 * ══════════════════════════════════════════════════════════════════════════
 */
export interface RateDecision { allowed: boolean; retryAfterMs: number; scope: 'user' | 'account' | 'ip' | null }

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly windowMs = 60_000) {}

  /** Enregistre la tentative si elle est permise. */
  take(key: string, limit: number, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: this.windowMs - (now - recent[0]) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

// ── Stockage partagé ────────────────────────────────────────────────────────

/**
 * Compteurs par minute. Les clés sont incrémentées DANS L'ORDRE, et chacune
 * seulement si la précédente reste sous son plafond (utilisateur, puis
 * compte, puis IP) : un utilisateur refusé ne consomme pas le quota de son
 * compte ni de son adresse. Rend la valeur de chaque clé incrémentée.
 */
export interface RateCounterStore {
  hit(entries: Array<{ key: string; limit: number }>): Promise<{ counts: Map<string, number>; resetMs: number }>;
  purge(): Promise<void>;
}

type SqlLike = {
  unsafe: (q: string, p?: never[]) => Promise<unknown>;
  begin: <T>(fn: (tx: { unsafe: (q: string, p?: never[]) => Promise<unknown> }) => Promise<T>) => Promise<T>;
};

/** Délai maximal accordé au compteur partagé (côté base) avant le repli en mémoire. */
export const SHARED_TIMEOUT_MS = 300;

/** Requête atomique unique : une CTE par clé, chaînée sur la précédente (pur, testé). */
export function sharedRateLimitSql(n: number): string {
  const ctes: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = `$${2 * i + 1}`;
    const condition = i === 0 ? '' : ` WHERE (SELECT hits FROM c${i - 1}) <= $${2 * i}::int`;
    ctes.push(`c${i} AS (
      INSERT INTO verebona_rate_limit_counters AS c (bucket_key, window_start, hits)
      SELECT ${k}::text, date_trunc('minute', now()), 1${condition}
      ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = c.hits + 1
      RETURNING hits)`);
  }
  const cols = Array.from({ length: n }, (_, i) => `(SELECT hits FROM c${i}) AS h${i}`).join(', ');
  return `WITH ${ctes.join(',\n')}
    SELECT ${cols},
           GREATEST(0, EXTRACT(EPOCH FROM (date_trunc('minute', now()) + interval '1 minute' - now())) * 1000)::int AS reset_ms`;
}

/**
 * Stockage PostgreSQL. Transaction courte avec `SET LOCAL statement_timeout`
 * (relecture lot 21) : au-delà de `timeoutMs`, c'est la BASE qui annule la
 * requête — rien ne continue de tourner ni de tenir une connexion.
 */
export function pgRateCounterStore(client?: SqlLike, timeoutMs = SHARED_TIMEOUT_MS): RateCounterStore {
  const sql = async (): Promise<SqlLike> => client ?? ((await import('@/db')).pgClient as unknown as SqlLike);
  return {
    async hit(entries) {
      const params: unknown[] = [];
      entries.forEach((e, i) => { params.push(e.key); if (i < entries.length - 1) params.push(e.limit); });
      const rows = (await (await sql()).begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(50, Math.floor(timeoutMs))}`);
        return tx.unsafe(sharedRateLimitSql(entries.length), params as never[]);
      })) as Array<Record<string, number | null>>;
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) throw new Error('compteurs partagés illisibles');
      const counts = new Map<string, number>();
      entries.forEach((e, i) => { if (row[`h${i}`] != null) counts.set(e.key, Number(row[`h${i}`])); });
      if (!counts.has(entries[0].key)) throw new Error('compteurs partagés incomplets');
      return { counts, resetMs: Number(row.reset_ms ?? 60_000) };
    },
    async purge() {
      await (await sql()).unsafe(`DELETE FROM verebona_rate_limit_counters WHERE window_start < now() - interval '10 minutes'`);
    },
  };
}

export interface RateEntry { key: string; limit: number; scope: 'user' | 'account' | 'ip' }

export interface RateLimiterHealth {
  mode: 'shared' | 'memory';
  /** Repli en mémoire en cours (base indisponible ou lente). */
  degraded: boolean;
  degradedSince: string | null;
  lastError: string | null;
  fallbacks: number;
}

export class SharedRateLimiter {
  private degradedSince: number | null = null;
  private lastError: string | null = null;
  private fallbacks = 0;
  private lastAlertAt = 0;

  constructor(
    private readonly store: RateCounterStore | null,
    private readonly memory = new SlidingWindowLimiter(),
    private readonly timeoutMs = SHARED_TIMEOUT_MS,
  ) {}

  async check(entries: RateEntry[], now = Date.now()): Promise<RateDecision> {
    if (this.store && entries.length > 0) {
      try {
        let timer: NodeJS.Timeout | undefined;
        const r = await Promise.race([
          this.store.hit(entries.map(({ key, limit }) => ({ key, limit }))),
          // Filet côté Node, au-delà du délai posé côté base.
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`délai de ${this.timeoutMs} ms dépassé`)), this.timeoutMs + 200);
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
        this.degradedSince = null;
        if (Math.random() < 1 / 200) this.store.purge().catch(() => undefined);
        // Clés incrémentées dans l'ordre : la première au-delà de son plafond
        // décide (les suivantes n'ont pas été comptées).
        for (const e of entries) {
          const n = r.counts.get(e.key);
          if (n === undefined || n > e.limit) return { allowed: false, retryAfterMs: Math.max(1000, r.resetMs), scope: e.scope };
        }
        return { allowed: true, retryAfterMs: 0, scope: null };
      } catch (e) {
        this.fallbacks += 1;
        this.lastError = (e as Error).message.slice(0, 200);
        if (this.degradedSince === null) this.degradedSince = Date.now();
        if (Date.now() - this.lastAlertAt > 60_000) {
          this.lastAlertAt = Date.now();
          console.error(`[verebona][débit] compteur partagé indisponible (${this.lastError}) — repli sur le limiteur en mémoire de l'instance.`);
        }
      }
    }
    for (const e of entries) {
      const t = this.memory.take(e.key, e.limit, now);
      if (!t.allowed) return { allowed: false, retryAfterMs: t.retryAfterMs, scope: e.scope };
    }
    return { allowed: true, retryAfterMs: 0, scope: null };
  }

  health(): RateLimiterHealth {
    return {
      mode: this.store ? 'shared' : 'memory',
      degraded: this.degradedSince !== null,
      degradedSince: this.degradedSince === null ? null : new Date(this.degradedSince).toISOString(),
      lastError: this.lastError,
      fallbacks: this.fallbacks,
    };
  }
}

// Tests unitaires : mémoire seule (aucune connexion), sauf limiteur injecté.
let limiter = new SharedRateLimiter(process.env.NODE_ENV === 'test' ? null : pgRateCounterStore());

/** Réservé aux tests : remplace le limiteur du processus. */
export function setAssistantRateLimiterForTests(l: SharedRateLimiter | null): void {
  limiter = l ?? new SharedRateLimiter(process.env.NODE_ENV === 'test' ? null : pgRateCounterStore());
}

/** État du limiteur de cette instance (`/api/health`, tableau de bord). */
export function rateLimiterHealth(): RateLimiterHealth {
  return limiter.health();
}

// ── Plafonds (administrés dans le BO, D-J1) ─────────────────────────────────

async function plafonds() {
  const { refreshAssistantSettings, effectiveSetting } = await import('@/services/verebona-assistant/config/assistant-settings');
  await refreshAssistantSettings();
  return {
    question: Number(effectiveSetting('rate_limit_per_minute')),
    read: Number(effectiveSetting('read_rate_limit_per_minute')),
    mutation: Number(effectiveSetting('mutation_rate_limit_per_minute')),
    account: Number(effectiveSetting('account_rate_multiplier')),
    ip: Number(effectiveSetting('ip_rate_multiplier')),
  };
}

function entries(prefix: string, userId: number, accountId: number, ip: string | null | undefined, perMinute: number, accountX: number, ipX: number): RateEntry[] {
  const out: RateEntry[] = [
    { key: `${prefix}:u:${userId}`, limit: perMinute, scope: 'user' },
    { key: `${prefix}:a:${accountId}`, limit: perMinute * accountX, scope: 'account' },
  ];
  if (ip && ip !== 'unknown') out.push({ key: `${prefix}:ip:${ip.slice(0, 64)}`, limit: perMinute * ipX, scope: 'ip' });
  return out;
}

/**
 * Routes qui écrivent sans poser de question (§27, §31.10) : avis, fils,
 * effacement, annulation, commandes. Quota propre à chaque famille.
 */
export type MutationBucket = 'feedback' | 'conversation' | 'cancel' | 'command' | 'usage';

export async function mutationRatePerMinute(): Promise<number> {
  return (await plafonds()).mutation;
}

export async function readRatePerMinute(): Promise<number> {
  return (await plafonds()).read;
}

export async function checkAssistantMutationRateLimit(
  userId: number, accountId: number, bucket: MutationBucket, ip?: string | null, perMinute?: number, now = Date.now(),
): Promise<RateDecision> {
  const p = await plafonds();
  return limiter.check(entries(`m:${bucket}`, userId, accountId, ip, perMinute ?? p.mutation, p.account, p.ip), now);
}

/**
 * Routes de LECTURE (§27) : explication, sources, historique, état d'une
 * demande, suggestions. Quota commun, large (120 / min par défaut).
 */
export async function checkAssistantReadRateLimit(
  userId: number, accountId: number, ip?: string | null, perMinute?: number, now = Date.now(),
): Promise<RateDecision> {
  const p = await plafonds();
  return limiter.check(entries('r', userId, accountId, ip, perMinute ?? p.read, p.account, p.ip), now);
}

/** Questions (§6.6 : 10 / min / utilisateur par défaut). */
export async function checkAssistantRateLimit(
  userId: number, accountId: number, perMinute?: number, now = Date.now(), ip?: string | null,
): Promise<RateDecision> {
  const p = await plafonds();
  return limiter.check(entries('q', userId, accountId, ip, perMinute ?? p.question, p.account, p.ip), now);
}
