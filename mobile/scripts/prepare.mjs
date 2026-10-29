/**
 * Préparation d'un build pour UN environnement — lot 95 (CDC 12 §27, BUILD-03/04/06 ; PO M7).
 *
 *   VEREBONA_ENV=preprod VEREBONA_APP_ORIGIN=https://… VEREBONA_APP_VERSION=1.0.0 VEREBONA_APP_BUILD=42 \
 *     node scripts/prepare.mjs
 *
 * Écrit les seuls fichiers propres à l'environnement (tous ignorés par git) :
 *   www/app-config.js          configuration publique lue par la page locale (hors connexion, mode B)
 *   android/verebona.properties version, build, domaine des App Links
 *   ios/Verebona.xcconfig      bundle ID, nom affiché, domaine associé, groupe d'apps, version, icône
 * Aucun secret : les clés de signature et fichiers Firebase sont posés par la
 * CI depuis les secrets GitHub, au moment du build.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildConfig } from '../config/environments.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Contenu des fichiers générés (pur, testé). */
export function generatedFiles(b) {
  const publicConfig = {
    env: b.env, appName: b.appName, origin: b.origin, startUrl: b.startUrl, uiMode: b.uiMode, version: b.version, build: b.build,
  };
  return {
    'www/app-config.js':
      `/* Généré par scripts/prepare.mjs — configuration PUBLIQUE de ce build (${b.env}). Ne pas modifier. */\n`
      + `window.VEREBONA_APP = Object.freeze(${JSON.stringify(publicConfig, null, 2)});\n`,
    'android/verebona.properties':
      `# Généré par scripts/prepare.mjs (${b.env}) — ne pas modifier, ne pas versionner.\n`
      + `versionName=${b.version}\nversionCode=${b.build}\nappHost=${b.host}\n`,
    'ios/Verebona.xcconfig':
      `// Généré par scripts/prepare.mjs (${b.env}) — ne pas modifier, ne pas versionner.\n`
      + `PRODUCT_BUNDLE_IDENTIFIER = ${b.appId}\n`
      + `VB_DISPLAY_NAME = ${b.appName}\n`
      + `VB_APP_HOST = ${b.host}\n`
      + `VB_URL_SCHEME = ${b.urlScheme}\n`
      + `VB_APP_GROUP = ${b.iosAppGroup}\n`
      + `MARKETING_VERSION = ${b.version}\n`
      + `CURRENT_PROJECT_VERSION = ${b.build}\n`
      + `ASSETCATALOG_COMPILER_APPICON_NAME = ${b.env === 'prod' ? 'AppIcon' : 'AppIcon-Preprod'}\n`
      + `CODE_SIGN_ENTITLEMENTS = App/App.entitlements\n`
      + `TARGETED_DEVICE_FAMILY = 1\n`
      + `VB_APS_ENVIRONMENT[config=Debug] = development\n`
      + `VB_APS_ENVIRONMENT[config=Release] = production\n`
      + `CAPACITOR_DEBUG[config=Debug] = true\n`
      + `CAPACITOR_DEBUG[config=Release] = false\n`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = resolveBuildConfig(process.env);
  for (const [rel, content] of Object.entries(generatedFiles(b))) {
    const p = resolve(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  console.log(`Build préparé : ${b.appName} (${b.appId}) → ${b.origin} — mode ${b.uiMode === 'remote' ? 'A (site distant)' : 'B (interface embarquée)'} — ${b.version} (${b.build}).`);
}
