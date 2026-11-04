/**
 * Confirmation DISCRÈTE d'un ajout réussi, dans le parcours d'ajout — lot 108I
 * (ticket « Notifications documents » : « Ajout réussi → confirmation discrète
 * dans le parcours d'import ; aucune notification »).
 *
 * Remplace la notification « Document ajouté » du lot 32 (PO-Q18/Q19), qui
 * doublonnait avec « Le document … a été analysé » dans le centre de
 * notifications. Un message bref et neutre (ni succès appuyé, ni cloche, ni
 * push), le temps de voir que l'ajout est pris en compte ; le document
 * apparaît ensuite dans les listes et, pour une analyse, le bandeau
 * « Analyse en cours… » prend le relais. Les ÉCHECS gardent leur message
 * d'erreur (lot 31, L31-5-AC4).
 */
import { toast } from 'sonner';
import { uploadNotificationText } from '@/lib/notifications/upload-notification-text';

/** Durée d'affichage de la confirmation (courte : simple accusé de réception). */
export const UPLOAD_CONFIRMATION_MS = 3_000;

/** Texte de la confirmation (pur). */
export function uploadConfirmationText(p: { count: number; kind: 'file' | 'web_link'; analysisStarted: boolean }): { title: string; description?: string } {
  const { title } = uploadNotificationText({ count: p.count, kind: p.kind });
  return p.analysisStarted ? { title, description: p.count > 1 ? 'Analyses en cours…' : 'Analyse en cours…' } : { title };
}

/** Affiche la confirmation (client). Silencieuse hors navigateur. */
export function confirmerAjout(p: { count: number; kind: 'file' | 'web_link'; analysisStarted: boolean }): void {
  if (p.count <= 0 || typeof window === 'undefined') return;
  const t = uploadConfirmationText(p);
  toast(t.title, { ...(t.description ? { description: t.description } : {}), duration: UPLOAD_CONFIRMATION_MS });
}
