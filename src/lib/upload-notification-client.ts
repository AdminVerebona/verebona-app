/**
 * Signale au serveur la fin d'un lot d'envoi réussi (lot 32, décisions PO
 * Q18/Q19) : le serveur émet UNE notification « Documents ajoutés » (cloche,
 * puis push / e-mail selon les préférences). Aucun toast côté client.
 *
 * Silencieux par construction : l'envoi a déjà réussi, l'absence de
 * notification n'est pas une erreur à montrer.
 */
export function signalerEnvoiReussi(fileIds: number[], lotId?: string | null): void {
  if (fileIds.length === 0 || typeof fetch !== 'function') return;
  fetch('/api/documents/upload-notification', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds, lotId: lotId ?? undefined }),
  }).catch(() => undefined);
}
