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

const GENERIC_FAILURE =
  'La génération du dossier a échoué. Vous pouvez réessayer dans quelques instants ; si le problème persiste, contactez le support.';

/**
 * Messages affichables (error.safe_message, §21) par code d'erreur. Codes du
 * CDC V12 §17.3 (INVALID_EXPORT_TYPE … STORAGE_ERROR) et codes internes du
 * moteur V12 (§15.3 : TEMPLATE_ERROR, RENDER_ERROR, ZIP_ERROR, DB_ERROR),
 * qui restent distincts dans l'historique et les journaux (LOG-003) mais
 * partagent un message générique.
 */
export const EXPORT_ERROR_MESSAGES = {
  GENERATION_FAILED: GENERIC_FAILURE,
  EXPORT_INTERNAL_ERROR:
    'Une erreur est survenue. Veuillez réessayer dans quelques instants.',
  INVALID_EXPORT_TYPE: 'Ce type de dossier n’est pas disponible.',
  ASSET_NOT_FOUND: 'Bien introuvable.',
  FORBIDDEN: 'Vous n’avez pas accès à ce bien.',
  NOT_ELIGIBLE: 'Ce dossier n’est pas disponible pour ce bien.',
  THRESHOLD_BLOCKED: 'Réduisez le contenu sélectionné.',
  FILE_UNAVAILABLE: 'Un fichier sélectionné n’est plus disponible.',
  RENDER_TIMEOUT: 'La génération a échoué. Réessayez avec moins de contenu.',
  STORAGE_ERROR: 'La génération a échoué lors du stockage.',
  TEMPLATE_ERROR: GENERIC_FAILURE,
  RENDER_ERROR: GENERIC_FAILURE,
  ZIP_ERROR: GENERIC_FAILURE,
  DB_ERROR: GENERIC_FAILURE,
  EXPORT_EXPIRED: 'Ce fichier a expiré. Relancez une préparation pour générer un nouveau dossier.',
  EXPORT_FILE_DELETED: 'Le fichier de ce dossier a été supprimé.',
  EXPORT_NOT_READY: 'Ce dossier n’est pas encore prêt.',
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
