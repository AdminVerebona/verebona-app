import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcrypt';
import { validatePassword, getPasswordValidationError } from '@/lib/auth/password';
import { emit } from '@/lib/notifications';
import { revokeAllUserSessions } from '@/db';
import { serverCacheDelete } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '@/lib/auth/session-cutoff';
import { verifyPasswordResetToken, consumePasswordResetToken } from '@/services/auth/password-reset.service';
import { getClientIp } from '@/lib/auth/client-ip';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, normalizeEmail, rateLimitBody } from '@/lib/auth/auth-rate-limit';
import { passwordResetReleaseKeys } from '@/lib/auth/login-throttle';
import { rememberTrustedDevice } from '@/lib/auth/device-trust';
import { logUserActivity } from '@/lib/audit-logger';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Route pour réinitialiser le mot de passe avec un token
 * 
 * Body: { token: string, newPassword: string }
 *
 * Lot 37 (C4, CDC 18 §33) : limiteur partagé — demandes par IP réelle (429).
 * Pas de verrou « par compte » ici : le compte n'est désigné que par le
 * lien lui-même, non authentifié — n'importe qui pourrait fabriquer des
 * liens faux au nom d'un utilisateur et l'empêcher de réinitialiser son mot
 * de passe. La signature HMAC-SHA256 du lien rend la force brute vaine ; le
 * plafond par IP borne le bruit.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, newPassword } = body;
    
    if (!token || !newPassword) {
      return NextResponse.json(
        { error: 'Token et nouveau mot de passe requis' },
        { status: 400 }
      );
    }
    
    // Valider le nouveau mot de passe
    if (!validatePassword(newPassword)) {
      return NextResponse.json(
        getPasswordValidationError(),
        { status: 400 }
      );
    }
    
    // Jeton SIGNÉ et à usage unique (voir `services/auth/password-reset.service.ts`) :
    // l'ancien format `base64(email:horodatage)` permettait à quiconque de
    // fabriquer un lien valide pour n'importe quelle adresse.
    if (typeof token !== 'string') {
      return NextResponse.json({ error: 'Token invalide', code: 'INVALID_TOKEN' }, { status: 400 });
    }

    if (authRateLimitEnabled()) {
      const ip = await getAuthRateLimiter().consume([
        { key: limitKey('reset', 'ip', getClientIp(request.headers)), policy: AUTH_LIMITS.resetIp },
      ]);
      if (!ip.allowed) {
        return NextResponse.json(rateLimitBody(ip.retryAfterSeconds), {
          status: 429, headers: { 'Retry-After': String(ip.retryAfterSeconds) },
        });
      }
    }

    const check = await verifyPasswordResetToken(token);
    if (!check.ok) {
      return NextResponse.json(
        check.code === 'TOKEN_EXPIRED'
          ? { error: 'Token expiré', code: 'TOKEN_EXPIRED' }
          : { error: 'Token invalide', code: 'INVALID_TOKEN' },
        { status: 400 }
      );
    }

    // Hasher le nouveau mot de passe AVANT l'écriture conditionnelle : la
    // fenêtre entre vérification et écriture n'a plus d'importance, c'est
    // l'UPDATE conditionnel qui tranche (usage unique même en concurrence).
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const consumed = await consumePasswordResetToken(check.userId, check.passwordHash, passwordHash);
    if (!consumed) {
      // Mot de passe déjà changé entre-temps (lien déjà utilisé, requête
      // concurrente) ou utilisateur disparu : le jeton n'est plus valable.
      return NextResponse.json({ error: 'Token invalide', code: 'INVALID_TOKEN' }, { status: 400 });
    }
    const user = { id: check.userId };

    // Réinitialisation = même risque qu'un changement : toutes les sessions
    // existantes (y compris celle d'un éventuel intrus) sont révoquées.
    await revokeAllUserSessions(user.id, 'PASSWORD_RESET');
    serverCacheDelete(sessionCutoffCacheKey(user.id));

    // Événement de sécurité obligatoire (cloche + email, CDC §7.7).
    try {
      await emit({
        type: 'PASSWORD_RESET_COMPLETED',
        recipientUserIds: [user.id],
        entityType: 'user',
        entityId: user.id,
        payload: {},
        // Une réinitialisation par occurrence (l'horodatage garantit l'unicité).
        dedupeKey: `security:password-reset:${user.id}:${Date.now()}`,
      });
    } catch (err) {
      console.error('[reset-password] emit PASSWORD_RESET_COMPLETED échoué:', err);
    }

    const response = NextResponse.json({
      success: true,
      message: 'Mot de passe réinitialisé avec succès'
    });

    // ══════════════════════════════════════════════════════════════════════
    // LOT 53A — D1 : la réinitialisation est la VÉRIFICATION SUPPLÉMENTAIRE
    // du titulaire pendant une attaque (lien reçu par e-mail = preuve de
    // contrôle de la boîte). Elle lève les pauses de connexion de l'adresse
    // (toutes origines, et depuis cette IP) et fait reconnaître ce
    // navigateur pour ce compte. Jamais bloquant : un échec est journalisé.
    // ══════════════════════════════════════════════════════════════════════
    try {
      const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)).limit(1);
      const identifier = normalizeEmail(row?.email);
      if (identifier) {
        if (authRateLimitEnabled()) {
          const limiter = getAuthRateLimiter();
          for (const key of passwordResetReleaseKeys(identifier, getClientIp(request.headers))) await limiter.reset(key);
        }
        rememberTrustedDevice(request, response, identifier);
        void logUserActivity({
          activityType: 'PASSWORD_RESET_COMPLETED',
          userId: user.id,
          userEmail: row?.email ?? '',
          details: { sessionsRevoked: true, loginThrottleReleased: true },
          request,
        });
      }
    } catch (e) {
      console.error('[reset-password] levée des pauses de connexion / appareil reconnu :', (e as Error)?.message);
    }

    return response;
    
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json(
      { error: 'Erreur interne du serveur' },
      { status: 500 }
    );
  }
}
