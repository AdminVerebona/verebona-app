/**
 * Variantes de l'application mobile — lot 95 (Gate 0), CDC 12 §27, décision PO M7.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE DES DEUX APPLICATIONS
 *
 *   préproduction : fr.verebona.app.preprod — « Verebona Préprod »
 *   production    : fr.verebona.app         — « Verebona »
 *
 * L'environnement est choisi AU BUILD (variable VEREBONA_ENV, posée par le
 * workflow GitHub Actions de l'environnement) et figé dans le binaire :
 * aucun réglage, menu ou lien ne permet à l'utilisateur de basculer une app
 * de préproduction sur la production, ni l'inverse (§27, M7). L'adresse du
 * serveur vient de VEREBONA_APP_ORIGIN, variable PROPRE à l'environnement
 * GitHub (mobile-preprod / production-mobile) : un build de production ne
 * contient aucune adresse de préproduction (REC-064).
 *
 * Mode d'affichage — VEREBONA_UI_MODE (décision PO du 03/11/2026, lot 108G :
 * l'interface DISTANTE est la cible V1 iOS / Android ; elle remplace B1) :
 *   remote (A) : CIBLE. La vue charge l'interface depuis l'origine de
 *                l'environnement ; la coque locale (`www/`) ne contient que
 *                les pages de secours (« Connexion Internet indisponible »).
 *                Architecture et durcissements : docs/mobile/architecture-distante.md ;
 *   local  (B) : SONDE TECHNIQUE du Gate 0 (`sonde-b/`), conservée pour le
 *                diagnostic. JAMAIS distribuée : refusée en production et à
 *                tout envoi TestFlight / Google Play (`checkDistribution`).
 *
 * Module JavaScript pur (aucune dépendance) : lu par capacitor.config.ts,
 * par les scripts de configuration native et par les tests (`node --test`).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** @typedef {'preprod' | 'prod'} MobileEnv */
/** @typedef {'remote' | 'local'} UiMode */

export const ENVIRONMENTS = Object.freeze({
  preprod: Object.freeze({
    env: 'preprod',
    /** Valeur `environment` attendue dans GET /api/mobile/config (NEXT_PUBLIC_APP_ENV du serveur). */
    serverEnvironment: 'preprod',
    appId: 'fr.verebona.app.preprod',
    appName: 'Verebona Préprod',
    /** Schéma de secours du retour OAuth si l'adresse https n'est pas captée (voir doc Gate 0 §M1). */
    urlScheme: 'fr.verebona.app.preprod',
    /** Groupe d'apps iOS partagé avec l'extension de partage (IMP-02). */
    iosAppGroup: 'group.fr.verebona.app.preprod',
    /** Variante visuelle de l'icône (M7 : préproduction reconnaissable). */
    iconVariant: 'preprod',
    /** Diffusion : testeurs autorisés uniquement (TestFlight / Internal Testing). */
    distribution: 'internal',
  }),
  prod: Object.freeze({
    env: 'prod',
    serverEnvironment: 'production',
    appId: 'fr.verebona.app',
    appName: 'Verebona',
    urlScheme: 'fr.verebona.app',
    iosAppGroup: 'group.fr.verebona.app',
    iconVariant: 'prod',
    distribution: 'store',
  }),
});

export const UI_MODES = Object.freeze(['remote', 'local']);

/** Mode des builds distribués (TestFlight, Google Play) : le seul admis. */
export const DISTRIBUTABLE_UI_MODE = 'remote';

/**
 * Origines de la coque LOCALE (pages de secours embarquées) : iOS sert `www/`
 * sous `capacitor://localhost`, Android sous `https://localhost`.
 */
export const LOCAL_ORIGINS = Object.freeze({ ios: 'capacitor://localhost', android: 'https://localhost' });

/**
 * Version minimale du moteur Android System WebView (Chromium). En dessous,
 * Capacitor affiche la page de secours au lieu du site : les versions plus
 * anciennes n'ont pas les mécanismes qui limitent le pont natif à l'origine
 * de l'environnement (WEB_MESSAGE_LISTENER, DOCUMENT_START_SCRIPT) et
 * Capacitor se replierait sur un pont ouvert à tous les cadres.
 * Point unique à ajuster (voir docs/mobile/architecture-distante.md § 4).
 */
export const ANDROID_MIN_WEBVIEW_VERSION = 100;

