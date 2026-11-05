/**
 * Lot 111E — contrôle BO « Association iOS / Android » (remplissage
 * automatique des mots de passe) : variables manquantes par NOM, fichiers
 * servis (200, sans redirection, JSON, identités), copie du CDN Apple,
 * aucune valeur secrète restituée. Réseau simulé (fetch injecté).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appleAppSiteAssociation, androidAssetLinks } from '@/lib/mobile/app-links';
import { EXPECTED_APP_IDS, checkCredentialAssociation } from '@/services/admin/ops/credential-association';

const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const ENV_OK = {
  NEXT_PUBLIC_APP_ENV: 'preprod',
  NEXT_PUBLIC_APP_URL: 'https://app.preprod.verebona.fr',
  MOBILE_IOS_TEAM_ID: 'ABCDE12345',
  MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app.preprod',
  MOBILE_ANDROID_PACKAGE: 'fr.verebona.app.preprod',
  MOBILE_ANDROID_SHA256_FINGERPRINTS: FP,
  // Secrets voisins : ne doivent jamais apparaître dans le rapport.
  FCM_SERVICE_ACCOUNT_JSON: '{"private_key":"SECRET-NE-PAS-AFFICHER"}',
};

type Resp = { status: number; body?: string; headers?: Record<string, string> };
function fakeFetch(map: Record<string, Resp | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = map[url];
    if (!r) return new Response('Not Found', { status: 404 });
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

const AASA_URL = 'https://app.preprod.verebona.fr/.well-known/apple-app-site-association';
const AL_URL = 'https://app.preprod.verebona.fr/.well-known/assetlinks.json';
const CDN_URL = 'https://app-site-association.cdn-apple.com/a/v1/app.preprod.verebona.fr';

describe('L111E — contrôle « Association iOS / Android »', () => {
  it('ASSOC-01 — tout correct : fichiers servis 200 JSON conformes, copie Apple à jour', async () => {
    const aasa = JSON.stringify(appleAppSiteAssociation(ENV_OK));
    const { impl, calls } = fakeFetch({
      [AASA_URL]: { status: 200, body: aasa },
      [CDN_URL]: { status: 200, body: aasa },
      [AL_URL]: { status: 200, body: JSON.stringify(androidAssetLinks(ENV_OK)) },
    });
    const r = await checkCredentialAssociation(ENV_OK, impl);
    expect(r.host).toBe('app.preprod.verebona.fr');
    expect(r.expectedAppId).toBe('fr.verebona.app.preprod');
    expect(r.ios.verdict).toBe('ok');
    expect(r.ios.identities).toEqual(['ABCDE12345.fr.verebona.app.preprod']);
    expect(r.ios.served?.matches).toBe(true);
    expect(r.ios.appleCdn?.matches).toBe(true);
    expect(r.ios.summary).toContain('webcredentials.apps = ABCDE12345.fr.verebona.app.preprod');
    expect(r.android.verdict).toBe('ok');
    expect(r.android.summary).toContain('get_login_creds');
    // Sans redirection suivie (une redirection invalide l'association iOS).
    expect(calls.every((c) => c.init?.redirect === 'manual')).toBe(true);
    const json = JSON.stringify(r);
    expect(json).not.toContain(FP);
    expect(json).not.toContain('SECRET-NE-PAS-AFFICHER');
  });

  it('ASSOC-02 — non configuré : NOMS des variables manquantes, verdict « non configuré », 404 servi', async () => {
    const env = { NEXT_PUBLIC_APP_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://app.verebona.fr' };
    const { impl } = fakeFetch({});
    const r = await checkCredentialAssociation(env, impl);
    expect(r.expectedAppId).toBe('fr.verebona.app');
    expect(r.ios.verdict).toBe('non-configure');
    expect(r.ios.missingVariables).toEqual(['MOBILE_IOS_TEAM_ID', 'MOBILE_IOS_BUNDLE_IDS']);
    expect(r.android.missingVariables).toEqual(['MOBILE_ANDROID_PACKAGE', 'MOBILE_ANDROID_SHA256_FINGERPRINTS']);
    expect(r.ios.served?.status).toBe(404);
    expect(r.ios.summary).toMatch(/404/);
  });

  it('ASSOC-03 — redirection, JSON invalide, identités différentes ou bundle d’un autre environnement → « À corriger »', async () => {
    const { impl } = fakeFetch({
      [AASA_URL]: { status: 301, headers: { location: 'https://verebona.fr/' } },
      [AL_URL]: { status: 200, body: '<html>' , headers: { 'content-type': 'text/html' } },
    });
    const r = await checkCredentialAssociation({ ...ENV_OK, MOBILE_IOS_BUNDLE_IDS: 'fr.verebona.app' }, impl);
    expect(r.ios.verdict).toBe('ko');
    expect(r.ios.expectedAppPresent).toBe(false);
    expect(r.ios.summary).toContain('redirection');
    expect(r.ios.summary).toContain('fr.verebona.app.preprod');
    expect(r.android.verdict).toBe('ko');
    expect(r.android.summary).toContain('JSON invalide');
  });

  it('ASSOC-04 — serveur injoignable / adresse publique inconnue : dit pourquoi, ne plante pas', async () => {
    const { impl } = fakeFetch({ [AASA_URL]: new Error('ECONNREFUSED'), [CDN_URL]: new Error('x'), [AL_URL]: new Error('x') });
    const r = await checkCredentialAssociation(ENV_OK, impl);
    expect(r.ios.served?.error).toBe('adresse injoignable depuis le serveur');
    expect(r.ios.verdict).toBe('ko');
    const sansOrigine = await checkCredentialAssociation({ ...ENV_OK, NEXT_PUBLIC_APP_URL: undefined }, impl);
    expect(sansOrigine.missingOriginVariables).toEqual(['APP_URL', 'NEXT_PUBLIC_APP_URL']);
    expect(sansOrigine.ios.served).toBeNull();
    expect(sansOrigine.ios.verdict).toBe('ok');
    expect(sansOrigine.ios.summary).toContain('non vérifiable');
  });

  it('ASSOC-05 — identifiants attendus = appId de mobile/config/environments.mjs', () => {
    const src = readFileSync(join(process.cwd(), 'mobile/config/environments.mjs'), 'utf8');
    expect(src).toContain(`appId: '${EXPECTED_APP_IDS.preprod}'`);
    expect(src).toContain(`appId: '${EXPECTED_APP_IDS.production}'`);
  });

  it('ASSOC-06 — AASA : webcredentials.apps ; assetlinks : get_login_creds ; entitlements webcredentials:$(VB_APP_HOST) ; garde CI sur le binaire signé', () => {
    expect((appleAppSiteAssociation(ENV_OK) as { webcredentials: { apps: string[] } }).webcredentials.apps).toEqual(['ABCDE12345.fr.verebona.app.preprod']);
    expect(JSON.stringify(androidAssetLinks(ENV_OK))).toContain('delegate_permission/common.get_login_creds');
    expect(readFileSync(join(process.cwd(), 'mobile/ios/App/App/App.entitlements'), 'utf8')).toContain('<string>webcredentials:$(VB_APP_HOST)</string>');
    const wf = readFileSync(join(process.cwd(), '.github/workflows/mobile-ios.yml'), 'utf8');
    expect(wf).toContain('grep -q "webcredentials:$HOST<"');
  });

  it('ASSOC-07 — BO : route admin gardée, carte branchée dans « Application mobile »', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/admin/ops/mobile/association/route.ts'), 'utf8');
    expect(route).toContain('requireAdmin(request)');
    expect(readFileSync(join(process.cwd(), 'src/app/admin/exploitation/_components/MobilePanel.tsx'), 'utf8')).toContain('<CredentialAssociationCard />');
  });
});
