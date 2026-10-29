import { NextRequest, NextResponse } from 'next/server';
import { hasActiveSubscriptionStatus } from '@/lib/billing/subscription-status';
import { db } from '@/db';
import { users, duoAccounts, accountMemberships, accountAuditLog } from '@/db/schema';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { emailService } from '@/lib/email/email-service';
import { AccountService } from '@/services/account-service';
import bcrypt from 'bcrypt';
import {
  checkEmailVerificationToken,
  consumeEmailVerification,
  isLegacyVerificationToken,
  parseEmailVerificationToken,
} from '@/services/auth/email-verification.service';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, rateLimitBody } from '@/lib/auth/auth-rate-limit';
import { getClientIp } from '@/lib/auth/client-ip';
import { logUserActivity } from '@/lib/audit-logger';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { issueSession } from '@/lib/auth/session-issuance';
import { rememberTrustedDevice } from '@/lib/auth/device-trust';
import { deviceAccountOf } from '@/lib/auth/device-account';

const baseUrl = () =>
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

function redirect(path: string) {
  return NextResponse.redirect(`${baseUrl()}${path}`);
}

/** Offres acceptées dans le paramètre `plan` : il est recopié dans l'URL de redirection. */
const KNOWN_PLANS = new Set(['standard', 'premium', 'premium_duo', 'premium_pro']);

/*
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 96A — ACTIVATION PROTÉGÉE PAR LE MOT DE PASSE DE L'INSCRIPTION
 * (CDC 18 Q9 / P1 ; faille reproduite sur le lot 93, voir
 * `email-verification.service.ts`)
 *
 *   GET  ?token=  — le lien reçu par e-mail. Il N'ACTIVE PLUS RIEN : un lien
 *                   valable mène à la page « Activez votre compte »
 *                   (`/verify-email/activer`), qui demande le mot de passe
 *                   choisi à l'inscription. Lien invalide, expiré, remplacé,
 *                   déjà utilisé : mêmes pages qu'avant, avec reprise de
 *                   l'inscription. Liens émis avant ce lot : même parcours
 *                   (mot de passe exigé) — ils ne sont plus jamais suffisants.
 *   POST { token, password, plan? } — vérifie le lien (inscription courante,
 *                   empreinte), PUIS le mot de passe de cette inscription
 *                   (limité : `activationUser` / `activationIp`, journalisé),
 *                   PUIS active (UPDATE conditionnel, usage unique) et ouvre
 *                   la session. Réponse JSON { success, redirectTo } ; les
 *                   cookies de session sont posés sur cette réponse.
 * ══════════════════════════════════════════════════════════════════════════
 */

type PendingUser = {
  id: number; email: string; firstName: string; isActive: boolean; role: string; planType: string;
  status: string; passwordHash: string | null; signupNonce: string | null;
};
type Resolution =
  | { kind: 'missing' } | { kind: 'outdated'; email: string } | { kind: 'invalid' }
  | { kind: 'expired'; email: string } | { kind: 'already' } | { kind: 'ok'; user: PendingUser };

/** Lit le lien et l'inscription qu'il désigne — aucune écriture. */
async function resolveLink(token: string | null | undefined): Promise<Resolution> {
  if (!token) return { kind: 'missing' };
  // Lien émis avant le passage au jeton signé : refusé, mais expliqué — et
  // l'adresse qu'il contient pré-remplit le renvoi (qui ne révèle rien).
  const legacy = isLegacyVerificationToken(token);
  if (legacy) return { kind: 'outdated', email: legacy.email };
  const parsed = parseEmailVerificationToken(token);
  if (!parsed) return { kind: 'invalid' };
  // Projection explicite : `select()` enumere toutes les colonnes du schema
  // et fait echouer la verification des qu'une seule manque en base.
  const [user] = await db
    .select({
      id: users.id, email: users.email, firstName: users.firstName, isActive: users.isActive, role: users.role,
      planType: users.planType, status: users.status, passwordHash: users.passwordHash, signupNonce: users.signupNonce,
    })
    .from(users)
    .where(eq(users.id, parsed.userId))
    .limit(1);
  // Compte introuvable, signature fausse, INSCRIPTION REMPLACÉE (autre ligne
  // ou autre empreinte) : même réponse. Distinguer dirait à un fabricant de
  // liens quels identifiants existent.
  const check = checkEmailVerificationToken(token, user ?? null);
  if (!check.ok || !user) {
    // Signature valide : c'est bien le lien de cette adresse (renvoi pré-rempli).
    if (check.ok === false && check.code === 'TOKEN_EXPIRED' && user && !user.isActive) return { kind: 'expired', email: user.email };
    if (check.ok === false && check.code === 'TOKEN_EXPIRED' && user?.isActive) return { kind: 'already' };
    return { kind: 'invalid' };
  }
  // Usage unique : un lien déjà utilisé n'ouvre plus rien.
  if (user.isActive) return { kind: 'already' };
  // Lot 96A : un compte sans mot de passe n'est jamais activé par ce parcours
  // (les comptes Google / Apple naissent actifs ; une telle ligne est anormale).
  if (!user.passwordHash) return { kind: 'invalid' };
  return { kind: 'ok', user };
}

