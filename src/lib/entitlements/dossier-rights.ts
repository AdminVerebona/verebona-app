/**
 * Droit fonctionnel « créer des dossiers » — lot 34, point 6.
 *
 * Le tiroir « Préparation des dossiers » de la fiche bien (ex-« Informations
 * complémentaires ») alimente les dossiers prêts à l'usage : son écriture suit
 * le MÊME droit que la génération des dossiers, jamais le nom d'une offre
 * (pas de `plan === 'PREMIUM'`). Ce droit est `premiumFeatures`, calculé par
 * `entitlements.service` (Premium, Premium Duo, essai, et toute future offre
 * qui l'ouvre) — côté serveur `canCreateDossiers` (alias documenté de
 * `canUsePremiumFeature`, celui des routes `prepare`, `generate`, `retry`).
 *
 * Module sans dépendance serveur : lu par le client (droits du magasin
 * partagé) et par la route (message du refus).
 */

/**
 * Refus affiché à un compte sans le droit (code `PREMIUM_REQUIRED`) — même
 * système de libellés que les autres fonctions Premium (« … est disponible
 * avec les offres Premium et Premium Duo. »), même fenêtre partagée.
 */
export const DOSSIER_PREPARATION_PREMIUM_MESSAGE =
  'La préparation des dossiers est disponible avec les offres Premium et Premium Duo.';

/** Libellé UI du tiroir (renommage du lot 34 ; clés API et colonnes inchangées). */
export const DOSSIER_PREPARATION_TITLE = 'Préparation des dossiers';

/** Texte d'introduction du tiroir (générique : indépendant de la liste des champs). */
export const DOSSIER_PREPARATION_INTRO =
  'Renseignez ici les informations utilisées pour préparer automatiquement vos dossiers. Elles seront reprises dans les dossiers compatibles avec ce bien.';

/**
 * Le compte peut-il créer des dossiers (donc écrire leurs informations de
 * préparation) ? `null` tant que les droits ne sont pas connus : l'appelant
 * n'ouvre RIEN en écriture dans cet état (aucun champ brièvement modifiable).
 * Toujours calculé sur les droits ACTUELS (magasin partagé relu après un
 * changement d'offre), jamais sur une valeur mémorisée.
 */
export function canCreateDossiers(
  entitlements: { premiumFeatures: boolean; canWrite?: boolean } | null | undefined,
): boolean | null {
  if (!entitlements) return null;
  return entitlements.premiumFeatures === true && entitlements.canWrite !== false;
}

/**
 * Clic sur l'en-tête du tiroir « Préparation des dossiers » :
 *   · ouvert → `close` ;
 *   · droit accordé → `open` ;
 *   · droit refusé (Standard) → `refuse` : fenêtre de fonctionnalité limitée
 *     partagée, le tiroir reste fermé (aucun champ, aucun clavier) ;
 *   · droits inconnus → `wait` : rien ne s'ouvre, décision à leur arrivée.
 */
export type DossierDrawerClick = 'close' | 'open' | 'refuse' | 'wait';

export function decideDossierDrawerClick(open: boolean, droit: boolean | null): DossierDrawerClick {
  if (open) return 'close';
  if (droit === true) return 'open';
  if (droit === false) return 'refuse';
  return 'wait';
}
