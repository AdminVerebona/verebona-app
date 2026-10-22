/**
 * Lot 79A — BO › Opérations › détail : « Rétablir » une séparation
 * automatique d'identité économique (lot 78A, `T3_IDENTITY_SEPARATED`).
 *
 * Règles PURES partagées par la route BO et l'écran (aucun import serveur :
 * utilisable côté client). SEULE exception à la lecture seule du détail
 * d'Opération (décision PO Q9 du lot 47A, exception PO du 22/10/2026) : le
 * BO ne saisit aucune valeur, il enregistre une décision de rapprochement
 * (CONFIRMED, origine ADMIN_REVIEW) que le moteur T3 réapplique.
 */

/** Motif obligatoire, consigné dans le journal d'audit admin (`OPERATION_IDENTITY_RESTORE`). */
export const RESTORE_REASON_MIN = 10;
export const RESTORE_REASON_MAX = 500;

/** Motif normalisé, ou `null` s'il est absent / trop court / trop long. */
export function normalizeRestoreReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length >= RESTORE_REASON_MIN && v.length <= RESTORE_REASON_MAX ? v : null;
}

/** Route de l'action (POST), relative à l'Opération affichée. */
export const restoreHref = (operationId: number, reviewId: number) =>
  `/api/admin/operations/${operationId}/identity-reviews/${reviewId}/restore`;

/** Action du journal d'audit admin (aussi relue par le détail BO et l'export de diagnostic). */
export const RESTORE_AUDIT_ACTION = 'OPERATION_IDENTITY_RESTORE' as const;
export const RESTORE_AUDIT_TARGET = 'OPERATION_IDENTITY_REVIEW' as const;

/** Pourquoi une séparation ne peut plus être rétablie (contrôlé côté serveur, sous verrou). */
export type RestoreBlockCode =
  | 'NOT_FOUND'
  | 'NOT_A_SEPARATION'
  | 'ALREADY_RESTORED'
  | 'SOURCE_DELETED'
  | 'CANDIDATE_GONE'
  | 'ORIGIN_MERGED'
  | 'ORIGIN_INVALIDATED'
  | 'ALREADY_ATTACHED';

export const RESTORE_BLOCK_MESSAGES: Readonly<Record<RestoreBlockCode, string>> = {
  NOT_FOUND: 'Séparation introuvable pour cette Opération.',
  NOT_A_SEPARATION: 'Ce contrôle n’est pas une séparation appliquée : rien à rétablir.',
  ALREADY_RESTORED: 'Cette séparation a déjà été rétablie.',
  SOURCE_DELETED: 'Le document séparé a été supprimé depuis : rien à rétablir.',
  CANDIDATE_GONE: 'Le document a été réanalysé depuis : l’opération décrite n’existe plus sous cette forme, rien à rétablir.',
  ORIGIN_MERGED: 'L’Opération d’origine a été fusionnée depuis : rétablir n’a plus de sens.',
  ORIGIN_INVALIDATED: 'L’Opération d’origine a été invalidée depuis : rétablir n’a plus de sens.',
  ALREADY_ATTACHED: 'Le document est de nouveau rattaché à l’Opération d’origine : la séparation n’est plus effective.',
};

/** Statut HTTP d'un refus : 404 si l'objet n'existe pas (pour ce compte / cette Opération), 409 sinon. */
export const restoreBlockStatus = (code: RestoreBlockCode): 404 | 409 => (code === 'NOT_FOUND' ? 404 : 409);

/** Montant concerné (indice financier T1 du document séparé). */
export interface RestoreAmount { role: string; amountMinor: number; currency: string }

/**
 * Résumé d'une séparation rétablissable, calculé par le détail BO (lecture
 * seule) et affiché dans la fenêtre de confirmation.
 */
export interface RestoreSummary {
  reviewId: number;
  fileId: number;
  candidateKey: string;
  summary: string | null;
  originOperationId: number;
  /** Opération qui porte aujourd'hui le document (créée ou rapprochée après la séparation), sinon null. */
  currentOperationId: number | null;
  amounts: RestoreAmount[];
}

/** Trace d'un rétablissement (journal d'audit admin, résultat SUCCESS). */
export interface RestoreTrace { adminId: number | null; adminEmail: string | null; at: string | null; reason: string | null }

/** Le bouton ne s'affiche QUE pour une séparation encore effective (`restore` calculé par le serveur). */
export function canRestore(r: { kind?: unknown; status?: unknown; restore?: unknown }): r is { kind: 'SEPARATED'; status: 'APPLIED'; restore: RestoreSummary } {
  return r.kind === 'SEPARATED' && r.status === 'APPLIED' && !!r.restore && typeof r.restore === 'object';
}

/** Effet attendu sur le TCO (texte de la fenêtre de confirmation). */
export function restoreTcoEffect(s: RestoreSummary): string {
  const ailleurs = s.currentOperationId !== null && s.currentOperationId !== s.originOperationId
    ? ` et retirés de l’Opération #${s.currentOperationId} (invalidée si elle n’a plus d’autre source)`
    : '';
  return s.amounts.length
    ? `Les montants de ce document seront de nouveau comptés dans l’Opération #${s.originOperationId}${ailleurs} ; le TCO du bien, `
      + 'l’agenda et les champs dérivés sont recalculés par le passage T3 suivant (aucun double compte).'
    : `Ce document ne porte aucun montant : le TCO ne change pas ; l’Opération #${s.originOperationId}${ailleurs ? ` et l’Opération #${s.currentOperationId}` : ''} `
      + 'et l’agenda sont recalculés par le passage T3 suivant.';
}

/** Libellés de l'écran (desktop et mobile : même composant). */
export const RESTORE_LABELS = {
  button: 'Rétablir',
  title: 'Rétablir ce rattachement ?',
  description:
    'La séparation automatique sera annulée : une décision de rapprochement prioritaire (origine BO) rattache de nouveau ce document '
    + 'à son Opération d’origine. Les contrôles automatiques ne le sépareront plus. Aucune valeur n’est saisie ici.',
  reason: `Motif (obligatoire, ${RESTORE_REASON_MIN} caractères minimum, consigné dans le journal d’audit)`,
  confirm: 'Rétablir',
  done: 'Rattachement rétabli : le passage T3 du compte recalcule l’Opération, le TCO et l’agenda.',
} as const;
