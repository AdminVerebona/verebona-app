/**
 * Étape « Vous avez déjà un compte Verebona ? » et inscription Google / Apple
 * (lot 93, CDC 18 §7.2, §8.1, §8.2, §12.4, §37) — logique des routes
 * `/api/auth/oauth/pending/*`, liée au navigateur (cookie `vb_oauth`).
 *
 *   · état        : ce qui s'affiche (fournisseur, prénom / nom proposés,
 *                   adresse attestée, étape) ;
 *   · mot de passe : « J'ai déjà un compte » — authentification COMPLÈTE du
 *                   compte existant (mêmes limiteurs, même temps de réponse
 *                   que la connexion), puis rattachement et session (§8.1,
 *                   SIGN-08). Aucun second facteur en V1 (décision PO Q2) ;
 *   · inscription : profil + CGSU → compte (adresse attestée) ou code
 *                   d'adresse (autre adresse) ;
 *   · code        : 6 chiffres, 15 min, 5 essais ;
 *   · annulation  : rien n'est créé (SIGN-11).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { pgClient } from '@/db';
import { getClientIp } from '@/lib/auth/client-ip';
import { comparePasswordConstantTime, runDetached } from '@/lib/auth/anti-enumeration';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, normalizeEmail, rateLimitBody } from '@/lib/auth/auth-rate-limit';
import {
  checkLoginThrottle, loginThrottledBody, recordLoginFailure, recordLoginSuccess, type LoginAttemptContext,
} from '@/lib/auth/login-throttle';
import { trustedDeviceForLogin } from '@/lib/auth/device-account';
import { INVALID_CREDENTIALS_MESSAGE } from '@/lib/auth/auth-messages';
import { scheduleSignupExistingEmail } from '@/services/auth/signup-existing-email.service';
import { emailService } from '@/lib/email/email-service';
import { logUserActivity } from '@/lib/audit-logger';
import type { SignupInvitation } from '@/lib/prelaunch-invitations';
import {
  EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_MIN_MS, EMAIL_CODE_TTL_MS, PROVIDER_LABEL, enabledProviders,
} from './config';
import { randomToken, safeEqual, sha256Hex, sixDigitCode } from './crypto';
import { linkIdentity } from './identities';
import {
  clearBindingCookie, countEmailCodeAttempt, findAwaitingByBinding, markFailed, readBinding, setPendingEmailCode,
  type AuthTransaction,
} from './transactions';
import { checkSessionEligibility } from './session-bridge';
import { finishWithSession, notifyIdentityChange } from './flow';
import {
  PROFILE_ERROR_MESSAGES, acceptedTermsVersion, checkSignupInvitation, createSocialAccount, emailHasAccount,
  validateProfileInput, type SocialProfile,
} from './social-signup';
import { SOCIAL_ERROR_MESSAGES, type SocialErrorCode } from './messages';

function err(code: SocialErrorCode | string, status: number, message?: string): NextResponse {
  const m = message ?? (SOCIAL_ERROR_MESSAGES as Record<string, string>)[code] ?? SOCIAL_ERROR_MESSAGES.OAUTH_PROVIDER_ERROR;
  return NextResponse.json({ error: m, code, message: m }, { status });
}

/** Étape en attente de CE navigateur, ou réponse 410 (expirée / inconnue). */
export async function loadPending(request: NextRequest): Promise<AuthTransaction | NextResponse> {
  const tx = await findAwaitingByBinding(readBinding(request));
  if (!tx || !tx.claims) return err('OAUTH_STATE_INVALID', 410);
  return tx;
}

interface StoredProfile extends SocialProfile { at?: number }

function storedProfile(tx: AuthTransaction): StoredProfile | null {
  const p = (tx.context as unknown as { profile?: StoredProfile }).profile;
  return p && typeof p.email === 'string' ? p : null;
}

// ── État affiché ────────────────────────────────────────────────────────────

export async function pendingState(tx: AuthTransaction) {
  const c = tx.claims!;
  const others = enabledProviders();
  const invitation = tx.context.inviteToken ? 'invitation' : tx.context.transmissionToken ? 'transmission' : null;
  return {
    provider: tx.provider,
    providerLabel: PROVIDER_LABEL[tx.provider],
    intent: tx.intent,
    stage: tx.stage ?? 'choice',
    firstName: c.firstName,
    lastName: c.lastName,
    providerEmail: c.email,
    providerEmailVerified: c.emailVerified,
    isPrivateRelay: c.isPrivateRelay,
    pendingEmail: tx.stage === 'email_code' ? tx.pendingEmail : null,
    referralCode: tx.context.referralCode ?? null,
    context: invitation,
    otherProviders: (['google', 'apple'] as const).filter((p) => p !== tx.provider && others[p]),
    expiresAt: tx.expiresAt.toISOString(),
  };
}

