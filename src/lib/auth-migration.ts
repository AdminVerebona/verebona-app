/**
 * Migration des sessions historiques (CDC §11).
 *
 * L'authentification repose desormais sur des cookies HttpOnly deposes par le
 * serveur. Les jetons conserves dans le navigateur n'ont plus lieu d'etre et
 * doivent etre effaces : c'est precisement le mecanisme que ce chantier
 * supprime (vol de jeton en cas de faille XSS).
 *
 * Strategie retenue (CDC §11.2) : suppression immediate des anciennes cles,
 * puis reconnexion. Aucune migration transparente depuis un jeton local, qui
 * prolongerait le mecanisme que l'on cherche a supprimer (CDC §11.3).
 */

/**
 * Cles d'authentification a supprimer.
 * Etablie a partir de l'audit du code reel (CDC §11.4).
 */
const LEGACY_AUTH_KEYS = [
  'bearer_token',
  'refresh_token',
  'access_token',
  'token',
  'jwt',
  'auth',
  'session',
  'user',
  'user_data',
] as const;

/**
 * Cles a PRESERVER : preferences d'affichage sans rapport avec
 * l'authentification (CDC §11.4 — « la suppression ne doit pas effacer des
 * preferences utilisateur sans rapport avec l'authentification »).
 *
 *   verebona-theme, sidebar-collapsed, assetDocumentsViewMode,
 *   pending_checkout_plan
 */

/**
 * Supprime les anciennes cles d'authentification du navigateur.
 * Retourne le nombre de cles effectivement supprimees.
 */
export function clearLegacyAuthStorage(): number {
  if (typeof window === 'undefined') return 0;

  let removed = 0;
  for (const key of LEGACY_AUTH_KEYS) {
    try {
      if (window.localStorage.getItem(key) !== null) {
        window.localStorage.removeItem(key);
        removed++;
      }
      if (window.sessionStorage.getItem(key) !== null) {
        window.sessionStorage.removeItem(key);
        removed++;
      }
    } catch {
      // Stockage indisponible (navigation privee, quota) : sans consequence.
    }
  }
  return removed;
}

/**
 * Une session historique subsiste-t-elle dans le navigateur ?
 * Utilise au demarrage pour declencher la reconnexion.
 */
export function hasLegacyAuthStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return LEGACY_AUTH_KEYS.some(
      (key) =>
        window.localStorage.getItem(key) !== null ||
        window.sessionStorage.getItem(key) !== null,
    );
  } catch {
    return false;
  }
}

/**
 * A appeler au demarrage de l'application.
 * Efface les traces d'authentification locales et signale si l'utilisateur
 * doit etre redirige vers la page de connexion.
 */
export function runAuthStorageMigration(): { migrated: boolean } {
  const had = hasLegacyAuthStorage();
  const removed = clearLegacyAuthStorage();
  if (had) {
    console.info(`[auth-migration] ${removed} cle(s) d'authentification locale(s) supprimee(s)`);
  }
  return { migrated: had };
}
