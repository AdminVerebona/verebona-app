import { NextRequest, NextResponse } from 'next/server';
import { hasActiveSubscriptionStatus } from '@/lib/billing/subscription-status';
import { db } from '@/db';
import { generateSessionTokens } from '@/lib/jwt';
import { ApiErrors } from '@/lib/api-errors';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { logUserActivity } from '@/lib/audit-logger';
import { AccountService } from '@/services/account-service';
import { getClientIp } from '@/lib/auth/client-ip';
import { authRateLimitEnabled, getAuthRateLimiter, normalizeEmail } from '@/lib/auth/auth-rate-limit';
import {
  checkLoginThrottle, loginThrottledBody, recordLoginFailure, recordLoginSuccess,
  type LoginAttemptContext, type ThrottleVerdict,
} from '@/lib/auth/login-throttle';
import { readDeviceCookie, rememberTrustedDevice, trustedDeviceFor } from '@/lib/auth/device-trust';
import { setSessionCookies } from '@/lib/auth/session-tokens';
import { comparePasswordConstantTime } from '@/lib/auth/anti-enumeration';
import { EMAIL_NOT_VERIFIED_MESSAGE, INVALID_CREDENTIALS_MESSAGE } from '@/lib/auth/auth-messages';
import { userGuideProgress } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { resolveSessionAccount, accountSuspendedResponse } from '@/lib/auth/account-suspension';


function invalidCredentials() {
  return NextResponse.json(
    { error: INVALID_CREDENTIALS_MESSAGE, code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE },
    { status: 401 },
  );
}

