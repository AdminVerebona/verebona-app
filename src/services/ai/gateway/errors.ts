/**
 * Erreurs typées de la gateway — CDC §5.2 (gestion des erreurs) et §11.4
 * (« le pipeline reste fonctionnel si le fournisseur IA est indisponible »).
 */
export type AiErrorCode =
  | 'OPERATION_UNKNOWN'
  | 'OPERATION_INACTIVE'
  | 'USE_CASE_MISMATCH'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_OUTPUT'
  | 'ALL_MODELS_FAILED'
  | 'MISSING_COST_ENTRY'
  | 'QUOTA_EXCEEDED';

export class AiGatewayError extends Error {
  readonly code: AiErrorCode;
  readonly operationCode: string;
  readonly recoverable: boolean;
  readonly cause?: unknown;

  constructor(code: AiErrorCode, operationCode: string, message: string, opts?: { recoverable?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'AiGatewayError';
    this.code = code;
    this.operationCode = operationCode;
    this.recoverable = opts?.recoverable ?? false;
    this.cause = opts?.cause;
  }
}

export function isAiGatewayError(e: unknown): e is AiGatewayError {
  return e instanceof AiGatewayError;
}
