import { NextRequest, NextResponse } from 'next/server';
import { startPasswordReset } from '@/services/auth/password-reset.service';
import { getClientIp } from '@/lib/auth/client-ip';
import {
  AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, normalizeEmail, rateLimitBody,
} from '@/lib/auth/auth-rate-limit';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { FORGOT_PASSWORD_NEUTRAL_MESSAGE } from '@/lib/auth/auth-messages';

/**
 * Route pour demander un reset de mot de passe
 *
 * Body: { email: string }
 *
 * La logique (jeton signé, e-mail `PASSWORD_RESET`) vit dans
 * `services/auth/password-reset.service.ts`, partagée avec l'action
 * administrateur « Réinitialiser le mot de passe » (CDC BO USR-A07) : les deux
 * déclencheurs suivent strictement le même parcours.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 37 — C3 / C4 (CDC 18 §10.4, §33)
 *
 * Avant : adresse inconnue → 200 immédiat ; adresse connue → envoi ATTENDU
 * (≈ quelques centaines de ms de plus), et 500 « Erreur lors de l'envoi » en
 * cas d'échec du fournisseur — deux façons de savoir qu'un compte existe.
 * Désormais la réponse est toujours la même (200, même corps) et ne dépend
 * que de la requête : la recherche du compte et l'envoi s'exécutent après la
 * réponse (échecs journalisés). Limiteur partagé : 429 par IP (ne dit rien
 * d'un compte) ; au-delà du plafond par adresse, réponse neutre identique,
 * sans envoi.
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
      const ip = await limiter.consume([{ key: limitKey('forgot', 'ip', getClientIp(request.headers)), policy: AUTH_LIMITS.forgotIp }]);
      if (!ip.allowed) {
        return NextResponse.json(rateLimitBody(ip.retryAfterSeconds), {
          status: 429, headers: { 'Retry-After': String(ip.retryAfterSeconds) },
        });
      }
      const account = await limiter.consume([{ key: limitKey('forgot', 'acct', normalized), policy: AUTH_LIMITS.forgotAccount }]);
      // Plafond par adresse atteint : réponse neutre IDENTIQUE, aucun envoi.
      if (!account.allowed) return neutral();
    }

    runDetached('mot de passe oublié', async () => {
      const result = await startPasswordReset(normalized);
      if (result.status === 'send_failed') {
        console.error('[forgot-password] envoi de l’e-mail de réinitialisation en échec :', result.error ?? 'cause inconnue');
      }
    });
    return neutral();
  } catch (error) {
    // Même pour une erreur interne, rien qui distingue un compte d'un autre.
    console.error('Forgot password error:', (error as Error)?.message ?? error);
    return neutral();
  }
}

function neutral() {
  return NextResponse.json({ success: true, message: FORGOT_PASSWORD_NEUTRAL_MESSAGE });
}
