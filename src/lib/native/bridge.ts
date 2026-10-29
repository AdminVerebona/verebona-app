/**
 * Pont vers la coque native (Capacitor) — lot 95, Gate 0 (CDC 12 §3.2 ; PO M4, M5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NO-OP SUR LE WEB, AUCUNE DÉPENDANCE NPM CÔTÉ SITE
 *
 * L'interface web partagée tourne soit dans un navigateur (aucun changement),
 * soit dans la WebView de l'application iOS / Android. Dans l'app, Capacitor
 * injecte AVANT les scripts de la page `window.Capacitor` et, pour chaque
 * plugin natif embarqué, un mandataire `window.Capacitor.Plugins[<nom>]`
 * (méthodes → promesses, `addListener`). Ce module s'appuie UNIQUEMENT sur
 * cet objet injecté : le site n'embarque aucun paquet `@capacitor/*`, son
 * build et son poids sont inchangés, et le même code fonctionne en mode A
 * (site distant) comme en mode B (interface embarquée).
 *
 * Sécurité (SEC-06) : seuls les plugins listés dans `NATIVE_PLUGINS` sont
 * appelés ; la coque n'en embarque pas d'autres (mobile/package.json).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type NativePlatform = 'ios' | 'android';

/** Noms des plugins natifs appelés par le code partagé (identifiants Capacitor). */
export const NATIVE_PLUGINS = {
  app: 'App',
  browser: 'Browser',
  network: 'Network',
  secureStorage: 'SecureStorage',
  biometric: 'BiometricAuthNative',
  privacyScreen: 'PrivacyScreen',
  push: 'FirebaseMessaging',
  scanner: 'DocumentScanner',
  shareTarget: 'CapacitorShareTarget',
  uploader: 'Uploader',
  filesystem: 'Filesystem',
  share: 'Share',
  /** Plugin local de l'app iOS (ASWebAuthenticationSession) — mobile/ios/App/App/VerebonaAuthSession.swift. */
  authSession: 'VerebonaAuthSession',
} as const;

export type NativePluginName = typeof NATIVE_PLUGINS[keyof typeof NATIVE_PLUGINS];

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
  convertFileSrc?: (path: string) => string;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { Capacitor?: unknown }).Capacitor;
  return c && typeof c === 'object' ? (c as CapacitorGlobal) : null;
}

/** Plateforme native de la coque, ou null (navigateur, serveur, tests). */
export function nativePlatform(): NativePlatform | null {
  const c = capacitor();
  if (!c) return null;
  try {
    if (typeof c.isNativePlatform === 'function' && !c.isNativePlatform()) return null;
    const p = c.getPlatform?.();
    return p === 'ios' || p === 'android' ? p : null;
  } catch {
    return null;
  }
}

/** L'interface tourne-t-elle dans l'application iOS / Android ? */
export function isNativeApp(): boolean {
  return nativePlatform() !== null;
}

/** Mandataire d'un plugin natif embarqué, ou null (Web, plugin absent). */
export function nativePlugin<T extends object>(name: NativePluginName): T | null {
  if (!isNativeApp()) return null;
  const p = capacitor()?.Plugins?.[name];
  return p && typeof p === 'object' ? (p as T) : null;
}

/** URL lisible par la WebView pour un fichier natif (`file://…`). */
export function nativeFileSrc(path: string): string {
  const c = capacitor();
  return typeof c?.convertFileSrc === 'function' ? c.convertFileSrc(path) : path;
}

interface Listenable {
  addListener?: (event: string, cb: (data: unknown) => void) => unknown;
}

/**
 * Abonnement à un événement natif. Les mandataires injectés renvoient selon
 * la version soit une poignée `{ remove }`, soit une promesse de poignée :
 * les deux sont acceptées. Renvoie la fonction de désabonnement (jamais
 * d'exception : un plugin absent rend une fonction vide).
 */
export async function listenNative<T>(plugin: Listenable | null, event: string, cb: (data: T) => void): Promise<() => void> {
  if (!plugin || typeof plugin.addListener !== 'function') return () => {};
  try {
    const handle = await Promise.resolve(plugin.addListener(event, (data) => cb(data as T)));
    return () => {
      try {
        const r = (handle as { remove?: () => unknown } | null)?.remove?.();
        if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => {});
      } catch { /* déjà retiré */ }
    };
  } catch {
    return () => {};
  }
}
