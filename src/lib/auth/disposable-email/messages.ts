/**
 * Lot 109F — code et message UNIQUES du refus d'une adresse e-mail jetable.
 * Module PUR (aucune liste, aucun import serveur) : partagé par les routes et
 * les écrans web / application (message affiché sous le champ e-mail).
 */
export const DISPOSABLE_EMAIL_NOT_ALLOWED = 'DISPOSABLE_EMAIL_NOT_ALLOWED' as const;

export const DISPOSABLE_EMAIL_MESSAGE =
  'Les adresses e-mail temporaires ne sont pas acceptées. Utilisez une adresse e-mail que vous conservez.';

/** Le serveur a-t-il refusé l'adresse comme jetable ? (corps JSON d'une réponse d'erreur) */
export function isDisposableEmailRefusal(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { code?: unknown }).code === DISPOSABLE_EMAIL_NOT_ALLOWED;
}
