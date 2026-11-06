/**
 * Identité de la coque native — lot 95 (CDC 12 §25 API-02, §30 VER-01, AUTH-13 ;
 * contrat `window.VerebonaNative` du lot 97, `lib/mobile/native-shell.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉDUCTION SYNCHRONE, DÈS LA PREMIÈRE REQUÊTE
 *
 * Le build de l'app ajoute à l'agent utilisateur de la WebView le marqueur
 * `VerebonaApp/<version> (<build>; <preprod|prod>)` (capacitor.config.ts,
 * `appendUserAgent`). Plateforme (Capacitor) + marqueur suffisent à remplir
 * le contrat du lot 97 sans attendre un appel natif : les en-têtes
 * X-Verebona-Client / -App-Version / -App-Build partent dès le premier appel
 * d'API. L'identifiant d'installation, lu dans le Keychain / Keystore, s'y
 * ajoute dès qu'il est chargé (`initInstallationId`).
 *
 * RÉINSTALLATION (AUTH-13) : le Keychain iOS survit à la désinstallation, le
 * stockage de la WebView non. Un marqueur non sensible dans le stockage local
 * signale une installation déjà initialisée ; absent, toutes les valeurs
 * sécurisées de l'app sont effacées et un NOUVEL identifiant est tiré.
 *
 * LOT 112E : jamais de purge ni de nouvel identifiant sur une lecture
 * INCERTAINE (téléphone verrouillé, Keystore en erreur, app en arrière-plan
 * sans sonde native) — la lecture est différée au retour au premier plan /
 * au déverrouillage (`installation-id.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaNativeInfo } from '@/lib/mobile/native-shell';
import { NATIVE_PLUGINS, listenNative, nativePlatform, nativePlugin } from './bridge';
import { SECURE_KEYS, secureClearAll, secureRead, secureSet, secureStatusPlugin } from './secure-store';
import { INSTALLATION_RETRY_AFTER_ERROR_MS, resolveInstallationId, type InstallationDeferReason } from './installation-id';
import { appendUnlockJournal } from './unlock-journal';

export type AppBuildEnv = 'preprod' | 'prod';

export interface UserAgentMarker {
  appVersion: string;
  build: string;
  env: AppBuildEnv;
}

const MARKER = /\bVerebonaApp\/(\d{1,4}\.\d{1,4}\.\d{1,4}) \((\d{1,9}); (preprod|prod)\)/;

/** Marqueur de l'agent utilisateur posé par le build, ou null. */
export function parseUserAgentMarker(ua: string | null | undefined): UserAgentMarker | null {
  if (typeof ua !== 'string') return null;
  const m = MARKER.exec(ua);
  return m ? { appVersion: m[1], build: m[2], env: m[3] as AppBuildEnv } : null;
}

/** Marqueur lu dans le navigateur courant. */
export function currentMarker(): UserAgentMarker | null {
  if (typeof navigator === 'undefined') return null;
  return parseUserAgentMarker(navigator.userAgent);
}

/** Environnement figé dans le binaire (préprod / prod), ou null hors de l'app. */
export function appBuildEnv(): AppBuildEnv | null {
  return nativePlatform() ? currentMarker()?.env ?? null : null;
}

/** Valeur `environment` attendue de GET /api/mobile/config pour ce binaire. */
export function expectedServerEnvironment(env: AppBuildEnv): 'preprod' | 'production' {
  return env === 'prod' ? 'production' : 'preprod';
}

/**
 * Schéma privé de chaque binaire (retour OAuth de secours, RFC 8252) — mêmes
 * valeurs que `urlScheme` de `mobile/config/environments.mjs` (contrôlé par
 * les tests du projet mobile).
 */
export const APP_URL_SCHEMES: Readonly<Record<AppBuildEnv, string>> = {
  preprod: 'fr.verebona.app.preprod',
  prod: 'fr.verebona.app',
};

/**
 * Origine https de l'environnement du binaire : celle de la page en mode A
 * (site distant) ; en mode B (interface embarquée), celle que le build a
 * inscrite dans `window.VEREBONA_APP.origin`. Null hors de l'app.
 */
export function appOrigin(): string | null {
  if (!nativePlatform() || typeof window === 'undefined') return null;
  const embarque = (window as unknown as { VEREBONA_APP?: { origin?: unknown } }).VEREBONA_APP?.origin;
  if (typeof embarque === 'string' && /^https:\/\/[^/]+$/.test(embarque)) return embarque;
  return window.location?.protocol === 'https:' ? window.location.origin : null;
}

/** Contexte de validation des liens entrants (`lib/native/deep-links`), ou null hors de l'app. */
export function appUrlContext(): { origin: string; urlScheme: string | null } | null {
  const origin = appOrigin();
  if (!origin) return null;
  const env = appBuildEnv();
  return { origin, urlScheme: env ? APP_URL_SCHEMES[env] : null };
}

