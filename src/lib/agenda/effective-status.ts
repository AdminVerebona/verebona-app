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

/**
 * Signaux d'attention d'un élément d'agenda — lot 66B1 : TOUJOURS un libellé
 * écrit, jamais le code brut (« en_retard » s'affichait tel quel dans la
 * liste de l'agenda et l'onglet Agenda du bien).
 */
export const ATTENTION_FLAG_LABELS: Readonly<Record<string, string>> = {
  sans_bien: 'Sans bien associé',
  en_retard: 'Date échue',
  date_incoherente: 'Date incohérente',
  donnee_distincte_a_qualifier: 'Donnée à qualifier',
};

/** Libellé d'un signal d'attention ; signal inconnu : « À vérifier » (jamais le code). */
export function attentionFlagLabel(flag: string): string {
  return ATTENTION_FLAG_LABELS[flag] ?? 'À vérifier';
}

/**
 * Signaux à afficher À CÔTÉ du statut : « en_retard » est déjà porté par le
 * badge de statut « Date échue » (rouge) — ne pas le répéter.
 */
export function visibleAttentionFlags(flags: readonly string[] | null | undefined): string[] {
  return (flags ?? []).filter((f) => f !== 'en_retard');
}
