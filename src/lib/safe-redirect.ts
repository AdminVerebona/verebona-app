/**
 * Cible de redirection après authentification — chemin INTERNE uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REDIRECTION OUVERTE
 *
 * `/login?returnUrl=…` renvoyait, après connexion, vers la valeur telle
 * quelle. `returnUrl=https://verebona-connexion.example` ou
 * `returnUrl=//verebona-connexion.example` envoyait donc l'utilisateur, tout
 * juste authentifié sur le vrai domaine, vers un site tiers : le scénario
 * classique d'hameçonnage (« votre session a expiré, ressaisissez votre mot
 * de passe »), crédible parce que le lien de départ est authentique.
 *
 * Seul un chemin relatif interne est accepté :
 *   - commence par un seul `/` (pas `//hote`, URL « relative au protocole ») ;
 *   - aucun `\` : les navigateurs le lisent comme `/`, `/\hote` vaut `//hote` ;
 *   - aucun caractère de contrôle ni espace : l'analyseur d'URL supprime
 *     tabulations et retours à la ligne, `/\t/hote` devient `//hote` ;
 *   - pas de schéma (`javascript:`, `https:`…) — implicite avec le `/` initial,
 *     et revérifié par une résolution sur une origine fictive : le résultat
 *     doit rester sur cette origine.
 *
 * Toute autre valeur est remplacée par le repli, sans erreur : un lien
 * altéré mène à l'accueil, pas à une page d'erreur.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Destination par défaut après authentification. */
export const DEFAULT_AFTER_AUTH_PATH = '/accueil';

const PROBE_ORIGIN = 'https://interne.invalid';

/**
 * Rend `raw` s'il désigne un chemin interne sûr, sinon `fallback`.
 * Pure : utilisable côté client comme côté serveur.
 */
export function safeInternalPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_AFTER_AUTH_PATH,
): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;
  // Caractères de contrôle et espaces (dont U+0000–U+001F, U+007F, U+0020).
  if (/[\u0000-\u0020\u007f]/.test(raw)) return fallback;
  try {
    const resolved = new URL(raw, PROBE_ORIGIN);
    if (resolved.origin !== PROBE_ORIGIN) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * Cible après connexion : chemin interne sûr, et jamais une page
 * d'authentification (sinon boucle connexion → connexion).
 */
export function safeReturnUrl(
  raw: string | null | undefined,
  fallback: string = DEFAULT_AFTER_AUTH_PATH,
): string {
  const path = safeInternalPath(raw, fallback);
  const AUTH_PAGES = ['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'];
  return AUTH_PAGES.some((p) => path === p || path.startsWith(`${p}?`) || path.startsWith(`${p}/`))
    ? fallback
    : path;
}
