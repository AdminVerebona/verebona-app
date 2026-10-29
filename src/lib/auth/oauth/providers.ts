/**
 * Google / Apple — échanges avec le fournisseur (lot 93, CDC 18 §12.2, §32).
 *
 *   · URL d'autorisation : Authorization Code + PKCE (S256), `state`, `nonce` ;
 *     Apple : `response_mode=form_post` (imposé dès que `name`/`email` sont
 *     demandés) ;
 *   · échange du code (Apple : `client_secret` = JWT ES256 signé avec la clé
 *     .p8, valable 5 minutes, régénéré à chaque échange) ;
 *   · validation STRICTE de l'id_token : algorithme attendu (RS256), clé du
 *     JWKS du fournisseur (cache 1 h, rechargé si `kid` inconnu, au plus une
 *     fois par minute), issuer, audience (= client_id), `azp` si présent,
 *     expiration (tolérance 60 s), `iat` plausible, nonce (comparé à
 *     l'empreinte stockée) ;
 *   · normalisation des attributs (subject, e-mail, vérifié, relais Apple,
 *     prénom / nom) ; aucun jeton fournisseur n'est journalisé.
 *
 * Réseau : `oauthFetch` est remplaçable dans les tests (faux fournisseur OIDC
 * local, `setOAuthFetchForTests`) — aucun appel réseau en test.
 */
import type { JsonWebKey } from 'node:crypto';
import {
  PROVIDER_ENDPOINTS, type AppleConfig, type OAuthProvider, type ProviderConfig,
} from './config';
import { decodeJwt, safeEqual, sha256Hex, signJwt, verifyJwtSignature } from './crypto';

// ── Réseau (injectable) ─────────────────────────────────────────────────────

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike | null = null;

/** Tests : faux fournisseur (aucun appel réseau). `null` : `fetch` global. */
export function setOAuthFetchForTests(f: FetchLike | null): void {
  fetchImpl = f;
  jwksCache.clear();
}

async function oauthFetch(url: string, init?: RequestInit): Promise<Response> {
  const f = fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    return await f(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class OAuthProviderError extends Error {
  constructor(readonly code: OAuthFailureCode, message: string) {
    super(message);
    this.name = 'OAuthProviderError';
  }
}

/** Motifs normalisés (journal ; jamais de jeton ni de valeur de claim). */
export type OAuthFailureCode =
  | 'TOKEN_EXCHANGE_FAILED' | 'ID_TOKEN_MISSING' | 'ID_TOKEN_MALFORMED' | 'ID_TOKEN_ALG'
  | 'ID_TOKEN_KID_UNKNOWN' | 'ID_TOKEN_SIGNATURE' | 'ID_TOKEN_ISSUER' | 'ID_TOKEN_AUDIENCE'
  | 'ID_TOKEN_EXPIRED' | 'ID_TOKEN_IAT' | 'ID_TOKEN_NONCE' | 'ID_TOKEN_SUBJECT' | 'JWKS_UNAVAILABLE'
  | 'ID_TOKEN_AUTH_TIME';

// ── URL d'autorisation ──────────────────────────────────────────────────────

export function buildAuthorizationUrl(
  cfg: ProviderConfig,
  p: { state: string; nonce: string; codeChallenge: string; reauth?: boolean; loginHint?: string | null },
): string {
  const ep = PROVIDER_ENDPOINTS[cfg.provider];
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: ep.scope,
    state: p.state,
    nonce: p.nonce,
  });
  if (cfg.pkce) {
    q.set('code_challenge', p.codeChallenge);
    q.set('code_challenge_method', 'S256');
  }
  if (cfg.provider === 'apple') {
    q.set('response_mode', 'form_post');
  } else {
    // Google : choix explicite du compte. Réauthentification (lot 96B, P2) :
    // `prompt=login` IMPOSE une nouvelle saisie chez Google (une session
    // Google silencieuse ne suffit pas) et `max_age` fait figurer `auth_time`
    // dans l'id_token, vérifié au retour (`assertFreshProviderAuth`).
    q.set('prompt', p.reauth ? 'login' : 'select_account');
    if (p.reauth) q.set('max_age', String(PROVIDER_REAUTH_MAX_AGE_S));
    if (p.loginHint) q.set('login_hint', p.loginHint);
  }
  return `${ep.authorizationEndpoint}?${q.toString()}`;
}

// ── Apple : client_secret signé ─────────────────────────────────────────────

export function appleClientSecret(cfg: AppleConfig, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return signJwt(
    { alg: 'ES256', kid: cfg.keyId, typ: 'JWT' },
    { iss: cfg.teamId, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: cfg.clientId },
    cfg.privateKeyPem,
  );
}

// ── Échange du code ─────────────────────────────────────────────────────────

export interface TokenSet {
  idToken: string;
  /** Apple : conservé chiffré pour la révocation à la suppression du compte. */
  refreshToken: string | null;
}

