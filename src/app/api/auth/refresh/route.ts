import { NextRequest, NextResponse } from 'next/server';
import { hasActiveSubscriptionStatus } from '@/lib/billing/subscription-status';
import { db, getRevokedTokenInfo, hashToken, getUserSessionCutoff, isIssuedBefore, revokeAllUserSessions } from '@/db';
import { clearSessionCookies, setSessionCookies } from '@/lib/auth/session-tokens';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { verifyRefreshToken, generateSessionTokens, newSessionId, type JWTPayload } from '@/lib/jwt';
import { ApiErrors, apiError } from '@/lib/api-errors';
import { AccountService } from '@/services/account-service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { revokeTokenOnce } from '@/db';
import { logUserActivity } from '@/lib/audit-logger';
import { resolveSessionAccount, accountSuspendedResponse } from '@/lib/auth/account-suspension';
import { serverCacheDelete } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '@/lib/auth/session-cutoff';
import { classifyRefreshReplay, REFRESH_REUSE_GRACE_MS } from '@/lib/auth/refresh-replay';
import { REFRESH_TOKEN_TTL_S } from '@/lib/auth/token-lifetimes';

const REFRESH_TTL_MS = REFRESH_TOKEN_TTL_S * 1000;

/**
 * Renouvellement de session (rotation du jeton de renouvellement).
 *
 * Le jeton est lu EXCLUSIVEMENT depuis le cookie HttpOnly (CDC §7.2), vérifié
 * comme jeton de RENOUVELLEMENT (clé et revendications propres — lot 37, C1),
 * puis consommé atomiquement avant l'émission de la paire suivante, qui
 * conserve la famille de session (`sid`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 37 — C2 : RÉUTILISATION D'UN JETON DÉJÀ TOURNÉ (CDC 18 §19.3)
 *
 * Avant : seulement journalisée. Désormais (`lib/auth/refresh-replay.ts`) :
 *   · jeton tourné il y a MOINS de REFRESH_REUSE_GRACE_MS (30 s) : requêtes
 *     concurrentes légitimes (onglets, application mobile qui renouvelle en
 *     parallèle). Réponse 200 `{ rotation: 'concurrent' }` SANS nouveau
 *     cookie : la requête gagnante a déjà déposé la paire suivante dans le
 *     même navigateur. Rien n'est accordé — aucune seconde session valide ;
 *   · au-delà : INCIDENT. Toutes les sessions de l'utilisateur sont révoquées
 *     (borne globale : jetons d'accès et de renouvellement émis avant,
 *     successeur volé compris), cookies effacés, 401 SESSION_REVOKED,
 *     journal AUTH_TOKEN_REUSE_DETECTED ;
 *   · jeton révoqué par une DÉCONNEXION (aucun successeur) ou révoqué avant
 *     le lot 37 (motif inconnu) : refus et journal, sans révocation globale.
 *
 * LOT 38 (volet B) : un e-mail « appareils déconnectés par précaution »
 * suivait la révocation globale. LOT 79C (décision PO) : e-mail SUPPRIMÉ,
 * sans notification de remplacement. La protection (révocation globale,
 * cookies effacés, 401) et le journal AUTH_TOKEN_REUSE_DETECTED sont
 * INCHANGÉS ; le journal porte en plus l'âge de la rotation (`rotationAgeMs`)
 * pour le diagnostic des déconnexions
 * (docs/exploitation/sessions-deconnexions-diagnostic.md).
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get('refresh_token')?.value;

    if (!refreshToken) {
      return ApiErrors.authRequired('No refresh token provided');
    }

    // Jeton de RENOUVELLEMENT uniquement : un jeton d'accès est refusé ici
    // comme un jeton de renouvellement l'est partout ailleurs.
    const payload = await verifyRefreshToken(refreshToken);
    if (!payload) {
      return ApiErrors.invalidToken('Invalid or expired refresh token');
    }

    const tokenHash = await hashToken(refreshToken);
    const revoked = await getRevokedTokenInfo(tokenHash);
    if (revoked) {
      return handleReplay(request, payload, revoked);
    }

    // Révocation globale (changement ou réinitialisation du mot de passe,
    // incident de réutilisation) : un jeton émis avant ne peut plus ouvrir de
    // nouvelle session. Une reconnexion est exigée, cookies effacés.
    const cutoff = await getUserSessionCutoff(payload.userId);
    if (isIssuedBefore(payload, cutoff)) {
      const refus = ApiErrors.invalidToken('Session revoked, please log in again');
      clearSessionCookies(refus);
      return refus;
    }

    // Fetch fresh user data
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (!user) {
      return ApiErrors.authRequired('User not found');
    }

    // Check account status
    if (user.status === 'SUSPENDED') {
      return ApiErrors.accountSuspended();
    }

    if (!user.isActive || user.status === 'DELETED') {
      return ApiErrors.accountInactive();
    }

    // CDC BO ACC-A02 : pas de nouvelle session sur un compte suspendu. La
    // suspension révoque déjà les jetons émis ; ce contrôle couvre aussi un
    // jeton émis entre la révocation et la bascule du drapeau. Cookies
    // effacés : le client revient à l'écran de connexion.
    //
    // C'est le compte DE LA SESSION (`currentAccountId` du jeton) qui est
    // contrôlé — et non un compte « par défaut » recalculé, qui pouvait
    // différer de celui réellement utilisé. Règles complètes (dont le
    // maintien de l'accès BO des administrateurs) : lib/auth/account-suspension.
    const resolution = resolveSessionAccount(
      await AccountService.getUserSessionAccounts(user.id),
      { role: user.role, preferredAccountId: payload.currentAccountId ?? null },
    );
    if (!resolution.allowed) {
      const refus = accountSuspendedResponse();
      clearSessionCookies(refus);
      return refus;
    }
    const defaultAccount = resolution.account;

    // Indication informative du jeton, jamais une source de droits : un
    // impayé reste connectable sans « abonnement actif » (APP-FUNC-31).
    const isSubscribedOrTrialing = !!defaultAccount && hasActiveSubscriptionStatus(defaultAccount.subscriptionStatus);

    // ══════════════════════════════════════════════════════════════════════
    // CDC §5.5 — ROTATION : L'ANCIEN JETON EST INVALIDÉ D'ABORD
    //
    // Révocation bloquante et atomique (motif `rotated`) :
    //   - échec technique → 503, aucun nouveau cookie (le client réessaie
    //     sans se déconnecter) ;
    //   - jeton déjà consommé par une requête concurrente → traité comme un
    //     rejeu (fenêtre de grâce ou incident), aucune seconde session.
    // ══════════════════════════════════════════════════════════════════════
    let consomme: boolean;
    try {
      const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + REFRESH_TTL_MS);
      consomme = await revokeTokenOnce(tokenHash, payload.userId, expiresAt, 'rotated');
    } catch (revokeError) {
      console.error('[refresh] revocation de l\'ancien jeton impossible — renouvellement refusé:', revokeError);
      return NextResponse.json(
        { error: 'Service temporairement indisponible', code: 'SERVICE_UNAVAILABLE' },
        { status: 503 },
      );
    }
    if (!consomme) {
      const info = await getRevokedTokenInfo(tokenHash).catch(() => null);
      return handleReplay(request, payload, info ?? { revokedAt: new Date(), reason: 'rotated' });
    }

    // Famille conservée ; un jeton historique (sans `sid`) en reçoit une.
    const sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : newSessionId();
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await generateSessionTokens({
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      planType: user.planType as PlanType,
      status: user.status as UserStatus,
      currentAccountId: defaultAccount?.id,
      hasActiveAccount: isSubscribedOrTrialing,
    }, sid);

    // Le nouveau jeton est forcément distinct de l'ancien (jti aléatoire) ;
    // garde-fou si ce n'était pas le cas, plutôt que déposer un jeton révoqué.
    if (newRefreshToken === refreshToken) {
      return ApiErrors.internalError('REFRESH_ROTATION_ERROR');
    }

    void logUserActivity({
      activityType: 'AUTH_TOKEN_REFRESH',
      userId: payload.userId,
      userEmail: user.email,
      details: { sid },
      request,
    });

    // CDC §10.1 : aucun jeton dans le corps de reponse. Les nouveaux jetons
    // sont deposes uniquement en cookies HttpOnly ci-dessous.
    const response = NextResponse.json({
      success: true,
      message: 'Token refreshed successfully',
    });

    // Durées des cookies = durées des JWT (source unique, lot 53A).
    setSessionCookies(response, { accessToken: newAccessToken, refreshToken: newRefreshToken });

    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    const isDbError = msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')
      || msg.includes('connection') || msg.includes('timeout') || msg.includes('ENOTFOUND');
    if (isDbError) {
      return NextResponse.json(
        { error: 'Service temporairement indisponible', code: 'SERVICE_UNAVAILABLE' },
        { status: 503 }
      );
    }
    return ApiErrors.internalError('REFRESH_ERROR');
  }
}

/** Présentation d'un jeton déjà révoqué : grâce, incident ou simple refus. */
async function handleReplay(
  request: NextRequest,
  payload: JWTPayload,
  revoked: { revokedAt: Date; reason: 'rotated' | 'logout' | null },
): Promise<NextResponse> {
  const verdict = classifyRefreshReplay(revoked, Date.now());

  if (verdict === 'concurrent') {
    // Rien n'est émis : la requête gagnante a déjà déposé la paire suivante.
    void logUserActivity({
      activityType: 'AUTH_TOKEN_REFRESH',
      userId: payload.userId,
      userEmail: '',
      details: { concurrent: true, graceMs: REFRESH_REUSE_GRACE_MS, sid: payload.sid ?? null },
      request,
    });
    return NextResponse.json(
      { success: true, rotation: 'concurrent', message: 'Session already renewed by a concurrent request' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (verdict === 'reuse') {
    // Incident de session (CDC 18 §19.3) : toutes les sessions révoquées.
    let revokedAll = true;
    try {
      await revokeAllUserSessions(payload.userId, 'REFRESH_TOKEN_REUSE');
      serverCacheDelete(sessionCutoffCacheKey(payload.userId));
    } catch (e) {
      revokedAll = false;
      console.error('[refresh] incident de réutilisation : révocation globale impossible :', (e as Error)?.message);
    }
    void logUserActivity({
      activityType: 'AUTH_TOKEN_REUSE_DETECTED',
      userId: payload.userId,
      userEmail: '',
      details: {
        severity: 'security_incident',
        sid: payload.sid ?? null,
        rotatedAt: revoked.revokedAt.toISOString(),
        // Lot 79C (diagnostic) : délai entre la rotation et la présentation
        // de l'ancien jeton. Ne qualifie rien à lui seul (intrusion ou
        // réponse perdue) : voir sessions-deconnexions-diagnostic.md.
        rotationAgeMs: Math.max(0, Date.now() - revoked.revokedAt.getTime()),
        sessionsRevoked: revokedAll,
      },
      request,
    });
    // Lot 79C : plus d'e-mail « appareils déconnectés par précaution »
    // (SECURITY_SESSIONS_REVOKED supprimé) ; la protection ci-dessus reste.
    const refus = apiError(401, 'SESSION_REVOKED', 'Session revoked, please log in again');
    clearSessionCookies(refus);
    return refus;
  }

  // Jeton d'une session déjà terminée (déconnexion) ou motif inconnu.
  void logUserActivity({
    activityType: 'AUTH_TOKEN_REUSE_DETECTED',
    userId: payload.userId,
    userEmail: '',
    details: { severity: 'warning', kind: revoked.reason ?? 'legacy', sid: payload.sid ?? null },
    request,
  });
  // Cookies NON effacés (comportement antérieur) : ce navigateur peut déjà
  // détenir un jeton plus récent, qu'un effacement détruirait.
  return ApiErrors.invalidToken('Refresh token has been revoked');
}
