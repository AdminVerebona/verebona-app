/**
 * Décision CENTRALE après une authentification primaire (lot 110B, ticket
 * §3, §6, §8) — appelée par la connexion par mot de passe, Google / Apple
 * (web et échange de l'application), et l'activation par le lien reçu.
 *
 *   · MFA non obligatoire pour cet utilisateur (aucun facteur, obligation
 *     non en vigueur) : comportement INCHANGÉ — session complète de niveau 1
 *     (`issueSession`), aucune session existante n'est cassée avant
 *     l'activation ;
 *   · MFA obligatoire : AUCUNE session complète. Contexte provisoire
 *     (`pending.ts`) : étape « challenge » (le compte a un facteur) ou
 *     « enroll » (premier facteur à créer). La session complète de niveau 2
 *     n'est émise qu'après la preuve forte (`completeStrongSession`).
 *
 * Mot de passe : la seconde étape est l'application d'authentification (ou
 * une clé d'accès, preuve plus forte) — jamais « mot de passe seul ».
 * Google / Apple : la preuve du fournisseur ne vaut pas MFA ; même étape.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { issueSession } from '../session-issuance';
import type { SessionSubject } from '../session-tokens';
import { rememberTrustedDevice, type DeviceTrustAccount } from '../device-trust';
import { deviceAccountOf } from '../device-account';
import { hasActiveSubscriptionStatus } from '@/lib/billing/subscription-status';
import { safeInternalPath } from '@/lib/safe-redirect';
import type { PlanType, UserRole, UserStatus } from '@/types/domain';
import { mfaRequirementFor } from './policy';
import { countStrongMethods, recordLastMethod } from './db';
import { clearPendingCookie, completePending, createPending, type PendingContext } from './pending';
import { strongAssurance } from './assurance';
import { auditMfa } from './notify';

export type PrimaryMethod = 'password' | 'google' | 'apple' | 'email_link';

export type PrimaryOutcome =
  | { kind: 'session'; sid: string }
  | { kind: 'mfa'; step: 'challenge' | 'enroll'; expiresAt: Date };

export async function concludePrimaryAuthentication(
  request: NextRequest,
  response: NextResponse,
  input: {
    subject: SessionSubject;
    method: PrimaryMethod;
    deviceAccount: DeviceTrustAccount;
    /** Reconnaissance de l'appareil (D1) — déposée à l'émission de la session complète. */
    rememberDevice?: boolean;
    returnUrl?: string | null;
  },
): Promise<PrimaryOutcome> {
  const requirement = await mfaRequirementFor(input.subject.id);
  if (!requirement.required) {
    const deviceId = input.rememberDevice === false ? null : rememberTrustedDevice(request, response, input.deviceAccount);
    const { sid } = await issueSession(request, response, {
      kind: 'open', method: input.method, replaceCurrent: true, deviceId, subject: input.subject,
    });
    return { kind: 'session', sid };
  }
  const step = (await countStrongMethods(input.subject.id)) > 0 ? 'challenge' : 'enroll';
  const { expiresAt } = await createPending(response, {
    userId: input.subject.id, purpose: step, primaryMethod: input.method,
    returnUrl: input.returnUrl ? safeInternalPath(input.returnUrl) : null,
    rememberDevice: input.rememberDevice !== false,
  });
  auditMfa(request, 'MFA_CHALLENGE_STARTED', input.subject.id, { primary: input.method, step, enforced: requirement.enforced, enrolled: requirement.enrolled });
  return { kind: 'mfa', step, expiresAt };
}

/** Corps JSON commun d'une réponse « seconde étape requise » (aucun facteur détaillé ici). */
export function mfaPendingBody(outcome: Extract<PrimaryOutcome, { kind: 'mfa' }>): Record<string, unknown> {
  return {
    success: true,
    mfaRequired: true,
    step: outcome.step,
    redirectTo: outcome.step === 'enroll' ? '/securiser-mon-compte' : '/verification',
    expiresAt: outcome.expiresAt.toISOString(),
  };
}

interface EligibleSessionUser {
  id: number; email: string; role: string; planType: string; status: string;
  account: { id: number; subscriptionStatus?: string | null } | null;
}