function planFrom(raw: string | null | undefined): string | null {
  // Liste fermée : le paramètre n'est pas signé et finit dans une URL de
  // redirection ; une valeur libre pourrait y injecter d'autres paramètres.
  const p = raw === 'duo' ? 'premium_duo' : raw;
  return p && KNOWN_PLANS.has(p) ? p : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const normalizedPlan = planFrom(searchParams.get('plan')); // 'premium' | 'premium_duo' | 'duo' | null
  const planSuffix = normalizedPlan ? `&plan=${normalizedPlan}` : '';

  try {
    const r = await resolveLink(token);
    switch (r.kind) {
      case 'missing': return redirect('/verify-email?error=missing_token');
      case 'outdated': return redirect(`/verify-email?error=link_outdated&email=${encodeURIComponent(r.email)}${planSuffix}`);
      case 'invalid': return redirect(`/verify-email?error=invalid_token${planSuffix}`);
      case 'expired': return redirect(`/verify-email?error=token_expired&email=${encodeURIComponent(r.email)}${planSuffix}`);
      case 'already': return redirect(`/verify-email?status=already_verified${planSuffix}`);
      case 'ok': {
        // Lot 96A : RIEN n'est activé ici — la page demande le mot de passe de l'inscription.
        const params = new URLSearchParams({ token: token! });
        if (normalizedPlan) params.set('plan', normalizedPlan);
        return redirect(`/verify-email/activer?${params.toString()}`);
      }
    }
  } catch (error) {
    console.error('Verify email error:', error);
    return redirect('/verify-email?error=server_error');
  }
}

const ACTIVATION_MESSAGES = {
  MISSING_TOKEN: 'Ce lien est incomplet. Copiez-le entièrement depuis l’e-mail, ou demandez-en un nouveau.',
  LINK_OUTDATED: 'Ce lien n’est plus valable. Demandez un nouveau lien d’activation.',
  INVALID_TOKEN: 'Ce lien ne correspond à aucune inscription en attente. Si vous venez de vous inscrire, recommencez votre inscription.',
  TOKEN_EXPIRED: 'Ce lien a plus de 24 heures et n’est plus valable. Demandez-en un nouveau.',
  ALREADY_VERIFIED: 'Ce compte est déjà activé. Vous pouvez vous connecter.',
  PASSWORD_REQUIRED: 'Saisissez le mot de passe que vous avez choisi à l’inscription.',
  WRONG_SIGNUP_PASSWORD: 'Ce mot de passe ne correspond pas à cette inscription. Vérifiez votre saisie. Si vous ne reconnaissez pas cette inscription ou avez oublié le mot de passe choisi, recommencez votre inscription.',
} as const;
type ActivationCode = keyof typeof ACTIVATION_MESSAGES;
const ACTIVATION_STATUS: Record<ActivationCode, number> = {
  MISSING_TOKEN: 400, LINK_OUTDATED: 410, INVALID_TOKEN: 400, TOKEN_EXPIRED: 410, ALREADY_VERIFIED: 409,
  PASSWORD_REQUIRED: 400, WRONG_SIGNUP_PASSWORD: 401,
};
/** Reprise propre : nouvelle inscription (une inscription en attente se remplace). */
const RESTART_SIGNUP_URL = '/signup';

function activationError(code: ActivationCode, extra: Record<string, unknown> = {}) {
  const restart = code === 'INVALID_TOKEN' || code === 'WRONG_SIGNUP_PASSWORD';
  return NextResponse.json(
    { error: code, code, message: ACTIVATION_MESSAGES[code], ...(restart ? { restartUrl: RESTART_SIGNUP_URL } : {}), ...extra },
    { status: ACTIVATION_STATUS[code] },
  );
}

