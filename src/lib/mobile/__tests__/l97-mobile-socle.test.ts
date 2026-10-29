/**
 * Lot 97 — socle serveur de l'application mobile (CDC 12) : contexte client,
 * compatibilité / version minimale, interrupteurs, fichiers d'association,
 * fournisseur push, chiffrement des jetons, politique §18.3.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { compareVersions, parseAppVersion, readClientContext } from '@/lib/mobile/client-context';
import {
  APP_UPDATE_REQUIRED_CODE, appUpdateRequiredBody, evaluateCompatibility, isExemptFromVersionGate, publicMobileConfig, readMobileServerConfig,
} from '@/lib/mobile/mobile-config';
import { androidAssetLinks, appleAppSiteAssociation, APP_LINK_ROUTES, appLinksStatus } from '@/lib/mobile/app-links';
import { classifyFcmError, fcmConfigStatus } from '@/lib/mobile/push-provider';
import { decryptPushToken, encryptPushToken, pushTokenHash } from '@/lib/mobile/push-token-crypto';
import { mobileCollapseKey, mobilePushPolicy } from '@/lib/notifications/mobile-push';
import { lireRestrictionReemission } from '@/lib/notifications/reemission-restriction';
import { canauxAReemettre } from '@/services/notifications/notification-reemission.service';
import { getCatalogEntry } from '@/lib/notifications/catalog';
import { middleware } from '@/middleware';

const req = (headers: Record<string, string>, path = '/api/assets') => new NextRequest(`http://localhost:3000${path}`, { headers });

describe('L97 — contexte client (API-02, VER-01)', () => {
  it('lit plateforme, version, build et installation ; absent → WEB', () => {
    const c = readClientContext(req({
      'X-Verebona-Client': 'ios', 'X-Verebona-App-Version': '1.4', 'X-Verebona-App-Build': '52',
      'X-Verebona-Installation-Id': '0f8fad5b-d9cb-469f-a165-70867728950e',
    }));
    expect(c).toMatchObject({ client: 'IOS', declared: true, appVersion: '1.4.0', build: '52', installationId: '0f8fad5b-d9cb-469f-a165-70867728950e', issues: [] });
    expect(readClientContext(req({}))).toMatchObject({ client: 'WEB', declared: false, appVersion: null, installationId: null });
  });

  it('valeurs invalides : null + anomalie, jamais une valeur devinée', () => {
    const c = readClientContext(req({ 'X-Verebona-Client': 'windows', 'X-Verebona-App-Version': 'v2-beta', 'X-Verebona-Installation-Id': 'court' }));
    expect(c.client).toBe('WEB');
    expect(c.appVersion).toBeNull();
    expect(c.installationId).toBeNull();
    expect(c.issues).toEqual(['client_invalide', 'version_invalide', 'installation_invalide']);
  });

  it('version avec build accolé ; comparaison numérique', () => {
    expect(parseAppVersion('1.2.3+45')).toEqual({ version: '1.2.3', build: '45' });
    expect(parseAppVersion('2.0 (7)')).toEqual({ version: '2.0.0', build: '7' });
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
  });
});

describe('L97 — version minimale et interrupteurs (API-07/08, VER-02..06)', () => {
  const env = {
    NEXT_PUBLIC_APP_ENV: 'preprod', MOBILE_MIN_VERSION_IOS: '1.2.0', MOBILE_MIN_VERSION_ANDROID: '1.1.0+30',
    MOBILE_STORE_URL_IOS: 'https://apps.apple.com/app/id000', MOBILE_FEATURES_OFF: 'scan,ios:background_upload,inconnue',
  };
  const cfg = readMobileServerConfig(env);
  const ctx = (h: Record<string, string>) => readClientContext(req(h));

  it('iOS et Android ont chacun leur minimum ; sous le minimum → mise à jour requise', () => {
    expect(evaluateCompatibility(ctx({ 'X-Verebona-Client': 'IOS', 'X-Verebona-App-Version': '1.1.9' }), cfg).status).toBe('update_required');
    expect(evaluateCompatibility(ctx({ 'X-Verebona-Client': 'IOS', 'X-Verebona-App-Version': '1.2.0' }), cfg).status).toBe('ok');
    expect(evaluateCompatibility(ctx({ 'X-Verebona-Client': 'ANDROID', 'X-Verebona-App-Version': '1.1.0+29' }), cfg).status).toBe('update_required');
    expect(evaluateCompatibility(ctx({ 'X-Verebona-Client': 'ANDROID', 'X-Verebona-App-Version': '1.1.0+30' }), cfg).status).toBe('ok');
  });

  it('jamais pour le Web ni la PWA ; client natif sans version : non bloqué (VER-04)', () => {
    expect(evaluateCompatibility(ctx({ 'X-Verebona-App-Version': '0.0.1' }), cfg).status).toBe('not_mobile');
    expect(evaluateCompatibility(ctx({ 'X-Verebona-Client': 'PWA', 'X-Verebona-App-Version': '0.0.1' }), cfg).status).toBe('not_mobile');
    expect(evaluateCompatibility(ctx({ 'X-Verebona-Client': 'IOS' }), cfg).status).toBe('unknown_version');
  });

  it('interrupteurs par plateforme ; fonction inconnue signalée ; COM-07 désactivé par défaut', () => {
    expect(cfg.features.ios.scan).toBe(false);
    expect(cfg.features.android.scan).toBe(false);
    expect(cfg.features.ios.background_upload).toBe(false);
    expect(cfg.features.android.background_upload).toBe(true);
    expect(cfg.features.ios.external_purchase_link).toBe(false);
    expect(cfg.issues.join(' ')).toMatch(/inconnue/);
    const on = readMobileServerConfig({ MOBILE_FEATURES_ON: 'external_purchase_link', MOBILE_FEATURES_OFF: 'android:external_purchase_link' });
    expect(on.features.ios.external_purchase_link).toBe(true);
    expect(on.features.android.external_purchase_link).toBe(false); // une coupure l'emporte
  });

  it('valeur invalide ignorée et signalée (aucun minimum deviné)', () => {
    const c = readMobileServerConfig({ MOBILE_MIN_VERSION_IOS: 'latest', MOBILE_STORE_URL_ANDROID: 'http://play' });
    expect(c.minVersions.ios).toBeNull();
    expect(c.storeUrls.android).toBeNull();
    expect(c.issues).toHaveLength(2);
  });

  it('configuration publique et corps du refus (contrat d’erreur API-06)', () => {
    const pub = publicMobileConfig(cfg, ctx({ 'X-Verebona-Client': 'IOS', 'X-Verebona-App-Version': '1.0.0' })) as Record<string, any>;
    expect(pub.environment).toBe('preprod');
    expect(pub.platforms.ios).toMatchObject({ minVersion: '1.2.0', storeUrl: 'https://apps.apple.com/app/id000' });
    expect(pub.client).toEqual({ platform: 'ios', appVersion: '1.0.0', updateRequired: true });
    const body = appUpdateRequiredBody(evaluateCompatibility(ctx({ 'X-Verebona-Client': 'IOS', 'X-Verebona-App-Version': '1.0.0' }), cfg));
    expect(body).toMatchObject({ code: APP_UPDATE_REQUIRED_CODE, details: { platform: 'ios', minVersion: '1.2.0' } });
    expect(Object.keys(body).sort()).toEqual(['code', 'details', 'error', 'message', 'timestamp']);
  });

  it('routes exemptées : configuration, sondes, renouvellement, déconnexion, désinscription push', () => {
    for (const p of ['/api/mobile/config', '/api/health/ready', '/api/auth/refresh', '/api/auth/logout', '/api/mobile/push-installations/current']) {
      expect(isExemptFromVersionGate(p), p).toBe(true);
    }
    expect(isExemptFromVersionGate('/api/assets')).toBe(false);
    expect(isExemptFromVersionGate('/api/auth/login')).toBe(false);
  });
});

describe('L97 — middleware : refus contrôlé 426 APP_UPDATE_REQUIRED', () => {
  it('app native trop ancienne : 426 ; Web : jamais ; configuration lisible', async () => {
    const avant = process.env.MOBILE_MIN_VERSION_ANDROID;
    process.env.MOBILE_MIN_VERSION_ANDROID = '2.0.0';
    try {
      const ancien = { 'X-Verebona-Client': 'ANDROID', 'X-Verebona-App-Version': '1.9.0', origin: 'http://localhost:3000' };
      const r = await middleware(req(ancien, '/api/assets'));
      expect(r.status).toBe(426);
      const b = await r.json();
      expect(b.code).toBe('APP_UPDATE_REQUIRED');
      expect(r.headers.get('x-verebona-min-version')).toBe('2.0.0');
      // Web avec la même « version » : contrôle de session normal (401), jamais 426.
      expect((await middleware(req({ 'X-Verebona-App-Version': '1.9.0', origin: 'http://localhost:3000' }, '/api/assets'))).status).toBe(401);
      // La configuration reste lisible sans session par l'app à mettre à jour.
      expect((await middleware(req(ancien, '/api/mobile/config'))).headers.get('x-middleware-next')).toBe('1');
    } finally {
      if (avant === undefined) delete process.env.MOBILE_MIN_VERSION_ANDROID; else process.env.MOBILE_MIN_VERSION_ANDROID = avant;
    }
  });

  it('page protégée sans session : la destination mémorisée garde sa requête (§19)', async () => {
    const r = await middleware(new NextRequest('http://localhost:3000/documents?drawer=document%3A12'));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get('location')!).searchParams.get('returnUrl')).toBe('/documents?drawer=document%3A12');
  });
});

describe('L97 — liens universels / App Links (§19)', () => {
  it('non configuré : rien (404 côté route)', () => {
    expect(appleAppSiteAssociation({})).toBeNull();
    expect(androidAssetLinks({})).toBeNull();
  });

  it('AASA : appIDs de l’environnement, exclusions commerciales en tête, chemins du CDC', () => {
    const aasa = appleAppSiteAssociation({ MOBILE_IOS_TEAM_ID: 'ABCDE12345', MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app.preprod' }) as any;
    const d = aasa.applinks.details[0];
    expect(d.appIDs).toEqual(['ABCDE12345.fr.verebona.app.preprod']);
    expect(d.components[0]).toMatchObject({ '/': '/mon-compte/offres*', exclude: true });
    const chemins = d.components.map((c: any) => c['/']);
    for (const p of ['/verify-email*', '/reset-password*', '/duo/join/*', '/assets/*', '/documents/*', '/agenda*', '/accueil/a-traiter*']) expect(chemins).toContain(p);
    expect(APP_LINK_ROUTES.length).toBeGreaterThanOrEqual(7);
  });

  it('assetlinks : paquet + empreintes valides ; empreinte invalide signalée', () => {
    const fp = Array.from({ length: 32 }, () => 'AB').join(':');
    const al = androidAssetLinks({ MOBILE_ANDROID_PACKAGE: 'fr.verebona.app', MOBILE_ANDROID_SHA256_FINGERPRINTS: `${fp.toLowerCase()},zz` }) as any[];
    expect(al[0].target).toEqual({ namespace: 'android_app', package_name: 'fr.verebona.app', sha256_cert_fingerprints: [fp] });
    expect(appLinksStatus({ MOBILE_ANDROID_PACKAGE: 'fr.verebona.app', MOBILE_ANDROID_SHA256_FINGERPRINTS: `${fp},zz` }).android.issues).toHaveLength(1);
    expect(appLinksStatus({ MOBILE_IOS_TEAM_ID: 'abc', MOBILE_IOS_BUNDLE_IDS: 'x' }).ios.configured).toBe(false);
  });
});

describe('L97 — push : fournisseur, jetons, politique (§18)', () => {
  it('FCM inactif sans variables ; JSON illisible signalé sans valeur', () => {
    expect(fcmConfigStatus({})).toEqual({ configured: false, projectId: null, issue: null });
    expect(fcmConfigStatus({ FIREBASE_SERVICE_ACCOUNT_JSON: 'pas du json' }).issue).toMatch(/illisible/);
    const sa = JSON.stringify({ project_id: 'vb-preprod', client_email: 'x@y.iam.gserviceaccount.com', private_key: '---' });
    expect(fcmConfigStatus({ FIREBASE_SERVICE_ACCOUNT_JSON: Buffer.from(sa).toString('base64') })).toEqual({ configured: true, projectId: 'vb-preprod', issue: null });
  });

  it('erreurs FCM : jeton invalide nettoyé, quota temporaire, authentification = configuration', () => {
    expect(classifyFcmError(404, { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] }).kind).toBe('invalid_token');
    expect(classifyFcmError(403, { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] }).kind).toBe('invalid_token');
    expect(classifyFcmError(400, { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' }).kind).toBe('invalid_token');
    expect(classifyFcmError(400, { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' }).kind).toBe('rejected');
    expect(classifyFcmError(429, { details: [{ errorCode: 'QUOTA_EXCEEDED' }] }).kind).toBe('transient');
    expect(classifyFcmError(401, {}).kind).toBe('config');
    expect(classifyFcmError(401, { details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }] }).kind).toBe('config');
  });

  it('jeton chiffré au repos (AES-GCM) ; autre clé → illisible ; empreinte stable', () => {
    const env = { JWT_SECRET: 'x'.repeat(40) };
    const enc = encryptPushToken('fcm-token-abcdefghijklmnopqrstuvwxyz', env);
    expect(enc).not.toContain('fcm-token');
    expect(decryptPushToken(enc, env)).toBe('fcm-token-abcdefghijklmnopqrstuvwxyz');
    expect(decryptPushToken(enc, { MOBILE_PUSH_TOKEN_KEY: 'autre-cle-de-chiffrement' })).toBeNull();
    expect(pushTokenHash('t')).toBe(pushTokenHash('t'));
    expect(pushTokenHash('t')).not.toContain('t:');
  });

  it('catalogue §18.3 : échéances, À traiter, Duo, sécurité oui ; commercial et actualités non', () => {
    const r = (t: string) => mobilePushPolicy(getCatalogEntry(t as never)!);
    expect(r('DEADLINE_DUE_IN_7_DAYS')).toBe('yes');
    expect(r('TO_PROCESS_DAILY_DIGEST')).toBe('yes');
    expect(r('DUO_INVITATION_RECEIVED')).toBe('yes');
    expect(r('DOCUMENT_BATCH_FAILED')).toBe('yes');
    expect(r('DOCUMENT_BATCH_COMPLETED')).toBe('optional');
    expect(r('PASSWORD_CHANGED')).toBe('yes');
    expect(r('GDPR_EXPORT_READY')).toBe('optional');
    expect(r('PAYMENT_FAILED')).toBe('no');
    expect(r('TRIAL_ENDING')).toBe('no');
    expect(r('NEWS_ANNOUNCEMENT')).toBe('no');
  });

  it('clé de regroupement : stable entre réémissions, sans donnée lisible', () => {
    const k = mobileCollapseKey('to-process:digest:2026-10-26:a12:n1:u5');
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(mobileCollapseKey('to-process:digest:2026-10-26:a12:n1:u5:reemis:1730000000000')).toBe(k);
  });

  it('réémission : seuls les appareils mobiles en échec ; restriction antérieure → aucun mobile', () => {
    const r = canauxAReemettre([
      { channel: 'push', status: 'sent', mobileInstallationId: 'm1' },
      { channel: 'push', status: 'failed', mobileInstallationId: 'm2' },
      { channel: 'bell', status: 'sent' },
    ]);
    expect(r).toEqual({ canaux: ['push'], mobileInstallationIds: ['m2'] });
    const lu = lireRestrictionReemission({ _reemission: { canaux: ['push'], ...r } });
    expect(lu.restriction).toEqual({ canaux: ['push'], mobileInstallationIds: ['m2'] });
    // Lot 94 (M3) : l'ancienne clé Web Push d'une réémission déjà en file est ignorée — aucun appareil servi.
    expect(lireRestrictionReemission({ _reemission: { canaux: ['push'], pushSubscriptionIds: ['w1'] } }).restriction).toEqual({ canaux: ['push'] });
  });
});
