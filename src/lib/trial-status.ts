/**
 * Critere unique « l'essai est termine ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * Le bandeau et l'ecran de fin d'essai lisaient la MEME reponse
 * (`/api/billing/trial-status`) avec DEUX criteres differents :
 *
 *   · bandeau  : `trial.status === 'expired' || isRestricted`
 *   · ecran    : `!isRestricted` → redirection vers /accueil
 *
 * Tant que les deux champs concordent, personne ne le remarque. Des qu'ils
 * divergent — c'etait le cas : `trial.status` se calcule sur `trialEndsAt`
 * tandis qu'`isRestricted` dependait d'un statut en base qu'aucune tache
 * planifiee ne mettait a jour — le bandeau annonce la fin de l'essai et son
 * bouton renvoie vers un ecran qui repart aussitot d'ou l'on vient.
 *
 * Vu de l'utilisateur : « le bouton ne mene a rien ». Il menait quelque
 * part ; l'ecran d'arrivee estimait simplement n'avoir pas lieu d'etre.
 *
 * Un seul critere, ici, pour les deux.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface TrialStatusPayload {
  trial?: {
    status?: 'none' | 'active' | 'expired' | 'converted';
    dejaConsomme?: boolean;
  } | null;
  isRestricted?: boolean;
  canWrite?: boolean;
}

/**
 * L'ecriture est-elle fermee faute d'offre ?
 *
 * Vrai lorsque l'essai est arrive a echeance, OU que le compte est en mode
 * restreint pour une autre raison (offre resiliee, aucun abonnement).
 */
export function isTrialOver(data: TrialStatusPayload | null | undefined): boolean {
  if (!data) return false;
  return data.trial?.status === 'expired' || data.isRestricted === true;
}
