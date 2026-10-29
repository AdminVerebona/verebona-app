/**
 * Lot 93 — connexion Google / Apple (CDC 18 §12.2, §32, §40) : tests unitaires
 * sans base ni réseau. Clés RSA / EC générées pour le test ; faux JWKS servi
 * par `setOAuthFetchForTests`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  callbackUrl, enabledProviders, getProviderConfig, normalizePem, oauthRedirectBase, type AppleConfig,
} from '../config';
import {
  createPkcePair, decodeJwt, decryptProviderToken, encryptProviderToken, pkceChallenge, randomToken, sha256Hex,
  signJwt, sixDigitCode, verifyJwtSignature,
} from '../crypto';
import {
  appleClientSecret, buildAuthorizationUrl, normalizeIdentity, parseAppleUserParam, setOAuthFetchForTests,
  validateIdToken, OAuthProviderError,
} from '../providers';
import { canUnlink, usableMethodCount } from '../identities';
import { contextFromQuery } from '../flow';
import { validateProfileInput } from '../social-signup';
import { socialErrorMessage, SOCIAL_ERROR_MESSAGES } from '../messages';

const GOOGLE_ENV = {
  NODE_ENV: 'test', GOOGLE_OAUTH_CLIENT_ID: 'gid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
  NEXT_PUBLIC_APP_URL: 'https://preprod.verebona.test',
};

let rsa: { privateKey: KeyObject; publicKey: KeyObject };
let rsaOther: { privateKey: KeyObject; publicKey: KeyObject };
let ec: { privateKey: KeyObject; publicKey: KeyObject };
const pem = (k: KeyObject) => k.export({ format: 'pem', type: 'pkcs8' }).toString();

beforeAll(() => {
  rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsaOther = generateKeyPairSync('rsa', { modulusLength: 2048 });
  ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
});

afterEach(() => setOAuthFetchForTests(null));

/** Faux JWKS (aucun réseau) ; compte les appels. */
function serveJwks(keys: Array<{ kid: string; key: KeyObject }>) {
  const calls: string[] = [];
  setOAuthFetchForTests(async (url) => {
    calls.push(url);
    if (url.endsWith('/certs') || url.endsWith('/auth/keys')) {
      return new Response(JSON.stringify({ keys: keys.map((k) => ({ ...k.key.export({ format: 'jwk' }), kid: k.kid, alg: 'RS256', use: 'sig' })) }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  return calls;
}

function idToken(over: Record<string, unknown> = {}, opts: { kid?: string; key?: KeyObject; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' },
    { iss: 'https://accounts.google.com', aud: GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_ID, sub: '1234567890', iat: now, exp: now + 600, nonce: 'n-123', email: 'Alice@Example.com', email_verified: true, ...over },
    pem(opts.key ?? rsa.privateKey),
  );
}

const expectations = { provider: 'google' as const, clientId: GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_ID, nonceHash: sha256Hex('n-123') };

async function rejects(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(OAuthProviderError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('L93 — PKCE, aléas, chiffrement', () => {
  it('PKCE S256 : vecteur de la RFC 7636 et paire générée cohérente', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const p = createPkcePair();
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.verifier.length).toBeLessThanOrEqual(128);
    expect(pkceChallenge(p.verifier)).toBe(p.challenge);
  });

  it('state / nonce imprévisibles, code à 6 chiffres', () => {
    const s = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(s.size).toBe(200);
    for (let i = 0; i < 50; i++) expect(sixDigitCode()).toMatch(/^\d{6}$/);
  });

  it('jeton Apple chiffré : aller-retour, altération refusée, jamais le clair', () => {
    const c = encryptProviderToken('r.apple-refresh-token');
    expect(c).not.toContain('apple-refresh');
    expect(decryptProviderToken(c)).toBe('r.apple-refresh-token');
    const parts = c.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
    expect(decryptProviderToken(parts.join('.'))).toBeNull();
    expect(decryptProviderToken(null)).toBeNull();
  });
});

describe('L93 — validation stricte de l’id_token (§12.2, §40 tests sécurité)', () => {
  it('jeton valide : claims rendus ; JWKS mis en cache (un seul appel)', async () => {
    const calls = serveJwks([{ kid: 'k1', key: rsa.publicKey }]);
    const c = await validateIdToken(idToken(), expectations);
    expect(c.sub).toBe('1234567890');
    await validateIdToken(idToken(), expectations);
    expect(calls.filter((u) => u.endsWith('/certs'))).toHaveLength(1);
  });

  it('issuer, audience, azp, expiration, iat, nonce, subject : chaque écart est refusé', async () => {
    serveJwks([{ kid: 'k1', key: rsa.publicKey }]);
    const now = Math.floor(Date.now() / 1000);
    await rejects(validateIdToken(idToken({ iss: 'https://evil.example' }), expectations), 'ID_TOKEN_ISSUER');
    await rejects(validateIdToken(idToken({ aud: 'autre-client' }), expectations), 'ID_TOKEN_AUDIENCE');
    await rejects(validateIdToken(idToken({ azp: 'autre-client' }), expectations), 'ID_TOKEN_AUDIENCE');
    await rejects(validateIdToken(idToken({ exp: now - 3600 }), expectations), 'ID_TOKEN_EXPIRED');
    await rejects(validateIdToken(idToken({ iat: now + 3600 }), expectations), 'ID_TOKEN_IAT');
    await rejects(validateIdToken(idToken({ nonce: 'autre-nonce' }), expectations), 'ID_TOKEN_NONCE');
    await rejects(validateIdToken(idToken({ nonce: undefined }), expectations), 'ID_TOKEN_NONCE');
    await rejects(validateIdToken(idToken({ sub: '' }), expectations), 'ID_TOKEN_SUBJECT');
  });

  it('signature : autre clé sous le même kid, algorithme « none » / HS256, jeton altéré → refus', async () => {
    serveJwks([{ kid: 'k1', key: rsa.publicKey }]);
    await rejects(validateIdToken(idToken({}, { key: rsaOther.privateKey }), expectations), 'ID_TOKEN_SIGNATURE');
    const t = idToken();
    const [h, p] = t.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${p}.`;
    await rejects(validateIdToken(none, expectations), 'ID_TOKEN_ALG');
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url')}.${p}.${t.split('.')[2]}`;
    await rejects(validateIdToken(hs, expectations), 'ID_TOKEN_ALG');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...decodeJwt(t)!.payload, sub: 'attaquant' })).toString('base64url')}.${t.split('.')[2]}`;
    await rejects(validateIdToken(forged, expectations), 'ID_TOKEN_SIGNATURE');
    await rejects(validateIdToken('pas-un-jwt', expectations), 'ID_TOKEN_MALFORMED');
  });

  it('rotation des clés : kid inconnu → JWKS rechargé ; toujours inconnu → refus', async () => {
    let keys = [{ kid: 'k1', key: rsa.publicKey }];
    const calls: string[] = [];
    setOAuthFetchForTests(async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ keys: keys.map((k) => ({ ...k.key.export({ format: 'jwk' }), kid: k.kid })) }), { status: 200 });
    });
    await validateIdToken(idToken(), expectations);
    keys = [{ kid: 'k2', key: rsaOther.publicKey }];
    // Rechargement forcé borné à une fois par minute : le premier jeton k2 est refusé tant que le cache est jeune.
    await rejects(validateIdToken(idToken({}, { kid: 'k2', key: rsaOther.privateKey }), expectations), 'ID_TOKEN_KID_UNKNOWN');
    expect(calls.length).toBe(1);
    setOAuthFetchForTests(async () => new Response(JSON.stringify({ keys: keys.map((k) => ({ ...k.key.export({ format: 'jwk' }), kid: k.kid })) }), { status: 200 }));
    const c = await validateIdToken(idToken({}, { kid: 'k2', key: rsaOther.privateKey }), expectations);
    expect(c.sub).toBe('1234567890');
  });

  it('JWKS injoignable sans cache : refus explicite (jamais d’acceptation sans clé)', async () => {
    setOAuthFetchForTests(async () => { throw new Error('réseau'); });
    await rejects(validateIdToken(idToken(), expectations), 'JWKS_UNAVAILABLE');
  });
});

describe('L93 — Apple : client_secret signé (.p8), form_post, nom à la première autorisation, relais', () => {
  const apple = (): AppleConfig => ({
    provider: 'apple', clientId: 'fr.verebona.web', teamId: 'TEAM123456', keyId: 'KEY1234567',
    privateKeyPem: pem(ec.privateKey), redirectUri: 'https://preprod.verebona.test/api/auth/oauth/apple/callback', pkce: true,
  });

  it('client_secret : JWT ES256 vérifiable avec la clé publique, claims Apple, 5 minutes', () => {
    const jwt = appleClientSecret(apple(), Date.parse('2026-10-26T10:00:00Z'));
    const parts = decodeJwt(jwt)!;
    expect(parts.header).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(parts.payload).toMatchObject({ iss: 'TEAM123456', sub: 'fr.verebona.web', aud: 'https://appleid.apple.com' });
    expect((parts.payload.exp as number) - (parts.payload.iat as number)).toBe(300);
    const jwk = ec.publicKey.export({ format: 'jwk' });
    expect(verifyJwtSignature(parts, jwk, 'ES256')).toBe(true);
  });

  it('URL d’autorisation : code + PKCE S256 + state + nonce ; Apple en form_post ; PKCE désactivable', () => {
    const g = new URL(buildAuthorizationUrl(getProviderConfig('google', GOOGLE_ENV)!, { state: 's', nonce: 'n', codeChallenge: 'c' }));
    expect(Object.fromEntries(g.searchParams)).toMatchObject({
      response_type: 'code', code_challenge: 'c', code_challenge_method: 'S256', state: 's', nonce: 'n',
      scope: 'openid email profile', redirect_uri: 'https://preprod.verebona.test/api/auth/oauth/google/callback',
    });
    const a = new URL(buildAuthorizationUrl(apple(), { state: 's', nonce: 'n', codeChallenge: 'c' }));
    expect(a.searchParams.get('response_mode')).toBe('form_post');
    expect(a.searchParams.get('scope')).toBe('name email');
    expect(a.searchParams.get('code_challenge')).toBe('c');
    const noPkce = new URL(buildAuthorizationUrl({ ...apple(), pkce: false }, { state: 's', nonce: 'n', codeChallenge: 'c' }));
    expect(noPkce.searchParams.get('code_challenge')).toBeNull();
  });

  it('attributs : booléens Apple en texte, relais privé, nom transmis seulement la première fois', () => {
    const first = normalizeIdentity('apple', { sub: '001.abc', email: 'xyz@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true' },
      parseAppleUserParam(JSON.stringify({ name: { firstName: 'Léa', lastName: 'Martin' }, email: 'xyz@privaterelay.appleid.com' })));
    expect(first).toMatchObject({ issuer: 'https://appleid.apple.com', subject: '001.abc', emailVerified: true, isPrivateRelay: true, firstName: 'Léa', lastName: 'Martin' });
    const later = normalizeIdentity('apple', { sub: '001.abc', email: 'xyz@privaterelay.appleid.com', email_verified: true }, parseAppleUserParam(null));
    expect(later.firstName).toBeNull();
    expect(later.isPrivateRelay).toBe(true);
    expect(parseAppleUserParam('{pas du json')).toEqual({ firstName: null, lastName: null });
    const g = normalizeIdentity('google', { sub: '42', email: ' Bob@Gmail.com ', email_verified: false, given_name: 'Bob' });
    expect(g).toMatchObject({ email: 'bob@gmail.com', emailVerified: false, firstName: 'Bob', isPrivateRelay: false });
  });
});

describe('L93 — activation par les variables Scalingo', () => {
  it('inactif sans identifiants (boutons masqués, routes 404) ; actif avec ; interrupteur AUTH_SOCIAL_*=off', () => {
    expect(enabledProviders({ NODE_ENV: 'production' })).toEqual({ google: false, apple: false });
    expect(enabledProviders({ ...GOOGLE_ENV })).toEqual({ google: true, apple: false });
    expect(enabledProviders({ ...GOOGLE_ENV, AUTH_SOCIAL_GOOGLE: 'off' }).google).toBe(false);
    const appleEnv = { ...GOOGLE_ENV, APPLE_SIGNIN_CLIENT_ID: 'svc', APPLE_SIGNIN_TEAM_ID: 't', APPLE_SIGNIN_KEY_ID: 'k', APPLE_SIGNIN_PRIVATE_KEY: 'MIGTAgEAMBMG' };
    expect(enabledProviders(appleEnv).apple).toBe(true);
    expect(enabledProviders({ ...appleEnv, APPLE_SIGNIN_TEAM_ID: '' }).apple).toBe(false);
  });

  it('URL de retour exacte, jamais déduite de la requête ; HTTPS imposé en production', () => {
    expect(callbackUrl('apple', GOOGLE_ENV)).toBe('https://preprod.verebona.test/api/auth/oauth/apple/callback');
    expect(oauthRedirectBase({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://preprod.verebona.test' })).toBeNull();
    expect(oauthRedirectBase({ NODE_ENV: 'production' })).toBeNull();
    expect(oauthRedirectBase({ NODE_ENV: 'production', OAUTH_REDIRECT_BASE_URL: 'https://a.test/', NEXT_PUBLIC_APP_URL: 'https://b.test' })).toBe('https://a.test');
  });

  it('clé .p8 : PEM avec « \\n » littéraux ou corps seul acceptés', () => {
    const p = pem(ec.privateKey);
    expect(normalizePem(p.replace(/\n/g, '\\n'))).toBe(p.trim());
    const body = p.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
    expect(normalizePem(body)).toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('L93 — règles pures du parcours', () => {
  it('dissociation : jamais la dernière méthode de connexion (§12.3, LAST_LOGIN_METHOD)', () => {
    expect(canUnlink({ password: false, providers: ['google'] }, 'google')).toBe(false);
    expect(canUnlink({ password: true, providers: ['google'] }, 'google')).toBe(true);
    expect(canUnlink({ password: false, providers: ['google', 'apple'] }, 'apple')).toBe(true);
    expect(canUnlink({ password: true, providers: [] }, 'apple')).toBe(false);
    expect(usableMethodCount({ password: true, providers: ['google', 'apple'] })).toBe(3);
  });

  it('contexte de démarrage filtré : retour interne seulement, jetons bornés, application sans retour configuré refusée', () => {
    const ctx = contextFromQuery(new URLSearchParams({ returnUrl: 'https://evil.example/x', inviteToken: 'abcDEF12345', ref: 'abc123', transmissionToken: '<script>' }));
    expect(ctx).toMatchObject({ client: 'web', returnUrl: '/accueil', inviteToken: 'abcDEF12345', referralCode: 'ABC123' });
    expect((ctx as { transmissionToken?: string }).transmissionToken).toBeUndefined();
    expect(contextFromQuery(new URLSearchParams({ returnUrl: '//evil.example' }))).toMatchObject({ returnUrl: '/accueil' });
    expect(contextFromQuery(new URLSearchParams({ client: 'app', app_challenge: 'x'.repeat(43) }))).toEqual({ error: 'APP_RETURN_NOT_CONFIGURED' });
  });

  it('profil d’inscription : prénom, nom, adresse, CGSU obligatoires', () => {
    expect(validateProfileInput({ firstName: ' ', lastName: 'M', email: 'a@b.fr', acceptedTerms: true })).toEqual({ ok: false, code: 'MISSING_FIRST_NAME' });
    expect(validateProfileInput({ firstName: 'L', lastName: 'M', email: 'pas-une-adresse', acceptedTerms: true })).toEqual({ ok: false, code: 'INVALID_EMAIL' });
    expect(validateProfileInput({ firstName: 'L', lastName: 'M', email: 'a@b.fr', acceptedTerms: false })).toEqual({ ok: false, code: 'TERMS_NOT_ACCEPTED' });
    expect(validateProfileInput({ firstName: 'Léa', lastName: 'Martin', email: ' Lea@B.fr ', acceptedTerms: true, referralCode: 'ab12' }))
      .toMatchObject({ ok: true, email: 'lea@b.fr', referralCode: 'AB12' });
  });

  it('messages : code connu en clair, code inconnu → message générique (aucune information technique)', () => {
    expect(socialErrorMessage('LAST_LOGIN_METHOD')).toBe('Vous devez conserver au moins une méthode de connexion.');
    expect(socialErrorMessage('XYZ')).toBe(SOCIAL_ERROR_MESSAGES.OAUTH_PROVIDER_ERROR);
    expect(socialErrorMessage(null)).toBeNull();
  });
});