function activationLimitEntries(userId: number, ip: string) {
  return [
    { key: limitKey('activation', 'user', String(userId)), policy: AUTH_LIMITS.activationUser },
    { key: limitKey('activation', 'ip', ip), policy: AUTH_LIMITS.activationIp },
  ];
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown; plan?: unknown };
  const token = typeof body.token === 'string' ? body.token : null;
  const password = typeof body.password === 'string' ? body.password : '';
  const normalizedPlan = planFrom(typeof body.plan === 'string' ? body.plan : null);
  const ip = getClientIp(request.headers);
  const limiter = authRateLimitEnabled() ? getAuthRateLimiter() : null;

  try {
    // Pause par IP AVANT toute lecture (aucune information révélée pendant la pause).
    if (limiter) {
      const byIp = await limiter.check([{ key: limitKey('activation', 'ip', ip), policy: AUTH_LIMITS.activationIp }]);
      if (!byIp.allowed) return NextResponse.json(rateLimitBody(byIp.retryAfterSeconds), { status: 429, headers: { 'Retry-After': String(byIp.retryAfterSeconds) } });
    }
    const r = await resolveLink(token);
    if (r.kind === 'missing') return activationError('MISSING_TOKEN');
    if (r.kind === 'outdated') return activationError('LINK_OUTDATED', { email: r.email });
    if (r.kind === 'invalid') return activationError('INVALID_TOKEN');
    if (r.kind === 'expired') return activationError('TOKEN_EXPIRED', { email: r.email });
    if (r.kind === 'already') return activationError('ALREADY_VERIFIED');
    const user = r.user;

    if (limiter) {
      const d = await limiter.check(activationLimitEntries(user.id, ip));
      if (!d.allowed) return NextResponse.json(rateLimitBody(d.retryAfterSeconds), { status: 429, headers: { 'Retry-After': String(d.retryAfterSeconds) } });
    }
    if (!password) return activationError('PASSWORD_REQUIRED');

    const ok = await bcrypt.compare(password, user.passwordHash!);
    if (!ok) {
      const d = limiter ? await limiter.recordFailure(activationLimitEntries(user.id, ip)) : null;
      // Journal §23.1 — jamais la valeur saisie.
      void logUserActivity({ activityType: 'ACCOUNT_ACTIVATION_FAILED', userId: user.id, userEmail: user.email, details: { reason: 'WRONG_SIGNUP_PASSWORD', signupBound: !!user.signupNonce }, request });
      if (d?.lockedNow) {
        void logUserActivity({ activityType: 'ACCOUNT_ACTIVATION_THROTTLED', userId: user.id, userEmail: user.email, details: { retryAfterSeconds: d.retryAfterSeconds }, request });
      }
      return activationError('WRONG_SIGNUP_PASSWORD');
    }
    if (limiter) await limiter.reset(limitKey('activation', 'user', String(user.id)));

    // Activation conditionnelle : seule la requête qui fait passer CETTE
    // inscription (même empreinte) de « non vérifiée » à « active » obtient une session.
    if (!(await consumeEmailVerification(user.id, user.signupNonce))) return activationError('ALREADY_VERIFIED');
    void logUserActivity({ activityType: 'ACCOUNT_ACTIVATED', userId: user.id, userEmail: user.email, details: { method: 'email_link_password', signupBound: !!user.signupNonce }, request });

    const response = NextResponse.json({ success: true, redirectTo: `/verify-email?status=success` });
    const redirectTo = await completeActivation(request, response, user, normalizedPlan);
    // Corps définitif (les cookies déjà posés sont reportés).
    const final = NextResponse.json({ success: true, redirectTo });
    for (const c of response.cookies.getAll()) final.cookies.set(c);
    return final;
  } catch (error) {
    console.error('Verify email (activation) error:', error);
    return NextResponse.json({ error: 'SERVER_ERROR', code: 'SERVER_ERROR', message: 'Activation impossible pour le moment. Réessayez dans quelques minutes.' }, { status: 500 });
  }
}

/**
 * Après activation : e-mail de bienvenue, invitations réservées, session.
 * Rend la page de destination (chemin + requête). Inchangé depuis le lot 72D,
 * déplacé du GET (lot 96A).
 */
