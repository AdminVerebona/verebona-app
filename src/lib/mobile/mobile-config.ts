/**
 * Configuration serveur de l'application mobile — lot 97 (CDC 12 §25 API-07 /
 * API-08, §30 VER-02..06, §31 OBS-05, Annexe F « Feature flags »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÉGLÉE PAR VARIABLES D'ENVIRONNEMENT, LUE À L'EXÉCUTION
 *
 * Aucun mécanisme générique de paramètres administrables n'existe dans le BO
 * (les réglages BO sont des tables dédiées par domaine). Les réglages mobiles
 * sont donc des variables Scalingo, propres à chaque environnement
 * (préproduction et production distinctes par construction) : une
 * modification redémarre les conteneurs (environ une minute), SANS nouveau
 * build ni publication sur les stores. Le BO (Exploitation › Application
 * mobile) en affiche la valeur effective. Toutes sont lues à chaque appel
 * (jamais figées au build : aucune n'est `NEXT_PUBLIC_*`).
 *
 *   MOBILE_MIN_VERSION_IOS / MOBILE_MIN_VERSION_ANDROID
 *       version minimale supportée (`1.2.0`, build optionnel `1.2.0+45`) ;
 *       vide = aucun minimum. En dessous : refus `APP_UPDATE_REQUIRED`.
 *   MOBILE_STORE_URL_IOS / MOBILE_STORE_URL_ANDROID
 *       fiche store (https) ouverte par l'écran « Mise à jour requise ».
 *   MOBILE_FEATURES_OFF
 *       interrupteurs d'urgence (kill switches) : liste de fonctions coupées,
 *       séparées par des virgules, préfixe de plateforme facultatif
 *       (`scan,ios:background_upload`).
 *   MOBILE_FEATURES_ON
 *       fonctions désactivées par défaut à activer (ex.
 *       `external_purchase_link`, COM-07 : validation stores préalable).
 *
 * Module PUR (pas d'accès base) : utilisable par le middleware Edge.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { parseEnvironment, type AiEnvironment } from '@/services/ai/config/environment';
import { compareVersions, mobilePlatformOf, parseAppVersion, type ClientContext, type MobilePlatform } from './client-context';

type Env = Record<string, string | undefined>;

/**
 * Catalogue des fonctions mobiles pilotables. `defaultOn: false` : fonction
 * jamais active sans décision explicite (COM-07 : lien commercial externe).
 * `server` : le serveur applique lui-même la coupure (en plus de l'app).
 */
export const MOBILE_FEATURES = {
  push: { label: 'Notifications push', defaultOn: true, server: true },
  scan: { label: 'Scanner de documents', defaultOn: true, server: false },
  file_import: { label: 'Import de fichiers et photos', defaultOn: true, server: false },
  share_in: { label: 'Partage entrant (Verebona destination)', defaultOn: true, server: false },
  share_out: { label: 'Partage sortant (feuille native)', defaultOn: true, server: false },
  background_upload: { label: 'Envoi en arrière-plan', defaultOn: true, server: false },
  biometrics: { label: 'Déverrouillage biométrique', defaultOn: true, server: false },
  deep_links: { label: 'Liens universels / App Links', defaultOn: true, server: false },
  document_viewer: { label: 'Visionneuse PDF / images', defaultOn: true, server: false },
  document_download: { label: 'Enregistrement local des documents', defaultOn: true, server: false },
  calendar_add: { label: 'Ajout au calendrier du téléphone', defaultOn: true, server: false },
  chat: { label: 'Mascotte / chat', defaultOn: true, server: false },
  exports: { label: 'Exports', defaultOn: true, server: false },
  external_purchase_link: { label: 'Lien commercial externe (COM-07)', defaultOn: false, server: false },
} as const satisfies Record<string, { label: string; defaultOn: boolean; server: boolean }>;

export type MobileFeature = keyof typeof MOBILE_FEATURES;

