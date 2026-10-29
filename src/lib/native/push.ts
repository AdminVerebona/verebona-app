/**
 * Notifications push de l'application — lot 95 (CDC 12 §18 PUSH-01..09, AUTH-10 ;
 * PO M2, M3 ; serveur du lot 97 : `/api/mobile/push-installations`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   · Jeton FCM (iOS : APNs via Firebase) obtenu par `@capacitor-firebase/messaging`.
 *   · Autorisation demandée UNIQUEMENT sur action de l'utilisateur
 *     (`enableNativePush`, PUSH-02) ; un refus ne bloque rien (PUSH-03).
 *   · Enregistrement idempotent après connexion, à chaque démarrage et à
 *     chaque rotation du jeton (`syncNativePush`, PUSH-09) : l'installation
 *     est rattachée à la session courante (registre du lot 92).
 *   · Déconnexion : désinscription de CET appareil, puis suppression du jeton
 *     local (AUTH-10, PUSH-08) ; le serveur coupe aussi le push de toute
 *     session révoquée (crochet du lot 97). Un jeton push ne vaut jamais
 *     session (M2).
 *   · Clic : `data.href` validé par `lib/native/deep-links` puis ouvert
 *     après déverrouillage (PUSH-04).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { clientPlatformHeaders } from '@/lib/client-platform';
import { NATIVE_PLUGINS, isNativeApp, listenNative, nativePlatform, nativePlugin } from './bridge';
import { initInstallationId, runtimeShellInfo } from './shell-info';

type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';

interface MessagingPlugin {
  checkPermissions(): Promise<{ receive: PermissionState }>;
  requestPermissions(): Promise<{ receive: PermissionState }>;
  getToken(o?: Record<string, unknown>): Promise<{ token: string }>;
  deleteToken(): Promise<void>;
  addListener?: (event: string, cb: (data: unknown) => void) => unknown;
}

function messaging(): MessagingPlugin | null {
  return nativePlugin<MessagingPlugin>(NATIVE_PLUGINS.push);
}

export type NativePushState = 'unavailable' | 'prompt' | 'granted' | 'denied';

export async function nativePushPermission(): Promise<NativePushState> {
  const m = messaging();
  if (!m) return 'unavailable';
  try {
    const { receive } = await m.checkPermissions();
    return receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'unavailable';
  }
}

/** Corps d'enregistrement (pur) — contrat du lot 97. */
export function pushRegistrationBody(input: {
  installationId: string; platform: 'ios' | 'android'; pushToken: string; appVersion?: string | null; build?: string | null;
}): Record<string, string> {
  return {
    installationId: input.installationId,
    platform: input.platform,
    pushToken: input.pushToken,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    ...(input.build ? { build: input.build } : {}),
  };
}

async function registerToken(token: string): Promise<boolean> {
  const platform = nativePlatform();
  const installationId = await initInstallationId();
  if (!platform || !installationId || !token) return false;
  const info = runtimeShellInfo();
  try {
    const res = await fetch('/api/mobile/push-installations', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...clientPlatformHeaders() },
      body: JSON.stringify(pushRegistrationBody({
        installationId, platform, pushToken: token, appVersion: info?.appVersion, build: info?.build,
      })),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Enregistre le jeton si l'autorisation est DÉJÀ accordée (aucune demande).
 * À appeler session ouverte : démarrage, connexion, retour au premier plan.
 */
export async function syncNativePush(): Promise<boolean> {
  const m = messaging();
  if (!m || (await nativePushPermission()) !== 'granted') return false;
  try {
    const { token } = await m.getToken();
    return registerToken(token);
  } catch {
    return false;
  }
}

/** Action de l'utilisateur « Activer les notifications » : demande puis enregistre. */
export async function enableNativePush(): Promise<NativePushState> {
  const m = messaging();
  if (!m) return 'unavailable';
  try {
    const { receive } = await m.requestPermissions();
    if (receive !== 'granted') return receive === 'denied' ? 'denied' : 'prompt';
    await syncNativePush();
    return 'granted';
  } catch {
    return 'unavailable';
  }
}

/** Rotation du jeton (PUSH-09) : réenregistrement automatique. */
export function watchPushTokenRotation(): Promise<() => void> {
  return listenNative<{ token?: string }>(messaging(), 'tokenReceived', (e) => {
    if (typeof e?.token === 'string' && e.token) void registerToken(e.token);
  });
}

/** Clic sur une notification → `data` transmis au gestionnaire (href validé ailleurs). */
export function watchPushOpens(onOpen: (data: unknown) => void): Promise<() => void> {
  return listenNative<{ notification?: { data?: unknown } }>(messaging(), 'notificationActionPerformed', (e) => {
    onOpen(e?.notification?.data ?? null);
  });
}

/**
 * Déconnexion de cet appareil (AUTH-10) : appelée par `apiClient.signOut`
 * (via `nativeSignOutPush`) AVANT la révocation de la session, qui a besoin
 * du cookie. Le serveur coupe de toute façon le push de la session terminée
 * (crochet des lots 92/94) ; ceci supprime en plus le jeton FCM local.
 * Ne lève jamais.
 */
export async function unregisterNativePush(signal?: AbortSignal): Promise<void> {
  const installationId = await initInstallationId();
  if (installationId && !signal?.aborted) {
    await fetch('/api/mobile/push-installations/current', {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...clientPlatformHeaders() },
      body: JSON.stringify({ installationId }),
      signal,
    }).catch(() => undefined);
  }
  try { await messaging()?.deleteToken(); } catch { /* jeton déjà absent */ }
}

/**
 * Désinscription push à passer à `apiClient.signOut` : uniquement dans
 * l'application iOS / Android ; `undefined` sur le Web (aucun Web Push, M3).
 */
export function nativeSignOutPush(): ((signal?: AbortSignal) => Promise<void>) | undefined {
  return isNativeApp() ? unregisterNativePush : undefined;
}
