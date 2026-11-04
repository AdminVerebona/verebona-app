/**
 * Ouvrir une adresse dans le NAVIGATEUR SYSTÈME du téléphone — lot 108H
 * (brique générique, extraite de `lib/legal/open-legal-link`, lot 103A).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HORS DE L'APPLICATION, JAMAIS DANS UN NAVIGATEUR INTÉGRÉ
 *
 *   · navigateur (Web / PWA) : nouvel onglet (`window.open(…, '_blank')`),
 *     la navigation web habituelle ;
 *   · application iOS / Android : plugin `AppLauncher`
 *     (@capacitor/app-launcher, déclaré dans mobile/package.json) :
 *       iOS     → `UIApplication.shared.open(url)` (AppLauncherPlugin.swift)
 *                 = Safari, application en arrière-plan ;
 *       Android → `startActivity(Intent(ACTION_VIEW, url))`
 *                 (AppLauncherPlugin.java) = navigateur par défaut.
 *     JAMAIS le plugin `Browser` (@capacitor/browser) : il présente un
 *     SFSafariViewController (iOS) / une Custom Tab (Android) DANS l'app.
 *     Jamais de chargement dans la vue de l'app (page, tiroir et saisies
 *     restent intacts au retour) ;
 *   · application sans AppLauncher (binaire antérieur au lot 103A) : une
 *     adresse HORS de l'origine de l'app passe par `window.open`, que la
 *     coque Capacitor remet au système (iOS : WebViewDelegationHandler
 *     `createWebViewWith` → `UIApplication.shared.open` ; Android :
 *     `Bridge.launchIntent` → `ACTION_VIEW` pour tout domaine absent
 *     d'`allowNavigation`) ; une adresse de l'origine de l'app serait chargée
 *     dans la vue → refus explicite (`native-unavailable`).
 *
 * Ce module ne décide PAS si une adresse est légitime (liste blanche) : c'est
 * l'appelant (ex. `openLegalLink`, liste blanche juridique). Il exige
 * seulement une adresse absolue http(s) sans identifiants. Ne lève jamais.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, nativePlatform, nativePlugin, type NativePlatform } from '@/lib/native/bridge';

export type ExternalOpenStrategy =
  /** Navigateur : nouvel onglet (comportement web habituel). */
  | 'web-new-tab'
  /** Application : navigateur système (AppLauncher). */
  | 'native-external'
  /** Application sans AppLauncher : remise au système par la coque (domaine hors app). */
  | 'native-system-handoff'
  /** Application : aucune ouverture externe sûre possible. */
  | 'native-unavailable';

/** Choix de la méthode d'ouverture (pur, testé). */
export function chooseExternalOpenStrategy(ctx: {
  platform: NativePlatform | null;
  hasAppLauncher: boolean;
  urlOrigin: string;
  appOrigin: string | null;
}): ExternalOpenStrategy {
  if (!ctx.platform) return 'web-new-tab';
  if (ctx.hasAppLauncher) return 'native-external';
  if (ctx.appOrigin && ctx.urlOrigin !== ctx.appOrigin) return 'native-system-handoff';
  return 'native-unavailable';
}

/** Interface minimale du plugin natif `AppLauncher`. */
export interface AppLauncherPlugin { openUrl(o: { url: string }): Promise<{ completed?: boolean }> }

export type ExternalOpenResult =
  | { ok: true; strategy: ExternalOpenStrategy; url: string }
  | { ok: false; reason: 'invalid' | 'open_failed' | 'unavailable'; strategy: ExternalOpenStrategy | null; url: string | null };

export interface OpenExternalDeps {
  platform?: NativePlatform | null;
  appLauncher?: AppLauncherPlugin | null;
  /** Origine de l'application (pour le repli sans AppLauncher). */
  appOrigin?: string | null;
  windowOpen?: (url: string) => boolean;
}

function defaultWindowOpen(url: string): boolean {
  // Avec `noopener`, `window.open` rend toujours null : seule une exception signale l'échec.
  try { window.open(url, '_blank', 'noopener,noreferrer'); return true; } catch { return false; }
}

function defaultAppOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const o = window.location?.origin;
  return o && /^https?:\/\//.test(o) ? o : null;
}

/** Adresse absolue http(s) sans identifiants, ou null (pur). */
export function normalizeExternalUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u;
}

/**
 * Ouvre `raw` hors de l'application (navigateur système) ou dans un nouvel
 * onglet sur le Web. Ne lève jamais.
 */
export async function openExternalUrl(raw: unknown, deps: OpenExternalDeps = {}): Promise<ExternalOpenResult> {
  const u = normalizeExternalUrl(raw);
  if (!u) return { ok: false, reason: 'invalid', strategy: null, url: null };
  const url = u.toString();

  const platform = deps.platform !== undefined ? deps.platform : nativePlatform();
  const appLauncher = deps.appLauncher !== undefined ? deps.appLauncher : nativePlugin<AppLauncherPlugin>(NATIVE_PLUGINS.appLauncher);
  const appOrigin = deps.appOrigin !== undefined ? deps.appOrigin : defaultAppOrigin();
  const strategy = chooseExternalOpenStrategy({
    platform, hasAppLauncher: !!appLauncher && typeof appLauncher.openUrl === 'function', urlOrigin: u.origin, appOrigin,
  });
  const windowOpen = deps.windowOpen ?? defaultWindowOpen;

  try {
    if (strategy === 'native-external') {
      const r = await appLauncher!.openUrl({ url });
      if (r && r.completed === false) return { ok: false, reason: 'open_failed', strategy, url };
      return { ok: true, strategy, url };
    }
    if (strategy === 'web-new-tab' || strategy === 'native-system-handoff') {
      return windowOpen(url) ? { ok: true, strategy, url } : { ok: false, reason: 'open_failed', strategy, url };
    }
    return { ok: false, reason: 'unavailable', strategy, url };
  } catch {
    return { ok: false, reason: 'open_failed', strategy, url };
  }
}
