/**
 * Traduction HTTP des refus métier RGPD (UX-003 : une action impossible est
 * expliquée, jamais un échec muet).
 */
import { RULE_ERROR_MESSAGES, type GdprRuleError } from './rules';

export type GdprApiError = GdprRuleError | 'NOT_FOUND' | 'SUBJECT_NOT_FOUND';

const STATUS: Record<GdprApiError, number> = {
  NOT_FOUND: 404,
  SUBJECT_NOT_FOUND: 422,
  SYSTEM_REQUEST_READ_ONLY: 409,
  REQUEST_DONE_FROZEN: 409,
  NOT_DONE: 409,
  INVALID_TRANSITION: 409,
  DUE_DATE_NOT_ACCEPTED: 400,
  INVALID_FIELD: 400,
  RECEIVED_IN_FUTURE: 400,
  SUBJECT_REQUIRED: 400,
  NOTHING_TO_UPDATE: 400,
};

const EXTRA_MESSAGES: Record<'NOT_FOUND' | 'SUBJECT_NOT_FOUND', string> = {
  NOT_FOUND: 'Demande introuvable.',
  SUBJECT_NOT_FOUND: 'Utilisateur ou compte introuvable.',
};

export function gdprApiError(error: GdprApiError, field?: string): { status: number; body: Record<string, unknown> } {
  const message = error === 'NOT_FOUND' || error === 'SUBJECT_NOT_FOUND'
    ? EXTRA_MESSAGES[error]
    : RULE_ERROR_MESSAGES[error] + (error === 'INVALID_FIELD' && field ? ` (${field})` : '');
  return { status: STATUS[error], body: { error, message, ...(field ? { field } : {}) } };
}

/** Identifiant de route numérique strictement positif, sinon null. */
export function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
