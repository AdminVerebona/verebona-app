/**
 * JWT utilities for Verebona
 * Uses Web Crypto API (HS256) — no external deps, Edge Runtime compatible.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 37 — C1 : UN JETON DE RENOUVELLEMENT N'EST JAMAIS UN JETON D'ACCÈS
 *
 * `verifyToken` acceptait indifféremment les deux jetons : signés avec la
 * même clé, ils ne différaient que par une revendication `type` que seule la
 * route `/api/auth/refresh` lisait. Le jeton de renouvellement (30 jours) —
 * présenté en `Authorization: Bearer` ou dans le cookie `access_token` —
 * ouvrait donc l'API comme un jeton d'accès, échappant à son expiration
 * courte et à la révocation à la déconnexion.
 *
 * Format v2 (émis depuis le lot 37) :
 *   · en-tête `kid` = `v2-access` | `v2-refresh` ;
 *   · CLÉS DISTINCTES par usage, dérivées de JWT_SECRET
 *     (HMAC-SHA256(JWT_SECRET, "verebona/jwt/v2/<usage>")) : un jeton d'un
 *     usage ne peut pas être vérifié avec la clé de l'autre, même si un
 *     contrôle de revendication était oublié ;
 *   · revendications `token_use`, `aud` (`verebona:access` |
 *     `verebona:refresh`), `iss`, `sid` (famille de session, conservée par la
 *     rotation), et `type` (compatibilité de lecture).
 * Chaque vérification est TYPÉE : `verifyAccessToken`, `verifyRefreshToken`.
 * `verifyToken` (historique) est un alias de `verifyAccessToken`.
 *
 * DOUBLE LECTURE BORNÉE (aucune déconnexion générale au déploiement)
 *   Les jetons émis avant le lot 37 (sans `kid`, signés avec JWT_SECRET brut)
 *   restent acceptés, mais seulement pour LEUR usage (`type` historique :
 *   accès → API, renouvellement → `/api/auth/refresh`, déconnexion), et dans
 *   leurs bornes : accès ≤ 2 h, renouvellement ≤ 30 jours, émis avant
 *   `LEGACY_TOKENS_ACCEPTED_UNTIL`. Le premier renouvellement remplace un
 *   jeton historique par un jeton v2. Retrait de cette lecture : possible
 *   30 jours après la mise en production du lot 37 (voir
 *   `docs/exploitation/securite-sessions.md`).
 *
 * LOT 37 — C5 : AUCUN SECRET DE REPLI EN PRODUCTION
 *   Le secret est lu À L'APPEL (jamais à l'import : `next build` ne l'exige
 *   pas). En production (`NODE_ENV=production`, préproduction comprise), un
 *   secret absent, trop court ou connu fait LEVER la signature comme la
 *   vérification ; `instrumentation-node.ts` appelle
 *   `assertJwtSecretConfigured()` au démarrage : le serveur refuse de
 *   démarrer, avec un message explicite.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { UserRole, PlanType, UserStatus } from '@/types/domain';
import { ACCESS_TOKEN_TTL_S, LEGACY_ACCESS_TOKEN_MAX_S, REFRESH_TOKEN_TTL_S } from '@/lib/auth/token-lifetimes';

// Lot 53A (retour PO Q21, CDC 18 §19.2 / SESS-01) : accès 15 min (était 2 h),
// renouvellement 30 jours glissants — source unique `auth/token-lifetimes`.
const JWT_ACCESS_EXPIRY_S  = ACCESS_TOKEN_TTL_S;   // 15 min
const JWT_REFRESH_EXPIRY_S = REFRESH_TOKEN_TTL_S;  // 30 j (rotation à chaque renouvellement)

export type TokenUse = 'access' | 'refresh';

export const JWT_ISSUER = 'verebona';
export const JWT_AUDIENCE: Readonly<Record<TokenUse, string>> = { access: 'verebona:access', refresh: 'verebona:refresh' };
export const JWT_KID: Readonly<Record<TokenUse, string>> = { access: 'v2-access', refresh: 'v2-refresh' };

/**
 * Au-delà de cette date, plus aucun jeton historique (sans `kid`) n'est lu,
 * même non expiré. Le plus long (renouvellement) vit 30 jours : la borne
 * laisse une large marge après la mise en production du lot 37.
 */