async function completeActivation(request: NextRequest, response: NextResponse, user: PendingUser, normalizedPlan: string | null): Promise<string> {
  const planSuffix = normalizedPlan ? `&plan=${normalizedPlan}` : '';
  // Lot 57A (P1-E) : le message de bienvenue n'est plus ATTENDU — un
  // fournisseur lent ou en panne ne retarde plus l'accès au compte.
  runDetached('e-mail de bienvenue', () => emailService.send({
    templateCode: 'WELCOME',
    to: user.email,
    variables: {
      firstName: user.firstName,
      loginUrl: `${baseUrl()}/login`,
    },
    userId: user.id,
  }));

  // CDC 18 §6 / LOGIN-05 : un compte suspendu ou supprimé entre-temps
  // n'obtient pas de session par le lien (l'adresse reste vérifiée).
  if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
    return `/verify-email?status=already_verified${planSuffix}`;
  }

  // Lot 72D (décision PO Q10) : invitation à un compte partagé réservée à
  // cette identité à l'inscription — l'adresse étant désormais vérifiée,
  // l'adhésion devient active (et l'espace est ouvert par défaut).
  const joinedAccountIds = await activateReservedAccountInvitations(user.id, user.email);

  try {
    // Dernier espace choisi d'abord (lot 72D) : l'espace rejoint ci-dessus.
    const defaultAccount = await AccountService.getUserDefaultAccount(user.id);
    // Indication informative du jeton, jamais une source de droits : un
    // impayé reste connectable sans « abonnement actif » (APP-FUNC-31).
    const isSubscribedOrTrialing = !!defaultAccount && hasActiveSubscriptionStatus(defaultAccount.subscriptionStatus);
    const tokenPayload = {
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      planType: user.planType as PlanType,
      status: user.status as UserStatus,
      currentAccountId: defaultAccount?.id,
      hasActiveAccount: isSubscribedOrTrialing,
    };

    // AUCUN JETON DANS L'URL — CDC cookies §5.1 et §13 : les deux jetons
    // sont posés en cookies HttpOnly sur la réponse.
    const params = new URLSearchParams({ status: 'success' });
    if (normalizedPlan) params.set('plan', normalizedPlan);
    // Lot 57A / P2 inscription des invités : une invitation Premium Duo EN
    // ATTENTE pour cette adresse (désormais vérifiée) → la page propose de
    // rejoindre le Duo, même si l'e-mail est ouvert dans un autre
    // navigateur que l'inscription. Simple indication : le rattachement
    // reste contrôlé par POST /api/duo/join (session, adresse invitée).
    const pendingDuo = await hasPendingDuoInvitation(user.email);
    if (pendingDuo) params.set('duo', '1');
    // Lot 72D : identité qui rejoint un compte existant — aucun essai à
    // annoncer ; sans espace (invitation Duo à accepter) : l'écran le dit.
    if (joinedAccountIds.length > 0) params.set('joined', '1');
    if (!defaultAccount) params.set('space', 'none');
    const targetPath = normalizedPlan && !pendingDuo ? '/abonnement/onboarding' : '/verify-email';

    // D1 : le lien reçu par e-mail ET le mot de passe de l'inscription
    // prouvent le contrôle de la boîte et du compte — navigateur reconnu.
    const deviceId = rememberTrustedDevice(request, response, deviceAccountOf(user));
    // Lot 53A (Q21, CDC 18 §19.3) : mêmes durées que partout ailleurs ;
    // lot 92 : émission unique (jetons + cookies + registre des sessions).
    await issueSession(request, response, { kind: 'open', method: 'email_link', replaceCurrent: true, deviceId, subject: tokenPayload });
    return `${targetPath}?${params.toString()}`;
  } catch {
    // Token generation failed — fall back to asking user to log in
    return `/verify-email?status=success${planSuffix}`;
  }
}

/**
 * Lot 72D : active les invitations à un compte partagé réservées à cette
 * identité (posées par l'inscription sur invitation), encore valides et
 * destinées à cette adresse. Jamais bloquant pour la vérification.
 */
async function activateReservedAccountInvitations(userId: number, email: string): Promise<number[]> {
  try {
    const now = new Date();
    const rows = await db
      .update(accountMemberships)
      .set({
        status: 'active',
        joinedAt: now,
        inviteToken: null,
        inviteTokenExpiresAt: null,
        lastSelectedAt: now,
        source: 'account_invitation',
        updatedAt: now,
      })
      .where(and(
        eq(accountMemberships.userId, userId),
        eq(accountMemberships.status, 'pending'),
        sql`(${accountMemberships.inviteTokenExpiresAt} IS NULL OR ${accountMemberships.inviteTokenExpiresAt} > now())`,
        sql`(${accountMemberships.invitedEmail} IS NULL OR lower(${accountMemberships.invitedEmail}) = ${email.trim().toLowerCase()})`,
      ))
      .returning({ accountId: accountMemberships.accountId });
    for (const r of rows) {
      await db.insert(accountAuditLog).values({
        accountId: r.accountId, userId, userEmail: email, actionType: 'MEMBER_JOINED',
        targetUserId: userId, targetUserEmail: email,
        details: JSON.stringify({ role: 'member', source: 'account_invitation' }), timestamp: now,
      });
    }
    return rows.map((r) => r.accountId);
  } catch (e) {
    console.error('[verify-email] activation des invitations de compte impossible:', (e as Error).message);
    return [];
  }
}

/** Invitation Premium Duo en attente, non expirée, adressée à cette adresse. */
async function hasPendingDuoInvitation(email: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: duoAccounts.id })
      .from(duoAccounts)
      .where(and(
        isNotNull(duoAccounts.pendingInviteToken),
        sql`lower(${duoAccounts.pendingInviteEmail}) = ${email.trim().toLowerCase()}`,
        sql`(${duoAccounts.pendingInviteTokenExpiresAt} IS NULL OR ${gt(duoAccounts.pendingInviteTokenExpiresAt, new Date())})`,
      ))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false; // indication seulement : jamais bloquant
  }
}