export async function exchangeCode(cfg: ProviderConfig, code: string, codeVerifier: string): Promise<TokenSet> {
  const ep = PROVIDER_ENDPOINTS[cfg.provider];
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.provider === 'apple' ? appleClientSecret(cfg) : cfg.clientSecret,
  });
  if (cfg.pkce) form.set('code_verifier', codeVerifier);
  let res: Response;
  try {
    res = await oauthFetch(ep.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
  } catch (e) {
    throw new OAuthProviderError('TOKEN_EXCHANGE_FAILED', `échange du code : ${(e as Error)?.name ?? 'erreur réseau'}`);
  }
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* corps illisible */ }
  if (!res.ok) {
    // Seul le code d'erreur OAuth normalisé est conservé (jamais le corps).
    const err = typeof body.error === 'string' ? body.error.slice(0, 60) : `http_${res.status}`;
    throw new OAuthProviderError('TOKEN_EXCHANGE_FAILED', `échange du code refusé (${err})`);
  }
  const idToken = typeof body.id_token === 'string' ? body.id_token : '';
  if (!idToken) throw new OAuthProviderError('ID_TOKEN_MISSING', 'aucun id_token dans la réponse');
  const refreshToken = cfg.provider === 'apple' && typeof body.refresh_token === 'string' ? body.refresh_token : null;
  return { idToken, refreshToken };
}

// ── JWKS (cache) ────────────────────────────────────────────────────────────

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const jwksCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();

async function loadJwks(uri: string, force: boolean, now: number): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(uri);
  if (cached && !force && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  if (cached && force && now - cached.fetchedAt < JWKS_MIN_REFRESH_MS) return cached.keys;
  try {
    const res = await oauthFetch(uri, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    const keys = Array.isArray(body.keys) ? (body.keys as JsonWebKey[]) : [];
    jwksCache.set(uri, { keys, fetchedAt: now });
    return keys;
  } catch (e) {
    if (cached) return cached.keys; // clés précédentes plutôt qu'un refus
    throw new OAuthProviderError('JWKS_UNAVAILABLE', `clés du fournisseur indisponibles (${(e as Error)?.message ?? 'erreur'})`);
  }
}

// ── Validation de l'id_token ────────────────────────────────────────────────

export interface IdTokenExpectations {
  provider: OAuthProvider;
  clientId: string;
  /** Empreinte SHA-256 du nonce envoyé (stockée dans la transaction). */
  nonceHash: string;
  now?: number;
}

const CLOCK_SKEW_S = 60;

export async function validateIdToken(idToken: string, exp: IdTokenExpectations): Promise<Record<string, unknown>> {
  const now = exp.now ?? Date.now();
  const nowS = Math.floor(now / 1000);
  const parts = decodeJwt(idToken);
  if (!parts) throw new OAuthProviderError('ID_TOKEN_MALFORMED', 'id_token illisible');
  // Algorithme IMPOSÉ (jamais `none`, jamais HS256 avec une clé publique).
  if (parts.header.alg !== 'RS256') throw new OAuthProviderError('ID_TOKEN_ALG', 'algorithme de signature inattendu');
  const kid = typeof parts.header.kid === 'string' ? parts.header.kid : null;
  const ep = PROVIDER_ENDPOINTS[exp.provider];

  const pick = (keys: JsonWebKey[]) => keys.find((k) => (k as { kid?: string }).kid === kid && (k.kty === 'RSA'));
  let jwk = kid ? pick(await loadJwks(ep.jwksUri, false, now)) : undefined;
  if (!jwk && kid) jwk = pick(await loadJwks(ep.jwksUri, true, now)); // rotation des clés
  if (!jwk) throw new OAuthProviderError('ID_TOKEN_KID_UNKNOWN', 'clé de signature inconnue');
  if (!verifyJwtSignature(parts, jwk, 'RS256')) throw new OAuthProviderError('ID_TOKEN_SIGNATURE', 'signature invalide');

  const c = parts.payload;
  if (typeof c.iss !== 'string' || !ep.issuers.includes(c.iss)) throw new OAuthProviderError('ID_TOKEN_ISSUER', 'issuer inattendu');
  const aud = c.aud;
  const audOk = typeof aud === 'string' ? aud === exp.clientId : Array.isArray(aud) && aud.includes(exp.clientId);
  if (!audOk) throw new OAuthProviderError('ID_TOKEN_AUDIENCE', 'audience inattendue');
  if (Array.isArray(aud) && aud.length > 1 && c.azp !== exp.clientId) throw new OAuthProviderError('ID_TOKEN_AUDIENCE', 'azp inattendu');
  if (c.azp !== undefined && typeof aud === 'string' && c.azp !== exp.clientId) throw new OAuthProviderError('ID_TOKEN_AUDIENCE', 'azp inattendu');
  if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_S < nowS) throw new OAuthProviderError('ID_TOKEN_EXPIRED', 'id_token expiré');
  if (typeof c.iat !== 'number' || c.iat > nowS + CLOCK_SKEW_S || c.iat < nowS - 24 * 3600) {
    throw new OAuthProviderError('ID_TOKEN_IAT', 'date d’émission invalide');
  }
  if (typeof c.nonce !== 'string' || !safeEqual(sha256Hex(c.nonce), exp.nonceHash)) {
    throw new OAuthProviderError('ID_TOKEN_NONCE', 'nonce invalide');
  }
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new OAuthProviderError('ID_TOKEN_SUBJECT', 'subject absent');
  return c;
}

