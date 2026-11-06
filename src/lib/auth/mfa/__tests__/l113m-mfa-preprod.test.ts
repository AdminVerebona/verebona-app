/**
 * Lot 113M (Trello #705) — préproduction : configuration Passkeys / TOTP,
 * BO et connexion. Complète L111W (même architecture, aucun système parallèle).
 *
 *   L113M-ENV    capture du 05/11 : préproduction déployée (NODE_ENV=production)
 *                → « Préproduction », NODE_ENV à part ; jamais « production » par défaut ;
 *   L113M-ASSOC  cohérence : association de l'app mobile de CET environnement
 *                (webcredentials iOS, get_login_creds Android) quand les clés
 *                d'accès sont configurées — variables par NOM, aucun secret ;
 *   L113M-OFFER  bouton de connexion = vue compatible ET service serveur prêt ;
 *                erreur ponctuelle → « Réessayer » ; statut sans donnée de compte ;
 *   L113M-ACCOUNT Mon compte › Sécurité : seuls les ajouts réalisables ;
 *   L113M-UI     écrans : aucune proposition avant de connaître la vue, plus de
 *                repli « Utilisez l'application d'authentification ».
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMfaCoherence, resolveAppEnvironment } from '../environment';
import { appleAppSiteAssociation, androidAssetLinks } from '@/lib/mobile/app-links';
import {
  LOGIN_METHODS_STATUS_URL, fetchLoginMethodsStatus, loginPasskeyOffer, securitySettingsChoices,
} from '../availability';

const KEY = Buffer.alloc(32, 9).toString('base64');
const FP = Array.from({ length: 32 }, () => 'CD').join(':');
const BARE = { NODE_ENV: 'production', NEXT_PUBLIC_APP_ENV: 'preprod', APP_URL: 'https://app.preprod.verebona.fr' };
const CONFIGURED = { ...BARE, WEBAUTHN_RP_ID: 'app.preprod.verebona.fr', WEBAUTHN_ORIGINS: 'https://app.preprod.verebona.fr', MFA_ENCRYPTION_KEYS: `k2026a:${KEY}` };
const MOBILE = { MOBILE_IOS_TEAM_ID: 'ABCDE12345', MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app.preprod', MOBILE_ANDROID_PACKAGE: 'fr.verebona.app.preprod', MOBILE_ANDROID_SHA256_FINGERPRINTS: FP };
const codes = (env: Record<string, string | undefined>) => checkMfaCoherence(env).issues.map((i) => i.code);
const root = join(__dirname, '..', '..', '..', '..', '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

describe('L113M-ENV environnement applicatif ≠ mode technique', () => {
  it('capture du 05/11 : NODE_ENV=production en préproduction → « Préproduction » + NODE_ENV restitué séparément', () => {
    const r = checkMfaCoherence(BARE);
    expect(r.environment).toEqual({ key: 'preprod', label: 'Préproduction', variable: 'NEXT_PUBLIC_APP_ENV', nodeEnv: 'production' });
    expect(r.issues.map((i) => i.code)).toEqual(['WEBAUTHN_NOT_CHECKED']);
  });
  it('NEXT_PUBLIC_APP_ENV absente : jamais « Production », même avec NODE_ENV=production', () => {
    const e = resolveAppEnvironment({ NODE_ENV: 'production' });
    expect(e.key).toBeNull();
    expect(e.label).not.toMatch(/production/i);
  });
  it('la route BO ne lit plus NODE_ENV comme environnement (aucun `VEREBONA_ENV ?? NODE_ENV`)', () => {
    const src = read('src/app/api/admin/ops/mfa/route.ts');
    expect(src).not.toMatch(/VEREBONA_ENV\s*\?\?\s*process\.env\.NODE_ENV/);
    expect(src).toContain('checkMfaCoherence');
  });
});

describe('L113M-ASSOC association de l’app mobile dans la cohérence MFA', () => {
  it('clés d’accès configurées sans association : iPhone et Android signalés (avertissement, le web reste prêt)', () => {
    const r = checkMfaCoherence(CONFIGURED);
    expect(r.verdict).toBe('warn');
    expect(r.issues.map((i) => i.code)).toEqual(['IOS_WEBCREDENTIALS_MISSING', 'ANDROID_ASSETLINKS_MISSING']);
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(r.issues[0].message).toContain('MOBILE_IOS_TEAM_ID');
  });
  it('association de l’app de préproduction : cohérente', () => {
    expect(checkMfaCoherence({ ...CONFIGURED, ...MOBILE })).toMatchObject({ verdict: 'ok', issues: [] });
  });
  it('app de production déclarée en préproduction (ou l’inverse) : signalée', () => {
    expect(codes({ ...CONFIGURED, ...MOBILE, MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app', MOBILE_ANDROID_PACKAGE: 'fr.verebona.app' }))
      .toEqual(['IOS_WEBCREDENTIALS_APP_MISSING', 'ANDROID_ASSETLINKS_APP_MISMATCH']);
    const prod = {
      NODE_ENV: 'production', NEXT_PUBLIC_APP_ENV: 'production', APP_URL: 'https://app.verebona.fr', WEBAUTHN_RP_ID: 'app.verebona.fr',
      WEBAUTHN_ORIGINS: 'https://app.verebona.fr', MFA_ENCRYPTION_KEYS: `k2026a:${KEY}`, ...MOBILE,
    };
    expect(codes(prod)).toEqual(['IOS_WEBCREDENTIALS_APP_MISSING', 'ANDROID_ASSETLINKS_APP_MISMATCH']);
    // Les deux apps déclarées (un même serveur) : l'app attendue est présente.
    expect(codes({ ...prod, MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app,fr.verebona.app.preprod' })).not.toContain('IOS_WEBCREDENTIALS_APP_MISSING');
  });
  it('clés d’accès non configurées : pas de bruit sur l’association (le manque WebAuthn prime)', () => {
    expect(codes(BARE)).not.toContain('IOS_WEBCREDENTIALS_MISSING');
  });
  it('fichiers servis pour la préproduction : webcredentials.apps et get_login_creds présents (lecture du code servi)', () => {
    const aasa = appleAppSiteAssociation({ ...MOBILE }) as { webcredentials: { apps: string[] } };
    expect(aasa.webcredentials.apps).toEqual(['ABCDE12345.fr.verebona.app.preprod']);
    const links = androidAssetLinks({ ...MOBILE }) as { relation: string[]; target: { package_name: string } }[];
    expect(links[0].relation).toContain('delegate_permission/common.get_login_creds');
    expect(links[0].target.package_name).toBe('fr.verebona.app.preprod');
    expect(read('mobile/ios/App/App/App.entitlements')).toContain('<string>webcredentials:$(VB_APP_HOST)</string>');
  });
  it('aucun secret dans le rapport', () => {
    const json = JSON.stringify(checkMfaCoherence({ ...CONFIGURED, ...MOBILE }));
    expect(json).not.toContain(KEY);
    expect(json).not.toContain(FP);
  });
});

describe('L113M-OFFER bouton de connexion par clé d’accès', () => {
  const ready = (passkey: boolean) => ({ state: 'ready' as const, passkey, google: false, apple: false });
  it('matrice client × serveur', () => {
    expect(loginPasskeyOffer(true, ready(true))).toBe('show');
    expect(loginPasskeyOffer(true, ready(false))).toBe('hide'); // capture du 05/11 : plus de bouton trompeur
    expect(loginPasskeyOffer(false, ready(true))).toBe('hide');
    expect(loginPasskeyOffer(null, ready(true))).toBe('checking');
    expect(loginPasskeyOffer(true, null)).toBe('checking');
    expect(loginPasskeyOffer(true, { state: 'error' })).toBe('retry');
    expect(loginPasskeyOffer(false, { state: 'error' })).toBe('hide');
  });
  it('erreur ponctuelle (réseau, 5xx) → état « error » ; statut lu sur la route publique, sans identifiant', async () => {
    const seen: string[] = [];
    const net = vi.fn(async (u: string) => { seen.push(u); throw new TypeError('Failed to fetch'); });
    expect(await fetchLoginMethodsStatus(net)).toEqual({ state: 'error' });
    expect(await fetchLoginMethodsStatus(async () => new Response('x', { status: 502 }))).toEqual({ state: 'error' });
    expect(await fetchLoginMethodsStatus(async () => Response.json({ passkey: true, google: true, apple: false })))
      .toEqual({ state: 'ready', passkey: true, google: true, apple: false });
    expect(seen).toEqual([LOGIN_METHODS_STATUS_URL]);
    expect(LOGIN_METHODS_STATUS_URL).not.toMatch(/[?#]/);
  });
});

describe('L113M-ACCOUNT Mon compte › Sécurité : ajouts réalisables seulement', () => {
  it('service serveur indisponible ≠ appareil incompatible', () => {
    expect(securitySettingsChoices({ passkeysAvailable: false, totpAvailable: true, webauthnHere: true }))
      .toEqual({ addPasskey: false, passkeyNote: 'Les clés d’accès ne sont pas disponibles pour le moment.', setupTotp: true, totpNote: null });
    expect(securitySettingsChoices({ passkeysAvailable: true, totpAvailable: true, webauthnHere: false }).passkeyNote)
      .toBe('Ajout de clé d’accès non disponible sur cet appareil.');
    expect(securitySettingsChoices({ passkeysAvailable: true, webauthnHere: true })).toEqual({ addPasskey: true, passkeyNote: null, setupTotp: true, totpNote: null });
  });
  it('vérification de la vue en cours : ni bouton ni mention', () => {
    expect(securitySettingsChoices({ passkeysAvailable: true, totpAvailable: true, webauthnHere: null })).toMatchObject({ addPasskey: false, passkeyNote: null });
  });
  it('trousseau TOTP indisponible : pas d’« Activer / Remplacer », mention exacte', () => {
    expect(securitySettingsChoices({ passkeysAvailable: true, totpAvailable: false, webauthnHere: true }))
      .toMatchObject({ setupTotp: false, totpNote: 'L’application d’authentification n’est pas disponible pour le moment.' });
  });
});

describe('L113M-UI écrans', () => {
  it('Mon compte › Sécurité branché sur securitySettingsChoices et totpAvailable', () => {
    const block = read('src/components/account/security/MfaBlock.tsx');
    expect(block).toContain('securitySettingsChoices(');
    expect(block).toMatch(/offer\.setupTotp && <Button/);
    expect(read('src/app/api/users/me/security/mfa/route.ts')).toContain('totpAvailable: keyRingStatus().problem === null');
  });
  it('/verification et /securiser-mon-compte : rien n’est proposé avant de connaître la vue', () => {
    const v = read('src/app/(auth)/verification/page.tsx');
    expect(v).toContain('useState<boolean | null>(null)');
    expect(v).toMatch(/state && webauthnHere !== null/);
    const s = read('src/app/(auth)/securiser-mon-compte/page.tsx');
    expect(s).toContain('useState<boolean | null>(null)');
    expect(s).toMatch(/view === 'choose' && webauthnHere === null/);
  });
  it('plus aucun repli « Utilisez l’application d’authentification » (écrans, routes, Mon compte)', () => {
    for (const f of [
      'src/lib/auth/mfa/http.ts', 'src/lib/auth/mfa/availability.ts', 'src/app/(auth)/login/page.tsx', 'src/app/(auth)/verification/page.tsx',
      'src/app/(auth)/securiser-mon-compte/page.tsx', 'src/components/account/security/MfaBlock.tsx',
    ]) expect(read(f), f).not.toContain('Utilisez l’application d’authentification');
  });
  it('script e2e de recette préproduction : 111W + 113M', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:e2e:mfa-preprod']).toContain('l111w-mfa-preprod.e2e.ts');
    expect(pkg.scripts['test:e2e:mfa-preprod']).toContain('l113m-mfa-preprod.e2e.ts');
  });
});
