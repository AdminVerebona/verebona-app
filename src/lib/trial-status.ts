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

import { formatUnpaidDeadline } from '@/services/billing/unpaid-cycle.rules';

/** Cycle d'impayé en cours, tel que rendu par `/api/billing/trial-status`. */
export interface UnpaidCyclePayload {
  startedAt: string;
  /** Date limite de régularisation (J+90) ; au-delà, suppression des données. */
  deadlineAt: string;
  daysLeft: number;
}

export interface TrialStatusPayload {
  trial?: {
    status?: 'none' | 'active' | 'expired' | 'converted';
    dejaConsomme?: boolean;
  } | null;
  isRestricted?: boolean;
  canWrite?: boolean;
  unpaid?: UnpaidCyclePayload | null;
}

/**
 * Le compte est-il restreint PARCE QU'UN PAIEMENT A ÉCHOUÉ ?
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN IMPAYÉ N'EST PAS UNE FIN D'ESSAI
 *
 * `isRestricted` vaut vrai dans les deux cas, et l'écran les confondait :
 * un client abonné dont la carte a été refusée lisait « Votre essai gratuit
 * est terminé — aucun prélèvement n'a été effectué », et on l'envoyait
 * CHOISIR une offre qu'il a déjà. Ce qu'il doit savoir est tout autre :
 * le paiement a échoué, il a jusqu'à telle date pour régulariser (sinon ses
 * données sont supprimées), il peut encore consulter, exporter et
 * transmettre, et le geste utile est de mettre à jour son moyen de paiement.
 *
 * Le serveur (`unpaid`) fait foi ; `isRestricted` est exigé en plus pour ne
 * pas afficher d'alerte à un compte déjà régularisé dont le cycle n'aurait
 * pas encore été refermé.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function isUnpaid(data: TrialStatusPayload | null | undefined): data is TrialStatusPayload & { unpaid: UnpaidCyclePayload } {
  if (!data?.unpaid) return false;
  return data.isRestricted === true || data.canWrite === false;
}

/**
 * L'ecriture est-elle fermee faute d'offre ?
 *
 * Vrai lorsque l'essai est arrive a echeance, OU que le compte est en mode
 * restreint pour une autre raison (offre resiliee, aucun abonnement) — SAUF
 * impayé en cours, qui a son propre discours (`isUnpaid`).
 */
export function isTrialOver(data: TrialStatusPayload | null | undefined): boolean {
  if (!data) return false;
  if (isUnpaid(data)) return false;
  return data.trial?.status === 'expired' || data.isRestricted === true;
}

/** Échéance lisible : « le 12 mars 2027 (dans 5 jours) ». Chaîne vide si date illisible. */
export function unpaidDeadlineLabel(unpaid: Pick<UnpaidCyclePayload, 'deadlineAt' | 'daysLeft'>): string {
  const date = formatUnpaidDeadline(unpaid.deadlineAt);
  if (!date) return '';
  const reste =
    unpaid.daysLeft <= 0 ? "aujourd'hui"
    : unpaid.daysLeft === 1 ? 'dans 1 jour'
    : `dans ${unpaid.daysLeft} jours`;
  return `le ${date} (${reste})`;
}