/**
 * Version présente sans en-tête de version valide : bloquée ou non ?
 * Choix prudent (VER-04 « pas de blocage arbitraire ») : NON — seule une
 * version déclarée et inférieure au minimum est refusée. Point unique à
 * changer si le PO veut bloquer les clients natifs sans version.
 */
export const BLOCK_NATIVE_CLIENT_WITHOUT_VERSION = false;

/** Code d'erreur stable du refus (API-06), connu de l'app native. */
export const APP_UPDATE_REQUIRED_CODE = 'APP_UPDATE_REQUIRED';
/** Statut HTTP du refus : 426 Upgrade Required. */
export const APP_UPDATE_REQUIRED_STATUS = 426;

interface MinVersion { version: string; build: string | null; raw: string }

export interface MobileServerConfig {
  environment: AiEnvironment | null;
  minVersions: Record<MobilePlatform, MinVersion | null>;
  storeUrls: Record<MobilePlatform, string | null>;
  /** État effectif par plateforme et par fonction. */
  features: Record<MobilePlatform, Record<MobileFeature, boolean>>;
  /** Valeurs invalides ignorées (affichées au BO, jamais devinées). */
  issues: string[];
}

function httpsUrl(raw: string | undefined, name: string, issues: string[]): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:') throw new Error('https');
    return u.toString();
  } catch {
    issues.push(`${name} : adresse https invalide (ignorée)`);
    return null;
  }
}

function minVersion(raw: string | undefined, name: string, issues: string[]): MinVersion | null {
  const v = raw?.trim();
  if (!v) return null;
  const p = parseAppVersion(v);
  if (!p) {
    issues.push(`${name} : version « ${v} » invalide (ignorée — aucun minimum appliqué)`);
    return null;
  }
  return { version: p.version, build: p.build, raw: v };
}

