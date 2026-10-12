/**
 * Erreurs d'intégrité des Opérations métier (CDC Opérations V1 C20.1, C24).
 *
 * Une erreur d'intégrité est une erreur TECHNIQUE (NFR-OP-008) : journalisée,
 * jamais transformée en « À traiter » utilisateur. Elle annule la transaction
 * entière (aucune écriture partielle, aucun événement émis).
 */
export type BusinessOperationErrorCode =
  | 'UNKNOWN_TYPE'
  | 'OTHER_AS_FALLBACK'
  | 'INVALID_STATUS'
  | 'STATUS_TRANSITION_FORBIDDEN'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_INACTIVE'
  | 'OPERATION_MERGED'
  | 'CROSS_ACCOUNT'
  | 'PARENT_SELF'
  | 'PARENT_TYPE_UNKNOWN'
  | 'PARENT_RELATION_NOT_ALLOWED'
  | 'PARENT_INACTIVE'
  | 'PARENT_CYCLE'
  | 'PARENT_DEPTH_EXCEEDED'
  | 'SOURCE_REQUIRED'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_TARGET_NOT_FOUND'
  | 'INVALID_SOURCE'
  | 'ASSET_NOT_FOUND'
  | 'EQUIPMENT_NOT_FOUND'
  | 'TARGET_NOT_LINKED'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_DATE'
  | 'INVALID_REFERENCE'
  | 'DETAILS_TYPE_MISMATCH'
  | 'INVALID_DETAILS'
  | 'LOCK_NOT_HELD'
  // Lot 42 — fusion V1 (B8).
  | 'MERGE_SELF'
  | 'MERGE_TYPE_MISMATCH';

export class BusinessOperationIntegrityError extends Error {
  readonly code: BusinessOperationErrorCode;

  constructor(code: BusinessOperationErrorCode, message: string) {
    super(`[business-operations] ${code} : ${message}`);
    this.name = 'BusinessOperationIntegrityError';
    this.code = code;
  }
}

export function isBusinessOperationIntegrityError(e: unknown): e is BusinessOperationIntegrityError {
  return e instanceof BusinessOperationIntegrityError;
}
