import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/auth/client-ip';
import {
  AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, normalizeEmail, rateLimitBody,
} from '@/lib/auth/auth-rate-limit';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { RESEND_VERIFICATION_NEUTRAL_MESSAGE } from '@/lib/auth/auth-messages';
import { resendVerification } from '@/services/auth/resend-verification.service';

/**
 * Route pour renvoyer l'email de vérification
 *
 * Body: { email: string }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 37 — C3 / C4 (CDC 18 §11.2 « renvoi possible avec réponse neutre », §33)
 *
 * Avant, trois réponses distinctes : adresse inconnue (« Si cet email
 * existe… »), compte déjà vérifié (« Ce compte est déjà vérifié »,
 * `alreadyVerified: true`), compte en attente (« Un nouveau lien… », ou 500
 * avec la cause de l'échec d'envoi) — et un temps de réponse plus long quand
 * un e-mail partait. Chacune révélait l'existence et l'état d'un compte.
 *
 * Désormais : réponse unique (200, même corps), indépendante du compte ; la
 * recherche et l'envoi s'exécutent après la réponse. Les causes d'échec
 * d'envoi (gabarit absent, e-mails désactivés, clé du fournisseur) vont au
 * journal du serveur — avec le remède — et non plus au client.
 * Limiteur partagé : 429 par IP ; au-delà du plafond par adresse, réponse
 * neutre identique sans envoi.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function POST(request: NextRequest) {
  let email: unknown;
  try {
    const body = await request.json();
    email = body?.email;
  } catch {
    email = undefined;
  }

  if (!email || typeof email !== 'string') {
    return NextResponse.json(
      { error: 'Email requis' },
      { status: 400 }
    );
  }

  try {
    const normalized = normalizeEmail(email);
    if (authRateLimitEnabled()) {
      const limiter = getAuthRateLimiter();
      const ip = await limiter.consume([{ key: limitKey('resend', 'ip', getClientIp(request.headers)), policy: AUTH_LIMITS.resendIp }]);
      if (!ip.allowed) {
        return NextResponse.json(rateLimitBody(ip.retryAfterSeconds), {
          status: 429, headers: { 'Retry-After': String(ip.retryAfterSeconds) },
        });
      }
      const account = await limiter.consume([{ key: limitKey('resend', 'acct', normalized), policy: AUTH_LIMITS.resendAccount }]);
      if (!account.allowed) return neutral();
    }

    runDetached('renvoi de vérification', () => resendVerification(normalized));
    return neutral();
  } catch (error) {
    console.error('Resend verification error:', (error as Error)?.message ?? error);
    return neutral();
  }
}

function neutral() {
  return NextResponse.json({ success: true, message: RESEND_VERIFICATION_NEUTRAL_MESSAGE });
}
