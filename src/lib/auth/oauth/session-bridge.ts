/**
 * Ouverture de session après une preuve Google / Apple — lot 93, CDC 18 §9.3,
 * §9.4, LOGIN-02/03/05.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ÉMISSION : fonction UNIQUE du lot 92 (`issueSession`, registre des sessions)
 *
 * Intégration 92 + 93 (26/10/2026) : `openSocialSession` applique les mêmes
 * effets que la connexion par mot de passe (`app/api/auth/login/route.ts`) —
 * contrôles de statut APRÈS la preuve (`checkSessionEligibility`), dernière
 * connexion, remise à zéro du guide, journal LOGIN_SUCCESS, appareil reconnu
 * (`vb_device`) — puis appelle `issueSession(request, response, { kind:
 * 'open', subject, method: 'google' | 'apple', replaceCurrent, deviceId })` :
 * jetons, cookies HttpOnly, nouveau `sid` et inscription au registre.
 * Appelants : `flow.ts › finishWithSession`, `app/api/auth/oauth/app/exchange`.
 * Aucun autre fichier du lot 93 n'émet de session.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { userGuideProgress } from '@/db/schema';
import { issueSession } from '@/lib/auth/session-issuance';
import { rememberTrustedDevice } from '@/lib/auth/device-trust';
import { deviceAccountOf } from '@/lib/auth/device-account';
import { resolveSessionAccount } from '@/lib/auth/account-suspension';
import { hasActiveSubscriptionStatus } from '@/lib/billing/subscription-status';
import { AccountService } from '@/services/account-service';
import { logUserActivity } from '@/lib/audit-logger';
import type { PlanType, UserRole, UserStatus } from '@/types/domain';
import type { OAuthProvider } from './config';

export type SessionRefusal = 'ACCOUNT_SUSPENDED' | 'ACCOUNT_DELETED' | 'EMAIL_NOT_VERIFIED' | 'USER_NOT_FOUND';

interface EligibleUser {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  role: string;
  planType: string;
  account: { id: number; subscriptionStatus?: string | null } | null;
}

export type Eligibility = { ok: true; user: EligibleUser } | { ok: false; code: SessionRefusal; userId?: number; email?: string };

/**
 * Contrôles de statut APRÈS la preuve fournisseur (§9.3 « mêmes contrôles que
 * le login local », §9.4). PENDING_DELETION : admis — la session ne donne
 * accès qu'à l'écran « Compte en cours de suppression » (middleware), comme
 * pour la connexion par mot de passe (E2E-21).
 */
export async function checkSessionEligibility(userId: number): Promise<Eligibility> {
  const [u] = await pgClient<{
    id: number; email: string; first_name: string | null; last_name: string | null; status: string; is_active: boolean;
    role: string; plan_type: string;
  }[]>`SELECT id, email, first_name, last_name, status, is_active, role, plan_type FROM users WHERE id = ${userId}`;
  if (!u) return { ok: false, code: 'USER_NOT_FOUND' };
  if (u.status === 'SUSPENDED') return { ok: false, code: 'ACCOUNT_SUSPENDED', userId: u.id, email: u.email };
  if (u.status === 'DELETED') return { ok: false, code: 'ACCOUNT_DELETED', userId: u.id, email: u.email };
  if (!u.is_active) return { ok: false, code: 'EMAIL_NOT_VERIFIED', userId: u.id, email: u.email };
  const resolution = resolveSessionAccount(await AccountService.getUserSessionAccounts(u.id), { role: u.role });
  if (!resolution.allowed) return { ok: false, code: 'ACCOUNT_SUSPENDED', userId: u.id, email: u.email };
  const account = resolution.account as { id: number; subscriptionStatus?: string | null } | null;
  return {
    ok: true,
    user: {
      id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, status: u.status, role: u.role,
      planType: u.plan_type, account,
    },
  };
}

/**
 * Ouvre la session sur `response` (déjà construite : redirection ou JSON).
 * Voir l'en-tête : émission unique du lot 92.
 */
export async function openSocialSession(
  request: NextRequest,
  response: NextResponse,
  user: EligibleUser,
  method: OAuthProvider,
  extra: Record<string, unknown> = {},
): Promise<{ sid: string }> {
  await pgClient`UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ${user.id}`;
  await db.delete(userGuideProgress).where(and(eq(userGuideProgress.userId, user.id), eq(userGuideProgress.status, 'skipped')));

  void logUserActivity({
    activityType: 'LOGIN_SUCCESS',
    userId: user.id,
    userEmail: user.email,
    details: { loginMethod: method, role: user.role, planType: user.planType, currentAccountId: user.account?.id, ...extra },
    request,
  });

  if (user.account?.id) {
    const accountId = user.account.id;
    void import('@/services/home/mascot/mascot.service')
      .then((m) => m.scheduleMascotPregeneration(accountId, 0, 'login'))
      .catch(() => {});
  }

  // Appareil reconnu (D1), comme la connexion par mot de passe.
  const deviceId = rememberTrustedDevice(request, response, deviceAccountOf(user));
  const { sid } = await issueSession(request, response, {
    kind: 'open',
    method,
    replaceCurrent: true,
    deviceId,
    subject: {
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      planType: user.planType as PlanType,
      status: user.status as UserStatus,
      currentAccountId: user.account?.id,
      hasActiveAccount: !!user.account && hasActiveSubscriptionStatus(user.account.subscriptionStatus ?? null),
    },
  });
  return { sid };
}

/** Page d'arrivée après ouverture de session. */
export function landingPath(user: { status: string }, returnUrl: string | undefined): string {
  if (user.status === 'PENDING_DELETION') return '/compte-en-suppression';
  return returnUrl || '/accueil';
}
