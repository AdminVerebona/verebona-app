/**
 * Limitation de débit dédiée à l'assistant — CDC §6.6, §31.10, §43.
 *
 * La route utilisait le limiteur PARTAGÉ avec le téléversement de fichiers
 * (`FILE_PRESIGN_RATE_LIMIT`) : `VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE`
 * n'était jamais lu, et un envoi de fichiers consommait le quota des questions.
 *
 * Deux fenêtres glissantes d'une minute :
 *   · par utilisateur : `rateLimitPerMinute` (10 par défaut, §6.6) ;
 *   · par compte : 3 × cette valeur (un Duo, plusieurs onglets) — détection
 *     d'usage anormal sans gêner un usage normal.
 * Mémoire du processus : avec plusieurs instances, le plafond se multiplie
 * (limite connue, à porter sur un stockage partagé si l'hébergement évolue).
 */
export interface RateDecision { allowed: boolean; retryAfterMs: number; scope: 'user' | 'account' | null }

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

const limiter = new SlidingWindowLimiter();

/**
 * Routes qui écrivent sans poser de question (§27, §31.10) : avis, fils,
 * effacement, annulation, commandes. Quota propre à chaque famille (la
 * question garde le sien), 30 par minute et par utilisateur par défaut
 * (`VEREBONA_ASSISTANT_MUTATION_RATE_LIMIT_PER_MINUTE`), 3× par compte.
 */
export type MutationBucket = 'feedback' | 'conversation' | 'cancel' | 'command';

export function mutationRatePerMinute(): number {
  const n = Number(process.env.VEREBONA_ASSISTANT_MUTATION_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

export function checkAssistantMutationRateLimit(
  userId: number,
  accountId: number,
  bucket: MutationBucket,
  perMinute = mutationRatePerMinute(),
  now = Date.now(),
): RateDecision {
  const user = limiter.take(`m:${bucket}:u:${userId}`, perMinute, now);
  if (!user.allowed) return { allowed: false, retryAfterMs: user.retryAfterMs, scope: 'user' };
  const account = limiter.take(`m:${bucket}:a:${accountId}`, perMinute * 3, now);
  if (!account.allowed) return { allowed: false, retryAfterMs: account.retryAfterMs, scope: 'account' };
  return { allowed: true, retryAfterMs: 0, scope: null };
}

export function checkAssistantRateLimit(userId: number, accountId: number, perMinute: number, now = Date.now()): RateDecision {
  const user = limiter.take(`u:${userId}`, perMinute, now);
  if (!user.allowed) return { allowed: false, retryAfterMs: user.retryAfterMs, scope: 'user' };
  const account = limiter.take(`a:${accountId}`, perMinute * 3, now);
  if (!account.allowed) return { allowed: false, retryAfterMs: account.retryAfterMs, scope: 'account' };
  return { allowed: true, retryAfterMs: 0, scope: null };
}