export const LEGACY_TOKENS_ACCEPTED_UNTIL = Date.parse('2027-03-31T00:00:00Z');
/** Durées maximales des jetons historiques (celles de l'ancien émetteur). */
const LEGACY_MAX_LIFETIME_S: Readonly<Record<TokenUse, number>> = {
  access: LEGACY_ACCESS_TOKEN_MAX_S,
  refresh: JWT_REFRESH_EXPIRY_S,
};

// ── Secret (C5) ─────────────────────────────────────────────────────────────

/** Valeur de repli historique — publique (dans le dépôt). */
export const INSECURE_DEFAULT_JWT_SECRET = 'your-secret-key-change-in-production';
/** Longueur minimale en production (caractères). `openssl rand -base64 48` en donne 64. */
export const JWT_SECRET_MIN_LENGTH = 32;
/** Valeurs connues (dépôt, exemples, tests) refusées en production. */
export const KNOWN_WEAK_JWT_SECRETS: ReadonlySet<string> = new Set([
  INSECURE_DEFAULT_JWT_SECRET,
  'your-secret-key',
  'your-jwt-secret',
  'change-me',
  'changeme',
  'change-me-in-production',
  'secret',
  'jwt-secret',
  'jwt_secret',
  'dev-secret',
  'test-secret',
  'e2e-secret',
  'verebona',
  'verebona-secret',
]);

export type JwtSecretProblem = 'missing' | 'too_short' | 'known_default';

type Env = Record<string, string | undefined>;

/** Diagnostic du secret (jamais sa valeur). `null` : conforme aux exigences de production. */
export function jwtSecretProblem(env: Env = process.env): JwtSecretProblem | null {
  const s = env.JWT_SECRET ?? '';
  if (!s.trim()) return 'missing';
  if (KNOWN_WEAK_JWT_SECRETS.has(s.trim()) || KNOWN_WEAK_JWT_SECRETS.has(s.trim().toLowerCase())) return 'known_default';
  if (s.length < JWT_SECRET_MIN_LENGTH) return 'too_short';
  return null;
}

const PROBLEM_TEXT: Record<JwtSecretProblem, string> = {
  missing: 'JWT_SECRET est absent',
  too_short: `JWT_SECRET est trop court (minimum ${JWT_SECRET_MIN_LENGTH} caractères)`,
  known_default: 'JWT_SECRET vaut une valeur publique connue (valeur de repli ou d’exemple)',
};

export function jwtSecretProblemMessage(problem: JwtSecretProblem): string {
  return `[jwt] ${PROBLEM_TEXT[problem]}. En production (NODE_ENV=production), le serveur refuse de démarrer : `
    + 'définissez JWT_SECRET avec une valeur aléatoire longue (ex. `openssl rand -base64 48`) dans les variables '
    + 'd’environnement de l’application. Changer ce secret déconnecte toutes les sessions.';
}

function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Contrôle de démarrage (instrumentation) : lève en production si le secret
 * n'est pas conforme. Hors production, ne lève jamais (développement, tests).
 */
export function assertJwtSecretConfigured(env: Env = process.env): void {
  if (!isProduction(env)) return;
  const problem = jwtSecretProblem(env);
  if (problem) throw new Error(jwtSecretProblemMessage(problem));
}

/** Secret effectif : lu à chaque appel ; jamais de repli en production. */
function currentSecret(): string {
  const env = process.env as Env;
  if (isProduction(env)) {
    const problem = jwtSecretProblem(env);
    if (problem) throw new Error(jwtSecretProblemMessage(problem));
    return env.JWT_SECRET as string;
  }
  return env.JWT_SECRET || INSECURE_DEFAULT_JWT_SECRET;
}

