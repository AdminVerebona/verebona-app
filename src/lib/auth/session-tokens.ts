/**
 * Émission et dépôt des jetons de session (cookies HttpOnly, CDC §10.1).
 *
 * Partagé par le renouvellement (`/api/auth/refresh`) et le changement de mot
 * de passe (session courante conservée sur demande explicite).
 */
import type { NextResponse } from 'next/server';
import { generateSessionTokens } from '@/lib/jwt';
import { AccountService } from '@/services/account-service';
import { hasActiveSubscriptionStatus } from '@/lib/billing/subscription-status';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S } from './token-lifetimes';

interface SessionUser {
  id: number;
  email: string;
  role: string;
  planType: string;
  status: string;
}

export async function issueSessionTokens(user: SessionUser): Promise<{ accessToken: string; refreshToken: string }> {
  const defaultAccount = await AccountService.getUserDefaultAccount(user.id);
  // Indication informative (abonnement actif), jamais une source de droits ;
  // un compte en impayé reste authentifiable (APP-FUNC-31).
  const hasActiveAccount = !!defaultAccount && hasActiveSubscriptionStatus(defaultAccount.subscriptionStatus);
  const claims = {
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    planType: user.planType as PlanType,
    status: user.status as UserStatus,
    currentAccountId: defaultAccount?.id,
    hasActiveAccount,
  };
  // Nouvelle famille de session (`sid`) : paire d'une même session (lot 37).
  const { accessToken, refreshToken } = await generateSessionTokens(claims);
  return { accessToken, refreshToken };
}

/**
 * Lot 72D — session ouverte sur un ESPACE PRÉCIS (acceptation d'une
 * invitation, changement d'espace). Le compte n'est retenu que si
 * l'utilisateur y a une adhésion ACTIVE et qu'il n'est pas suspendu : un
 * identifiant fourni par le client n'accorde jamais de droit. `null` : refus.
 * Nouvelle famille de session (`sid`), comme une connexion.
 */
export async function issueSessionTokensOnAccount(
  user: SessionUser,
  accountId: number,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const candidates = await AccountService.getUserSessionAccounts(user.id);
  const target = candidates.find((c) => c.account.id === accountId)?.account;
  if (!target || target.isActive === false) return null;
  const { accessToken, refreshToken } = await generateSessionTokens({
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    planType: user.planType as PlanType,
    status: user.status as UserStatus,
    currentAccountId: target.id,
    hasActiveAccount: hasActiveSubscriptionStatus(target.subscriptionStatus),
  });
  return { accessToken, refreshToken };
}

/**
 * Dépôt des deux cookies de session. SEUL point d'écriture (connexion,
 * renouvellement, vérification d'adresse, changement de mot de passe,
 * clôture) : durées = celles des JWT (`token-lifetimes`), aucune divergence
 * « 15 min / 2 h selon la route » (CDC 18 §19.3, lot 53A).
 */
export function setSessionCookies(response: NextResponse, tokens: { accessToken: string; refreshToken: string }): void {
  const secure = process.env.NODE_ENV === 'production';
  response.cookies.set('access_token', tokens.accessToken, {
    httpOnly: true, secure, sameSite: 'lax', maxAge: ACCESS_TOKEN_TTL_S, path: '/',
  });
  response.cookies.set('refresh_token', tokens.refreshToken, {
    httpOnly: true, secure, sameSite: 'lax', maxAge: REFRESH_TOKEN_TTL_S, path: '/', // CDC §5.4
  });
}

export function clearSessionCookies(response: NextResponse): void {
  const secure = process.env.NODE_ENV === 'production';
  for (const name of ['access_token', 'refresh_token']) {
    response.cookies.set(name, '', { httpOnly: true, secure, sameSite: 'lax', maxAge: 0, path: '/' });
  }
}

export { sessionCutoffCacheKey } from './session-cutoff';
