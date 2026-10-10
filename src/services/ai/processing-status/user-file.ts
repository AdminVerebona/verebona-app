/**
 * Projection d'un document vers l'application — lot 34C. Pur (aucun accès
 * base) : utilisable par toute route, y compris sous des tests qui simulent
 * `@/db`.
 */
import type { ProcessingView } from '@/lib/ai/processing-status';

/** Champs techniques d'un document qui ne quittent jamais le serveur vers l'application. */
export const TECHNICAL_FILE_FIELDS = ['analysisFailReason', 'analysis_fail_reason'] as const;

/** Champs fonctionnels ajoutés à un document rendu à l'application. */
export interface UserProcessingFields {
  processingStatus: ProcessingView['processingStatus'];
  userMessageCode: ProcessingView['userMessageCode'];
  retryScheduled: boolean;
  nextAttemptAt: string | null;
  processingResumeAt: string | null;
}

export function processingFields(view: ProcessingView): UserProcessingFields {
  return {
    processingStatus: view.processingStatus,
    userMessageCode: view.userMessageCode,
    retryScheduled: view.retryScheduled,
    nextAttemptAt: view.nextAttemptAt,
    processingResumeAt: view.resumeAt,
  };
}

/**
 * Projection d'une ligne `asset_files` vers l'application : motif technique
 * retiré, statut fonctionnel ajouté (si fourni).
 */
export function toUserFile<T extends object>(
  row: T, view?: ProcessingView | null,
): Omit<T, (typeof TECHNICAL_FILE_FIELDS)[number]> & Partial<UserProcessingFields> {
  const copie = { ...row } as Record<string, unknown>;
  for (const k of TECHNICAL_FILE_FIELDS) delete copie[k];
  return (view ? { ...copie, ...processingFields(view) } : copie) as Omit<T, (typeof TECHNICAL_FILE_FIELDS)[number]> & Partial<UserProcessingFields>;
}