export interface JWTPayload {
  userId: number;
  email: string;
  role: UserRole;
  planType: PlanType;
  status: UserStatus;
  currentAccountId?: number;
  hasActiveAccount?: boolean;
  type: TokenUse;
  /** v2 : usage du jeton (même valeur que `type`). Absent des jetons historiques. */
  token_use?: TokenUse;
  aud?: string;
  iss?: string;
  /** v2 : famille de session (conservée par la rotation). */
  sid?: string;
  iat?: number;
  /** Milliseconde d'émission — comparée à la révocation globale des sessions. */
  iatMs?: number;
  /** Identifiant unique du jeton. */
  jti?: string;
  exp?: number;
}

export type AccessTokenPayload = JWTPayload;

// ── Internal helpers ──────────────────────────────────────────────────────────

function b64url(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

const enc = new TextEncoder();

async function hmacKey(raw: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Clés dérivées par usage, en cache par valeur de secret (rotation de secret = nouvelles clés). */
let derivedCache: { secret: string; keys: Record<TokenUse, Uint8Array> } | null = null;

async function derivedKeyBytes(use: TokenUse): Promise<Uint8Array> {
  const secret = currentSecret();
  if (!derivedCache || derivedCache.secret !== secret) {
    const master = await hmacKey(enc.encode(secret), 'sign');
    const derive = async (u: TokenUse) =>
      new Uint8Array(await crypto.subtle.sign('HMAC', master, enc.encode(`verebona/jwt/v2/${u}`)));
    derivedCache = { secret, keys: { access: await derive('access'), refresh: await derive('refresh') } };
  }
  return derivedCache.keys[use];
}

async function signingKey(use: TokenUse): Promise<CryptoKey> {
  return hmacKey(await derivedKeyBytes(use), 'sign');
}

async function verificationKey(use: TokenUse | 'legacy'): Promise<CryptoKey> {
  if (use === 'legacy') return hmacKey(enc.encode(currentSecret()), 'verify');
  return hmacKey(await derivedKeyBytes(use), 'verify');
}

/** Identifiant de famille de session. */
export function newSessionId(): string {
  return crypto.randomUUID();
}

async function createToken(use: TokenUse, claims: Record<string, unknown>, expiresInSeconds: number): Promise<string> {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  // `jti` aléatoire : deux jetons émis dans la même seconde pour le même
  // utilisateur étaient strictement identiques — même empreinte, donc une
  // rotation pouvait « révoquer » le jeton qu'elle venait d'émettre.
  const payload = {
    ...claims,
    type: use,
    token_use: use,
    aud: JWT_AUDIENCE[use],
    iss: JWT_ISSUER,
    jti: crypto.randomUUID(),
    iat: now,
    iatMs: nowMs,
    exp: now + expiresInSeconds,
  };
  const part = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));
  const header = part({ alg: 'HS256', typ: 'JWT', kid: JWT_KID[use] });
  const body   = part(payload);
  const msg    = `${header}.${body}`;
  const sig    = await crypto.subtle.sign('HMAC', await signingKey(use), enc.encode(msg));
  return `${msg}.${b64url(new Uint8Array(sig))}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface TokenSubject {
  id: number; email: string; role: UserRole; planType: PlanType; status: UserStatus;
  currentAccountId?: number; hasActiveAccount?: boolean;
}

function subjectClaims(user: TokenSubject, sid: string): Record<string, unknown> {
  return {
    userId: user.id, email: user.email, role: user.role,
    planType: user.planType, status: user.status,
    currentAccountId: user.currentAccountId,
    hasActiveAccount: user.hasActiveAccount,
    sid,
  };
}

export async function generateAccessToken(user: TokenSubject, opts: { sid?: string } = {}): Promise<string> {
  return createToken('access', subjectClaims(user, opts.sid ?? newSessionId()), JWT_ACCESS_EXPIRY_S);
}

export async function generateRefreshToken(user: TokenSubject, opts: { sid?: string } = {}): Promise<string> {
  return createToken('refresh', subjectClaims(user, opts.sid ?? newSessionId()), JWT_REFRESH_EXPIRY_S);
}

/**
 * Paire de jetons d'une même session (même `sid`). `sid` fourni : la rotation
 * conserve la famille ; absent : nouvelle session (connexion).
 */
export async function generateSessionTokens(
  user: TokenSubject,
  sid: string = newSessionId(),
): Promise<{ accessToken: string; refreshToken: string; sid: string }> {
  const [accessToken, refreshToken] = await Promise.all([
    generateAccessToken(user, { sid }),
    generateRefreshToken(user, { sid }),
  ]);
  return { accessToken, refreshToken, sid };
}

/** Lecture de l'en-tête sans vérification (choix de la clé). */
function readHeader(segment: string): { kid?: unknown; alg?: unknown } | null {
  try {
    const h = JSON.parse(new TextDecoder().decode(b64urlDecode(segment)));
    return h && typeof h === 'object' ? h : null;
  } catch {
    return null;
  }
}

/**
 * Vérification TYPÉE : signature avec la clé de l'usage attendu, puis
 * revendications d'usage, d'audience, d'émetteur et d'expiration.
 * `null` pour tout jeton d'un autre usage, mal formé, expiré ou hors borne.
 */
export async function verifyTypedToken(token: string, expected: TokenUse): Promise<JWTPayload | null> {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const h = readHeader(header);
    if (!h || h.alg !== 'HS256') return null;

    let mode: TokenUse | 'legacy';
    if (h.kid === undefined) mode = 'legacy';
    else if (h.kid === JWT_KID[expected]) mode = expected;
    else return null; // autre usage (ou clé inconnue) : jamais vérifié avec la clé attendue

    const valid = await crypto.subtle.verify(
      'HMAC', await verificationKey(mode),
      b64urlDecode(sig) as unknown as ArrayBuffer,
      enc.encode(`${header}.${body}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as JWTPayload;
    if (!payload || typeof payload !== 'object') return null;

    const nowS = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || nowS > payload.exp) return null;
    if (payload.type !== expected) return null;

    if (mode === 'legacy') {
      // Jeton émis avant le lot 37 : usage historique seul, bornes de l'ancien émetteur.
      if (payload.token_use !== undefined || payload.aud !== undefined) return null;
      if (typeof payload.iat !== 'number') return null;
      if (payload.exp - payload.iat > LEGACY_MAX_LIFETIME_S[expected]) return null;
      if (payload.iat * 1000 >= LEGACY_TOKENS_ACCEPTED_UNTIL || Date.now() >= LEGACY_TOKENS_ACCEPTED_UNTIL) return null;
      return payload;
    }

    if (payload.token_use !== expected) return null;
    if (payload.aud !== JWT_AUDIENCE[expected]) return null;
    if (payload.iss !== JWT_ISSUER) return null;
    return payload;
  } catch (e) {
    // Secret de production non conforme : ce n'est pas un « jeton invalide ».
    if (e instanceof Error && e.message.startsWith('[jwt]')) throw e;
    return null;
  }
}

/** Jeton d'accès uniquement (API, pages, middleware). Refuse tout jeton de renouvellement. */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  return verifyTypedToken(token, 'access');
}

/** Jeton de renouvellement uniquement (`/api/auth/refresh`, déconnexion). */
export async function verifyRefreshToken(token: string): Promise<JWTPayload | null> {
  return verifyTypedToken(token, 'refresh');
}

/**
 * @deprecated Alias de `verifyAccessToken` (lot 37, C1) : un appelant oublié
 * obtient le comportement sûr — un jeton de renouvellement est refusé.
 */
export async function verifyToken(token: string): Promise<JWTPayload | null> {
  return verifyAccessToken(token);
}

export function extractToken(authHeader: string | null, cookieHeader: string | null): string | null {
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7);
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      acc[k] = v;
      return acc;
    }, {} as Record<string, string>);
    return cookies.access_token || null;
  }
  return null;
}
