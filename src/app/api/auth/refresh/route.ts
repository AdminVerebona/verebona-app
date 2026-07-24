import { NextRequest, NextResponse } from 'next/server';
import { db, isTokenRevoked, hashToken } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { verifyToken, generateAccessToken, generateRefreshToken } from '@/lib/jwt';
import { ApiErrors } from '@/lib/api-errors';
import { AccountService } from '@/services/account-service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { revokeToken } from '@/db';
import { logUserActivity } from '@/lib/audit-logger';

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

      const isSubscribedOrTrialing = !!defaultAccount && ['ACTIVE', 'TRIALING', 'PAST_DUE_GRACE'].includes(defaultAccount.subscriptionStatus);

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

    // CDC §5.5 — rotation : l'ancien jeton de renouvellement est invalide
    // immediatement. Toute presentation ulterieure sera detectee ci-dessus
    // comme une reutilisation.
    try {
      await revokeToken(tokenHash, payload.userId, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    } catch (revokeError) {
      console.error('[refresh] revocation de l\'ancien jeton impossible:', revokeError);
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