/**
 * Limitation de débit des demandes de génération (création et relance) :
 * par utilisateur, en mémoire de l'instance (`exportGenerationRateLimiter`).
 * Le plafond DURABLE est celui des générations actives par compte
 * (`MAX_ACTIVE_PER_ACCOUNT`, contrôlé en base à la mise en file).
 */

import { NextResponse } from 'next/server';
import { exportGenerationRateLimiter } from '@/lib/rate-limiter';

export const RATE_LIMITED_MESSAGE = 'Trop de demandes de génération en peu de temps. Patientez une minute avant de réessayer.';

/** Réponse 429 si l'utilisateur a dépassé son quota, sinon `null`. */
export function exportRateLimitResponse(userId: number): NextResponse | null {
  const r = exportGenerationRateLimiter.check(`export-generation:${userId}`);
  if (r.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: 'RATE_LIMITED', code: 'RATE_LIMITED', message: RATE_LIMITED_MESSAGE, retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}
