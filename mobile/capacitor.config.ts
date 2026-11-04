/**
 * Configuration Capacitor — lot 95 (Gate 0), industrialisée au lot 108G
 * (décision PO du 03/11/2026 : interface DISTANTE = cible V1 iOS / Android).
 *
 * Tout dépend de l'environnement choisi AU BUILD (`config/environments.mjs`) :
 *   VEREBONA_ENV=preprod|prod  VEREBONA_APP_ORIGIN=https://…  [VEREBONA_UI_MODE=remote|local]
 *   [VEREBONA_APP_VERSION=1.2.3] [VEREBONA_APP_BUILD=42]
 * `npx cap sync` recopie cette configuration dans les projets natifs : un
 * binaire ne contient qu'UN environnement (aucune bascule utilisateur).
 *
 * Architecture du mode distant et audit de sécurité : docs/mobile/architecture-distante.md.
 * En bref : coque locale signée (pages de secours seulement) + interface
 * chargée depuis l'ORIGINE EXACTE de l'environnement ; tout autre domaine
 * s'ouvre dans le navigateur du téléphone ; le pont natif n'est joignable que
 * depuis cette origine (garde natif `VerebonaNavigationGuard`, domaines
 * « app-bound » iOS, règle d'origine Android, WebView Android minimale).
 */
import type { CapacitorConfig } from '@capacitor/cli';
import { ANDROID_MIN_WEBVIEW_VERSION, resolveBuildConfig } from './config/environments.mjs';

const b = resolveBuildConfig(process.env);
const remote = b.uiMode === 'remote';

const config: CapacitorConfig = {
  appId: b.appId,
  appName: b.appName,
  // Mode distant : coque locale = pages de secours (`www/`). La sonde
  // technique du Gate 0 (`sonde-b/`) n'est JAMAIS copiée dans un build distant.
  webDir: remote ? 'www' : 'sonde-b',
  // Version, build et environnement lisibles dès la première requête par le
  // code web partagé (src/lib/native/shell-info.ts) → en-têtes X-Verebona-*.
  appendUserAgent: b.userAgentMarker,
  // Fond « Sérénité » (beige) pendant le chargement : jamais d'écran blanc (§4.3).
  backgroundColor: '#F8F6F1',
  loggingBehavior: b.env === 'prod' ? 'none' : 'debug',
  server: remote
    ? {
        // ORIGINE seule, sans chemin (voir `serverUrl` dans environments.mjs :
        // un chemin désactivait la règle d'origine du pont sur Android).
        url: b.serverUrl,
        // Aucun domaine supplémentaire : seule l'origine de l'environnement
        // est chargée dans la vue (et reçoit le pont natif sur Android).
        allowNavigation: [],
        // Page locale si le site ne répond pas ou si la WebView Android est
        // trop ancienne (« Connexion Internet indisponible » + « Réessayer »).
        errorPath: 'offline.html',
        androidScheme: 'https',
        cleartext: false,
      }
    : {
        // Sonde B (diagnostic, jamais distribuée) : sert `sonde-b/` sous
        // https://localhost (Android) / capacitor://localhost (iOS).
        androidScheme: 'https',
        cleartext: false,
      },
  ios: {
    contentInset: 'never',
    // Inspection Safari autorisée en préproduction seulement.
    webContentsDebuggingEnabled: b.env !== 'prod',
    // Domaines « app-bound » (WKAppBoundDomains de Info.plist : domaine de
    // l'environnement + localhost) : WebKit n'exécute scripts injectés et
    // gestionnaires de messages (le pont) QUE sur ces domaines.
    limitsNavigationsToAppBoundDomains: remote,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: b.env !== 'prod',
    // Moteur WebView trop ancien → page de secours au lieu du site.
    minWebViewVersion: ANDROID_MIN_WEBVIEW_VERSION,
    // Variante Gradle (productFlavors) sélectionnée par la CI : preprod / prod.
    flavor: b.env,
  },
  plugins: {
    SplashScreen: { launchAutoHide: true, launchShowDuration: 600, backgroundColor: '#F8F6F1', showSpinner: false },
    // AUTH-15 / SEC-09 : contenu masqué dans l'aperçu multitâche ; captures autorisées.
    PrivacyScreen: { enable: true, preventScreenshots: false },
    // Sonde B uniquement : requêtes et cookies par la pile native. En mode
    // distant, la pile web de même origine suffit et le relais HTTP natif
    // (qui contournerait les en-têtes de sécurité du serveur) reste coupé.
    CapacitorHttp: { enabled: !remote },
    CapacitorCookies: { enabled: !remote },
    FirebaseMessaging: { presentationOptions: ['alert', 'sound'] },
    CapacitorShareTarget: { appGroupId: b.iosAppGroup },
    // VisionKit public uniquement (pas de « swizzle » privé : risque de revue App Store).
    DocumentScanner: { iosVisionKitSwizzle: false },
  },
  experimental: {
    // Collision d'identité SwiftPM documentée par @capacitor-firebase/messaging (CLI ≥ 8.4).
    ios: { spm: { packageOptions: { '@capacitor-firebase/messaging': { symlink: true } } } },
  },
};

export default config;
