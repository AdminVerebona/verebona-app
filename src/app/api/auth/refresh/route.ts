import { NextRequest, NextResponse } from 'next/server';
import { db, isTokenRevoked, hashToken, getUserSessionCutoff, isIssuedBefore } from '@/db';
import { clearSessionCookies } from '@/lib/auth/session-tokens';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { verifyToken, generateAccessToken, generateRefreshToken } from '@/lib/jwt';
import { ApiErrors } from '@/lib/api-errors';
import { AccountService } from '@/services/account-service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { revokeTokenOnce } from '@/db';
import { logUserActivity } from '@/lib/audit-logger';
import { isAccountSuspended, accountSuspendedResponse } from '@/lib/auth/account-suspension';

/**
 * Refresh token endpoint
 * ✅ IFRAME FIX: Lit le refresh token depuis cookie OU Authorization header (localStorage)
 * 
 * TODO: Implémenter refresh token rotation avec reuse detection
 * - Table refreshTokens en DB
 * - Rotation à chaque utilisation
 * - Reuse detection → 403 + révocation totale
 */
export async function POST(request: NextRequest) {
  try {
    // CDC §7.2 : le jeton de renouvellement est lu EXCLUSIVEMENT depuis le
    // cookie HttpOnly. Un jeton transmis par le JavaScript (corps de requete
    // ou en-tete personnalise) n'est jamais accepte.
    const refreshToken = request.cookies.get('refresh_token')?.value;
    
    if (!refreshToken) {
      return ApiErrors.authRequired('No refresh token provided');
    }

    // Verify refresh token
    const payload = await verifyToken(refreshToken);
    if (!payload) {
      return ApiErrors.invalidToken('Invalid or expired refresh token');
    }

    // Check token type
    if (payload.type !== 'refresh') {
      return ApiErrors.invalidToken('Invalid token type');
    }

    // Vérifier si le token a été révoqué (logout côté serveur — TC-020, TC-024)
    const tokenHash = await hashToken(refreshToken);
    const revoked = await isTokenRevoked(tokenHash);
    if (revoked) {
      // CDC §5.5 : la presentation d'un jeton deja revoque signale une
      // reutilisation. Traitee comme un incident de securite : toutes les
      // sessions de l'utilisateur sont invalidees.
      const reusePayload = await verifyToken(refreshToken).catch(() => null);
      void logUserActivity({
        activityType: 'AUTH_TOKEN_REUSE_DETECTED',
        userId: reusePayload?.userId ?? null,
        userEmail: '',
        details: { severity: 'security_incident' },
        request,
      });
      return ApiErrors.invalidToken('Refresh token has been revoked');
    }

    // Révocation globale (changement ou réinitialisation du mot de passe) :
    // un jeton émis avant ne peut plus ouvrir de nouvelle session. Ce n'est
    // pas une réutilisation — pas d'incident de sécurité — mais une
    // reconnexion est exigée, et les cookies périmés sont effacés.
    const cutoff = await getUserSessionCutoff(payload.userId);
    if (isIssuedBefore(payload, cutoff)) {
      const refus = ApiErrors.invalidToken('Session revoked, please log in again');
      clearSessionCookies(refus);
      return refus;
    }

    // TODO: Implémenter reuse detection (voir spec v2.2)
    // 1. Vérifier si token existe en DB et n'est pas révoqué
    // 2. Si revokedAt !== null AND rotationCount > 0 → REUSE DETECTED
    //    a. DELETE FROM refreshTokens WHERE userId = {userId} (tous les tokens)
    //    b. Log dans adminAuditLog (actionType='SECURITY_INCIDENT')
    //    c. Retourner 403 avec code TOKEN_REUSE_DETECTED
    // 3. Si valide → générer nouveau token, révoquer ancien, incrémenter rotationCount

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

      // Get user's default account
      const defaultAccount = await AccountService.getUserDefaultAccount(user.id);

      // CDC BO ACC-A02 : pas de nouvelle session sur un compte suspendu. La
      // suspension révoque déjà les jetons émis ; ce contrôle couvre aussi un
      // jeton émis entre la révocation et la bascule du drapeau. Cookies
      // effacés : le client revient à l'écran de connexion.
      if (isAccountSuspended(defaultAccount)) {
        const refus = accountSuspendedResponse();
        clearSessionCookies(refus);
        return refus;
      }

      const isSubscribedOrTrialing = !!defaultAccount && ['ACTIVE', 'TRIALING', 'PAST_DUE_GRACE'].includes(defaultAccount.subscriptionStatus);

    // ══════════════════════════════════════════════════════════════════════
    // CDC §5.5 — ROTATION : L'ANCIEN JETON EST INVALIDÉ D'ABORD
    //
    // La révocation était tentée APRÈS l'émission, et son échec seulement
    // journalisé : la route annonçait un renouvellement réussi alors que
    // l'ancien jeton restait valide. Elle est désormais bloquante et
    // atomique :
    //   - échec technique → 503, aucun nouveau cookie (le client réessaie
    //     sans se déconnecter) ;
    //   - jeton déjà consommé par une requête concurrente → réutilisation,
    //     aucune seconde session.
    // ══════════════════════════════════════════════════════════════════════
    let consomme: boolean;
    try {
      consomme = await revokeTokenOnce(tokenHash, payload.userId, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    } catch (revokeError) {
      console.error('[refresh] revocation de l\'ancien jeton impossible — renouvellement refusé:', revokeError);
      return NextResponse.json(
        { error: 'Service temporairement indisponible', code: 'SERVICE_UNAVAILABLE' },
        { status: 503 },
      );
    }
    if (!consomme) {
      void logUserActivity({
        activityType: 'AUTH_TOKEN_REUSE_DETECTED',
        userId: payload.userId,
        userEmail: user.email,
        details: { severity: 'security_incident', concurrent: true },
        request,
      });
      return ApiErrors.invalidToken('Refresh token has been revoked');
    }

      // Generate new tokens
      const newAccessToken = await generateAccessToken({
        id: user.id,
        email: user.email,
        role: user.role as UserRole,
        planType: user.planType as PlanType,
        status: user.status as UserStatus,
        currentAccountId: defaultAccount?.id,
        hasActiveAccount: isSubscribedOrTrialing,
      });

      const newRefreshToken = await generateRefreshToken({
        id: user.id,
        email: user.email,
        role: user.role as UserRole,
        planType: user.planType as PlanType,
        status: user.status as UserStatus,
        currentAccountId: defaultAccount?.id,
        hasActiveAccount: isSubscribedOrTrialing,
      });

    // Le nouveau jeton est forcément distinct de l'ancien (jti aléatoire) ;
    // garde-fou si ce n'était pas le cas, plutôt que déposer un jeton révoqué.
    if (newRefreshToken === refreshToken) {
      return ApiErrors.internalError('REFRESH_ROTATION_ERROR');
    }

    void logUserActivity({
      activityType: 'AUTH_TOKEN_REFRESH',
      userId: payload.userId,
      userEmail: user.email,
      request,
    });

    // CDC §10.1 : aucun jeton dans le corps de reponse. Les nouveaux jetons
    // sont deposes uniquement en cookies HttpOnly ci-dessous.
    const response = NextResponse.json({
      success: true,
      message: 'Token refreshed successfully',
    });

    // Depot des nouveaux cookies
    const isProduction = process.env.NODE_ENV === 'production';

    response.cookies.set('access_token', newAccessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax', // ✅ Changé de 'strict' à 'lax'
      maxAge: 15 * 60, // 15 minutes
      path: '/',
    });

    response.cookies.set('refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax', // ✅ Changé de 'strict' à 'lax'
      maxAge: 30 * 24 * 60 * 60, // CDC §5.4 // 7 days
      path: '/',
    });

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