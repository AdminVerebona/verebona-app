/**
 * Primitives du parcours OAuth / OIDC (lot 93, CDC 18 §12.2, §32) — Node
 * `crypto`, aucune dépendance : aléas, empreintes, PKCE (RFC 7636 S256),
 * vérification et signature de JWT (RS256 / ES256) contre une JWK, chiffrement
 * du jeton Apple conservé pour la révocation.
 */
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey,
  randomBytes, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify, type JsonWebKey,
} from 'node:crypto';

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/** Valeur aléatoire non devinable (256 bits par défaut), base64url. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** Empreinte SHA-256 hexadécimale — ce qui est stocké à la place d'un secret. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Comparaison à temps constant de deux chaînes. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** PKCE : vérificateur (43 à 128 caractères) et défi S256. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48); // 64 caractères
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** Code à 6 chiffres (vérification d'adresse), uniformément tiré. */
export function sixDigitCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

// ── JWT ─────────────────────────────────────────────────────────────────────

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

/** Découpe un JWS compact sans rien vérifier ; `null` si malformé. */
export function decodeJwt(token: string): JwtParts | null {
  if (typeof token !== 'string' || token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
  } catch {
    return null;
  }
}

export type JwtAlg = 'RS256' | 'ES256';

/** Vérifie la signature d'un JWS avec une clé publique JWK (algorithme imposé, jamais lu du jeton seul). */
export function verifyJwtSignature(parts: JwtParts, jwk: JsonWebKey, alg: JwtAlg): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(parts.signingInput, 'utf8');
    if (alg === 'RS256') {
      if (key.asymmetricKeyType !== 'rsa') return false;
      return cryptoVerify('sha256', data, key, parts.signature);
    }
    if (key.asymmetricKeyType !== 'ec') return false;
    return cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, parts.signature);
  } catch {
    return false;
  }
}

/** Signe un JWT (ES256 avec une clé PKCS#8 PEM — clé .p8 Apple ; RS256 pour les tests). */
export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKeyPem: string): string {
  const alg = header.alg;
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  const data = Buffer.from(input, 'utf8');
  const sig = alg === 'ES256'
    ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
    : cryptoSign('sha256', data, key);
  return `${input}.${b64url(sig)}`;
}

// ── Chiffrement du jeton Apple (révocation à la suppression, CDC §25) ───────

const INSECURE_DEFAULT = 'your-secret-key-change-in-production';

/**
 * Clé AES-256 : AUTH_PROVIDER_TOKEN_KEY si posée, sinon dérivée de JWT_SECRET
 * (HMAC à étiquette dédiée). Changer l'une ou l'autre rend les jetons
 * existants illisibles : la révocation Apple de ces comptes est alors sautée
 * (journalisée), rien d'autre ne casse.
 */
function tokenKey(env: Record<string, string | undefined> = process.env): Buffer {
  const base = (env.AUTH_PROVIDER_TOKEN_KEY || env.JWT_SECRET || INSECURE_DEFAULT).trim();
  return createHmac('sha256', base).update('verebona/oauth/provider-refresh-token/v1').digest();
}

export function encryptProviderToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${b64url(iv)}.${b64url(c.getAuthTag())}.${b64url(enc)}`;
}

export function decryptProviderToken(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [v, iv, tag, data] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
