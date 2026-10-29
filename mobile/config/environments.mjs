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
 * Mode d'affichage (Gate 0, M5) — VEREBONA_UI_MODE :
 *   remote (A) : la WebView charge le site de l'environnement (prototype) ;
 *   local  (B) : la WebView charge l'interface embarquée (`www/`), qui
 *                appelle l'API de l'environnement. Au Gate 0, `www/` ne
 *                contient qu'une SONDE technique (auth, cookies, CSRF) :
 *                l'interface Next.js n'est pas exportable telle quelle
 *                (docs/mobile/gate0-comparaison-architectures.md).
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
