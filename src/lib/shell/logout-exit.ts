/**
 * Sortie après déconnexion — lot 62 (L62-DECO).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'APPLICATION INSTALLÉE NE PEUT PAS « PARTIR » VERS LE SITE VITRINE
 *
 * Après une déconnexion confirmée par le serveur, le navigateur part vers le
 * site vitrine (`publicSiteUrl('/')`, autre domaine). Dans l'application
 * installée (WebView Capacitor), une navigation de premier niveau vers un
 * hôte qui n'est pas celui de l'application est ANNULÉE par la coquille
 * native et confiée à Safari : la vue web reste sur l'écran « Déconnexion… »,
 * sans bouton — l'application paraît figée et il faut la quitter.
 *
 * · Application installée : retour à la connexion DANS l'application
 *   (`/login`, même origine), sans jamais quitter la vue web.
 * · Navigateur (ordinateur, web mobile) : site vitrine, comme avant ; si la
 *   navigation n'a pas eu lieu après un délai (coquille qui l'a interceptée,
 *   détection native en défaut), repli sur `/login` : jamais d'écran bloqué.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { publicSiteUrl } from '@/lib/external-urls';

/** Connexion, dans l'application (même origine). */
const LOGOUT_IN_APP_PATH = '/login';

/**
 * Délai avant le repli : une navigation vers le site vitrine qui démarre
 * décharge la page (et ce minuteur avec elle) bien avant.
 */
export const LOGOUT_EXIT_FALLBACK_MS = 4_000;

export interface LogoutExitWindow {
  location: { href: string; protocol?: string; replace(url: string): void };
  setTimeout(handler: () => void, ms: number): unknown;
  Capacitor?: { isNativePlatform?: () => boolean };
}

/** Vue web de l'application installée (Capacitor iOS / Android) ? */
export function isNativeAppShell(w: Pick<LogoutExitWindow, 'location' | 'Capacitor'>): boolean {
  try {
    if (w.Capacitor?.isNativePlatform?.() === true) return true;
  } catch { /* pont natif indisponible : on s'en tient au protocole */ }
  const p = w.location?.protocol;
  return p === 'capacitor:' || p === 'ionic:';
}

/** Destination après déconnexion. */
function logoutExitTarget(w: Pick<LogoutExitWindow, 'location' | 'Capacitor'>): string {
  return isNativeAppShell(w) ? LOGOUT_IN_APP_PATH : publicSiteUrl('/');
}

/**
 * Quitte l'application après déconnexion. Rend la destination demandée.
 * Ne lève jamais.
 */
export function leaveAfterLogout(
  w: LogoutExitWindow = window as unknown as LogoutExitWindow,
  fallbackMs: number = LOGOUT_EXIT_FALLBACK_MS,
): string {
  const target = logoutExitTarget(w);
  if (target !== LOGOUT_IN_APP_PATH) {
    w.setTimeout(() => {
      try { w.location.replace(LOGOUT_IN_APP_PATH); } catch { /* rien de mieux à faire */ }
    }, fallbackMs);
  }
  try {
    w.location.href = target;
  } catch {
    try { w.location.replace(LOGOUT_IN_APP_PATH); } catch { /* idem */ }
  }
  return target;
}
