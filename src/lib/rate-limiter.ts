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

  constructor() {
    // Configurable via env var, default 10 requests per minute
    this.maxRequests = parseInt(process.env.FILE_PRESIGN_RATE_LIMIT || '10', 10);
    this.windowMs = 60 * 1000; // 1 minute

    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
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

// ─────────────────────────────────────────────────────────────────────────────
// Auth rate limiter — sliding window, 5 tentatives / 15 minutes par IP
// ─────────────────────────────────────────────────────────────────────────────

interface SlidingWindowEntry {
  timestamps: number[];
}

const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 min

const authStore = new Map<string, SlidingWindowEntry>();

// Nettoyage périodique (toutes les 5 min, non bloquant)
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authStore.entries()) {
    entry.timestamps = entry.timestamps.filter((ts) => now - ts < AUTH_WINDOW_MS);
    if (entry.timestamps.length === 0) authStore.delete(key);
  }
}, 5 * 60 * 1000);

// Ne pas bloquer le processus Node en mode test / serverless
if (typeof cleanupTimer === 'object' && cleanupTimer !== null && 'unref' in cleanupTimer) {
  (cleanupTimer as unknown as { unref: () => void }).unref();
}

export interface AuthRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
}

/**
 * Vérifie + enregistre une tentative de login pour la clé IP donnée.
 */
export function checkAuthRateLimit(ip: string): AuthRateLimitResult {
  const now = Date.now();
  const entry = authStore.get(ip) ?? { timestamps: [] };

  // Supprimer les tentatives hors de la fenêtre glissante
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < AUTH_WINDOW_MS);

  if (entry.timestamps.length >= AUTH_MAX_ATTEMPTS) {
    const oldest = entry.timestamps[0];
    const retryAfterSeconds = Math.ceil((AUTH_WINDOW_MS - (now - oldest)) / 1000);
    authStore.set(ip, entry);
    return { allowed: false, remaining: 0, retryAfterSeconds, limit: AUTH_MAX_ATTEMPTS };
  }

  entry.timestamps.push(now);
  authStore.set(ip, entry);

  return {
    allowed: true,
    remaining: AUTH_MAX_ATTEMPTS - entry.timestamps.length,
    retryAfterSeconds: 0,
    limit: AUTH_MAX_ATTEMPTS,
  };
}

/**
 * Réinitialise le compteur auth pour une IP (appelé après login réussi)
 */
export function resetAuthRateLimit(ip: string): void {
  authStore.delete(ip);
}

/**
 * Extrait l'IP cliente réelle depuis les headers Next.js (supporte reverse-proxies)
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    'unknown'
  );
}
