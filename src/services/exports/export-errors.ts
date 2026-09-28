/**
 * Messages d'erreur des exports (CDC Exports V12 — DRH-008, error.safe_message).
 *
 * Le message technique (`error.message` : exception S3, jsPDF, SQL…) était
 * renvoyé tel quel à l'interface et relu depuis l'historique. L'utilisateur
 * reçoit désormais un message générique en français accompagné d'un code ;
 * le détail technique reste dans les journaux serveur (et dans
 * `error_payload.technicalMessage`, jamais renvoyé au client).
 */

import { NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';

export const EXPORT_ERROR_MESSAGES = {
  GENERATION_FAILED:
    'La génération du dossier a échoué. Vous pouvez réessayer dans quelques instants ; si le problème persiste, contactez le support.',
  EXPORT_INTERNAL_ERROR:
    'Une erreur est survenue. Veuillez réessayer dans quelques instants.',
} as const;

export type ExportErrorCode = keyof typeof EXPORT_ERROR_MESSAGES;

/** Message affichable pour un `error_payload` stocké (anciens payloads compris). */
export function safeExportErrorMessage(errorPayload: string | null | undefined): string | null {
  if (!errorPayload) return null;
  let code: string | undefined;
  try { code = JSON.parse(errorPayload)?.code; } catch { /* payload illisible */ }
  return EXPORT_ERROR_MESSAGES[(code ?? '') as ExportErrorCode] ?? EXPORT_ERROR_MESSAGES.GENERATION_FAILED;
}

/** Texte technique d'une exception, pour les journaux uniquement. */
export function technicalErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}

/**
 * Réponse d'erreur d'une route d'export : les erreurs de session gardent leur
 * réponse habituelle (401/403) ; toute autre erreur est journalisée et
 * remplacée par un message générique.
 */
export function exportRouteError(error: unknown, context: string): NextResponse {
  const res = SessionService.handleSessionError(error);
  if (res.status < 500) return res;
  console.error(`${context} erreur inattendue :`, error);
  return NextResponse.json(
    { error: 'EXPORT_INTERNAL_ERROR', code: 'EXPORT_INTERNAL_ERROR', message: EXPORT_ERROR_MESSAGES.EXPORT_INTERNAL_ERROR },
    { status: 500 },
  );
}
