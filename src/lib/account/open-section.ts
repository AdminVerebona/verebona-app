/**
 * Carte #774 — ouverture d'une section de « Mon compte » demandée par un lien
 * d'e-mail APRÈS un passage par la connexion.
 *
 * Un lien d'e-mail vise une section par son ancre (`/mon-compte#securite`).
 * Pour un utilisateur non connecté, le serveur redirige vers `/login` avec
 * `returnUrl` : l'ancre n'est jamais transmise au serveur, elle était donc
 * perdue au retour (arrivée sur Mon compte, carte Sécurité fermée). Le lien
 * porte désormais aussi `?ouvrir=<section>` : conservé par `returnUrl`, il
 * rétablit l'ancre à l'arrivée.
 *
 * Aucun droit n'est accordé par ce paramètre : il ne fait qu'ouvrir une carte
 * de la page déjà autorisée. Liste FERMÉE de sections (aucune valeur libre
 * n'est recopiée dans l'URL).
 */
export const OPEN_SECTION_PARAM = 'ouvrir';

/**
 * Ancre à rétablir : la section demandée par `?ouvrir=`, si elle est admise
 * et si l'URL ne porte pas déjà une ancre. Sinon `null`.
 */
export function anchorFromOpenParam(search: string, hash: string, allowed: readonly string[]): string | null {
  if (hash && hash !== '#') return null;
  let wanted: string | null = null;
  try {
    wanted = new URLSearchParams(search).get(OPEN_SECTION_PARAM);
  } catch {
    return null;
  }
  return wanted && allowed.includes(wanted) ? wanted : null;
}
