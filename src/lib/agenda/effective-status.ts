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

/**
 * Lot 103D (ticket « Agenda — statut et rappels ») : libellé de l'option
 * « sans statut manuel » du sélecteur de statut (tiroir Agenda, desktop et
 * mobile). Cette option rend la main au calcul serveur : elle affiche donc le
 * statut CALCULÉ (`automaticStatus`, sinon le statut effectif d'un élément
 * sans statut manuel) — jamais « À venir » en dur. Cause démontrée du
 * « À venir » affiché pour un contrôle du 22/12/2020 : cette option portait le
 * libellé fixe « À venir » quel que soit l'état calculé (badge « Statut à
 * confirmer » juste au-dessus).
 */
export const AUTOMATIC_STATUS_FALLBACK_LABEL = 'Selon la date';
export function automaticStatusOptionLabel(item: {
  automaticStatus?: string | null; effectiveStatus?: string | null; manualStatus?: string | null;
}): string {
  if (item.automaticStatus) return effectiveStatusLabel(item.automaticStatus);
  if (!item.manualStatus && item.effectiveStatus) return effectiveStatusLabel(item.effectiveStatus);
  return AUTOMATIC_STATUS_FALLBACK_LABEL;
}

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
 * Signaux JAMAIS affichés à l'utilisateur :
 *   · « en_retard » : déjà porté par le badge de statut « Date échue » ;
 *   · « donnee_distincte_a_qualifier » : métadonnée interne de qualification
 *     (décision PO lot 105, 02/11/2026 : badge « Donnée à qualifier » supprimé
 *     de toutes les vues Agenda). Le signal reste calculé et conservé pour
 *     T3 / T4, la cohérence, le diagnostic et la supervision ; un vrai besoin
 *     de décision passe par « À traiter », jamais par un badge.
 */
export const HIDDEN_ATTENTION_FLAGS: ReadonlySet<string> = new Set(['en_retard', 'donnee_distincte_a_qualifier']);

/** Signaux à afficher À CÔTÉ du statut (règle unique : fiche, liste, onglet du bien). */
export function visibleAttentionFlags(flags: readonly string[] | null | undefined): string[] {
  return (flags ?? []).filter((f) => !HIDDEN_ATTENTION_FLAGS.has(f));
}