/**
 * Partage natif vers Verebona — lot 110A (décision PO du 04/11/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POINT UNIQUE DE BASCULE APRÈS ARBITRAGE PO (aucun nouveau développement :
 * un nouveau build suffit, la valeur est figée dans le binaire).
 *
 * Contrat : « Importer et ouvrir Verebona » / « Importer sans ouvrir » /
 * « Annuler » (src/lib/mobile/share-import-policy.ts).
 *
 *   android.openAppChoice : true — l'activité de réception fait partie de
 *       l'app : « Importer et ouvrir Verebona » ouvre réellement Verebona.
 *   ios.openAppChoice : TOUJOURS false. Une extension de partage ne peut pas
 *       ouvrir son application avec une API publique (Apple DTS, forum
 *       776488 ; `NSExtensionContext.open` réservé aux widgets / iMessage).
 *       Le choix n'est donc PAS affiché (jamais une option qui n'ouvre pas).
 *       Valeur verrouillée par `resolveShareImportConfig` et par test.
 *   ios.completionNotification : option B de l'arbitrage — après l'accusé
 *       serveur, notification locale « Document ajouté à Verebona — Touchez
 *       pour l'ouvrir » (sans nom de fichier ; autorisation de notifications
 *       requise). Livré : true (décision PO du 05/11/2026, option B).
 *   ios.importLabel : libellé du bouton d'import iOS, parmi les libellés
 *       validés ; livré : « Importer dans Verebona » (décision PO du
 *       05/11/2026 : pas de référence à l'ouverture, absente sur iOS).
 * ══════════════════════════════════════════════════════════════════════════
 */
export const SHARE_IMPORT = Object.freeze({
  android: Object.freeze({ openAppChoice: true }),
  ios: Object.freeze({
    openAppChoice: false,
    completionNotification: true,
    importLabel: 'Importer dans Verebona',
  }),
});

/** Libellés d'import iOS admis (validé PO / variante d'arbitrage). */
export const IOS_SHARE_IMPORT_LABELS = Object.freeze(['Importer sans ouvrir', 'Importer dans Verebona']);

/**
 * Configuration de partage figée dans le build (pure, testée). Refuse toute
 * valeur qui afficherait sur iOS une option « et ouvrir » sans effet.
 * @param {typeof SHARE_IMPORT} [c]
 */
export function resolveShareImportConfig(c = SHARE_IMPORT) {
  const errors = [];
  if (c.ios.openAppChoice !== false) errors.push('SHARE_IMPORT.ios.openAppChoice : aucune API publique ne permet à une extension de partage iOS d’ouvrir Verebona — option interdite.');
  if (!IOS_SHARE_IMPORT_LABELS.includes(c.ios.importLabel)) errors.push(`SHARE_IMPORT.ios.importLabel : libellé non validé (${IOS_SHARE_IMPORT_LABELS.join(' / ')}).`);
  if (typeof c.ios.completionNotification !== 'boolean' || typeof c.android.openAppChoice !== 'boolean') errors.push('SHARE_IMPORT : valeurs booléennes attendues.');
  if (errors.length > 0) {
    const e = new Error(`Configuration du partage invalide :\n- ${errors.join('\n- ')}`);
    e.name = 'MobileBuildConfigError';
    throw e;
  }
  return Object.freeze({
    iosCompletionNotice: c.ios.completionNotification ? 'YES' : 'NO',
    iosImportLabel: c.ios.importLabel,
    androidOpenApp: c.android.openAppChoice ? 'true' : 'false',
  });
}

/** Chemin d'ouverture de l'app (mode A) : l'accueil ; sans session, le middleware renvoie à la connexion. */
export const START_PATH = '/accueil';

/** Chemin de retour OAuth de l'application (APP_OAUTH_RETURN_URL = origine + ce chemin). */
export const OAUTH_RETURN_PATH = '/app/retour-connexion';

/** Version marketing : `1.2.3` ; numéro de build : entier positif (BUILD-06). */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const BUILD = /^[1-9]\d{0,8}$/;
/** Nom d'hôte de préproduction : un label contenant preprod / staging / recette. */
export const PREPROD_HOST = /(^|[.-])(preprod|pre-prod|staging|recette)([.-]|$)/i;

/**
 * Origine https stricte (schéma + hôte [+ port]), sans chemin ni paramètres.
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function parseOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Configuration de build résolue à partir des variables d'environnement.
 * Lève une erreur explicite (jamais de valeur devinée) : un build mal
 * paramétré échoue au lieu de produire une app branchée au mauvais serveur.
 *
 * @param {Record<string, string | undefined>} env
 */
