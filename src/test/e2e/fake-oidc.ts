/**
 * Faux fournisseur OIDC LOCAL (Google + Apple) — lot 93, CDC 18 §40.
 *
 * Aucun appel réseau : il remplace `fetch` du module OAuth
 * (`setOAuthFetchForTests`) et joue, en mémoire, les trois points d'accès
 * qu'appelle le serveur (jeton, JWKS, révocation Apple) avec de VRAIES
 * vérifications : client_id, client_secret (Google : valeur ; Apple : JWT
 * ES256 vérifié avec la clé publique de la clé .p8 générée), redirect_uri,
 * PKCE S256, code à usage unique. Les id_token sont de vrais JWT RS256 signés
 * par une clé générée, publiée dans le JWKS.
 *
 * `authorize(urlDeRedirection, utilisateur)` simule la page du fournisseur :
 * lit state / nonce / code_challenge de l'URL construite par Verebona et
 * délivre un code.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { decodeJwt, pkceChallenge, signJwt, verifyJwtSignature } from '@/lib/auth/oauth/crypto';

export interface FakeUser {
  sub: string;
  email?: string | null;
  emailVerified?: boolean;
  privateRelay?: boolean;
  givenName?: string;
  familyName?: string;
  /** Apple : nom transmis (première autorisation seulement). */
  appleName?: { firstName: string; lastName: string } | null;
  /** Rejoue un mauvais nonce (attaque). */
  nonceOverride?: string;
  /**
   * Lot 96B (P2) : âge, en secondes, de la dernière authentification RÉELLE
   * chez le fournisseur (`auth_time`). 0 par défaut (la personne vient de
   * s'identifier) ; `null` : claim absent ; grand nombre : session
   * silencieuse ancienne.
   */
  authAgeS?: number | null;
}

interface PendingCode {
  provider: 'google' | 'apple';
  clientId: string;
  redirectUri: string;
  challenge: string | null;
  nonce: string;
  user: FakeUser;
  used: boolean;
}

const pem = (k: KeyObject) => k.export({ format: 'pem', type: 'pkcs8' }).toString();

export function createFakeOidc() {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const codes = new Map<string, PendingCode>();
  const revoked: string[] = [];
  const tokenCalls: Array<{ provider: string; ok: boolean; reason?: string }> = [];
  let n = 0;

  const env: Record<string, string> = {
    GOOGLE_OAUTH_CLIENT_ID: 'e2e-google.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'e2e-google-secret',
    APPLE_SIGNIN_CLIENT_ID: 'fr.verebona.e2e',
    APPLE_SIGNIN_TEAM_ID: 'E2ETEAM001',
    APPLE_SIGNIN_KEY_ID: 'E2EKEY0001',
    APPLE_SIGNIN_PRIVATE_KEY: pem(ec.privateKey).replace(/\n/g, '\\n'),
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  };

  function authorize(location: string, user: FakeUser): { code: string; state: string; redirectUri: string; appleUser: string | null; prompt: string | null; maxAge: string | null } {
    const u = new URL(location);
    const provider = u.hostname.includes('apple') ? 'apple' : 'google';
    const q = u.searchParams;
    const code = `code-${provider}-${++n}-${Math.random().toString(36).slice(2)}`;
    codes.set(code, {
      provider, clientId: q.get('client_id') ?? '', redirectUri: q.get('redirect_uri') ?? '',
      challenge: q.get('code_challenge'), nonce: q.get('nonce') ?? '', user, used: false,
    });
    const appleUser = provider === 'apple' && user.appleName ? JSON.stringify({ name: user.appleName, email: user.email }) : null;
    return { code, state: q.get('state') ?? '', redirectUri: q.get('redirect_uri') ?? '', appleUser, prompt: q.get('prompt'), maxAge: q.get('max_age') };
  }

  function idToken(c: PendingCode): string {
    const now = Math.floor(Date.now() / 1000);
    const iss = c.provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com';
    const claims: Record<string, unknown> = {
      iss, aud: c.clientId, sub: c.user.sub, iat: now, exp: now + 600, nonce: c.user.nonceOverride ?? c.nonce,
    };
    const age = c.user.authAgeS === undefined ? 0 : c.user.authAgeS;
    if (age !== null) claims.auth_time = now - age;
    if (c.user.email) {
      claims.email = c.user.email;
      claims.email_verified = c.provider === 'apple' ? String(c.user.emailVerified ?? true) : (c.user.emailVerified ?? true);
    }
    if (c.provider === 'apple' && c.user.privateRelay) claims.is_private_email = 'true';
    if (c.provider === 'google') {
      if (c.user.givenName) claims.given_name = c.user.givenName;
      if (c.user.familyName) claims.family_name = c.user.familyName;
    }
    return signJwt({ alg: 'RS256', kid: 'e2e-k1', typ: 'JWT' }, claims, pem(rsa.privateKey));
  }

  function appleSecretOk(secret: string | null): boolean {
    if (!secret) return false;
    const parts = decodeJwt(secret);
    if (!parts || parts.header.alg !== 'ES256' || parts.header.kid !== env.APPLE_SIGNIN_KEY_ID) return false;
    const p = parts.payload;
    if (p.iss !== env.APPLE_SIGNIN_TEAM_ID || p.sub !== env.APPLE_SIGNIN_CLIENT_ID || p.aud !== 'https://appleid.apple.com') return false;
    return verifyJwtSignature(parts, ec.publicKey.export({ format: 'jwk' }), 'ES256');
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(url: string, init?: RequestInit): Promise<Response> {
    if (url.endsWith('/oauth2/v3/certs') || url.endsWith('/auth/keys')) {
      return json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'e2e-k1', alg: 'RS256', use: 'sig' }] });
    }
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (url === 'https://appleid.apple.com/auth/revoke') {
      if (!appleSecretOk(form.get('client_secret'))) return json({ error: 'invalid_client' }, 400);
      revoked.push(form.get('token') ?? '');
      return new Response('', { status: 200 });
    }
    if (url === 'https://oauth2.googleapis.com/token' || url === 'https://appleid.apple.com/auth/token') {
      const provider = url.includes('apple') ? 'apple' : 'google';
      const fail = (reason: string) => { tokenCalls.push({ provider, ok: false, reason }); return json({ error: reason }, 400); };
      const c = codes.get(form.get('code') ?? '');
      if (!c || c.provider !== provider) return fail('invalid_grant');
      if (c.used) return fail('invalid_grant');
      if (form.get('client_id') !== c.clientId) return fail('invalid_client');
      if (provider === 'google' && form.get('client_secret') !== env.GOOGLE_OAUTH_CLIENT_SECRET) return fail('invalid_client');
      if (provider === 'apple' && !appleSecretOk(form.get('client_secret'))) return fail('invalid_client');
      if (form.get('redirect_uri') !== c.redirectUri) return fail('redirect_uri_mismatch');
      if (c.challenge && pkceChallenge(form.get('code_verifier') ?? '') !== c.challenge) return fail('invalid_grant_pkce');
      c.used = true;
      tokenCalls.push({ provider, ok: true });
      return json({
        access_token: `at-${c.user.sub}`, token_type: 'Bearer', expires_in: 3600, id_token: idToken(c),
        ...(provider === 'apple' ? { refresh_token: `apple-rt-${c.user.sub}` } : {}),
      });
    }
    return json({ error: 'not_found' }, 404);
  }

  return { env, authorize, fetchImpl, revoked, tokenCalls };
}
