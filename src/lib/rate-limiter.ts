/**
 * In-memory rate limiter for file operations
 * Configurable via environment variable
 */

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private store: Map<string, RateLimitRecord> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(opts: { maxRequests?: number; windowMs?: number } = {}) {
    // Configurable via env var, default 10 requests per minute
    this.maxRequests = opts.maxRequests ?? parseInt(process.env.FILE_PRESIGN_RATE_LIMIT || '10', 10);
    this.windowMs = opts.windowMs ?? 60 * 1000; // 1 minute

    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref?.();
  }

  /**
   * Check if request is allowed for given key (typically userId)
   * Returns { allowed: boolean, remaining: number, resetAt: number }
   */
  check(key: string): { allowed: boolean; remaining: number; resetAt: number; limit: number } {
    const now = Date.now();
    const record = this.store.get(key);

    if (!record || now > record.resetAt) {
      // New window or expired
      const resetAt = now + this.windowMs;
      this.store.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetAt,
        limit: this.maxRequests,
      };
    }

    // Within window
    if (record.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: record.resetAt,
        limit: this.maxRequests,
      };
    }

    // Increment count
    record.count++;
    this.store.set(key, record);

    return {
      allowed: true,
      remaining: this.maxRequests - record.count,
      resetAt: record.resetAt,
      limit: this.maxRequests,
    };
  }

  /**
   * Remove expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      if (now > record.resetAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Reset rate limit for a specific key (for testing)
   */
  reset(key: string): void {
    this.store.delete(key);
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

/**
 * Demandes de génération d'exports (POST création / relance) : par
 * utilisateur, `EXPORTS_POST_RATE_LIMIT` par minute (défaut 6). Complète le
 * plafond durable de générations actives par compte (exports V12).
 */
export const exportGenerationRateLimiter = new RateLimiter({
  maxRequests: Math.max(1, parseInt(process.env.EXPORTS_POST_RATE_LIMIT || '6', 10) || 6),
  windowMs: 60 * 1000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Lot 53A : l'ancien limiteur d'authentification EN MÉMOIRE (5 / 15 min par
// clé, utilisé par la clôture de compte) est retiré. Toute limitation
// d'authentification passe par les compteurs PARTAGÉS en base
// (`lib/auth/auth-rate-limit.ts`) : connexion (`login-throttle.ts`),
// réauthentification (`reauth-throttle.ts`), parcours d'e-mail (CDC 18 §32,
// §33, SEC-04).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IP cliente réelle derrière le routeur Scalingo (lot 37, C4) : lecture de
 * droite à gauche de `x-forwarded-for` — voir `lib/auth/client-ip.ts`.
 * L'ancienne version lisait la valeur la plus à gauche, fournie par le client.
 */
export { getClientIp } from './auth/client-ip';