// ── Réauthentification : preuve d'une authentification RÉCENTE (P2) ────────

/**
 * Âge maximal de l'authentification chez le fournisseur pour une
 * réauthentification Verebona (Q7 : cinq minutes). Un seul point à changer.
 */
export const PROVIDER_REAUTH_MAX_AGE_S = 300;

/**
 * Lot 96B (décision PO P2, Q7) — une session OAuth silencieuse ne vaut JAMAIS
 * preuve fraîche. L'id_token d'une réauthentification doit porter `auth_time`
 * (date de la dernière authentification RÉELLE de la personne chez le
 * fournisseur), datant de moins de `PROVIDER_REAUTH_MAX_AGE_S` (tolérance
 * d'horloge 60 s) et non future.
 *
 *   · Google : `prompt=login` (nouvelle saisie imposée) + `max_age` ;
 *     `auth_time` est alors toujours présent.
 *   · Apple : pas d'équivalent à `prompt=login` ; Apple exige toujours une
 *     action sur sa page (aucune autorisation silencieuse) et l'id_token
 *     porte `auth_time`. Si Apple réutilise une session ouverte depuis plus
 *     de 5 minutes, la preuve est REFUSÉE (REAUTH_NOT_RECENT) : la personne
 *     doit s'identifier à nouveau chez Apple ou utiliser son mot de passe.
 *     `auth_time` absent : REFUS (jamais d'acceptation sans preuve).
 * Le même `subject` que l'identité liée reste exigé (`flow.ts ›
 * completeReauth`).
 */
export function assertFreshProviderAuth(claims: Record<string, unknown>, nowMs = Date.now()): void {
  const nowS = Math.floor(nowMs / 1000);
  const raw = claims.auth_time;
  const authTime = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{9,11}$/.test(raw) ? Number(raw) : null;
  if (authTime === null) throw new OAuthProviderError('ID_TOKEN_AUTH_TIME', 'auth_time absent : authentification récente non prouvée');
  if (authTime > nowS + CLOCK_SKEW_S) throw new OAuthProviderError('ID_TOKEN_AUTH_TIME', 'auth_time dans le futur');
  if (nowS - authTime > PROVIDER_REAUTH_MAX_AGE_S + CLOCK_SKEW_S) {
    throw new OAuthProviderError('ID_TOKEN_AUTH_TIME', 'authentification chez le fournisseur trop ancienne');
  }
}

// ── Attributs normalisés ────────────────────────────────────────────────────

export interface ProviderIdentity {
  provider: OAuthProvider;
  issuer: string;
  subject: string;
  /** Adresse fournie (informative), normalisée (trim + minuscules). */
  email: string | null;
  emailVerified: boolean;
  isPrivateRelay: boolean;
  firstName: string | null;
  lastName: string | null;
}

const bool = (v: unknown): boolean => v === true || v === 'true';
const str = (v: unknown, max = 100): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return s ? s.slice(0, max) : null;
};

/** Apple transmet le nom UNE fois (première autorisation), dans le paramètre `user` du form_post. */
export function parseAppleUserParam(raw: unknown): { firstName: string | null; lastName: string | null } {
  if (typeof raw !== 'string' || raw.length > 4096) return { firstName: null, lastName: null };
  try {
    const u = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    return { firstName: str(u?.name?.firstName), lastName: str(u?.name?.lastName) };
  } catch {
    return { firstName: null, lastName: null };
  }
}

export function normalizeIdentity(
  provider: OAuthProvider,
  claims: Record<string, unknown>,
  appleUser?: { firstName: string | null; lastName: string | null },
): ProviderIdentity {
  const email = str(claims.email, 320)?.toLowerCase() ?? null;
  const issuer = PROVIDER_ENDPOINTS[provider].issuers[0];
  if (provider === 'google') {
    return {
      provider, issuer, subject: String(claims.sub), email,
      emailVerified: !!email && bool(claims.email_verified),
      isPrivateRelay: false,
      firstName: str(claims.given_name), lastName: str(claims.family_name),
    };
  }
  return {
    provider, issuer, subject: String(claims.sub), email,
    // Apple : adresses (réelles ou relais) vérifiées par Apple.
    emailVerified: !!email && bool(claims.email_verified),
    isPrivateRelay: bool(claims.is_private_email) || (!!email && email.endsWith('@privaterelay.appleid.com')),
    firstName: appleUser?.firstName ?? null, lastName: appleUser?.lastName ?? null,
  };
}

// ── Apple : révocation (suppression du compte, dissociation) ────────────────

export async function revokeAppleRefreshToken(cfg: AppleConfig, refreshToken: string): Promise<boolean> {
  const ep = PROVIDER_ENDPOINTS.apple;
  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: appleClientSecret(cfg),
    token: refreshToken,
    token_type_hint: 'refresh_token',
  });
  try {
    const res = await oauthFetch(ep.revocationEndpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
