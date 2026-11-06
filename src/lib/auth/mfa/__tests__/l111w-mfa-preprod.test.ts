/**
 * Lot 111W — MFA / clés d'accès en préproduction.
 *
 *   L111W-ENV   environnement applicatif (NEXT_PUBLIC_APP_ENV) distinct de
 *               NODE_ENV ; jamais « production » par défaut ;
 *   L111W-COH   cohérence environnement / origine applicative / RP ID /
 *               origines WebAuthn, sans secret ;
 *   L111W-OFFER bouton clé d'accès = vue compatible ET service serveur prêt ;
 *               réseau ≠ indisponible ;
 *   L111W-MSG   messages de repli exacts (connexion anonyme, seconde étape,
 *               premier facteur) — plus jamais « Utilisez l'application
 *               d'authentification » par défaut.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMfaCoherence, looksNonProductionHost, resolveAppEnvironment, UNKNOWN_ENVIRONMENT_LABEL } from '../environment';
import {
  classifyMfaFailure, enrollmentChoices, fetchLoginMethodsStatus, loginAlternativesText, loginPasskeyOffer,
  loginPasskeyUnavailableText, verificationChoices, verificationUnavailableText,
} from '../availability';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PREPROD = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_APP_ENV: 'preprod',
  APP_URL: 'https://app.preprod.verebona.fr',
  WEBAUTHN_RP_ID: 'app.preprod.verebona.fr',
  WEBAUTHN_ORIGINS: 'https://app.preprod.verebona.fr',
  MFA_ENCRYPTION_KEYS: `k2026a:${KEY}`,
  // Lot 113M : une préproduction « correctement configurée » associe aussi SON
  // app mobile (webcredentials iOS, get_login_creds Android) — sinon la
  // cohérence signale désormais IOS_WEBCREDENTIALS_MISSING / ANDROID_ASSETLINKS_MISSING.
  MOBILE_IOS_TEAM_ID: 'ABCDE12345',
  MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app.preprod',
  MOBILE_ANDROID_PACKAGE: 'fr.verebona.app.preprod',
  MOBILE_ANDROID_SHA256_FINGERPRINTS: Array.from({ length: 32 }, () => 'AB').join(':'),
};
const codes = (env: Record<string, string | undefined>) => checkMfaCoherence(env).issues.map((i) => i.code);

describe('L111W-ENV environnement applicatif ≠ NODE_ENV', () => {
  it('préproduction déployée (NODE_ENV=production) : « Préproduction », NODE_ENV restitué séparément', () => {
    const e = resolveAppEnvironment({ NODE_ENV: 'production', NEXT_PUBLIC_APP_ENV: 'preprod' });
    expect(e).toEqual({ key: 'preprod', label: 'Préproduction', variable: 'NEXT_PUBLIC_APP_ENV', nodeEnv: 'production' });
  });
  it('synonymes de l’application (staging, prod)', () => {
    expect(resolveAppEnvironment({ NEXT_PUBLIC_APP_ENV: 'staging' }).label).toBe('Préproduction');
    expect(resolveAppEnvironment({ NEXT_PUBLIC_APP_ENV: 'prod' }).label).toBe('Production');
  });
  it('absente ou illisible : « Inconnu / configuration à vérifier », jamais production — même avec NODE_ENV=production ou VEREBONA_ENV', () => {
    for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', NEXT_PUBLIC_APP_ENV: 'bidule' }, { NODE_ENV: 'production', VEREBONA_ENV: 'production' }]) {
      const e = resolveAppEnvironment(env);
      expect(e.key).toBeNull();
      expect(e.label).toBe(UNKNOWN_ENVIRONMENT_LABEL);
    }
    expect(codes({ NODE_ENV: 'production', VEREBONA_ENV: 'production' })).toEqual(expect.arrayContaining(['ENV_UNKNOWN', 'VEREBONA_ENV_IGNORED']));
  });
});

describe('L111W-COH cohérence environnement / origine / RP ID / origines', () => {
  it('préproduction correctement configurée : cohérente', () => {
    const r = checkMfaCoherence(PREPROD);
    expect(r.verdict).toBe('ok');
    expect(r.issues).toEqual([]);
    expect(r.appOrigin).toEqual({ origin: 'https://app.preprod.verebona.fr', variable: 'APP_URL' });
  });
  it('variables WebAuthn / trousseau absents (capture du 05/11) : contrôle signalé, aucune valeur devinée', () => {
    const r = checkMfaCoherence({ NODE_ENV: 'production', NEXT_PUBLIC_APP_ENV: 'preprod', APP_URL: 'https://app.preprod.verebona.fr' });
    expect(r.verdict).toBe('warn');
    expect(r.issues.map((i) => i.code)).toEqual(['WEBAUTHN_NOT_CHECKED']);
  });
  it('RP ID différent de l’hôte de l’application → discordance bloquante', () => {
    expect(codes({ ...PREPROD, WEBAUTHN_RP_ID: 'app.verebona.fr', WEBAUTHN_ORIGINS: 'https://app.verebona.fr' }))
      .toEqual(expect.arrayContaining(['RP_ID_HOST_MISMATCH', 'APP_ORIGIN_NOT_ALLOWED', 'RP_ID_ENV_TO_CHECK']));
  });
  it('RP ID domaine parent : avertissement (fichiers d’association sur le domaine parent)', () => {
    const r = checkMfaCoherence({ ...PREPROD, WEBAUTHN_RP_ID: 'preprod.verebona.fr' });
    expect(r.issues.map((i) => i.code)).toEqual(['RP_ID_PARENT_DOMAIN']);
    expect(r.verdict).toBe('warn');
  });
  it('production avec un RP ID ou une origine de préproduction → discordance', () => {
    const r = checkMfaCoherence({ ...PREPROD, NEXT_PUBLIC_APP_ENV: 'production' });
    expect(r.verdict).toBe('ko');
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['APP_ORIGIN_ENV_MISMATCH', 'RP_ID_ENV_MISMATCH']));
  });
  it('origine applicative absente, locale ou en http dans un environnement hébergé', () => {
    expect(codes({ ...PREPROD, APP_URL: undefined })).toContain('APP_ORIGIN_MISSING');
    expect(codes({ ...PREPROD, APP_URL: 'http://localhost:3001' })).toContain('APP_ORIGIN_LOCAL');
    expect(codes({ ...PREPROD, APP_URL: 'http://app.preprod.verebona.fr' })).toContain('APP_ORIGIN_NOT_HTTPS');
  });
  it('NODE_ENV ≠ production en environnement hébergé : clé de développement signalée', () => {
    const c = codes({ ...PREPROD, NODE_ENV: 'development', MFA_ENCRYPTION_KEYS: undefined });
    expect(c).toEqual(expect.arrayContaining(['NODE_ENV_NOT_PRODUCTION', 'TOTP_DEV_KEY']));
  });
  it('aucun secret dans le rapport (ni la clé, ni son encodage)', () => {
    for (const env of [PREPROD, { ...PREPROD, NEXT_PUBLIC_APP_ENV: 'production' }, { ...PREPROD, MFA_ENCRYPTION_KEYS: 'k2026a:trop-court' }]) {
      const json = JSON.stringify(checkMfaCoherence(env));
      expect(json).not.toContain(KEY);
      expect(json).not.toContain('trop-court');
    }
  });
  it('marqueurs hors production par libellé (pas de sous-chaîne trompeuse)', () => {
    expect(looksNonProductionHost('app.preprod.verebona.fr')).toBe(true);
    expect(looksNonProductionHost('app-staging.verebona.fr')).toBe(true);
    expect(looksNonProductionHost('app.pre-prod.verebona.fr')).toBe(true);
    expect(looksNonProductionHost('testeur.verebona.fr')).toBe(false);
    expect(looksNonProductionHost('app.verebona.fr')).toBe(false);
    expect(looksNonProductionHost('devis.verebona.fr')).toBe(false);
  });
});

describe('L111W-OFFER bouton clé d’accès : client ET serveur', () => {
  const ready = (passkey: boolean) => ({ state: 'ready' as const, passkey, google: true, apple: false });
  it('matrice', () => {
    expect(loginPasskeyOffer(true, ready(true))).toBe('show');
    expect(loginPasskeyOffer(true, ready(false))).toBe('hide'); // capture du 05/11 : serveur non configuré → plus de bouton trompeur
    expect(loginPasskeyOffer(false, ready(true))).toBe('hide');
    expect(loginPasskeyOffer(false, { state: 'error' })).toBe('hide');
    expect(loginPasskeyOffer(true, { state: 'error' })).toBe('retry'); // réseau ≠ indisponible
    expect(loginPasskeyOffer(null, ready(true))).toBe('checking');
    expect(loginPasskeyOffer(true, null)).toBe('checking');
  });
  it('statut global : lecture tolérante, erreur réseau / serveur distincte, jamais de paramètre de compte', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ google: true, apple: true, passkey: true }), { status: 200 }));
    expect(await fetchLoginMethodsStatus(f)).toEqual({ state: 'ready', passkey: true, google: true, apple: true });
    expect(f).toHaveBeenCalledWith('/api/auth/oauth/providers', expect.objectContaining({ cache: 'no-store' }));
    expect(await fetchLoginMethodsStatus(async () => new Response(JSON.stringify({ google: false, apple: false }), { status: 200 })))
      .toEqual({ state: 'ready', passkey: false, google: false, apple: false }); // serveur antérieur : pas de bouton
    expect(await fetchLoginMethodsStatus(async () => new Response('', { status: 502 }))).toEqual({ state: 'error' });
    expect(await fetchLoginMethodsStatus(async () => { throw new TypeError('Failed to fetch'); })).toEqual({ state: 'error' });
  });
  it('classification des échecs', () => {
    expect(classifyMfaFailure(503, 'MFA_METHOD_UNAVAILABLE')).toBe('unavailable');
    expect(classifyMfaFailure(503, 'SERVICE_UNAVAILABLE')).toBe('temporary');
    expect(classifyMfaFailure(500, 'MFA_FAILED')).toBe('temporary');
    expect(classifyMfaFailure(400, 'MFA_INVALID')).toBe('other');
    expect(classifyMfaFailure(429, 'MFA_THROTTLED')).toBe('other');
  });
});

describe('L111W-MSG messages de repli exacts', () => {
  it('connexion anonyme : e-mail / mot de passe, puis Google / Apple seulement s’ils sont actifs — jamais un facteur', () => {
    expect(loginAlternativesText({})).toBe('Connectez-vous avec votre e-mail et votre mot de passe.');
    expect(loginAlternativesText({ google: true, apple: true })).toBe('Connectez-vous avec votre e-mail et votre mot de passe, ou avec Google ou Apple.');
    expect(loginAlternativesText({ apple: true })).toBe('Connectez-vous avec votre e-mail et votre mot de passe, ou avec Apple.');
    const t = loginPasskeyUnavailableText({ google: true });
    expect(t).toBe('Les clés d’accès ne sont pas disponibles pour le moment. Connectez-vous avec votre e-mail et votre mot de passe, ou avec Google.');
    expect(t).not.toMatch(/application d’authentification/);
  });
  it('seconde étape : seulement les facteurs enrôlés ET disponibles, sinon récupération', () => {
    const base = { methods: { passkey: true, totp: true }, passkeysAvailable: true, totpAvailable: true, webauthnHere: true };
    expect(verificationChoices(base)).toEqual({ passkey: true, totp: true, notice: null });
    expect(verificationChoices({ ...base, passkeysAvailable: false })).toEqual({ passkey: false, totp: true, notice: null });
    expect(verificationChoices({ ...base, methods: { passkey: true, totp: false }, passkeysAvailable: false }).notice)
      .toBe('Les clés d’accès sont momentanément indisponibles. Réessayez plus tard, ou utilisez un code de récupération (« Je n’ai plus accès à ma méthode de sécurité »).');
    expect(verificationChoices({ ...base, methods: { passkey: true, totp: false }, webauthnHere: false }).notice).toMatch(/ne peut pas être utilisée sur cet appareil/);
    expect(verificationChoices({ ...base, methods: { passkey: false, totp: true }, totpAvailable: false })).toMatchObject({ passkey: false, totp: false });
    expect(verificationChoices({ ...base, passkeysAvailable: false, totpAvailable: false }).notice).toMatch(/^Vos méthodes de sécurité sont momentanément indisponibles/);
    // Une méthode NON enrôlée n'est jamais proposée, même disponible.
    expect(verificationChoices({ ...base, methods: { passkey: false, totp: false } })).toMatchObject({ passkey: false, totp: false });
  });
  it('503 en seconde étape : l’autre facteur seulement s’il est utilisable', () => {
    expect(verificationUnavailableText('passkey', true)).toBe('Les clés d’accès ne sont pas disponibles pour le moment. Utilisez le code de votre application d’authentification.');
    expect(verificationUnavailableText('passkey', false)).not.toMatch(/application d’authentification/);
    expect(verificationUnavailableText('passkey', false)).toMatch(/code de récupération/);
    expect(verificationUnavailableText('totp', false)).not.toMatch(/clé d’accès\./);
  });
  it('premier facteur : mentions exactes, jamais de renvoi vers une méthode indisponible', () => {
    expect(enrollmentChoices({ passkeysAvailable: false, totpAvailable: true, webauthnHere: true }))
      .toMatchObject({ passkey: false, passkeyNote: 'Momentanément indisponible : choisissez le code de sécurité.', totp: true, notice: null });
    expect(enrollmentChoices({ passkeysAvailable: true, totpAvailable: true, webauthnHere: false }).passkeyNote).toBe('Non disponible sur cet appareil : choisissez le code de sécurité.');
    expect(enrollmentChoices({ passkeysAvailable: true, totpAvailable: false, webauthnHere: true }))
      .toMatchObject({ passkey: true, totp: false, totpNote: 'Momentanément indisponible : choisissez la clé d’accès.' });
    const none = enrollmentChoices({ passkeysAvailable: false, totpAvailable: false, webauthnHere: true });
    expect(none).toMatchObject({ passkey: false, totp: false, passkeyNote: 'Momentanément indisponible.', totpNote: 'Momentanément indisponible.' });
    expect(none.notice).toMatch(/Aucune méthode de sécurité ne peut être configurée/);
  });
  it('plus aucun repli automatique « Utilisez l’application d’authentification » dans le code applicatif', () => {
    const root = join(__dirname, '../../../../..');
    for (const f of [
      'src/lib/auth/mfa/http.ts', 'src/app/(auth)/login/page.tsx', 'src/app/(auth)/verification/page.tsx',
      'src/app/(auth)/securiser-mon-compte/page.tsx',
    ]) {
      expect(readFileSync(join(root, f), 'utf8'), f).not.toContain('Utilisez l’application d’authentification');
    }
    const login = readFileSync(join(root, 'src/app/(auth)/login/page.tsx'), 'utf8');
    expect(login).toContain('loginPasskeyOffer(clientPasskey, serverStatus)');
    expect(login).toContain('fetchLoginMethodsStatus');
  });
});
