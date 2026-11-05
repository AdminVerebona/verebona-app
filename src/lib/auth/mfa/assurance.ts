/**
 * Niveau de preuve d'une session (lot 110B) — module PUR.
 *
 * Lu dans les revendications d'un jeton VÉRIFIÉ (accès ou renouvellement).
 * Tout jeton sans `aal: 2` explicite (jeton antérieur au lot, jeton
 * historique sans `kid`, valeur inattendue) vaut niveau 1 : fail closed.
 */
import type { TokenAssurance } from '@/lib/jwt';
import { AAL_MFA, AAL_PRIMARY } from './constants';

export interface AssuranceClaims { aal?: unknown; amr?: unknown; mfaAt?: unknown }

export function assuranceOf(payload: AssuranceClaims | null | undefined): TokenAssurance {
  if (!payload || payload.aal !== AAL_MFA) {
    const amr = Array.isArray(payload?.amr) ? (payload!.amr as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
    return { aal: AAL_PRIMARY, ...(amr?.length ? { amr } : {}) };
  }
  const amr = Array.isArray(payload.amr) ? (payload.amr as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return { aal: AAL_MFA, amr, ...(typeof payload.mfaAt === 'number' ? { mfaAt: payload.mfaAt } : {}) };
}

export function isStrongSession(payload: AssuranceClaims | null | undefined): boolean {
  return assuranceOf(payload).aal === AAL_MFA;
}

/** `amr` d'une méthode primaire (journal, jetons). */
export function primaryAmr(method: string | null | undefined): string {
  switch (method) {
    case 'password': return 'pwd';
    case 'google': return 'google';
    case 'apple': return 'apple';
    case 'email_link': return 'link';
    case 'recovery': return 'recovery';
    default: return 'other';
  }
}

/** Preuve forte : méthode primaire (s'il y en a une) + facteur. */
export function strongAssurance(primary: string | null, factor: 'passkey' | 'otp', now = Date.now()): TokenAssurance {
  const amr = [...(primary ? [primaryAmr(primary)] : []), factor];
  return { aal: AAL_MFA, amr: [...new Set(amr)], mfaAt: now };
}