function featureList(raw: string | undefined, name: string, issues: string[]): Array<{ feature: MobileFeature; platform: MobilePlatform | null }> {
  const out: Array<{ feature: MobileFeature; platform: MobilePlatform | null }> = [];
  for (const brut of (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [a, b] = brut.includes(':') ? brut.split(':', 2) : [null, brut];
    const platform = a === 'ios' || a === 'android' ? a : null;
    if (a !== null && !platform) { issues.push(`${name} : plateforme inconnue « ${a} »`); continue; }
    if (!(b in MOBILE_FEATURES)) { issues.push(`${name} : fonction inconnue « ${b} »`); continue; }
    out.push({ feature: b as MobileFeature, platform });
  }
  return out;
}

/** Configuration effective (pure : `env` injectable pour les tests). */
export function readMobileServerConfig(env: Env = process.env): MobileServerConfig {
  const issues: string[] = [];
  const environment = parseEnvironment(env.NEXT_PUBLIC_APP_ENV);
  const minVersions = {
    ios: minVersion(env.MOBILE_MIN_VERSION_IOS, 'MOBILE_MIN_VERSION_IOS', issues),
    android: minVersion(env.MOBILE_MIN_VERSION_ANDROID, 'MOBILE_MIN_VERSION_ANDROID', issues),
  };
  const storeUrls = {
    ios: httpsUrl(env.MOBILE_STORE_URL_IOS, 'MOBILE_STORE_URL_IOS', issues),
    android: httpsUrl(env.MOBILE_STORE_URL_ANDROID, 'MOBILE_STORE_URL_ANDROID', issues),
  };
  const off = featureList(env.MOBILE_FEATURES_OFF, 'MOBILE_FEATURES_OFF', issues);
  const on = featureList(env.MOBILE_FEATURES_ON, 'MOBILE_FEATURES_ON', issues);
  const features = {} as MobileServerConfig['features'];
  for (const platform of ['ios', 'android'] as const) {
    const etat = {} as Record<MobileFeature, boolean>;
    for (const f of Object.keys(MOBILE_FEATURES) as MobileFeature[]) {
      let actif: boolean = MOBILE_FEATURES[f].defaultOn;
      if (on.some((x) => x.feature === f && (x.platform === null || x.platform === platform))) actif = true;
      // Une coupure l'emporte toujours sur une activation (kill switch).
      if (off.some((x) => x.feature === f && (x.platform === null || x.platform === platform))) actif = false;
      etat[f] = actif;
    }
    features[platform] = etat;
  }
  return { environment, minVersions, storeUrls, features, issues };
}

/** Fonction active pour une plateforme (le serveur applique les coupures `server: true`). */
export function isMobileFeatureEnabled(feature: MobileFeature, platform: MobilePlatform, env: Env = process.env): boolean {
  return readMobileServerConfig(env).features[platform][feature];
}

export type CompatibilityStatus = 'not_mobile' | 'ok' | 'unknown_version' | 'update_required';

export interface CompatibilityResult {
  status: CompatibilityStatus;
  platform: MobilePlatform | null;
  currentVersion: string | null;
  minVersion: string | null;
  storeUrl: string | null;
}

/**
 * Le client peut-il utiliser l'API ? Jamais de refus pour le Web ou la PWA ;
 * un client natif est refusé seulement s'il déclare une version inférieure au
 * minimum de sa plateforme (VER-02..04).
 */
export function evaluateCompatibility(ctx: ClientContext, config: MobileServerConfig): CompatibilityResult {
  const platform = mobilePlatformOf(ctx.client);
  if (!platform) return { status: 'not_mobile', platform: null, currentVersion: null, minVersion: null, storeUrl: null };
  const min = config.minVersions[platform];
  const base = { platform, currentVersion: ctx.appVersion, minVersion: min?.raw ?? null, storeUrl: config.storeUrls[platform] };
  if (!min) return { status: 'ok', ...base };
  if (!ctx.appVersion) return { status: BLOCK_NATIVE_CLIENT_WITHOUT_VERSION ? 'update_required' : 'unknown_version', ...base };
  const cmp = compareVersions(ctx.appVersion, min.version);
  if (cmp < 0) return { status: 'update_required', ...base };
  if (cmp === 0 && min.build && ctx.build && Number(ctx.build) < Number(min.build)) return { status: 'update_required', ...base };
  return { status: 'ok', ...base };
}

/**
 * Routes jamais soumises au contrôle de version : lecture de la
 * configuration (l'app doit pouvoir afficher l'écran de mise à jour), sondes,
 * renouvellement et fin de session (la session reste valide après la mise à
 * jour ; la déconnexion doit toujours aboutir), désinscription push.
 */
const EXEMPT_PREFIXES = ['/api/mobile/config', '/api/health', '/api/auth/refresh', '/api/auth/logout', '/api/mobile/push-installations/current'];

export function isExemptFromVersionGate(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Corps du refus — même forme que `apiError` (error, code, message, details, timestamp). */
export function appUpdateRequiredBody(r: CompatibilityResult): Record<string, unknown> {
  const message = 'Une mise à jour de l’application Verebona est nécessaire pour continuer.';
  return {
    error: message,
    code: APP_UPDATE_REQUIRED_CODE,
    message,
    details: { platform: r.platform, currentVersion: r.currentVersion, minVersion: r.minVersion, storeUrl: r.storeUrl },
    timestamp: new Date().toISOString(),
  };
}

/** Configuration publique (`GET /api/mobile/config`) : aucune donnée sensible. */
export function publicMobileConfig(config: MobileServerConfig, ctx?: ClientContext): Record<string, unknown> {
  const compat = ctx ? evaluateCompatibility(ctx, config) : null;
  return {
    schema: 'verebona.mobile-config/1',
    environment: config.environment,
    platforms: Object.fromEntries((['ios', 'android'] as const).map((p) => [p, {
      minVersion: config.minVersions[p]?.raw ?? null,
      storeUrl: config.storeUrls[p],
      features: config.features[p],
    }])),
    ...(compat && compat.platform ? {
      client: {
        platform: compat.platform,
        appVersion: compat.currentVersion,
        updateRequired: compat.status === 'update_required',
      },
    } : {}),
  };
}
