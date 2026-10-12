/**
 * « Reconsolider ce compte » (lot 48, O10) — règles PURES partagées par la
 * route BO et l'écran (aucun import serveur : utilisable côté client).
 */

/** Motif obligatoire de l'action, consigné dans le journal d'audit admin. */
export const RECONSOLIDATION_REASON_MIN = 5;
export const RECONSOLIDATION_REASON_MAX = 500;

/** Motif normalisé, ou `null` s'il est absent / trop court / trop long. */
export function normalizeReconsolidationReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length >= RECONSOLIDATION_REASON_MIN && v.length <= RECONSOLIDATION_REASON_MAX ? v : null;
}

/** Route de l'action (POST). */
export const reconsolidationHref = (accountId: number) => `/api/admin/accounts/${accountId}/operations-reconsolidation`;

/** Libellés de l'écran (desktop et mobile : même composant). */
export const RECONSOLIDATION_LABELS = {
  button: 'Reconsolider ce compte',
  title: 'Reconsolider les Opérations de ce compte ?',
  description:
    'Le moteur de consolidation repassera sur toutes les preuves du compte (documents, données de la fiche, sinistres, agenda) '
    + 'et recalculera chaque Opération, puis leur projection dans l’agenda. Aucune valeur n’est saisie ici : ce n’est pas une '
    + 'modification d’Opération. Un compte déjà cohérent reste inchangé. Si un passage est déjà en file, la demande s’y ajoute.',
  reason: 'Motif (obligatoire, consigné dans le journal d’audit)',
  confirm: 'Mettre en file',
  queued: 'Reconsolidation mise en file : le passage T3 du compte suit la file IA.',
  waiting: 'Reconsolidation mise en file : elle attend la réactivation de T3 (arrêt d’urgence ou traitement coupé).',
} as const;