function tooManyAttempts(retryAfterSeconds: number) {
  return NextResponse.json(loginThrottledBody(retryAfterSeconds), {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

/** Détail de journal de la limitation (aucune clé, aucune IP, aucune adresse). */
function throttleDetails(ctx: LoginAttemptContext, verdict: ThrottleVerdict | null) {
  return {
    trustedDevice: !!ctx.trustedDeviceId,
    ...(verdict?.lockedNow ? { throttle: { rule: verdict.rule, retryAfterSeconds: verdict.retryAfterSeconds } } : {}),
  };
}

/**
 * Connexion e-mail + mot de passe.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 37 — C3 (énumération) et C4 (limiteur)
 *
 * Avant : adresse inconnue → 401 immédiat (sans bcrypt, donc ~60 ms plus
 * rapide) ; compte non vérifié, suspendu ou supprimé → 403 AVANT le contrôle
 * du mot de passe. Les deux révélaient l'existence d'un compte.
 * Désormais :
 *   1. limiteur partagé (IP réelle ET adresse saisie) : 429 identique pour
 *      toute adresse, inscrite ou non ;
 *   2. bcrypt TOUJOURS exécuté (empreinte factice pour une adresse inconnue) ;
 *   3. adresse inconnue ou mot de passe faux → MÊME réponse (401
 *      INVALID_CREDENTIALS, même corps), échec compté sur les deux clés ;
 *   4. mot de passe prouvé → les états du compte (suspendu, supprimé,
 *      e-mail non vérifié) ne sont dits qu'à ce moment-là (CDC 18 §30
 *      EMAIL_NOT_VERIFIED).
 *
 * LOT 53A — D1 (retour PO) : le limiteur ne bloque plus l'ADRESSE pour tout
 * le monde. Règles (origine, origine × adresse, adresse pour les appareils
 * non reconnus, appareil reconnu) : `lib/auth/login-throttle.ts`. Une
 * session ouverte fait reconnaître ce navigateur pour ce compte
 * (`lib/auth/device-trust.ts`) : une attaque ultérieure, même distribuée,
 * ne l'empêche pas de se connecter.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string } = {};
  try {
    body = await request.json();
    const { email, password } = body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return ApiErrors.missingField('email or password');
    }

    const normalized = normalizeEmail(email);
    const limiter = getAuthRateLimiter();
    const limitEnabled = authRateLimitEnabled();
    const throttleCtx: LoginAttemptContext = {
      identifier: normalized,
      ip: getClientIp(request.headers),
      trustedDeviceId: trustedDeviceFor(readDeviceCookie(request), normalized),
    };

    if (limitEnabled) {
      // Avant toute lecture du compte : le refus est identique pour toute adresse.
      const decision = await checkLoginThrottle(limiter, throttleCtx);
      if (!decision.allowed) return tooManyAttempts(decision.retryAfterSeconds);
    }

    // Adresse saisie telle quelle (comptes historiques) ou normalisée
    // (inscription : trim + minuscules) ; l'exacte est préférée.
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
      WHERE email IN (${email}, ${normalized})
      ORDER BY (email = ${email}) DESC
      LIMIT 1
    `;

    const row = userRows[0] ?? null;
    // Toujours exécuté, même sans compte : temps de réponse indépendant de l'existence.
    const passwordMatch = await comparePasswordConstantTime(password, row?.password_hash);

    if (!row || !passwordMatch) {
      const verdict = limitEnabled ? await recordLoginFailure(limiter, throttleCtx) : null;
      const throttle = throttleDetails(throttleCtx, verdict);
      void logUserActivity({
        activityType: 'LOGIN_FAILED',
        userId: row?.id ?? null,
        userEmail: row?.email ?? normalized,
        details: row
          ? { reason: 'invalid_password', attemptCount: 1, accountStatus: String(row.status).toLowerCase(), ...throttle }
          : { reason: 'user_not_found', attemptCount: 1, accountStatus: 'not_found', ...throttle },
        request,
      });
      if (verdict?.lockedNow) {
        // Traçabilité D1 : une pause vient d'être déclenchée (une ligne par pause).
        void logUserActivity({
          activityType: 'AUTH_LOGIN_THROTTLED',
          userId: row?.id ?? null,
          userEmail: row?.email ?? normalized,
          details: { rule: verdict.rule, retryAfterSeconds: verdict.retryAfterSeconds, trustedDevice: !!throttleCtx.trustedDeviceId },
          request,
        });
      }
      return invalidCredentials();
    }

    // Mot de passe prouvé : seuls les compteurs de CET appareil reconnu ou de
    // la paire (IP, adresse) repartent à zéro — jamais celui de l'IP, ni
    // celui de l'adresse toutes origines (D1).
    if (limitEnabled) await recordLoginSuccess(limiter, throttleCtx);

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
          error: EMAIL_NOT_VERIFIED_MESSAGE,
          code: 'EMAIL_NOT_VERIFIED',
          message: EMAIL_NOT_VERIFIED_MESSAGE,
          canResendVerification: true,
        },
        { status: 403 }
      );
    }

    // CDC BO ACC-A02 : un compte suspendu par l'administration n'ouvre plus de
    // session. Contrôlé APRÈS le mot de passe, pour ne pas révéler l'état
    // d'un compte à qui ne connaît que l'e-mail ; et AVANT toute écriture
    // (dernière connexion, progression du guide).
    //
    // La session s'ouvre sur le premier compte ACTIF (ordre stable : titulaire
    // d'abord, puis ancienneté). Le refus n'intervient que si TOUS les comptes
    // de l'utilisateur sont suspendus ; un administrateur BO garde alors
    // l'accès au BO, sans compte courant (règles : lib/auth/account-suspension).
    const resolution = resolveSessionAccount(
      await AccountService.getUserSessionAccounts(user.id),
      { role: user.role },
    );
    if (!resolution.allowed) {
      void logUserActivity({
        activityType: 'LOGIN_FAILED',
        userId: user.id,
        userEmail: user.email,
        details: { reason: 'account_suspended_by_admin', accountStatus: 'suspended', accountId: resolution.suspendedAccountId },
        request,
      });
      return accountSuspendedResponse();
    }
    const defaultAccount = resolution.account;

    await db.$client`
      UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ${user.id}
    `;

    // Reset guide skipped steps on each new login
    await db
      .delete(userGuideProgress)
      .where(and(eq(userGuideProgress.userId, user.id), eq(userGuideProgress.status, 'skipped')));

    void logUserActivity({
      activityType: 'LOGIN_SUCCESS',
      userId: user.id,
      userEmail: user.email,
      details: {
        loginMethod: 'email_password',
        role: user.role,
        planType: user.planType,
        currentAccountId: defaultAccount?.id,
        // D1 : appareil déjà reconnu pour ce compte (sinon : premier succès ici).
        trustedDevice: !!throttleCtx.trustedDeviceId,
      },
      request,
    });

    // Lot 32 (décision PO 6) : la situation du compte a pu changer depuis la
    // dernière visite (échéances passées) — sa prise de parole est préparée
    // tout de suite, durablement. Jamais attendu, jamais bloquant.
    if (defaultAccount?.id) {
      const accountId = defaultAccount.id;
      void import('@/services/home/mascot/mascot.service')
        .then((m) => m.scheduleMascotPregeneration(accountId, 0, 'login'))
        .catch(() => {});
    }

    // Indication informative du jeton, jamais une source de droits : un
    // impayé reste connectable sans « abonnement actif » (APP-FUNC-31).
    const isSubscribedOrTrialing = !!defaultAccount && hasActiveSubscriptionStatus(defaultAccount.subscriptionStatus);

    // Nouvelle session : nouvelle famille (`sid`), conservée par les rotations.
    const { accessToken, refreshToken } = await generateSessionTokens({
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      planType: user.planType as PlanType,
      status: user.status as UserStatus,
      currentAccountId: defaultAccount?.id,
      hasActiveAccount: isSubscribedOrTrialing,
    });

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
      // CDC §10.1 : les jetons ne sont JAMAIS renvoyes dans le corps JSON.
      // Ils sont deposes uniquement en cookies HttpOnly ci-dessous.
    });

    // Durées = celles des JWT (accès 15 min, renouvellement 30 j glissants).
    setSessionCookies(response, { accessToken, refreshToken });
    // D1 : ce navigateur / cette application est désormais reconnu pour ce compte.
    rememberTrustedDevice(request, response, normalizeEmail(user.email));

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
