/**
 * Parcours Google / Apple — orchestration (lot 93, CDC 18 §7.2, §8, §9.3,
 * §12.2, §12.3, §18.2, §21.3, §23.1, §33, §37).
 *
 *   start      → transaction serveur + redirection vers le fournisseur ;
 *   callback   → state (haché) + liaison navigateur + code échangé +
 *                id_token validé, puis aiguillage :
 *                · intention login / signup : identité liée → session ;
 *                  sinon → étape « Vous avez déjà un compte Verebona ? »
 *                  (écran /connexion-sociale) ;
 *                · link   : rattachement au compte de la session ;
 *                · reauth : même subject que l'identité liée → preuve 5 min.
 *
 * Toute erreur renvoie vers un écran Verebona (jamais une URL externe),
 * avec un code stable ; rien n'est créé ni modifié sur annulation.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { emit } from '@/lib/notifications';
import { logUserActivity } from '@/lib/audit-logger';
import { getClientIp } from '@/lib/auth/client-ip';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey } from '@/lib/auth/auth-rate-limit';
import { verifySessionAccessToken } from '@/lib/auth/session-guard';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { safeInternalPath, safeReturnUrl } from '@/lib/safe-redirect';
import {
  APP_HANDOFF_TTL_MS, PENDING_SIGNUP_TTL_MS, PROVIDER_LABEL, appReturnUrl, getProviderConfig, oauthRedirectBase,
  type OAuthProvider, type ProviderConfig,
} from './config';
import { encryptProviderToken, pkceChallenge, randomToken, sha256Hex } from './crypto';
import {
  findIdentityBySubject, linkIdentity, touchIdentity,
} from './identities';
import {
  OAuthProviderError, assertFreshProviderAuth, buildAuthorizationUrl, exchangeCode, normalizeIdentity, parseAppleUserParam,
  validateIdToken,
} from './providers';
import {
  bindingMatches, claimAppTicket, clearBindingCookie, createTransaction, ensureBinding, findAwaitingByBinding, findById, findByState,
  markFailed, readBinding, setBindingCookie, transition,
  type AuthTransaction, type OAuthIntent, type TxClaims, type TxContext,
} from './transactions';
import { checkSessionEligibility, landingPath, openSocialSession } from './session-bridge';
import { issueReauthProof, ReauthError } from '@/lib/auth/reauth';
import { emailHasAccount } from './social-signup';
import { socialErrorMessage, type SocialErrorCode } from './messages';

export const PENDING_PAGE = '/connexion-sociale';
export const SECURITY_PAGE = '/mon-compte/informations';

// ── URL ─────────────────────────────────────────────────────────────────────

function absolute(path: string): string {
  return new URL(path, `${oauthRedirectBase() ?? 'http://localhost:3000'}/`).toString();
}

/** Redirection 303 (après un POST form_post) ou 307 (GET). */
export function redirectTo(path: string, status: 302 | 303 = 302): NextResponse {
  return NextResponse.redirect(absolute(path), status);
}

export function errorPath(intent: OAuthIntent, code: SocialErrorCode | string, context?: TxContext): string {
  // Lot 97B : association / confirmation démarrée DANS L'APPLICATION — l'erreur
  // revient à l'app (retour `APP_OAUTH_RETURN_URL?error=`), pas à une page web
  // ouverte dans le navigateur système sans session.
  if ((intent === 'link' || intent === 'reauth') && context?.client === 'app') {
    const ret = appReturnUrl();
    if (ret) return `${ret}?${new URLSearchParams({ error: String(code) }).toString()}`;
  }
  if (intent === 'link' || intent === 'reauth') return `${SECURITY_PAGE}?securite=erreur&code=${encodeURIComponent(code)}#securite`;
  const base = intent === 'signup' ? '/signup' : '/login';
  const q = new URLSearchParams({ social_error: code });
  if (intent === 'signup' && context?.inviteToken) q.set('inviteToken', context.inviteToken);
  if (intent === 'signup' && context?.transmissionToken) q.set('transmissionToken', context.transmissionToken);
  if (intent === 'signup' && context?.referralCode) q.set('ref', context.referralCode);
  return `${base}?${q.toString()}`;
}

/** 404 identique pour un fournisseur inactif ou inconnu (aucune information). */
export function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
}

// ── Limitation (§33 « OAuth start/callback ») ───────────────────────────────

