/**
 * Connexion Google / Apple — configuration (lot 93, CDC 18 §12.2, §32, §36).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INACTIF TANT QUE LES VARIABLES NE SONT PAS POSÉES
 *
 * Un fournisseur n'est actif que si TOUS ses identifiants sont présents
 * (variables Scalingo, jamais dans le code) :
 *
 *   Google : GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
 *   Apple  : APPLE_SIGNIN_CLIENT_ID (Services ID), APPLE_SIGNIN_TEAM_ID,
 *            APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_PRIVATE_KEY (contenu du .p8)
 *
 * Inactif : boutons masqués, routes `/api/auth/oauth/<fournisseur>/*` en 404.
 *
 * Interrupteurs (CDC §36, feature flags) : AUTH_SOCIAL_GOOGLE=off /
 * AUTH_SOCIAL_APPLE=off coupent un fournisseur même configuré (les comptes
 * « Google uniquement » ne peuvent alors plus se connecter : plan de repli
 * = « Mot de passe oublié » n'aide pas, voir la documentation d'exploitation).
 *
 * URL de retour EXACTE (liste blanche chez le fournisseur, §12.2) :
 *   <base>/api/auth/oauth/google/callback
 *   <base>/api/auth/oauth/apple/callback
 * <base> = OAUTH_REDIRECT_BASE_URL, sinon NEXT_PUBLIC_APP_URL. Jamais déduite
 * des en-têtes de la requête (un hôte forgé ne doit pas changer l'URL).
 *
 * Application mobile (§21.3) : APP_OAUTH_RETURN_URL = adresse de retour vers
 * l'application (Universal Link / App Link vérifié). Absente : le parcours
 * « application » est refusé, le web fonctionne.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type OAuthProvider = 'google' | 'apple';
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'apple'];

export const PROVIDER_LABEL: Readonly<Record<OAuthProvider, string>> = { google: 'Google', apple: 'Apple' };

type Env = Record<string, string | undefined>;

interface ProviderEndpoints {
  /** Issuers acceptés (le premier est la valeur enregistrée). */
  issuers: readonly string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
  scope: string;
}

export const PROVIDER_ENDPOINTS: Readonly<Record<OAuthProvider, ProviderEndpoints>> = {
  google: {
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    // Scopes minimaux (§12.2, §32).
    scope: 'openid email profile',
  },
  apple: {
    issuers: ['https://appleid.apple.com'],
    authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
    tokenEndpoint: 'https://appleid.apple.com/auth/token',
    jwksUri: 'https://appleid.apple.com/auth/keys',
    revocationEndpoint: 'https://appleid.apple.com/auth/revoke',
    scope: 'name email',
  },
};

export interface GoogleConfig {
  provider: 'google';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  pkce: true;
}

export interface AppleConfig {
  provider: 'apple';
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  redirectUri: string;
  /** Paramètres PKCE envoyés à Apple (APPLE_SIGNIN_PKCE=off pour les retirer). */
  pkce: boolean;
}

export type ProviderConfig = GoogleConfig | AppleConfig;

const trim = (v: string | undefined) => (v ?? '').trim();
const isOff = (v: string | undefined) => ['off', '0', 'false', 'non', 'no'].includes(trim(v).toLowerCase());

/** Base des URL de retour (sans `/` final), ou `null` si rien n'est configuré. */
export function oauthRedirectBase(env: Env = process.env): string | null {
  const raw = trim(env.OAUTH_REDIRECT_BASE_URL) || trim(env.NEXT_PUBLIC_APP_URL);
  if (!raw) return env.NODE_ENV === 'production' ? null : 'http://localhost:3000';
  try {
    const u = new URL(raw);
    if (env.NODE_ENV === 'production' && u.protocol !== 'https:') return null;
    return `${u.origin}`;
  } catch {
    return null;
  }
}

export function callbackUrl(provider: OAuthProvider, env: Env = process.env): string | null {
  const base = oauthRedirectBase(env);
  return base ? `${base}/api/auth/oauth/${provider}/callback` : null;
}

/** Clé privée .p8 : accepte le contenu PEM avec de vrais retours à la ligne ou des `\n` littéraux. */
export function normalizePem(raw: string): string {
  const s = raw.replace(/\\n/g, '\n').trim();
  if (s.includes('-----BEGIN')) return s;
  // Contenu base64 seul (sans en-têtes) : on le remet en forme.
  const body = s.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

/** Configuration d'un fournisseur, ou `null` s'il est inactif. */
export function getProviderConfig(provider: OAuthProvider, env: Env = process.env): ProviderConfig | null {
  if (provider === 'google') {
    if (isOff(env.AUTH_SOCIAL_GOOGLE)) return null;
    const clientId = trim(env.GOOGLE_OAUTH_CLIENT_ID);
    const clientSecret = trim(env.GOOGLE_OAUTH_CLIENT_SECRET);
    const redirectUri = callbackUrl('google', env);
    if (!clientId || !clientSecret || !redirectUri) return null;
    return { provider, clientId, clientSecret, redirectUri, pkce: true };
  }
  if (provider === 'apple') {
    if (isOff(env.AUTH_SOCIAL_APPLE)) return null;
    const clientId = trim(env.APPLE_SIGNIN_CLIENT_ID);
    const teamId = trim(env.APPLE_SIGNIN_TEAM_ID);
    const keyId = trim(env.APPLE_SIGNIN_KEY_ID);
    const key = trim(env.APPLE_SIGNIN_PRIVATE_KEY);
    const redirectUri = callbackUrl('apple', env);
    if (!clientId || !teamId || !keyId || !key || !redirectUri) return null;
    return { provider, clientId, teamId, keyId, privateKeyPem: normalizePem(key), redirectUri, pkce: !isOff(env.APPLE_SIGNIN_PKCE) };
  }
  return null;
}

export function isOAuthProvider(v: unknown): v is OAuthProvider {
  return v === 'google' || v === 'apple';
}

/** Fournisseurs actifs (pour l'affichage des boutons). */
export function enabledProviders(env: Env = process.env): Record<OAuthProvider, boolean> {
  return { google: !!getProviderConfig('google', env), apple: !!getProviderConfig('apple', env) };
}

/** Retour vers l'application mobile (§21.3), ou `null` si non configuré. */
export function appReturnUrl(env: Env = process.env): string | null {
  const raw = trim(env.APP_OAUTH_RETURN_URL);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.search || u.hash) return null; // adresse exacte, sans paramètres
    return u.toString();
  } catch {
    return null;
  }
}

/** Durées (CDC 18 §19.2). */
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;
/** Étape d'inscription en attente après le retour du fournisseur (profil, choix). */
export const PENDING_SIGNUP_TTL_MS = 30 * 60 * 1000;
/** Code de vérification d'adresse (inscription sociale avec une autre adresse). */
export const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_MIN_MS = 60 * 1000;
/** Échange application ↔ serveur après le retour mobile. */
export const APP_HANDOFF_TTL_MS = 2 * 60 * 1000;
