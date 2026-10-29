/**
 * Liens universels iOS / App Links Android — lot 97 (CDC 12 §19, §27, §24
 * SEC-04, R8).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FICHIERS D'ASSOCIATION SERVIS PAR ENVIRONNEMENT
 *
 *   /.well-known/apple-app-site-association   (JSON, sans extension)
 *   /.well-known/assetlinks.json
 *
 * construits à partir de variables Scalingo PROPRES à chaque environnement
 * (préproduction et production associent chacune SON application) :
 *
 *   MOBILE_IOS_TEAM_ID                  identifiant d'équipe Apple (10 car.)
 *   MOBILE_IOS_BUNDLE_IDS               identifiant(s) d'app iOS, virgules
 *   MOBILE_ANDROID_PACKAGE              nom de paquet Android
 *   MOBILE_ANDROID_SHA256_FINGERPRINTS  empreinte(s) SHA-256 du certificat de
 *                                       signature (Play App Signing), virgules
 *
 * Non configuré (ou valeur invalide) : 404 — jamais un fichier deviné. Les
 * chemins couverts sont listés ICI (source unique) ; Android ne les déclare
 * pas dans assetlinks.json mais dans le manifeste de l'app (intent-filters) :
 * la même liste est à reporter dans le projet natif (doc d'exploitation).
 *
 * Toute route NON listée reste dans le navigateur (offres, paiement,
 * rétractation, administration…) : aucun parcours commercial n'ouvre l'app
 * (COM-01/05).
 * ══════════════════════════════════════════════════════════════════════════
 */

type Env = Record<string, string | undefined>;

/**
 * Chemin de retour de l'application après Google / Apple (lot 95). Page web
 * de repli : `src/app/app/retour-connexion/page.tsx` (app non installée ou
 * lien non capté). Même valeur que `OAUTH_RETURN_PATH` de
 * `mobile/config/environments.mjs`.
 */
export const OAUTH_APP_RETURN_PATH = '/app/retour-connexion';

export interface AppLinkRoute {
  /** Motif de chemin (syntaxe AASA : `*` = n'importe quelle suite, `?` = un caractère). */
  path: string;
  /** Écran ouvert dans l'app. */
  ecran: string;
  /** Exigence du CDC couverte. */
  exigence: string;
}

/** Chemins EXCLUS en tête (l'ordre compte pour iOS : premier motif qui s'applique). */
export const APP_LINK_EXCLUSIONS: readonly string[] = [
  '/mon-compte/offres*', '/mon-compte/abonnement*', '/abonnement*', '/retractation*', '/admin*', '/api/*',
];

export const APP_LINK_ROUTES: readonly AppLinkRoute[] = [
  { path: '/verify-email*', ecran: 'Vérification de l’adresse e-mail (lien expiré / invalide : écran explicite)', exigence: 'AUTH-04, §19 Vérification e-mail' },
  { path: '/reset-password*', ecran: 'Réinitialisation du mot de passe (lien expiré : écran explicite)', exigence: 'AUTH-03, §19 Réinitialisation' },
  { path: '/duo/join/*', ecran: 'Invitation Duo', exigence: 'DUO-02, §19 Invitation Duo, REC-047' },
  { path: '/assets/*', ecran: 'Fiche bien', exigence: '§19 Bien, REC-042' },
  { path: '/documents/*', ecran: 'Fiche / visionneuse document', exigence: '§19 Document' },
  { path: '/documents', ecran: 'Documents (tiroir document `?drawer=document:<id>`)', exigence: '§19 Document' },
  { path: '/agenda*', ecran: 'Agenda / échéance (`?date=`, tiroir échéance)', exigence: '§19 Échéance, AG-03, REC-037' },
  { path: '/accueil/a-traiter*', ecran: 'À traiter (action ciblée)', exigence: '§19 À traiter' },
  { path: '/accueil', ecran: 'Accueil (tiroirs `?drawer=` des notifications)', exigence: '§19 Notification' },
  { path: '/transmission/*', ecran: 'Transmission d’un bien reçue', exigence: '§18.3, EXP-05' },
  { path: '/mon-compte/notifications', ecran: 'Réglages de notification', exigence: 'ACC-05' },
  // Lot 96A : lien reçu à la nouvelle adresse (session exigée, confirmation par bouton).
  { path: '/mon-compte/confirmer-adresse*', ecran: 'Confirmer ma nouvelle adresse e-mail', exigence: 'CDC 18 §11.3, EMAIL-04' },
  { path: '/mon-compte', ecran: 'Mon compte (sécurité, Duo, données)', exigence: '§18.3 Sécurité compte' },
  // Lot 95 : retour du navigateur système après Google / Apple
  // (APP_OAUTH_RETURN_URL = origine + ce chemin) ; l'app échange le code
  // `handoff` avec son vérificateur PKCE (POST /api/auth/oauth/app/exchange).
  { path: OAUTH_APP_RETURN_PATH, ecran: 'Retour de connexion Google / Apple (échange du code dans l’app)', exigence: 'PO M1, CDC 18 MOB-10' },
];

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const liste = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export interface AppLinksStatus {
  ios: { configured: boolean; appIds: string[]; issues: string[] };
  android: { configured: boolean; packageName: string | null; fingerprintCount: number; issues: string[] };
}