// ── « J'ai déjà un compte » : mot de passe ──────────────────────────────────

export async function linkWithPassword(request: NextRequest, tx: AuthTransaction, body: Record<string, unknown>): Promise<NextResponse> {
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return err('MISSING_FIELD', 400, 'Adresse e-mail et mot de passe requis.');
  const normalized = normalizeEmail(email);
  const limiter = getAuthRateLimiter();
  const limitOn = authRateLimitEnabled();
  const ctx: LoginAttemptContext = {
    identifier: normalized, ip: getClientIp(request.headers), trustedDeviceId: await trustedDeviceForLogin(request, email, normalized),
  };
  if (limitOn) {
    const d = await checkLoginThrottle(limiter, ctx);
    if (!d.allowed) return NextResponse.json(loginThrottledBody(d.retryAfterSeconds), { status: 429, headers: { 'Retry-After': String(d.retryAfterSeconds) } });
  }
  const rows = await pgClient<{ id: number; email: string; password_hash: string | null }[]>`
    SELECT id, email, password_hash FROM users WHERE email IN (${email}, ${normalized}) ORDER BY (email = ${email}) DESC LIMIT 1`;
  const row = rows[0] ?? null;
  // Toujours exécuté (empreinte factice si aucun compte ou aucun mot de passe) : même temps de réponse.
  const ok = await comparePasswordConstantTime(password, row?.password_hash);
  if (!row || !ok) {
    if (limitOn) await recordLoginFailure(limiter, ctx);
    void logUserActivity({
      activityType: 'LOGIN_FAILED', userId: row?.id ?? null, userEmail: row?.email ?? normalized,
      details: { reason: row ? 'invalid_password' : 'user_not_found', context: 'social_link_existing', provider: tx.provider }, request,
    });
    return NextResponse.json({ error: INVALID_CREDENTIALS_MESSAGE, code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE }, { status: 401 });
  }
  if (limitOn) await recordLoginSuccess(limiter, ctx);

  // Statut du compte APRÈS la preuve du mot de passe (comme la connexion).
  const eligibility = await checkSessionEligibility(row.id);
  if (!eligibility.ok) return err(eligibility.code === 'USER_NOT_FOUND' ? 'INVALID_CREDENTIALS' : eligibility.code, 403);

  const outcome = await linkIdentity(row.id, tx.claims!);
  if (!outcome.ok) {
    void logUserActivity({
      activityType: 'OAUTH_CALLBACK_FAILED', userId: row.id, userEmail: row.email,
      details: { provider: tx.provider, intent: 'link_existing', reason: outcome.code, authTransactionId: tx.id }, request,
    });
    return err(outcome.code, 409);
  }
  if (!outcome.alreadyLinked) await notifyIdentityChange(request, row.id, row.email, tx.provider, 'linked', 'existing_account');
  return finishWithSession(request, tx, ['awaiting_user'], row.id, tx.provider, 'json', { linkedVia: 'password' });
}

// ── Inscription ─────────────────────────────────────────────────────────────

export async function signup(request: NextRequest, tx: AuthTransaction, body: Record<string, unknown>): Promise<NextResponse> {
  if (tx.stage === 'existing_email') return err('ACCOUNT_ALREADY_EXISTS', 409);
  const v = validateProfileInput(body);
  if (!v.ok) return err(v.code, 400, PROFILE_ERROR_MESSAGES[v.code]);
  const termsVersion = await acceptedTermsVersion(v.presentedVersion);
  if (!termsVersion) return err('NO_CURRENT_LEGAL_VERSION', 503, PROFILE_ERROR_MESSAGES.NO_CURRENT_LEGAL_VERSION);
  const invitation = await checkSignupInvitation(tx.context, v.email);
  if (!invitation.ok) return err(invitation.code, 403);

  const profile: SocialProfile = {
    firstName: v.firstName, lastName: v.lastName, email: v.email, termsVersion,
    // Jamais de parrainage pour une identité qui rejoint un compte (même règle que l'inscription locale).
    referralCode: invitation.invitation?.valid && invitation.invitation.kind !== 'transmission' ? null : v.referralCode,
  };
  const c = tx.claims!;

  // Adresse attestée par le fournisseur : compte actif tout de suite (§6).
  if (c.email && c.emailVerified && v.email === c.email) {
    return createAndOpen(request, tx, profile, invitation.invitation);
  }
  return sendEmailCode(request, tx, profile);
}

async function createAndOpen(
  request: NextRequest, tx: AuthTransaction, profile: SocialProfile, invitation: SignupInvitation | null,
): Promise<NextResponse> {
  const created = await createSocialAccount({ claims: tx.claims!, profile, invitation, request });
  if (!created.ok) return err(created.code === 'EMAIL_TAKEN' ? 'ACCOUNT_ALREADY_EXISTS' : created.code, 409);
  return finishWithSession(request, tx, ['awaiting_user'], created.userId, tx.provider, 'json', { signup: true });
}

