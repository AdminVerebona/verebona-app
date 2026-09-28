/**
 * Compte clôturé en attente de suppression — règles d'accès.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION PRODUIT : SUPPRESSION VOLONTAIRE DIFFÉRÉE DE 30 JOURS
 *
 * À la confirmation, le compte est CLÔTURÉ immédiatement
 * (`users.status = 'PENDING_DELETION'`) et toutes les sessions sont
 * révoquées. L'utilisateur peut encore se connecter avec son mot de passe,
 * mais la session ne donne accès qu'à l'écran « Compte en cours de
 * suppression », qui offre deux actions : ANNULER la suppression (retour à
 * un usage normal) et EXPORTER ses données (export RGPD « Mes données »).
 *
 * Pourquoi ne pas simplement interdire la connexion ? Parce qu'annuler et
 * exporter supposent de prouver son identité : la connexion par mot de passe
 * est la seule preuve dont on dispose, et elle est déjà protégée (limitation
 * de débit, révocation). Un lien d'annulation « magique » envoyé par e-mail
 * serait une seconde porte d'entrée à protéger ; le lien des e-mails mène
 * donc à cet écran, derrière la connexion.
 *
 * Module PUR, sans base : il est lu par le middleware (Edge) et par
 * `SessionService` (défense en profondeur côté route).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Statut utilisateur d'un compte clôturé, en attente de suppression. */
export const PENDING_DELETION_STATUS = 'PENDING_DELETION' as const;

/** Seul écran accessible à un compte clôturé. */
export const PENDING_DELETION_PAGE = '/compte-en-suppression';

/** Code d'erreur des API refusées à un compte clôturé. */
export const ACCOUNT_PENDING_DELETION_CODE = 'ACCOUNT_PENDING_DELETION';

export const ACCOUNT_PENDING_DELETION_MESSAGE =
  'Votre compte est en cours de suppression. Vous pouvez seulement annuler la suppression ou exporter vos données.';

export function isPendingDeletion(status: string | null | undefined): boolean {
  return status === PENDING_DELETION_STATUS;
}

/**
 * API accessibles à un compte clôturé — le strict nécessaire :
 *   - état, annulation de la suppression ;
 *   - export RGPD (demande, état, téléchargement) ;
 *   - identité en LECTURE (écran de connexion, bandeau « connecté en tant
 *     que »), déconnexion.
 * Les routes publiques (connexion, renouvellement…) sont traitées avant par
 * le middleware et ne passent pas par ici.
 */
const ALLOWED: ReadonlyArray<{ path: string; methods: ReadonlyArray<string> }> = [
  { path: '/api/users/me/deletion', methods: ['GET', 'DELETE'] },
  { path: '/api/users/me/gdpr-export', methods: ['GET', 'POST'] },
  { path: '/api/users/me/gdpr-export/download', methods: ['GET'] },
  { path: '/api/users/me', methods: ['GET'] },
  { path: '/api/auth/me', methods: ['GET'] },
  { path: '/api/auth/logout', methods: ['POST', 'GET'] },
];

export function isApiAllowedWhilePendingDeletion(pathname: string, method: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  if (m === 'HEAD' || m === 'OPTIONS') return ALLOWED.some((a) => a.path === p);
  return ALLOWED.some((a) => a.path === p && a.methods.includes(m));
}

/** Pages accessibles à un compte clôturé (hors fichiers statiques). */
export function isPageAllowedWhilePendingDeletion(pathname: string): boolean {
  return pathname === PENDING_DELETION_PAGE || pathname.startsWith(`${PENDING_DELETION_PAGE}/`);
}