function subjectOf(u: EligibleSessionUser): SessionSubject {
  return {
    id: u.id, email: u.email, role: u.role as UserRole, planType: u.planType as PlanType, status: u.status as UserStatus,
    currentAccountId: u.account?.id,
    hasActiveAccount: !!u.account && hasActiveSubscriptionStatus(u.account.subscriptionStatus ?? null),
  };
}

export type StrongSessionResult = { ok: true; redirectTo: string; sid: string } | { ok: false; code: 'MFA_EXPIRED' | 'ACCOUNT_SUSPENDED' | 'ACCOUNT_DELETED' | 'EMAIL_NOT_VERIFIED' };

/**
 * Preuve forte réussie dans un contexte provisoire → session COMPLÈTE de
 * niveau 2. Complétion atomique (un seul onglet gagne), statuts relus.
 */
export async function completeStrongSession(
  request: NextRequest,
  response: NextResponse,
  ctx: PendingContext,
  factor: 'passkey' | 'otp',
): Promise<StrongSessionResult> {
  const { checkSessionEligibility, landingPath } = await import('../oauth/session-bridge');
  const eligibility = await checkSessionEligibility(ctx.userId);
  if (!eligibility.ok) return { ok: false, code: eligibility.code === 'USER_NOT_FOUND' ? 'MFA_EXPIRED' : eligibility.code };
  if (!(await completePending(ctx.pid))) return { ok: false, code: 'MFA_EXPIRED' };
  const deviceId = ctx.rememberDevice ? rememberTrustedDevice(request, response, deviceAccountOf(eligibility.user)) : null;
  const primary = ctx.primaryMethod === 'recovery' ? 'recovery' : ctx.primaryMethod;
  const { sid } = await issueSession(request, response, {
    kind: 'open', method: primary, replaceCurrent: true, deviceId,
    subject: subjectOf(eligibility.user), assurance: strongAssurance(primary, factor),
  });
  clearPendingCookie(response);
  await recordLastMethod(ctx.userId, factor === 'otp' ? 'totp' : 'passkey').catch(() => null);
  auditMfa(request, 'MFA_SUCCESS', ctx.userId, { primary, factor, sid });
  return { ok: true, sid, redirectTo: safeInternalPath(landingPath(eligibility.user, ctx.returnUrl ?? undefined)) };
}

/** Connexion par clé d'accès SEULE (sans mot de passe) : session de niveau 2. */
export async function openPasskeySession(
  request: NextRequest,
  response: NextResponse,
  userId: number,
  returnUrl: string | null,
): Promise<StrongSessionResult> {
  const { checkSessionEligibility, landingPath } = await import('../oauth/session-bridge');
  const eligibility = await checkSessionEligibility(userId);
  if (!eligibility.ok) return { ok: false, code: eligibility.code === 'USER_NOT_FOUND' ? 'MFA_EXPIRED' : eligibility.code };
  const { db, pgClient } = await import('@/db');
  const { userGuideProgress } = await import('@/db/schema');
  await pgClient`UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ${userId}`;
  await db.delete(userGuideProgress).where(and(eq(userGuideProgress.userId, userId), eq(userGuideProgress.status, 'skipped')));
  const { logUserActivity } = await import('@/lib/audit-logger');
  void logUserActivity({
    activityType: 'LOGIN_SUCCESS', userId, userEmail: eligibility.user.email,
    details: { loginMethod: 'passkey', role: eligibility.user.role, currentAccountId: eligibility.user.account?.id }, request,
  });
  const deviceId = rememberTrustedDevice(request, response, deviceAccountOf(eligibility.user));
  const { sid } = await issueSession(request, response, {
    kind: 'open', method: 'passkey', replaceCurrent: true, deviceId,
    subject: subjectOf(eligibility.user), assurance: strongAssurance(null, 'passkey'),
  });
  clearPendingCookie(response);
  await recordLastMethod(userId, 'passkey').catch(() => null);
  auditMfa(request, 'MFA_SUCCESS', userId, { primary: null, factor: 'passkey', sid });
  return { ok: true, sid, redirectTo: safeInternalPath(landingPath(eligibility.user, returnUrl ?? undefined)) };
}
