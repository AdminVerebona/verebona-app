/**
 * Connexion Google / Apple dans l'application — lot 95 (PO M1 ; CDC 18 MOB-10 ;
 * serveur du lot 93 : `start?client=app&app_challenge=…` →
 * `APP_OAUTH_RETURN_URL?handoff=…` → `POST /api/auth/oauth/app/exchange`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS DANS LA WEBVIEW
 *
 * Google refuse les WebView intégrées (`disallowed_useragent`) et M1 impose
 * le navigateur système. Le parcours est ouvert :
 *   · iOS : ASWebAuthenticationSession (plugin local `VerebonaAuthSession`),
 *     qui rend directement l'adresse de retour ;
 *   · Android : Custom Tabs (`@capacitor/browser`) ; le retour arrive par
 *     App Link ou schéma privé (`appUrlOpen`), traité par l'hôte natif.
 * Le vérificateur PKCE ne quitte jamais l'app : tiré ici, conservé dans le
 * Keychain / Keystore le temps du parcours (10 min, usage unique), présenté
 * seulement à l'échange. Un code `handoff` intercepté sans lui est inutile.
 * La session est émise par l'échange (émission unique `issueSession`, lot 92)
 * dans les cookies HttpOnly de la WebView : même compte, mêmes données que
 * sur le site (M1).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { clientPlatformHeaders } from '@/lib/client-platform';
import { NATIVE_PLUGINS, nativePlatform, nativePlugin } from './bridge';
import { SECURE_KEYS, secureGet, secureRemove, secureSet } from './secure-store';
import { appUrlContext } from './shell-info';
import { resolveAppUrl } from './deep-links';
import { OAUTH_APP_RETURN_PATH } from '@/lib/mobile/app-links';
import { nativeOAuthReturn } from './features';

export type SocialProvider = 'google' | 'apple';

/** Durée de vie d'un parcours en attente de retour. */
export const NATIVE_OAUTH_TTL_MS = 10 * 60 * 1000;

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Vérificateur PKCE : 32 octets aléatoires → 43 caractères base64url (RFC 7636). */
export function newPkceVerifier(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return base64url(b);
}

/** Défi S256 = base64url(SHA-256(vérificateur)) — 43 caractères, attendus par `start`. */
export async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** URL de démarrage du parcours « application » (pure). */
export function nativeOAuthStartUrl(
  origin: string, provider: SocialProvider, challenge: string, params: Record<string, string | null | undefined> = {},
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  q.set('client', 'app');
  q.set('app_challenge', challenge);
  return `${origin}/api/auth/oauth/${provider}/start?${q.toString()}`;
}

/**
 * Retour attendu par la session d'authentification iOS (pur, testé) : la
 * forme annoncée par le serveur (`/api/mobile/config` › `auth.appOAuthReturn`).
 * Inconnue : schéma privé (accepté par toutes les versions d'iOS).
 */
export function authSessionCallback(
  kind: 'https' | 'scheme' | null, ctx: { origin: string; urlScheme: string | null },
): { callbackScheme?: string; callbackHost?: string; callbackPath?: string } {
  if (kind === 'https') return { callbackHost: new URL(ctx.origin).host, callbackPath: OAUTH_APP_RETURN_PATH };
  return ctx.urlScheme ? { callbackScheme: ctx.urlScheme } : {};
}

interface PendingOAuth { verifier: string; provider: SocialProvider; startedAt: number }

export type NativeOAuthOutcome =
  | { status: 'signed_in'; redirectTo: string }
  | { status: 'cancelled' }
  | { status: 'pending_return' }
  | { status: 'failed'; message: string };

const MESSAGE_ECHEC = 'La connexion n’a pas pu aboutir. Réessayez, ou utilisez votre e-mail et votre mot de passe.';
const MESSAGE_IOS_ANCIEN = 'Sur cet iPhone, la connexion avec Google ou Apple demande iOS 17.4 ou plus récent. Utilisez votre e-mail et votre mot de passe, ou mettez à jour l’iPhone.';

interface AuthSessionPlugin {
  start(o: { url: string; callbackScheme?: string; callbackHost?: string; callbackPath?: string }): Promise<{ status: 'completed' | 'cancelled'; url?: string }>;
}
interface BrowserPlugin { open(o: { url: string; presentationStyle?: string }): Promise<void>; close?(): Promise<void> }

/**
 * Démarre « Continuer avec Google / Apple » depuis l'app. Sur iOS, attend le
 * retour et termine la connexion ; sur Android, rend `pending_return` (le
 * retour est traité par `completeNativeOAuth` à l'ouverture du lien).
 */
