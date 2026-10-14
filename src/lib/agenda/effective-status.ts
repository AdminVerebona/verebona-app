/**
 * Libellés des statuts effectifs d'un élément d'agenda — lot 53 (retour PO
 * D17). Module pur, sans import serveur : partagé par toutes les vues
 * (page agenda desktop et mobile, onglet Agenda du bien, tiroirs élément,
 * équipement et document, fiche du bien).
 *
 * Cinq états DISTINCTS, jamais confondus :
 *   a_venir      « À venir »             date future ;
 *   en_retard    « Date échue »          échéance passée sans statut (rien ne
 *                                        prouve qu'elle n'a pas été faite) ;
 *   a_confirmer  « Statut à confirmer »  fait passé sans preuve de réalisation
 *                                        (une date passée ne prouve rien) ;
 *   realise      « Réalisé »             statut établi (utilisateur, ou preuve
 *                                        de réalisation consolidée) ;
 *   annule       « Annulé ».
 * Le calcul reste côté serveur (`computeEffectiveStatus`) ; les vues
 * n'affichent que la valeur reçue.
 */
export type AgendaEffectiveStatus = 'a_venir' | 'en_retard' | 'a_confirmer' | 'realise' | 'annule';

export const EFFECTIVE_STATUS_LABELS: Record<AgendaEffectiveStatus, string> = {
  a_venir: 'À venir',
  en_retard: 'Date échue',
  a_confirmer: 'Statut à confirmer',
  realise: 'Réalisé',
  annule: 'Annulé',
};

/** Libellé d'un statut reçu (valeur inconnue : rendue telle quelle). */
export function effectiveStatusLabel(status: string | null | undefined): string {
  return (status && EFFECTIVE_STATUS_LABELS[status as AgendaEffectiveStatus]) || (status ?? '');
}
