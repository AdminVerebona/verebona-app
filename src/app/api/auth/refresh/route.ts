import { NextRequest, NextResponse } from 'next/server';
import { db, isTokenRevoked, hashToken } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { verifyToken, generateAccessToken, generateRefreshToken } from '@/lib/jwt';
import { ApiErrors } from '@/lib/api-errors';
import { AccountService } from '@/services/account-service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';

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
    // ✅ IFRAME FIX: Lire depuis Authorization header (localStorage) en priorité,
    //    puis cookie en fallback. CRITIQUE : le cookie peut être obsolète si un
    //    autre utilisateur s'est connecté sans `credentials: include` (login fetch).
    let refreshToken: string | undefined;
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      refreshToken = authHeader.substring(7);
    }

    // Fallback cookie si pas de Authorization header
    if (!refreshToken) {
      refreshToken = request.cookies.get('refresh_token')?.value;
    }
    
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

    // ✅ IFRAME FIX: Retourner les tokens dans le JSON pour localStorage
    const response = NextResponse.json({
      success: true,
      message: 'Token refreshed successfully',
      accessToken: newAccessToken, // ✅ Exposé pour localStorage
      refreshToken: newRefreshToken, // ✅ Exposé pour localStorage
    });

    // Set new cookies (backup pour environnements non-iframe)
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
      maxAge: 7 * 24 * 60 * 60, // 7 days
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