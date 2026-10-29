/**
 * Liste des sessions d'un utilisateur dans la fiche BO — lot 92 (CDC 18 §20,
 * §26). RÉGLAGE PO, désactivé par défaut.
 *
 * Le CDC Back-Office V1 (USR-D03) prévoit que les sessions actives ne sont
 * JAMAIS listées dans la fiche utilisateur ; le lot 92 prépare l'affichage
 * (appareil, navigateur ou application, dernière activité ; jamais d'IP) et
 * la déconnexion d'UNE session (journalisée `USER_SESSION_REVOKE`), activables
 * par la variable Scalingo `AUTH_BO_SESSION_LIST=on` si le PO lève USR-D03.
 * « Déconnecter toutes les sessions » (USR-A06) reste disponible dans tous
 * les cas.
 */
export function boSessionListEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['on', 'true', '1'].includes(String(env.AUTH_BO_SESSION_LIST ?? '').trim().toLowerCase());
}
