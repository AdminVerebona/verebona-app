/**
 * Fenêtre de rétractation — source unique de l'affichage ET du refus (lot 26).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « LE BLOC DISPARAÎT 15 JOURS APRÈS LA SOUSCRIPTION »
 *
 * Demande produit : tout ce qui propose la rétractation à l'utilisateur
 * connecté (carte de Mon compte, bouton « Renoncer au contrat ici ») doit
 * disparaître 15 jours après la souscription payante.
 *
 * La règle légale déjà codée (`french-calendar.ts`, L. 221-18/19 du Code de
 * la consommation) dit exactement cela, sans introduire de seconde constante :
 *
 *   · le jour J de la souscription n'est pas compté ;
 *   · le délai de 14 jours court de J+1 à J+14 inclus, jusqu'à 23 h 59 min
 *     59 s heure de Paris ;
 *   · il est donc clos à 00 h 00 le 15ᵉ jour après la souscription (J+15).
 *
 * « 15 jours après la souscription » = fin du délai légal de 14 jours. Une
 * constante d'affichage distincte (15 jours depuis l'horodatage) aurait
 * laissé le bouton visible quelques heures APRÈS la clôture légale — l'API
 * refusant alors ce que l'écran propose — ou l'aurait masqué AVANT la fin
 * d'un délai prorogé (14ᵉ jour tombant un samedi, un dimanche ou un jour
 * férié), ce que la directive (UE) 2023/2673 interdit : la fonction de
 * rétractation doit rester accessible pendant tout le délai.
 *
 * Ce module est PUR (aucune base, aucune horloge implicite) : il peut être
 * importé par le serveur comme par un composant client.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { computeWithdrawalDeadline, WITHDRAWAL_PERIOD_DAYS } from '@/services/legal/french-calendar';

export { WITHDRAWAL_PERIOD_DAYS };

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Instant de clôture de la fenêtre (23 h 59 min 59 s, Paris, du dernier jour
 * du délai, prorogation comprise), ou `null` si la date de souscription est
 * inconnue.
 */
export function withdrawalWindowClosesAt(subscribedAt: Date | string | null | undefined): Date | null {
  const start = toDate(subscribedAt);
  return start ? computeWithdrawalDeadline(start).deadlineAt : null;
}

/**
 * La rétractation est-elle encore ouverte à `now` ?
 *
 * Sans date de souscription, la fenêtre n'est pas calculable : `false` (rien
 * n'est proposé — un contrat sans date relève de l'examen humain, voir
 * `shouldOfferWithdrawal`).
 */
export function isWithdrawalWindowOpen(
  subscribedAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  const closesAt = withdrawalWindowClosesAt(subscribedAt);
  return closesAt !== null && now.getTime() <= closesAt.getTime();
}

export type WithdrawalVerdict = 'eligible' | 'ineligible' | 'undetermined';

/**
 * Faut-il proposer la rétractation (carte de Mon compte, bouton) ?
 *
 * @param verdict verdict de `evaluateEligibility`.
 * @param subscribedAt date de conclusion du contrat payant
 *   (`contract_concluded_at`) ; à défaut, première facturation — repli
 *   d'AFFICHAGE seulement, jamais de décision juridique.
 *
 *   · `ineligible` (délai écoulé, aucun contrat payant, membre Duo, déjà
 *     rétracté) : rien n'est proposé — le suivi d'une demande existante est
 *     géré à part ;
 *   · `eligible` / `undetermined` avec une date : proposé tant que la
 *     fenêtre est ouverte ;
 *   · `undetermined` sans aucune date : proposé (on ne peut pas affirmer que
 *     le délai est écoulé ; la déclaration partira en examen humain, §5.5).
 */
export function shouldOfferWithdrawal(input: {
  verdict: WithdrawalVerdict;
  subscribedAt: Date | string | null | undefined;
  now?: Date;
}): boolean {
  if (input.verdict === 'ineligible') return false;
  const start = toDate(input.subscribedAt);
  if (!start) return input.verdict === 'undetermined';
  return isWithdrawalWindowOpen(start, input.now ?? new Date());
}