/**
 * Autre adresse que celle attestée : code envoyé à CETTE adresse. Réponse
 * identique que l'adresse ait déjà un compte ou non (anti-énumération) :
 * si elle en a un, son titulaire reçoit « vous avez déjà un compte » et
 * aucun code n'existe.
 */
async function sendEmailCode(request: NextRequest, tx: AuthTransaction, profile: SocialProfile): Promise<NextResponse> {
  if (authRateLimitEnabled()) {
    const d = await getAuthRateLimiter().consume([{ key: limitKey('oauth', 'acct', profile.email), policy: AUTH_LIMITS.socialEmailCodeAccount }]);
    if (!d.allowed) return NextResponse.json(rateLimitBody(d.retryAfterSeconds), { status: 429, headers: { 'Retry-After': String(d.retryAfterSeconds) } });
  }
  const existing = await emailHasAccount(profile.email);
  const code = sixDigitCode();
  const stored = await setPendingEmailCode(tx.id, {
    stage: 'email_code',
    pendingEmail: profile.email,
    // Un code introuvable pour une adresse déjà inscrite (aucun envoi) : jamais vérifiable.
    codeHash: existing ? sha256Hex(`none:${randomToken(16)}`) : sha256Hex(`${tx.id}:${code}`),
    codeExpiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MS),
    profile: profile as unknown as Record<string, unknown>,
  });
  if (!stored) return err('OAUTH_STATE_INVALID', 410);
  if (existing) {
    scheduleSignupExistingEmail(existing.id);
  } else {
    runDetached('code de confirmation (inscription Google / Apple)', async () => {
      const r = await emailService.send({
        templateCode: 'SOCIAL_SIGNUP_EMAIL_CODE',
        to: profile.email,
        variables: { firstName: profile.firstName, code, expiresIn: '15 minutes' },
      });
      if (!r?.success) console.error('[oauth] envoi du code de confirmation en échec');
    });
  }
  return NextResponse.json({ success: true, stage: 'email_code', email: profile.email });
}

export async function resendEmailCode(request: NextRequest, tx: AuthTransaction): Promise<NextResponse> {
  const profile = storedProfile(tx);
  if (tx.stage !== 'email_code' || !profile) return err('OAUTH_STATE_INVALID', 409);
  if (tx.emailCodeSentAt && Date.now() - tx.emailCodeSentAt.getTime() < EMAIL_CODE_RESEND_MIN_MS) {
    const s = Math.ceil((EMAIL_CODE_RESEND_MIN_MS - (Date.now() - tx.emailCodeSentAt.getTime())) / 1000);
    return NextResponse.json({ ...rateLimitBody(s), message: `Patientez ${s} secondes avant de demander un nouveau code.` }, { status: 429 });
  }
  return sendEmailCode(request, tx, profile);
}

export async function verifyEmailCode(request: NextRequest, tx: AuthTransaction, body: Record<string, unknown>): Promise<NextResponse> {
  const profile = storedProfile(tx);
  if (tx.stage !== 'email_code' || !profile || !tx.emailCodeHash) return err('OAUTH_STATE_INVALID', 409);
  const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  // Tentative comptée AVANT la comparaison : deux requêtes parallèles ne gagnent pas d'essai.
  const attempts = await countEmailCodeAttempt(tx.id);
  if (attempts == null) return err('OAUTH_STATE_INVALID', 410);
  if (attempts > EMAIL_CODE_MAX_ATTEMPTS) {
    await markFailed(tx.id, 'email_code_attempts');
    const res = err('RATE_LIMIT_EXCEEDED', 429, 'Trop d’essais. Recommencez la connexion avec Google ou Apple.');
    clearBindingCookie(res);
    return res;
  }
  const expired = !tx.emailCodeExpiresAt || tx.emailCodeExpiresAt.getTime() <= Date.now();
  if (expired || !/^\d{6}$/.test(code) || !safeEqual(sha256Hex(`${tx.id}:${code}`), tx.emailCodeHash)) {
    return err('EMAIL_CODE_INVALID', 400, expired ? 'Ce code a expiré. Demandez-en un nouveau.' : 'Le code saisi est invalide ou expiré.');
  }
  const invitation = await checkSignupInvitation(tx.context, profile.email);
  if (!invitation.ok) return err(invitation.code, 403);
  return createAndOpen(request, tx, profile, invitation.invitation);
}

export async function cancelPending(tx: AuthTransaction): Promise<NextResponse> {
  await markFailed(tx.id, 'cancelled');
  const res = NextResponse.json({ success: true, redirectTo: tx.intent === 'signup' ? '/signup' : '/login' });
  clearBindingCookie(res);
  return res;
}