export async function oauthRateLimited(request: NextRequest, kind: 'start' | 'callback'): Promise<boolean> {
  if (!authRateLimitEnabled()) return false;
  const policy = kind === 'start' ? AUTH_LIMITS.oauthStartIp : AUTH_LIMITS.oauthCallbackIp;
  const d = await getAuthRateLimiter().consume([{ key: limitKey('oauth', kind === 'start' ? 'ip' : 'pair', getClientIp(request.headers)), policy }]);
  return !d.allowed;
}

// ── Démarrage ───────────────────────────────────────────────────────────────

const CONTEXT_TOKEN = /^[A-Za-z0-9._~-]{8,200}$/;
const REFERRAL = /^[A-Z0-9-]{3,40}$/;

/** Contexte d'inscription lu de la requête de démarrage, filtré (jamais reconstruit plus tard). */
export function contextFromQuery(q: URLSearchParams): TxContext | { error: 'APP_RETURN_NOT_CONFIGURED' | 'APP_CHALLENGE_INVALID' } {
  const ctx: TxContext = { client: 'web' };
  const ret = q.get('returnUrl');
  if (ret) ctx.returnUrl = safeReturnUrl(ret);
  const invite = q.get('inviteToken');
  if (invite && CONTEXT_TOKEN.test(invite)) ctx.inviteToken = invite;
  const transmission = q.get('transmissionToken');
  if (transmission && CONTEXT_TOKEN.test(transmission)) ctx.transmissionToken = transmission;
  const ref = (q.get('ref') ?? '').trim().toUpperCase();
  if (ref && REFERRAL.test(ref)) ctx.referralCode = ref;
  if (q.get('client') === 'app') {
    if (!appReturnUrl()) return { error: 'APP_RETURN_NOT_CONFIGURED' };
    const challenge = q.get('app_challenge') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return { error: 'APP_CHALLENGE_INVALID' };
    ctx.client = 'app';
    ctx.appChallenge = challenge;
  }
  return ctx;
}

export interface StartedFlow {
  url: string;
  binding: string;
  txId: number;
}

export async function startFlow(input: {
  request: NextRequest;
  cfg: ProviderConfig;
  intent: OAuthIntent;
  context: TxContext;
  userId?: number | null;
  sessionSid?: string | null;
  loginHint?: string | null;
}): Promise<StartedFlow> {
  const binding = ensureBinding(input.request);
  const tx = await createTransaction({
    provider: input.cfg.provider, intent: input.intent, binding, context: input.context,
    userId: input.userId ?? null, sessionSid: input.sessionSid ?? null,
  });
  void logUserActivity({
    activityType: 'OAUTH_START',
    userId: input.userId ?? null,
    userEmail: '',
    details: { provider: input.cfg.provider, intent: input.intent, client: input.context.client, authTransactionId: tx.id },
    request: input.request,
  });
  const url = buildAuthorizationUrl(input.cfg, {
    state: tx.state, nonce: tx.nonce, codeChallenge: tx.codeChallenge, reauth: input.intent === 'reauth', loginHint: input.loginHint,
  });
  return { url, binding, txId: tx.id };
}

// ── Lot 97B : association / confirmation depuis l'APPLICATION ──────────────
//
// La vue de l'app (session + réauthentification 5 min) ne fait JAMAIS l'OAuth
// elle-même (PO M1) : elle crée la transaction puis ouvre dans le navigateur
// système `/api/auth/oauth/app/continue?ticket=…` (ticket à usage unique) ; ce
// navigateur reçoit sa liaison (`vb_oauth`) et part chez le fournisseur. Au
// retour, aucun effet dans le navigateur système (il n'a pas de session) :
// un code d'échange (2 min) repart vers l'app, qui le présente avec son
// vérificateur PKCE DEPUIS SA VUE (cookies de session) — l'association ou la
// preuve de réauthentification est alors appliquée à CETTE session.

/** Corps `{ client: 'app', appChallenge }` des routes link / reauth (null : parcours web). */
export function appAccountContextFromBody(body: Record<string, unknown>): TxContext | { error: 'APP_RETURN_NOT_CONFIGURED' | 'APP_CHALLENGE_INVALID' } | null {
  if (body.client !== 'app') return null;
  if (!appReturnUrl()) return { error: 'APP_RETURN_NOT_CONFIGURED' };
  const challenge = typeof body.appChallenge === 'string' ? body.appChallenge : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return { error: 'APP_CHALLENGE_INVALID' };
  return { client: 'app', appChallenge: challenge };
}

