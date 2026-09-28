/**
 * Erreurs de génération V12 : un code distinct par cause (§17.3, §21), une
 * catégorie (LOG-003 : métier, seuil, fichier, rendu, stockage) et l'étape du
 * job (§15.3). Le message technique reste dans les journaux ; l'utilisateur
 * ne voit que `EXPORT_ERROR_MESSAGES[code]` (error.safe_message, DRH-008).
 */

import { EXPORT_ERROR_MESSAGES } from '@/services/exports/export-errors';

export type GenerationStep =
  | 'validate_request' | 'lock_snapshot' | 'resolve_files' | 'render_html' | 'render_pdf'
  | 'assemble_zip' | 'store_result' | 'finalize_history';

export type ErrorCategory = 'business' | 'threshold' | 'file' | 'render' | 'storage' | 'internal';

export type GenerationErrorCode =
  | 'INVALID_EXPORT_TYPE' | 'ASSET_NOT_FOUND' | 'FORBIDDEN' | 'NOT_ELIGIBLE' | 'THRESHOLD_BLOCKED'
  | 'FILE_UNAVAILABLE' | 'RENDER_TIMEOUT' | 'STORAGE_ERROR' | 'TEMPLATE_ERROR' | 'RENDER_ERROR'
  | 'ZIP_ERROR' | 'DB_ERROR' | 'GENERATION_FAILED';

const CATEGORY: Record<GenerationErrorCode, ErrorCategory> = {
  INVALID_EXPORT_TYPE: 'business', ASSET_NOT_FOUND: 'business', FORBIDDEN: 'business', NOT_ELIGIBLE: 'business',
  THRESHOLD_BLOCKED: 'threshold', FILE_UNAVAILABLE: 'file', RENDER_TIMEOUT: 'render', RENDER_ERROR: 'render',
  TEMPLATE_ERROR: 'render', STORAGE_ERROR: 'storage', ZIP_ERROR: 'internal', DB_ERROR: 'internal', GENERATION_FAILED: 'internal',
};

/** Erreurs non transitoires : relancer ne changerait rien (pas de nouvelle tentative automatique). */
const PERMANENT: ReadonlySet<GenerationErrorCode> = new Set([
  'INVALID_EXPORT_TYPE', 'ASSET_NOT_FOUND', 'FORBIDDEN', 'NOT_ELIGIBLE', 'THRESHOLD_BLOCKED', 'TEMPLATE_ERROR', 'RENDER_TIMEOUT',
]);

export class ExportGenerationError extends Error {
  readonly code: GenerationErrorCode;
  readonly step: GenerationStep;
  readonly category: ErrorCategory;
  readonly details?: Record<string, unknown>;
  constructor(code: GenerationErrorCode, step: GenerationStep, technicalMessage: string, details?: Record<string, unknown>) {
    super(technicalMessage);
    this.name = 'ExportGenerationError';
    this.code = code;
    this.step = step;
    this.category = CATEGORY[code];
    this.details = details;
  }
  get permanent(): boolean { return PERMANENT.has(this.code); }
  get safeMessage(): string { return EXPORT_ERROR_MESSAGES[this.code]; }
}

/**
 * Convertit une erreur quelconque levée pendant `step` en erreur codée : un
 * code déjà porté (`exportErrorCode`, ex. RENDER_TIMEOUT du navigateur) est
 * conservé, sinon le code par défaut de l'étape.
 */
export function asGenerationError(e: unknown, step: GenerationStep): ExportGenerationError {
  if (e instanceof ExportGenerationError) return e;
  const carried = (e as { exportErrorCode?: string } | null)?.exportErrorCode as GenerationErrorCode | undefined;
  const byStep: Record<GenerationStep, GenerationErrorCode> = {
    validate_request: 'GENERATION_FAILED',
    lock_snapshot: 'DB_ERROR',
    resolve_files: 'FILE_UNAVAILABLE',
    render_html: 'TEMPLATE_ERROR',
    render_pdf: 'RENDER_ERROR',
    assemble_zip: 'ZIP_ERROR',
    store_result: 'STORAGE_ERROR',
    finalize_history: 'DB_ERROR',
  };
  const code = carried && carried in CATEGORY ? carried : byStep[step];
  const message = e instanceof Error ? e.message : String(e ?? 'erreur inconnue');
  return new ExportGenerationError(code, step, message.slice(0, 2000));
}