export function appLinksStatus(env: Env = process.env): AppLinksStatus {
  const iosIssues: string[] = [];
  const team = env.MOBILE_IOS_TEAM_ID?.trim() ?? '';
  const bundles = liste(env.MOBILE_IOS_BUNDLE_IDS);
  if (team && !TEAM_ID.test(team)) iosIssues.push('MOBILE_IOS_TEAM_ID invalide (10 caractères majuscules / chiffres)');
  const okBundles = bundles.filter((b) => BUNDLE_ID.test(b));
  if (okBundles.length !== bundles.length) iosIssues.push('MOBILE_IOS_BUNDLE_IDS : identifiant invalide ignoré');
  const iosOk = TEAM_ID.test(team) && okBundles.length > 0;

  const andIssues: string[] = [];
  const pkg = env.MOBILE_ANDROID_PACKAGE?.trim() ?? '';
  if (pkg && !PACKAGE.test(pkg)) andIssues.push('MOBILE_ANDROID_PACKAGE invalide');
  const fps = liste(env.MOBILE_ANDROID_SHA256_FINGERPRINTS).map((f) => f.toUpperCase());
  const okFps = fps.filter((f) => FINGERPRINT.test(f));
  if (okFps.length !== fps.length) andIssues.push('MOBILE_ANDROID_SHA256_FINGERPRINTS : empreinte invalide ignorée (format AA:BB:… 32 octets)');
  const andOk = PACKAGE.test(pkg) && okFps.length > 0;

  return {
    ios: { configured: iosOk, appIds: iosOk ? okBundles.map((b) => `${team}.${b}`) : [], issues: iosIssues },
    android: { configured: andOk, packageName: andOk ? pkg : null, fingerprintCount: andOk ? okFps.length : 0, issues: andIssues },
  };
}

/** Contenu de `apple-app-site-association`, ou null si non configuré. */
export function appleAppSiteAssociation(env: Env = process.env): Record<string, unknown> | null {
  const st = appLinksStatus(env);
  if (!st.ios.configured) return null;
  const components = [
    ...APP_LINK_EXCLUSIONS.map((p) => ({ '/': p, exclude: true, comment: 'reste dans le navigateur' })),
    ...APP_LINK_ROUTES.map((r) => ({ '/': r.path, comment: r.ecran })),
  ];
  return {
    applinks: {
      // Format iOS 13+ (`appIDs` + `components`) et format historique
      // (`appID` + `paths`, ignoré par les versions récentes).
      details: st.ios.appIds.map((appID) => ({
        appIDs: [appID],
        components,
        appID,
        paths: [...APP_LINK_EXCLUSIONS.map((p) => `NOT ${p}`), ...APP_LINK_ROUTES.map((r) => r.path)],
      })),
    },
    webcredentials: { apps: st.ios.appIds },
  };
}

/** Contenu de `assetlinks.json`, ou null si non configuré. */
export function androidAssetLinks(env: Env = process.env): unknown[] | null {
  const st = appLinksStatus(env);
  if (!st.android.configured || !st.android.packageName) return null;
  const fps = liste(env.MOBILE_ANDROID_SHA256_FINGERPRINTS).map((f) => f.toUpperCase()).filter((f) => FINGERPRINT.test(f));
  return [{
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: st.android.packageName, sha256_cert_fingerprints: fps },
  }];
}
