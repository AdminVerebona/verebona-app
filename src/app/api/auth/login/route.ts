import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import bcrypt from 'bcrypt';
import { generateAccessToken, generateRefreshToken } from '@/lib/jwt';
import { ApiErrors } from '@/lib/api-errors';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { logUserActivity } from '@/lib/audit-logger';
import { AccountService } from '@/services/account-service';
import { checkAuthRateLimit, resetAuthRateLimit, getClientIp } from '@/lib/rate-limiter';
import { userGuideProgress } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  // ── Rate limiting : 5 tentatives / IP / 15 minutes (désactivé en dev) ───
  const ip = getClientIp(request.headers);
  if (process.env.NODE_ENV !== 'development') {
    const rl = checkAuthRateLimit(ip);
    if (!rl.allowed) {
      return NextResponse.json(
        {
          error: 'Too Many Requests',
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Trop de tentatives. Réessayez dans ${rl.retryAfterSeconds} secondes.`,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfterSeconds),
            'X-RateLimit-Limit': String(rl.limit),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }
  }
  // ─────────────────────────────────────────────────────────────────────────
  let body: { email?: string; password?: string } = {};
  try {
    body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return ApiErrors.missingField('email or password');
    }

    const userRows = await db.$client<{
      id: number;
      email: string;
      first_name: string | null;
      last_name: string | null;
      username: string | null;
      company: string | null;
      password_hash: string;
      status: string;
      is_active: boolean;
      role: string;
      plan_type: string;
      locale: string | null;
    }[]>`
      SELECT id, email, first_name, last_name, username, company, password_hash, status, is_active, role, plan_type, locale
      FROM users
      WHERE email = ${email}
      LIMIT 1
    `;

    if (userRows.length === 0) {
      void logUserActivity({
        activityType: 'LOGIN_FAILED',
        userId: null,
        userEmail: email,
        details: { reason: 'user_not_found', attemptCount: 1, accountStatus: 'not_found' },
        request,
      });
      return ApiErrors.invalidCredentials();
    }

    const row = userRows[0];
    const user = {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      username: row.username,
      company: row.company,
      passwordHash: row.password_hash,
      status: row.status,
      isActive: row.is_active,
      role: row.role,
      planType: row.plan_type,
      locale: row.locale,
    };

    if (user.status === 'SUSPENDED') {
      void logUserActivity({
        activityType: 'LOGIN_FAILED',
        userId: user.id,
        userEmail: user.email,
        details: { reason: 'account_suspended', accountStatus: 'suspended' },
        request,
      });
      return ApiErrors.accountSuspended('Contactez l\'administration');
    }

    if (!user.isActive) {
      void logUserActivity({
        activityType: 'LOGIN_FAILED',
        userId: user.id,
        userEmail: user.email,
        details: { reason: 'email_not_verified', accountStatus: 'pending_verification' },
        request,
      });
      return NextResponse.json(
        {
          error: 'Veuillez vérifier votre email avant de vous connecter. Consultez votre boîte de réception.',
          code: 'EMAIL_NOT_VERIFIED',
        },
        { status: 403 }
      );
    }

    if (user.status === 'DELETED') {
      void logUserActivity({
        activityType: 'LOGIN_FAILED',
        userId: user.id,
        userEmail: user.email,
        details: { reason: 'account_deleted', accountStatus: 'deleted' },
        request,
      });
      return ApiErrors.accountInactive();
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatch) {
      void logUserActivity({
        activityType: 'LOGIN_FAILED',
        userId: user.id,
        userEmail: user.email,
        details: { reason: 'invalid_password', attemptCount: 1, accountStatus: 'active' },
        request,
      });
      return ApiErrors.invalidCredentials();
    }

    await db.$client`
      UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ${user.id}
    `;

    // Reset guide skipped steps on each new login
    await db
      .delete(userGuideProgress)
      .where(and(eq(userGuideProgress.userId, user.id), eq(userGuideProgress.status, 'skipped')));

    const defaultAccount = await AccountService.getUserDefaultAccount(user.id);

    void logUserActivity({
      activityType: 'LOGIN_SUCCESS',
      userId: user.id,
      userEmail: user.email,
      details: {
        loginMethod: 'email_password',
        role: user.role,
        planType: user.planType,
        currentAccountId: defaultAccount?.id,
      },
      request,
    });

    // Login réussi → réinitialiser le compteur pour cette IP
    resetAuthRateLimit(ip);

    const isSubscribedOrTrialing = !!defaultAccount && ['ACTIVE', 'TRIALING', 'PAST_DUE_GRACE'].includes(defaultAccount.subscriptionStatus);

    const [accessToken, refreshToken] = await Promise.all([
      generateAccessToken({
        id: user.id,
        email: user.email,
        role: user.role as UserRole,
        planType: user.planType as PlanType,
        status: user.status as UserStatus,
        currentAccountId: defaultAccount?.id,
        hasActiveAccount: isSubscribedOrTrialing,
      }),
      generateRefreshToken({
        id: user.id,
        email: user.email,
        role: user.role as UserRole,
        planType: user.planType as PlanType,
        status: user.status as UserStatus,
        currentAccountId: defaultAccount?.id,
        hasActiveAccount: isSubscribedOrTrialing,
      }),
    ]);

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        company: user.company,
        planType: user.planType,
        role: user.role,
        status: user.status,
        locale: user.locale,
      },
      accessToken,
      refreshToken,
    });

    const isProduction = process.env.NODE_ENV === 'production';

    response.cookies.set('access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 15 * 60,
      path: '/',
    });

    response.cookies.set('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = `LOGIN_${Date.now().toString(36).toUpperCase()}`;

    // Detect DB connection errors to give a friendlier message
    const isDbConnectionError = errorMessage.includes('ECONNREFUSED')
      || errorMessage.includes('ETIMEDOUT')
      || errorMessage.includes('connection')
      || errorMessage.includes('timeout')
      || errorMessage.includes('ENOTFOUND');

    void logUserActivity({
      activityType: 'SERVER_ERROR',
      userId: null,
      userEmail: body.email || 'unknown',
      details: {
        errorCode,
        errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
        endpoint: '/api/auth/login',
        httpStatus: 500,
        errorMessage,
      },
      request,
    }).catch(() => null);

    if (isDbConnectionError) {
      return NextResponse.json(
        { error: 'Service temporairement indisponible. Veuillez réessayer dans quelques instants.', code: 'SERVICE_UNAVAILABLE' },
        { status: 503 }
      );
    }

    return ApiErrors.internalError(errorCode);
  }
}