/** Réponse d'erreur des routes link / reauth pour un contexte d'app invalide. */
export function appContextErrorResponse(code: 'APP_RETURN_NOT_CONFIGURED' | 'APP_CHALLENGE_INVALID'): NextResponse {
  const message = code === 'APP_RETURN_NOT_CONFIGURED'
    ? 'Cette action n’est pas encore disponible dans l’application. Utilisez le site Verebona.'
    : 'Demande invalide. Recommencez depuis l’application.';
  return NextResponse.json({ error: message, code, message }, { status: code === 'APP_RETURN_NOT_CONFIGURED' ? 409 : 400 });
}

/** Adresse à ouvrir dans le navigateur système (pure, testée). */
export function appContinueUrl(ticket: string): string {
  return absolute(`/api/auth/oauth/app/continue?${new URLSearchParams({ ticket }).toString()}`);
}

/**
 * Crée la transaction « link » / « reauth » de l'app, liée à l'utilisateur et
 * à la session de la vue (jamais au cookie de liaison de la vue : le retour se
 * fait dans le navigateur système). Rend l'adresse d'ouverture.
 */
export async function startAppAccountFlow(input: {
  request: NextRequest; cfg: ProviderConfig; intent: 'link' | 'reauth'; context: TxContext; userId: number; sessionSid: string | null;
}): Promise<{ redirectUrl: string; txId: number }> {
  const ticket = randomToken(32);
  const tx = await createTransaction({
    provider: input.cfg.provider, intent: input.intent, binding: randomToken(32), context: input.context,
    userId: input.userId, sessionSid: input.sessionSid, appTicket: ticket,
  });
  void logUserActivity({
    activityType: 'OAUTH_START',
    userId: input.userId,
    userEmail: '',
    details: { provider: input.cfg.provider, intent: input.intent, client: 'app', authTransactionId: tx.id },
    request: input.request,
  });
  return { redirectUrl: appContinueUrl(ticket), txId: tx.id };
}

