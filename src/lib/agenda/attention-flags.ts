/**
 * Signaux d'attention d'un élément d'agenda — module pur, sans import serveur,
 * partagé par toutes les vues (page Agenda desktop et mobile, onglet Agenda du
 * bien, tiroirs élément, équipement et document).
 *
 * Lot 113P (#715, décision PO du 06/11/2026) : les événements n'ont PLUS de
 * statut (« À venir », « Date échue », « Statut à confirmer », « Réalisé »,
 * « Annulé ») — l'ancien module `effective-status.ts` (libellés des cinq états,
 * option « Selon la date ») est supprimé. Seuls restent ces signaux, qui ne
 * sont PAS des statuts : ils ne disent rien de l'exécution de l'événement.
 * Le signal « en_retard » n'existe plus (une date passée n'est pas un retard).
 */

/** Lot 66B1 : TOUJOURS un libellé écrit, jamais le code brut. */
export const ATTENTION_FLAG_LABELS: Readonly<Record<string, string>> = {
  sans_bien: 'Sans bien associé',
  date_incoherente: 'Date incohérente',
  donnee_distincte_a_qualifier: 'Donnée à qualifier',
};

/** Libellé d'un signal d'attention ; signal inconnu : « À vérifier » (jamais le code). */
export function attentionFlagLabel(flag: string): string {
  return ATTENTION_FLAG_LABELS[flag] ?? 'À vérifier';
}

/**
 * Signaux JAMAIS affichés à l'utilisateur :
 *   · « donnee_distincte_a_qualifier » : métadonnée interne de qualification
 *     (décision PO lot 105, 02/11/2026). Un vrai besoin de décision passe par
 *     « À traiter », jamais par un badge ;
 *   · « en_retard » : plus produit depuis le lot 113P ; masqué par sécurité si
 *     une réponse ancienne (cache PWA) le portait encore.
 */
export const HIDDEN_ATTENTION_FLAGS: ReadonlySet<string> = new Set(['en_retard', 'donnee_distincte_a_qualifier']);

/** Signaux à afficher (règle unique : fiche, liste, onglet du bien). */
export function visibleAttentionFlags(flags: readonly string[] | null | undefined): string[] {
  return (flags ?? []).filter((f) => !HIDDEN_ATTENTION_FLAGS.has(f));
}
