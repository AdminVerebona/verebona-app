/**
 * Configuration Capacitor — lot 95, prototype Gate 0 (CDC 12 §3.2, §27 ; décisions PO M4, M5, M7).
 *
 * Tout dépend de l'environnement choisi AU BUILD (`config/environments.mjs`) :
 *   VEREBONA_ENV=preprod|prod  VEREBONA_APP_ORIGIN=https://…  [VEREBONA_UI_MODE=remote|local]
 *   [VEREBONA_APP_VERSION=1.2.3] [VEREBONA_APP_BUILD=42]
 * `npx cap sync` recopie cette configuration dans les projets natifs : un
 * binaire ne contient qu'UN environnement (aucune bascule utilisateur).
 */
import type { CapacitorConfig } from '@capacitor/cli';
import { resolveBuildConfig } from './config/environments.mjs';

const b = resolveBuildConfig(process.env);
const remote = b.uiMode === 'remote';

const config: CapacitorConfig = {
  appId: b.appId,
  appName: b.appName,
  webDir: 'www',
  // Version, build et environnement lisibles dès la première requête par le
  // code web partagé (src/lib/native/shell-info.ts) → en-têtes X-Verebona-*.
  appendUserAgent: b.userAgentMarker,
  // Fond « Sérénité » (beige) pendant le chargement : jamais d'écran blanc (§4.3).
  backgroundColor: '#F8F6F1',
  loggingBehavior: b.env === 'prod' ? 'none' : 'debug',
  server: remote
    ? {
        // (A) Prototype : le site de l'environnement. Capacitor documente
        // `server.url` comme « non destiné à la production » : ce mode sert à
        // la qualification Gate 0 (M5), pas à l'industrialisation.
        url: b.startUrl,
        // Navigation interne limitée au domaine de l'environnement (SEC-05) ;
        // tout autre lien s'ouvre dans le navigateur système.
        allowNavigation: [b.host],
        // Page locale si le site ne répond pas (NET-02, REC-052).
        errorPath: 'offline.html',
        androidScheme: 'https',
        cleartext: false,
      }
    : {
        // (B) Interface embarquée : sert `www/` sous https://localhost
        // (Android) / capacitor://localhost (iOS).
        androidScheme: 'https',
        cleartext: false,
      },
  ios: {
    contentInset: 'never',
    // Inspection Safari autorisée en préproduction seulement.
    webContentsDebuggingEnabled: b.env !== 'prod',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: b.env !== 'prod',
    // Variante Gradle (productFlavors) sélectionnée par la CI : preprod / prod.
    flavor: b.env,
  },
  plugins: {
    SplashScreen: { launchAutoHide: true, launchShowDuration: 600, backgroundColor: '#F8F6F1', showSpinner: false },
    // AUTH-15 / SEC-09 : contenu masqué dans l'aperçu multitâche ; captures autorisées.
    PrivacyScreen: { enable: true, preventScreenshots: false },
    // Mode B uniquement : requêtes et cookies par la pile native (pas de CORS
    // ni de cookies tiers bloqués par WebKit). Sans effet en mode A.
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