let installationId: string | null = null;

/**
 * Contrat `VerebonaNative` déduit de la coque, ou null (navigateur, ou app
 * sans marqueur — jamais une version devinée).
 */
export function runtimeShellInfo(): VerebonaNativeInfo | null {
  const platform = nativePlatform();
  if (!platform) return null;
  const m = currentMarker();
  if (!m) return null;
  return { platform, appVersion: m.appVersion, build: m.build, ...(installationId ? { installationId } : {}) };
}

/** Marqueur local (non sensible) d'une installation initialisée. */
export const INSTALL_MARKER_KEY = 'verebona:native:installed';

function newInstallationId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function readMarker(): boolean {
  try { return globalThis.localStorage?.getItem(INSTALL_MARKER_KEY) === '1'; } catch { return false; }
}

function writeMarker(): void {
  try { globalThis.localStorage?.setItem(INSTALL_MARKER_KEY, '1'); } catch { /* sans marqueur : réinitialisé au prochain lancement */ }
}

/** Lot 112E : l'identifiant vient d'être obtenu après au moins un report. */
export const INSTALLATION_ID_READY_EVENT = 'verebona:installation-id-ready';

let inflight: Promise<string | null> | null = null;
let deferredOnce = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryOffs: Array<Promise<() => void>> = [];

async function appForeground(): Promise<boolean | null> {
  const app = nativePlugin<{ getState?: () => Promise<{ isActive?: unknown }> }>(NATIVE_PLUGINS.app);
  if (!app || typeof app.getState !== 'function') return null;
  try {
    const st = await app.getState();
    return typeof st?.isActive === 'boolean' ? st.isActive : null;
  } catch {
    return null;
  }
}

function disarmRetry(): void {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const offs = retryOffs;
  retryOffs = [];
  for (const off of offs) void off.then((f) => f());
}

/** Nouvelle tentative au premier plan / au déverrouillage (une seule fois armée). */
function armRetry(reason: InstallationDeferReason): void {
  if (retryOffs.length === 0) {
    const relancer = () => { void initInstallationId(); };
    retryOffs = [
      listenNative<{ isActive?: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (st) => { if (st?.isActive) relancer(); }),
      listenNative<{ available?: boolean }>(secureStatusPlugin(), 'protectedDataChange', (d) => { if (d?.available) relancer(); }),
    ];
  }
  // Erreur passagère du stockage alors que l'app est au premier plan : pas
  // de changement d'état à attendre, une relance différée suffit.
  if (reason === 'storage_error' && !retryTimer) {
    retryTimer = setTimeout(() => { retryTimer = null; void initInstallationId(); }, INSTALLATION_RETRY_AFTER_ERROR_MS);
  }
}

async function loadInstallationId(): Promise<string | null> {
  const outcome = await resolveInstallationId({
    readMarker,
    writeMarker,
    read: () => secureRead(SECURE_KEYS.installationId),
    foreground: appForeground,
    clearAll: secureClearAll,
    write: (id) => secureSet(SECURE_KEYS.installationId, id),
    newId: newInstallationId,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    journal: (outcome, detail) => appendUnlockJournal('INSTALL_ID', { outcome, platform: nativePlatform(), ...detail }),
  });
  if (outcome.kind === 'deferred') {
    deferredOnce = true;
    armRetry(outcome.reason);
    return null;
  }
  disarmRetry();
  installationId = outcome.id;
  const info = runtimeShellInfo();
  if (info && typeof window !== 'undefined') {
    window.VerebonaNative = info;
    if (deferredOnce) {
      deferredOnce = false;
      try { window.dispatchEvent(new Event(INSTALLATION_ID_READY_EVENT)); } catch { /* sans événement */ }
    }
  }
  return outcome.id;
}

/**
 * Charge (ou crée) l'identifiant d'installation et l'ajoute au contrat
 * `window.VerebonaNative`. Idempotent ; appels concurrents partagés.
 * Hors de l'app : null. Lot 112E : null aussi tant que le stockage sécurisé
 * est illisible (aucun identifiant tiré) — nouvelle tentative automatique au
 * retour au premier plan / au déverrouillage, puis `INSTALLATION_ID_READY_EVENT`.
 */
export async function initInstallationId(): Promise<string | null> {
  if (!nativePlatform()) return null;
  if (installationId) return installationId;
  if (!inflight) inflight = loadInstallationId().finally(() => { inflight = null; });
  return inflight;
}

/** Tests uniquement. */
export function __resetShellInfoForTests(): void {
  installationId = null;
  inflight = null;
  deferredOnce = false;
  disarmRetry();
}
