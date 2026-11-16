/**
 * Pages d'AUTHENTIFICATION — liste FERMÉE et unique (carte #798).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS LISTES DIVERGENTES DÉCIDAIENT DU MÊME SUJET
 *
 * Avant cette carte, « sommes-nous sur une page d'authentification ? » était
 * répondu à trois endroits, avec trois contenus différents :
 *
 *   · `SessionContext.PAGES_SANS_SESSION` : /login, /signup, /forgot-password,
 *     /reset-password, /verify-email — mais NI /verification (seconde étape de
 *     la double authentification), NI /securiser-mon-compte, NI /recuperation,
 *     NI /connexion-sociale ;
 *   · `api-client.handleAuthFailure` (garde anti-boucle) : /login et /signup
 *     SEULEMENT ;
 *   · `api-client` (renvoi sur 403 MFA_REQUIRED) : /login, /verification,
 *     /securiser-mon-compte, /recuperation.
 *
 * Conséquences démontrées par les tests de cette carte :
 *
 *   1. aller de /login à /verification (connexion acceptée, preuve forte
 *      encore à produire : AUCUNE session n'est émise à cet instant) était vu
 *      comme « sortie d'une page sans session » → transition de session
 *      « login » → relecture de `/api/users/me` et des droits alors qu'il n'y
 *      a rien à lire. Le magasin passait « non authentifié » et le refus de
 *      renouvellement (`AUTH_REQUIRED`) restait en mémoire du client HTTP ;
 *   2. un refus définitif constaté DEPUIS /verification n'était pas protégé
 *      par la garde anti-boucle : la procédure de sortie partait, appelait
 *      `POST /api/auth/logout` avec `trigger=auth-failure` (ligne BO
 *      « Déconnexion par précaution ») et renvoyait sur
 *      `/login?reason=post_login_rejected` — le message « la session n'a pas
 *      pu être conservée sur cet appareil », alors que rien ne permet de
 *      conclure que l'appareil a perdu un cookie.
 *
 * Une seule liste, donc, pour les trois décisions. Module PUR (aucune
 * dépendance navigateur) : lu par le contexte de session, le client HTTP et
 * les tests.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Chemins des pages d'authentification (préfixes). Aucune session complète
 * n'y est attendue : ni lecture d'identité, ni lecture de droits, ni
 * procédure de sortie (qui y tournerait en boucle).
 */
export const AUTH_PAGES: readonly string[] = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  // Lot 110B : seconde étape de la double authentification (jeton PROVISOIRE
  // seulement, aucune session complète) et premier enrôlement.
  '/verification',
  '/securiser-mon-compte',
  '/recuperation',
  // Lot 93 : retour d'un parcours Google / Apple (la session naît à la fin).
  '/connexion-sociale',
];

/** Vrai si ce chemin est une page d'authentification (pur, testé). */
export function isAuthPage(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}