export function resolveBuildConfig(env) {
  const errors = [];
  const name = (env.VEREBONA_ENV ?? '').trim();
  const variant = name === 'preprod' || name === 'prod' ? ENVIRONMENTS[name] : null;
  if (!variant) errors.push('VEREBONA_ENV doit valoir « preprod » ou « prod ».');

  const origin = parseOrigin(env.VEREBONA_APP_ORIGIN);
  if (!origin) errors.push('VEREBONA_APP_ORIGIN doit être une origine https (ex. https://app.verebona.fr), sans chemin.');

  // Garde-fou d'isolation (M7, REC-064) : une app de production ne pointe
  // jamais vers une adresse qui se présente comme de la préproduction, et
  // une app de préproduction vise une adresse qui se présente comme telle.
  // Le motif est le seul point à adapter si l'adresse réelle diffère.
  if (variant && origin) {
    const looksPreprod = PREPROD_HOST.test(new URL(origin).hostname);
    if (variant.env === 'prod' && looksPreprod) errors.push(`Build de production vers une adresse de préproduction (${origin}) : refusé.`);
    if (variant.env === 'preprod' && !looksPreprod) errors.push(`Build de préproduction vers une adresse qui n’est pas de préproduction (${origin}) : refusé.`);
  }

  // Variable GitHub non posée = chaîne vide : valeur par défaut (et non erreur).
  const uiMode = (env.VEREBONA_UI_MODE ?? '').trim() || 'remote';
  if (!UI_MODES.includes(uiMode)) errors.push('VEREBONA_UI_MODE doit valoir « remote » (A) ou « local » (B).');

  const version = (env.VEREBONA_APP_VERSION ?? '').trim() || '0.1.0';
  if (!VERSION.test(version)) errors.push('VEREBONA_APP_VERSION doit être de la forme 1.2.3.');
  const build = (env.VEREBONA_APP_BUILD ?? '').trim() || '1';
  if (!BUILD.test(build)) errors.push('VEREBONA_APP_BUILD doit être un entier positif.');

  if (errors.length > 0 || !variant || !origin) {
    const e = new Error(`Configuration mobile invalide :\n- ${errors.join('\n- ')}`);
    e.name = 'MobileBuildConfigError';
    throw e;
  }

  return Object.freeze({
    ...variant,
    origin,
    host: new URL(origin).host,
    uiMode: /** @type {UiMode} */ (uiMode),
    version,
    build,
    /**
     * Adresse chargée par la vue (`server.url`) : l'ORIGINE seule, sans chemin.
     * Lot 108G : avec un chemin (`…/accueil`), Android refusait la règle
     * d'origine du pont (`addWebMessageListener` n'accepte qu'une origine) et
     * Capacitor se repliait sur `addJavascriptInterface`, joignable depuis
     * TOUT cadre et toute page. La racine du site redirige vers l'accueil
     * (session) ou la connexion.
     */
    serverUrl: origin,
    /** Nom d'hôte seul (domaine « app-bound » iOS, App Links). */
    hostname: new URL(origin).hostname,
    /** Page d'accueil (bouton « Réessayer » de la page de secours). */
    startUrl: `${origin}${START_PATH}`,
    oauthReturnUrl: `${origin}${OAUTH_RETURN_PATH}`,
    /**
     * Marqueur ajouté à l'agent utilisateur de la WebView. Le code web partagé
     * (`src/lib/native/shell-info.ts`) en déduit version, build et
     * environnement de façon SYNCHRONE, dès la première requête (API-02).
     */
    userAgentMarker: `VerebonaApp/${version} (${build}; ${variant.env})`,
  });
}

/**
 * Garde-fou de distribution (lot 108G, CA02) : un build envoyé à TestFlight /
 * Google Play, ou un build de production, est TOUJOURS en mode distant.
 * La sonde technique (mode local) ne peut être produite qu'en préproduction,
 * en compilation seule (artefact GitHub), jamais publiée.
 *
 * @param {{ env: MobileEnv, uiMode: UiMode }} b  configuration résolue
 * @param {{ publish?: boolean }} [opts]
 * @returns {string[]} problèmes (vide = build admis)
 */
export function checkDistribution(b, opts = {}) {
  const problems = [];
  if (b.uiMode !== DISTRIBUTABLE_UI_MODE) {
    if (b.env === 'prod') problems.push('Sonde technique (mode local) interdite pour l’application de production : seul le mode distant est admis.');
    if (opts.publish) problems.push('Sonde technique (mode local) : envoi à TestFlight / Google Play refusé. Relancer avec « publish » décoché (artefact seul) ou en mode distant.');
  }
  return problems;
}
