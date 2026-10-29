import { mobileClientHeaders } from '@/lib/mobile/native-shell';

/**
 * En-têtes déclaratifs du client — fonction UNIQUE côté navigateur (lots 92
 * et 97 — CDC 18 §20.2, CDC 12 mobile §25 API-02). Décrivent l'appareil
 * (« Appareils connectés », version minimale mobile, rattachement push) ;
 * jamais une base de droits. Lus côté serveur par `lib/mobile/client-context`.
 *
 *   · application native : contrat de la coque (`window.VerebonaNative`,
 *     `lib/mobile/native-shell.ts`) → `IOS` / `ANDROID` + version, build,
 *     identifiant d'installation ; à défaut (coque sans ce contrat), la
 *     plateforme Capacitor seule ;
 *   · application web installée (mode autonome) : `pwa` ;
 *   · sinon : `web`.
 * Hors navigateur (serveur, tests) : aucun en-tête.
 */
export function clientPlatformHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const native = mobileClientHeaders();
    if (native['X-Verebona-Client']) return native;
    const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const platform = cap?.getPlatform?.();
    if (platform === 'ios' || platform === 'android') return { 'X-Verebona-Client': platform };
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
    return { 'X-Verebona-Client': standalone ? 'pwa' : 'web' };
  } catch {
    return {};
  }
}