export async function startNativeSocialSignIn(
  provider: SocialProvider, params: Record<string, string | null | undefined> = {},
): Promise<NativeOAuthOutcome> {
  const platform = nativePlatform();
  const ctx = appUrlContext();
  if (!platform || !ctx) return { status: 'failed', message: MESSAGE_ECHEC };

  const verifier = newPkceVerifier();
  const challenge = await pkceChallengeS256(verifier);
  const pending: PendingOAuth = { verifier, provider, startedAt: Date.now() };
  if (!(await secureSet(SECURE_KEYS.oauthVerifier, JSON.stringify(pending)))) return { status: 'failed', message: MESSAGE_ECHEC };
  const url = nativeOAuthStartUrl(ctx.origin, provider, challenge, params);

  const authSession = platform === 'ios' ? nativePlugin<AuthSessionPlugin>(NATIVE_PLUGINS.authSession) : null;
  if (authSession) {
    try {
      const r = await authSession.start({ url, ...authSessionCallback(nativeOAuthReturn(), ctx) });
      if (r.status !== 'completed' || !r.url) { await secureRemove(SECURE_KEYS.oauthVerifier); return { status: 'cancelled' }; }
      const res = resolveAppUrl(r.url, ctx);
      if (res.kind !== 'oauth') { await secureRemove(SECURE_KEYS.oauthVerifier); return { status: 'failed', message: MESSAGE_ECHEC }; }
      return completeNativeOAuth(res.handoff);
    } catch (e) {
      await secureRemove(SECURE_KEYS.oauthVerifier);
      // Retour https annoncé par le serveur mais iOS < 17.4 (VerebonaAuthSession.swift).
      if ((e as { code?: unknown })?.code === 'NO_CALLBACK') return { status: 'failed', message: MESSAGE_IOS_ANCIEN };
      return { status: 'failed', message: MESSAGE_ECHEC };
    }
  }

  const browser = nativePlugin<BrowserPlugin>(NATIVE_PLUGINS.browser);
  if (!browser) { await secureRemove(SECURE_KEYS.oauthVerifier); return { status: 'failed', message: MESSAGE_ECHEC }; }
  try {
    await browser.open({ url, presentationStyle: 'fullscreen' });
    return { status: 'pending_return' };
  } catch {
    await secureRemove(SECURE_KEYS.oauthVerifier);
    return { status: 'failed', message: MESSAGE_ECHEC };
  }
}

/**
 * Termine un parcours : échange du code contre la session (cookies HttpOnly
 * de la WebView). Le vérificateur est consommé dans tous les cas (usage
 * unique) ; un retour sans parcours en cours, expiré ou refusé échoue
 * proprement, sans session incohérente (M1 « échec, annulation, reprise »).
 */
export async function completeNativeOAuth(handoff: string, now: number = Date.now()): Promise<NativeOAuthOutcome> {
  const raw = await secureGet(SECURE_KEYS.oauthVerifier);
  await secureRemove(SECURE_KEYS.oauthVerifier);
  nativePlugin<BrowserPlugin>(NATIVE_PLUGINS.browser)?.close?.().catch(() => {});
  let pending: PendingOAuth | null = null;
  try { pending = raw ? JSON.parse(raw) as PendingOAuth : null; } catch { pending = null; }
  if (!pending || typeof pending.verifier !== 'string' || now - Number(pending.startedAt) > NATIVE_OAUTH_TTL_MS) {
    return { status: 'failed', message: 'Ce lien de connexion a expiré. Recommencez la connexion.' };
  }
  try {
    const res = await fetch('/api/auth/oauth/app/exchange', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...clientPlatformHeaders() },
      body: JSON.stringify({ handoff, verifier: pending.verifier }),
    });
    const body = await res.json().catch(() => ({})) as { success?: boolean; redirectTo?: unknown; error?: unknown };
    if (!res.ok || body.success !== true) {
      return { status: 'failed', message: typeof body.error === 'string' && res.status === 400 ? body.error : MESSAGE_ECHEC };
    }
    const target = typeof body.redirectTo === 'string' && body.redirectTo.startsWith('/') && !body.redirectTo.startsWith('//')
      ? body.redirectTo : '/accueil';
    return { status: 'signed_in', redirectTo: target };
  } catch {
    return { status: 'failed', message: 'Connexion Internet requise pour terminer la connexion.' };
  }
}
