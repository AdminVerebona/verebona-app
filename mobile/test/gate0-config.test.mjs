/**
 * Projet mobile — lot 95 (Gate 0). Tests propres au dossier mobile/ (`npm test`),
 * hors vitest / typecheck / lint du site (PO M4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENTS, OAUTH_RETURN_PATH, parseOrigin, resolveBuildConfig } from '../config/environments.mjs';
import { generatedFiles } from '../scripts/prepare.mjs';
import { MANIFEST, androidPathAttribute, appLinksBlock, applyBlock, loadServerRoutes } from '../scripts/app-links.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PREPROD = { VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: 'https://app.preprod.verebona.fr' };
const PROD = { VEREBONA_ENV: 'prod', VEREBONA_APP_ORIGIN: 'https://app.verebona.fr' };

test('M7 : deux applications distinctes, identifiants et noms décidés par le PO', () => {
  assert.equal(ENVIRONMENTS.preprod.appId, 'fr.verebona.app.preprod');
  assert.equal(ENVIRONMENTS.preprod.appName, 'Verebona Préprod');
  assert.equal(ENVIRONMENTS.prod.appId, 'fr.verebona.app');
  assert.equal(ENVIRONMENTS.prod.appName, 'Verebona');
  assert.notEqual(ENVIRONMENTS.preprod.urlScheme, ENVIRONMENTS.prod.urlScheme);
  assert.notEqual(ENVIRONMENTS.preprod.iosAppGroup, ENVIRONMENTS.prod.iosAppGroup);
});

test('configuration de build : valeurs résolues, marqueur d’agent utilisateur', () => {
  const b = resolveBuildConfig({ ...PREPROD, VEREBONA_APP_VERSION: '1.4.0', VEREBONA_APP_BUILD: '52' });
  assert.equal(b.uiMode, 'remote');
  assert.equal(b.startUrl, 'https://app.preprod.verebona.fr/accueil');
  assert.equal(b.oauthReturnUrl, `https://app.preprod.verebona.fr${OAUTH_RETURN_PATH}`);
  assert.equal(b.userAgentMarker, 'VerebonaApp/1.4.0 (52; preprod)');
  assert.equal(resolveBuildConfig({ ...PROD, VEREBONA_UI_MODE: 'local' }).uiMode, 'local');
});

test('isolation préprod / prod : aucun build croisé, aucune valeur devinée (REC-063/064)', () => {
  assert.throws(() => resolveBuildConfig({ VEREBONA_ENV: 'prod', VEREBONA_APP_ORIGIN: 'https://app.preprod.verebona.fr' }), /production vers une adresse de préproduction/);
  assert.throws(() => resolveBuildConfig({ VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: 'https://app.verebona.fr' }), /préproduction vers une adresse/);
  assert.throws(() => resolveBuildConfig({ VEREBONA_ENV: 'recette', VEREBONA_APP_ORIGIN: 'https://x.verebona.fr' }), /VEREBONA_ENV/);
  assert.throws(() => resolveBuildConfig({ VEREBONA_ENV: 'prod' }), /VEREBONA_APP_ORIGIN/);
  assert.throws(() => resolveBuildConfig({ ...PROD, VEREBONA_UI_MODE: 'hybride' }), /VEREBONA_UI_MODE/);
  assert.throws(() => resolveBuildConfig({ ...PROD, VEREBONA_APP_VERSION: '1.2' }), /VEREBONA_APP_VERSION/);
  assert.throws(() => resolveBuildConfig({ ...PROD, VEREBONA_APP_BUILD: '0' }), /VEREBONA_APP_BUILD/);
  assert.equal(parseOrigin('http://app.verebona.fr'), null);
  assert.equal(parseOrigin('https://app.verebona.fr/accueil'), null);
  assert.equal(parseOrigin('https://user:pw@app.verebona.fr'), null);
  assert.equal(parseOrigin('https://app.verebona.fr/'), 'https://app.verebona.fr');
});

test('capacitor.config.ts : mode A (site distant, domaine restreint, page hors connexion) et mode B', async () => {
  const load = async (env) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      return (await import(`../capacitor.config.ts?${Math.random()}`)).default;
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };
  const a = await load(PREPROD);
  assert.equal(a.appId, 'fr.verebona.app.preprod');
  assert.equal(a.server.url, 'https://app.preprod.verebona.fr/accueil');
  assert.deepEqual(a.server.allowNavigation, ['app.preprod.verebona.fr']);
  assert.equal(a.server.errorPath, 'offline.html');
  assert.equal(a.server.cleartext, false);
  assert.equal(a.plugins.PrivacyScreen.enable, true);
  assert.equal(a.plugins.CapacitorHttp.enabled, false);
  assert.equal(a.android.flavor, 'preprod');
  assert.equal(a.ios.webContentsDebuggingEnabled, true);

  const prod = await load({ ...PROD, VEREBONA_UI_MODE: 'local' });
  assert.equal(prod.server.url, undefined);
  assert.equal(prod.plugins.CapacitorHttp.enabled, true);
  assert.equal(prod.ios.webContentsDebuggingEnabled, false);
  assert.equal(prod.loggingBehavior, 'none');
  assert.ok(!JSON.stringify(prod).includes('preprod'), 'aucune valeur de préproduction dans un build de production');
});

test('fichiers générés par build : identifiants, version, domaine, aucune donnée secrète', () => {
  const f = generatedFiles(resolveBuildConfig({ ...PROD, VEREBONA_APP_VERSION: '2.0.1', VEREBONA_APP_BUILD: '7' }));
  assert.match(f['ios/Verebona.xcconfig'], /PRODUCT_BUNDLE_IDENTIFIER = fr\.verebona\.app\n/);
  assert.match(f['ios/Verebona.xcconfig'], /VB_DISPLAY_NAME = Verebona\n/);
  assert.match(f['ios/Verebona.xcconfig'], /ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon\n/);
  assert.match(f['ios/Verebona.xcconfig'], /TARGETED_DEVICE_FAMILY = 1\n/);
  assert.match(f['android/verebona.properties'], /versionName=2\.0\.1\nversionCode=7\nappHost=app\.verebona\.fr/);
  assert.match(f['www/app-config.js'], /"origin": "https:\/\/app\.verebona\.fr"/);
  const all = Object.values(f).join('\n');
  assert.ok(!/password|secret|token|BEGIN PRIVATE/i.test(all));
  const pre = generatedFiles(resolveBuildConfig(PREPROD));
  assert.match(pre['ios/Verebona.xcconfig'], /AppIcon-Preprod/);
});

test('App Links Android : liste unique du serveur, manifeste à jour, exclusions respectées', async () => {
  const { routes, exclusions } = await loadServerRoutes();
  assert.ok(routes.some((r) => r.path === OAUTH_RETURN_PATH), 'retour OAuth déclaré côté serveur');
  assert.equal(androidPathAttribute('/agenda*'), 'android:pathPrefix="/agenda"');
  assert.equal(androidPathAttribute('/duo/join/*'), 'android:pathPrefix="/duo/join/"');
  assert.equal(androidPathAttribute('/mon-compte'), 'android:path="/mon-compte"');
  assert.throws(() => appLinksBlock([{ path: '/mon-compte*' }], ['/mon-compte/offres*']), /recouvre/);
  const manifest = readFileSync(MANIFEST, 'utf8');
  assert.equal(applyBlock(manifest, appLinksBlock(routes, exclusions)), manifest, 'lancer `npm run sync:links`');
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android.intent.action.SEND_MULTIPLE/);
  assert.ok(!/android.permission.CAMERA/.test(manifest), 'aucune permission inutilisée (STORE-04)');
});

test('schémas privés identiques côté app native et code web partagé', () => {
  const src = readFileSync(resolve(here, '../../src/lib/native/shell-info.ts'), 'utf8');
  assert.match(src, new RegExp(`preprod: '${ENVIRONMENTS.preprod.urlScheme.replace(/\./g, '\\.')}'`));
  assert.match(src, new RegExp(`prod: '${ENVIRONMENTS.prod.urlScheme.replace(/\./g, '\\.')}'`));
  const links = readFileSync(resolve(here, '../../src/lib/mobile/app-links.ts'), 'utf8');
  assert.match(links, new RegExp(`OAUTH_APP_RETURN_PATH = '${OAUTH_RETURN_PATH}'`));
});

test('iOS : projet branché sur Verebona.xcconfig, droits paramétrés, plugin local enregistré', () => {
  const pbx = readFileSync(resolve(here, '../ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
  assert.equal((pbx.match(/baseConfigurationReference = 95B0E0012F0A000000000001/g) ?? []).length, 2);
  assert.ok(!/PRODUCT_BUNDLE_IDENTIFIER = fr\.verebona/.test(pbx), 'identifiant lu dans le xcconfig de l’environnement');
  assert.match(pbx, /VerebonaAuthSession\.swift in Sources/);
  const ent = readFileSync(resolve(here, '../ios/App/App/App.entitlements'), 'utf8');
  assert.match(ent, /applinks:\$\(VB_APP_HOST\)/);
  assert.match(ent, /\$\(VB_APS_ENVIRONMENT\)/);
  const plist = readFileSync(resolve(here, '../ios/App/App/Info.plist'), 'utf8');
  assert.match(plist, /\$\(VB_DISPLAY_NAME\)/);
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(readFileSync(resolve(here, '../ios/App/App/SceneDelegate.swift'), 'utf8'), /VerebonaBridgeViewController\(\)/);
});