/** `GET /api/auth/oauth/app/continue?ticket=` — navigateur système : liaison puis fournisseur. */
export async function continueAppTicket(request: NextRequest, ticket: string | null): Promise<NextResponse> {
  const claimed = ticket ? await claimAppTicket(ticket) : null;
  const cfg = claimed ? getProviderConfig(claimed.tx.provider) : null;
  if (!claimed || !cfg) {
    void logUserActivity({
      activityType: 'OAUTH_CALLBACK_FAILED', userId: claimed?.tx.userId ?? null, userEmail: '',
      details: { provider: claimed?.tx.provider ?? null, intent: claimed?.tx.intent ?? 'link', reason: 'app_ticket_invalid', authTransactionId: claimed?.tx.id ?? null },
      request,
    });
    if (claimed) void markFailed(claimed.tx.id, 'provider_disabled').catch(() => {});
    return redirectTo(errorPath('link', 'OAUTH_STATE_INVALID', { client: 'app' }));
  }
  const url = buildAuthorizationUrl(cfg, {
    state: claimed.state, nonce: claimed.nonce, codeChallenge: pkceChallenge(claimed.tx.codeVerifier), reauth: claimed.tx.intent === 'reauth',
  });
  const res = NextResponse.redirect(url, 302);
  setBindingCookie(res, claimed.binding);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** Fin du passage chez le fournisseur pour l'app : code d'échange vers l'app (aucun effet ici). */
async function handoffAccountToApp(request: NextRequest, tx: AuthTransaction): Promise<NextResponse> {
  const ret = appReturnUrl();
  if (!ret || !tx.userId) return callbackFailure(tx, tx.intent, 'OAUTH_STATE_INVALID', 'app_return_missing', request);
  const handoff = randomToken(32);
  const moved = await transition(tx.id, 'received', 'handoff', {
    handoffHash: sha256Hex(handoff), expiresAt: new Date(Date.now() + APP_HANDOFF_TTL_MS),
  });
  if (!moved) return callbackFailure(null, tx.intent, 'OAUTH_STATE_INVALID', 'state_replayed', request);
  const res = NextResponse.redirect(`${ret}?${new URLSearchParams({ handoff }).toString()}`, 302);
  clearBindingCookie(res);
  return res;
}

type AccountExchangeFailure = { code: SocialErrorCode; status: number };

/**
 * Échange (vue de l'app) d'une association / confirmation : la session qui
 * présente le code doit être CELLE qui a démarré le parcours (même compte,
 * même `sid`) ; puis mêmes règles que sur le site (identité déjà liée
 * ailleurs refusée, même subject exigé, preuve 5 min de CETTE session).
 */
export async function completeAppAccountExchange(request: NextRequest, tx: AuthTransaction): Promise<NextResponse> {
  const fail = (f: AccountExchangeFailure, reason: string) => {
    void logUserActivity({
      activityType: tx.intent === 'reauth' && f.code === 'REAUTH_SUBJECT_MISMATCH' ? 'REAUTH_FAILED' : 'OAUTH_CALLBACK_FAILED',
      userId: tx.userId, userEmail: '',
      details: tx.intent === 'reauth' && f.code === 'REAUTH_SUBJECT_MISMATCH'
        ? { method: tx.provider, reason }
        : { provider: tx.provider, intent: tx.intent, reason, authTransactionId: tx.id, client: 'app' },
      request,
    });
    const message = socialErrorMessage(f.code)!;
    return NextResponse.json({ error: message, code: f.code, message }, { status: f.status });
  };
  if (!tx.userId || !tx.claims || !(await sessionOwnsTransaction(request, tx))) {
    return fail({ code: 'SESSION_EXPIRED', status: 401 }, 'session_mismatch');
  }
  if (tx.intent === 'link') {
    const outcome = await linkIdentity(tx.userId, tx.claims);
    if (!outcome.ok) return fail({ code: outcome.code, status: 409 }, outcome.code.toLowerCase());
    if (!outcome.alreadyLinked) await notifyIdentityChange(request, tx.userId, await userEmail(tx.userId), tx.provider, 'linked', 'security_app');
    return NextResponse.json({ success: true, intent: 'link', provider: tx.provider, redirectTo: `${SECURITY_PAGE}?securite=linked&provider=${tx.provider}#securite` });
  }
  // reauth — REAUTH-04/05 : même subject que l'identité liée à CE compte.
  const identity = await findIdentityBySubject(tx.claims.provider, tx.claims.issuer, tx.claims.subject);
  if (!identity || identity.userId !== tx.userId || identity.provider !== tx.provider) {
    return fail({ code: 'REAUTH_SUBJECT_MISMATCH', status: 403 }, 'subject_mismatch');
  }
  await touchIdentity(identity.id, tx.claims);
  try {
    await issueReauthProof(tx.userId, tx.sessionSid!, tx.provider, { request });
  } catch (e) {
    if (!(e instanceof ReauthError)) throw e;
    return fail({ code: 'SESSION_EXPIRED', status: 401 }, 'session_revoked');
  }
  const resume = tx.context.resume && /^[a-z-]{3,40}$/.test(tx.context.resume) ? `&resume=${tx.context.resume}` : '';
  return NextResponse.json({ success: true, intent: 'reauth', provider: tx.provider, redirectTo: `${SECURITY_PAGE}?securite=reauth&provider=${tx.provider}${resume}#securite` });
}

/** Attache au parcours de connexion l'étape d'inscription en attente de ce navigateur (§8.1 via un autre fournisseur). */
export async function pendingLinkContext(request: NextRequest, provider: OAuthProvider): Promise<number | null> {
  const pending = await findAwaitingByBinding(readBinding(request));
  if (!pending || pending.provider === provider) return null;
  return pending.id;
}

// ── Retour du fournisseur ───────────────────────────────────────────────────

export interface CallbackParams {
  state: string | null;
  code: string | null;
  error: string | null;
  /** Apple : paramètre `user` (nom, première autorisation seulement). */
  appleUser?: string | null;
}

function callbackFailure(tx: AuthTransaction | null, intent: OAuthIntent, code: SocialErrorCode, reason: string, request: NextRequest, status: 302 | 303 = 302): NextResponse {
  void logUserActivity({
    activityType: 'OAUTH_CALLBACK_FAILED',
    userId: tx?.userId ?? null,
    userEmail: '',
    details: { provider: tx?.provider ?? null, intent, reason, authTransactionId: tx?.id ?? null },
    request,
  });
  if (intent === 'reauth' && code === 'REAUTH_NOT_RECENT') {
    void logUserActivity({ activityType: 'REAUTH_FAILED', userId: tx?.userId ?? null, userEmail: '', details: { method: tx?.provider ?? null, reason: 'not_recent' }, request });
  }
  if (tx) void markFailed(tx.id, reason).catch(() => {});
  return redirectTo(errorPath(intent, code, tx?.context), status);
}

/** Échange du code et validation de l'id_token → identité normalisée (rien n'est journalisé du contenu). */
async function identityFromCode(cfg: ProviderConfig, tx: AuthTransaction, code: string, appleUser: string | null | undefined): Promise<TxClaims> {
  const tokens = await exchangeCode(cfg, code, tx.codeVerifier);
  const claims = await validateIdToken(tokens.idToken, { provider: cfg.provider, clientId: cfg.clientId, nonceHash: tx.nonceHash });
  // Lot 96B (P2) : une réauthentification exige une authentification RÉCENTE chez le fournisseur.
  if (tx.intent === 'reauth') assertFreshProviderAuth(claims);
  const identity = normalizeIdentity(cfg.provider, claims, cfg.provider === 'apple' ? parseAppleUserParam(appleUser) : undefined);
  return { ...identity, refreshTokenCiphertext: tokens.refreshToken ? encryptProviderToken(tokens.refreshToken) : null };
}

/** Code affiché : authentification fournisseur trop ancienne (P2) → message dédié. */
function providerFailureCode(e: unknown): SocialErrorCode {
  return e instanceof OAuthProviderError && e.code === 'ID_TOKEN_AUTH_TIME' ? 'REAUTH_NOT_RECENT' : 'OAUTH_PROVIDER_ERROR';
}

/**
 * Apple `form_post` : requête INTER-SITES (aucun cookie SameSite=Lax). Le
 * code est échangé et l'identité validée mise de côté ; le navigateur est
 * renvoyé en GET (navigation de premier niveau : cookies présents), où la
 * liaison au navigateur est vérifiée AVANT tout effet.
 */
export async function handleFormPost(request: NextRequest, cfg: ProviderConfig, p: CallbackParams): Promise<NextResponse> {
  const tx = p.state ? await findByState(p.state) : null;
  if (!tx || tx.provider !== cfg.provider || tx.status !== 'pending') {
    return callbackFailure(null, tx?.intent ?? 'login', 'OAUTH_STATE_INVALID', tx ? 'state_replayed' : 'state_unknown', request, 303);
  }
  if (p.error || !p.code) {
    return callbackFailure(tx, tx.intent, 'OAUTH_CANCELLED', p.error === 'user_cancelled_authorize' || p.error === 'access_denied' ? 'cancelled' : 'provider_error', request, 303);
  }
  let claims: TxClaims;
  try {
    claims = await identityFromCode(cfg, tx, p.code, p.appleUser);
  } catch (e) {
    const reason = e instanceof OAuthProviderError ? e.code : 'exchange_error';
    return callbackFailure(tx, tx.intent, providerFailureCode(e), reason, request, 303);
  }
  const moved = await transition(tx.id, 'pending', 'received', { claims });
  if (!moved) return callbackFailure(tx, tx.intent, 'OAUTH_STATE_INVALID', 'state_replayed', request, 303);
  const q = new URLSearchParams({ state: p.state! });
  return redirectTo(`/api/auth/oauth/${cfg.provider}/callback?${q.toString()}`, 303);
}

/** Retour GET : Google (code), ou reprise Apple après `form_post`. */
export async function handleCallback(request: NextRequest, cfg: ProviderConfig, p: CallbackParams): Promise<NextResponse> {
  const tx = p.state ? await findByState(p.state) : null;
  if (!tx || tx.provider !== cfg.provider) return callbackFailure(null, 'login', 'OAUTH_STATE_INVALID', 'state_unknown', request);
  // Liaison au navigateur qui a démarré le parcours (§12.2) — avant tout effet.
  if (!bindingMatches(tx, readBinding(request))) return callbackFailure(tx, tx.intent, 'OAUTH_STATE_INVALID', 'binding_mismatch', request);

  let ready: AuthTransaction | null = null;
  if (tx.status === 'pending') {
    if (p.error || !p.code) return callbackFailure(tx, tx.intent, 'OAUTH_CANCELLED', p.error === 'access_denied' ? 'cancelled' : 'provider_error', request);
    let claims: TxClaims;
    try {
      claims = await identityFromCode(cfg, tx, p.code, null);
    } catch (e) {
      const reason = e instanceof OAuthProviderError ? e.code : 'exchange_error';
      return callbackFailure(tx, tx.intent, providerFailureCode(e), reason, request);
    }
    ready = await transition(tx.id, 'pending', 'received', { claims });
  } else if (tx.status === 'received' && !p.code) {
    ready = tx;
  }
  // Retour rejoué (transaction consommée, expirée, ou course perdue) : refus, sans session (E2E-23).
  if (!ready || !ready.claims || ready.expiresAt.getTime() <= Date.now()) {
    return callbackFailure(null, tx.intent, 'OAUTH_STATE_INVALID', 'state_replayed', request);
  }

  void logUserActivity({
    activityType: 'OAUTH_CALLBACK_SUCCESS',
    userId: tx.userId,
    userEmail: '',
    details: { provider: tx.provider, intent: tx.intent, authTransactionId: tx.id, privateRelay: ready.claims.isPrivateRelay },
    request,
  });

  if (ready.intent === 'link') return completeLink(request, ready);
  if (ready.intent === 'reauth') return completeReauth(request, ready);
  return completeLogin(request, ready);
}

// ── Connexion / inscription ─────────────────────────────────────────────────

async function completeLogin(request: NextRequest, tx: AuthTransaction): Promise<NextResponse> {
  const claims = tx.claims!;
  const identity = await findIdentityBySubject(claims.provider, claims.issuer, claims.subject);

  if (identity) {
    // Provider lié : connexion sur le subject stable, même si l'adresse a changé (§9.4).
    const eligibility = await checkSessionEligibility(identity.userId);
    if (!eligibility.ok) {
      void logUserActivity({
        activityType: 'LOGIN_FAILED', userId: eligibility.userId ?? identity.userId, userEmail: eligibility.email ?? '',
        details: { reason: eligibility.code.toLowerCase(), loginMethod: claims.provider }, request,
      });
      const code: SocialErrorCode = eligibility.code === 'USER_NOT_FOUND' ? 'OAUTH_STATE_INVALID' : eligibility.code;
      return callbackFailure(tx, tx.intent, code, eligibility.code.toLowerCase(), request);
    }
    await touchIdentity(identity.id, claims);

    // Rattachement en attente prouvé par CE fournisseur déjà lié (§8.1, §18.2).
    let linkedPending: OAuthProvider | null = null;
    if (tx.context.pendingLinkTxId) {
      linkedPending = await linkPendingTransaction(request, tx.context.pendingLinkTxId, eligibility.user.id, eligibility.user.email);
    }
    return finishWithSession(request, tx, ['received'], eligibility.user.id, claims.provider, 'redirect', linkedPending ? { linkedProvider: linkedPending } : {});
  }

  // Aucune identité liée : jamais de rattachement silencieux sur l'adresse
  // (§8.1, LOGIN-04). Adresse vérifiée par le fournisseur et portée par un
  // compte → seul le rattachement est proposé (création interdite, SIGN-06) ;
  // sinon → « Vous avez déjà un compte Verebona ? » (§8.2, SIGN-07).
  const existing = claims.email && claims.emailVerified ? await emailHasAccount(claims.email) : null;
  const stage = existing ? 'existing_email' : 'choice';
  const moved = await transition(tx.id, 'received', 'awaiting_user', {
    stage, expiresAt: new Date(Date.now() + PENDING_SIGNUP_TTL_MS),
  });
  if (!moved) return callbackFailure(null, tx.intent, 'OAUTH_STATE_INVALID', 'state_replayed', request);
  const res = redirectTo(PENDING_PAGE);
  setBindingCookie(res, readBinding(request)!);
  return res;
}

/**
 * Lie l'identité d'une étape d'inscription en attente (même navigateur) au
 * compte qui vient de s'authentifier complètement. Rend le fournisseur lié,
 * ou `null` (conflit : refus sans déplacement, §8.3).
 */
export async function linkPendingTransaction(request: NextRequest, pendingTxId: number, userId: number, userEmail: string): Promise<OAuthProvider | null> {
  const pending = await findById(pendingTxId);
  if (!pending || pending.status !== 'awaiting_user' || !pending.claims) return null;
  if (!bindingMatches(pending, readBinding(request))) return null;
  const consumed = await transition(pending.id, 'awaiting_user', 'consumed', { userId });
  if (!consumed) return null;
  const outcome = await linkIdentity(userId, pending.claims);
  if (!outcome.ok) {
    void logUserActivity({
      activityType: 'OAUTH_CALLBACK_FAILED', userId, userEmail,
      details: { provider: pending.provider, intent: 'link_existing', reason: outcome.code, authTransactionId: pending.id }, request,
    });
    return null;
  }
  if (!outcome.alreadyLinked) await notifyIdentityChange(request, userId, userEmail, pending.provider, 'linked', 'existing_account');
  return pending.provider;
}

/**
 * Fin de parcours avec session : web → cookies + page d'arrivée ; application
 * mobile → code d'échange à usage unique (2 min) vers APP_OAUTH_RETURN_URL
 * (§21.3), la session étant émise à l'échange par l'application.
 */
export async function finishWithSession(
  request: NextRequest,
  tx: AuthTransaction,
  from: Array<'received' | 'awaiting_user'>,
  userId: number,
  method: OAuthProvider,
  mode: 'redirect' | 'json',
  extra: Record<string, unknown> = {},
): Promise<NextResponse> {
  const eligibility = await checkSessionEligibility(userId);
  if (!eligibility.ok) {
    const code: SocialErrorCode = eligibility.code === 'USER_NOT_FOUND' ? 'OAUTH_STATE_INVALID' : eligibility.code;
    await markFailed(tx.id, eligibility.code.toLowerCase());
    return mode === 'redirect'
      ? redirectTo(errorPath(tx.intent, code, tx.context))
      : NextResponse.json({ error: code, code }, { status: 403 });
  }

  if (tx.context.client === 'app') {
    const handoff = randomToken(32);
    const moved = await transition(tx.id, from, 'handoff', {
      handoffHash: sha256Hex(handoff), userId, expiresAt: new Date(Date.now() + APP_HANDOFF_TTL_MS),
    });
    if (!moved) return mode === 'redirect' ? redirectTo(errorPath(tx.intent, 'OAUTH_STATE_INVALID')) : NextResponse.json({ code: 'OAUTH_STATE_INVALID' }, { status: 409 });
    const target = `${appReturnUrl()}?${new URLSearchParams({ handoff }).toString()}`;
    const res = mode === 'redirect' ? NextResponse.redirect(target, 302) : NextResponse.json({ success: true, redirectTo: target });
    clearBindingCookie(res);
    return res;
  }

  const moved = await transition(tx.id, from, 'consumed', { userId });
  if (!moved) {
    return mode === 'redirect'
      ? redirectTo(errorPath(tx.intent, 'OAUTH_STATE_INVALID'))
      : NextResponse.json({ error: 'OAUTH_STATE_INVALID', code: 'OAUTH_STATE_INVALID' }, { status: 409 });
  }
  const target = safeInternalPath(landingPath(eligibility.user, tx.context.returnUrl));
  const res = mode === 'redirect' ? redirectTo(target) : NextResponse.json({ success: true, redirectTo: target });
  await openSocialSession(request, res, eligibility.user, method, { authTransactionId: tx.id, ...extra });
  clearBindingCookie(res);
  return res;
}

// ── Liaison depuis Mon compte › Sécurité ────────────────────────────────────

/** La session de la requête est-elle celle qui a démarré la transaction ? */
async function sessionOwnsTransaction(request: NextRequest, tx: AuthTransaction): Promise<boolean> {
  try {
    const payload = await verifySessionAccessToken(extractAccessToken(request), request);
    return !!payload && payload.userId === tx.userId && !!tx.sessionSid && payload.sid === tx.sessionSid;
  } catch {
    return false;
  }
}

async function completeLink(request: NextRequest, tx: AuthTransaction): Promise<NextResponse> {
  if (tx.context.client === 'app') return handoffAccountToApp(request, tx);
  if (!tx.userId || !(await sessionOwnsTransaction(request, tx))) {
    return callbackFailure(tx, 'link', 'SESSION_EXPIRED', 'session_mismatch', request);
  }
  const outcome = await linkIdentity(tx.userId, tx.claims!);
  if (!outcome.ok) return callbackFailure(tx, 'link', outcome.code, outcome.code.toLowerCase(), request);
  const consumed = await transition(tx.id, 'received', 'consumed');
  if (!consumed) return callbackFailure(null, 'link', 'OAUTH_STATE_INVALID', 'state_replayed', request);
  const email = await userEmail(tx.userId);
  if (!outcome.alreadyLinked) await notifyIdentityChange(request, tx.userId, email, tx.provider, 'linked', 'security');
  const res = redirectTo(`${SECURITY_PAGE}?securite=linked&provider=${tx.provider}#securite`);
  clearBindingCookie(res);
  return res;
}

async function completeReauth(request: NextRequest, tx: AuthTransaction): Promise<NextResponse> {
  if (tx.context.client === 'app') return handoffAccountToApp(request, tx);
  if (!tx.userId || !(await sessionOwnsTransaction(request, tx))) {
    return callbackFailure(tx, 'reauth', 'SESSION_EXPIRED', 'session_mismatch', request);
  }
  const claims = tx.claims!;
  const identity = await findIdentityBySubject(claims.provider, claims.issuer, claims.subject);
  // REAUTH-04/05 : même subject que l'identité liée à CE compte.
  if (!identity || identity.userId !== tx.userId || identity.provider !== tx.provider) {
    void logUserActivity({ activityType: 'REAUTH_FAILED', userId: tx.userId, userEmail: '', details: { method: tx.provider, reason: 'subject_mismatch' }, request });
    return callbackFailure(tx, 'reauth', 'REAUTH_SUBJECT_MISMATCH', 'subject_mismatch', request);
  }
  const consumed = await transition(tx.id, 'received', 'consumed');
  if (!consumed) return callbackFailure(null, 'reauth', 'OAUTH_STATE_INVALID', 'state_replayed', request);
  await touchIdentity(identity.id, claims);
  const resume = tx.context.resume && /^[a-z-]{3,40}$/.test(tx.context.resume) ? `&resume=${tx.context.resume}` : '';
  // Preuve SERVEUR du lot 92, liée à la session qui a démarré la réauthentification.
  try {
    await issueReauthProof(tx.userId, tx.sessionSid!, tx.provider, { request });
  } catch (e) {
    if (!(e instanceof ReauthError)) throw e;
    return callbackFailure(null, 'reauth', 'SESSION_EXPIRED', 'session_revoked', request);
  }
  const res = redirectTo(`${SECURITY_PAGE}?securite=reauth&provider=${tx.provider}${resume}#securite`);
  clearBindingCookie(res);
  return res;
}

// ── Notifications et journal (NOTIF-01, §23.1) ──────────────────────────────

async function userEmail(userId: number): Promise<string> {
  const { pgClient } = await import('@/db');
  const [u] = await pgClient<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}`;
  return u?.email ?? '';
}

export async function notifyIdentityChange(
  request: NextRequest, userId: number, email: string, provider: OAuthProvider, kind: 'linked' | 'unlinked', context: string,
): Promise<void> {
  // Lot 96A (CDC 18 Q7) : association / dissociation = changement d'identifiant —
  // toute preuve de réauthentification de l'utilisateur est retirée (toutes sessions).
  const { invalidateReauthProofs } = await import('@/lib/auth/reauth');
  await invalidateReauthProofs(userId, { reason: `identity_${kind}` });
  void logUserActivity({
    activityType: kind === 'linked' ? 'IDENTITY_LINKED' : 'IDENTITY_UNLINKED',
    userId, userEmail: email, details: { provider, context }, request,
  });
  try {
    await emit({
      type: kind === 'linked' ? 'AUTH_IDENTITY_LINKED' : 'AUTH_IDENTITY_UNLINKED',
      recipientUserIds: [userId],
      entityType: 'user',
      entityId: userId,
      payload: { provider },
      dedupeKey: `security:identity-${kind}:${userId}:${provider}:${Date.now()}`,
    });
  } catch (e) {
    // Une notification en échec n'annule jamais l'action déjà enregistrée (§37).
    console.error(`[oauth] notification ${kind} (${PROVIDER_LABEL[provider]}) en échec :`, (e as Error)?.message ?? e);
  }
}

export function providerConfigOr404(provider: string): ProviderConfig | null {
  if (provider !== 'google' && provider !== 'apple') return null;
  return getProviderConfig(provider);
}
