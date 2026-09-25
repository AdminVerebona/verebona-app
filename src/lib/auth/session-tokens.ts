/**
 * Émission et dépôt des jetons de session (cookies HttpOnly, CDC §10.1).
 *
 * Partagé par le renouvellement (`/api/auth/refresh`) et le changement de mot
 * de passe (session courante conservée sur demande explicite).
 */
import type { NextResponse } from 'next/server';
import { generateAccessToken, generateRefreshToken } from '@/lib/jwt';
import { AccountService } from '@/services/account-service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';

export interface SessionUser {
  id: number;
  email: string;
  role: string;
  planType: string;
  status: string;
}

export async function issueSessionTokens(user: SessionUser): Promise<{ accessToken: string; refreshToken: string }> {
  const defaultAccount = await AccountService.getUserDefaultAccount(user.id);
  const hasActiveAccount = !!defaultAccount
    && ['ACTIVE', 'TRIALING', 'PAST_DUE_GRACE'].includes(defaultAccount.subscriptionStatus);
  const claims = {
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    planType: user.planType as PlanType,
    status: user.status as UserStatus,
    currentAccountId: defaultAccount?.id,
    hasActiveAccount,
  };
  const [accessToken, refreshToken] = await Promise.all([
    generateAccessToken(claims),
    generateRefreshToken(claims),
  ]);
  return { accessToken, refreshToken };
}

export function setSessionCookies(response: NextResponse, tokens: { accessToken: string; refreshToken: string }): void {
  const secure = process.env.NODE_ENV === 'production';
  response.cookies.set('access_token', tokens.accessToken, {
    httpOnly: true, secure, sameSite: 'lax', maxAge: 15 * 60, path: '/',
  });
  response.cookies.set('refresh_token', tokens.refreshToken, {
    httpOnly: true, secure, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60, path: '/', // CDC §5.4
  });
}

export function clearSessionCookies(response: NextResponse): void {
  const secure = process.env.NODE_ENV === 'production';
  for (const name of ['access_token', 'refresh_token']) {
    response.cookies.set(name, '', { httpOnly: true, secure, sameSite: 'lax', maxAge: 0, path: '/' });
  }
}

export { sessionCutoffCacheKey } from './session-cutoff';
