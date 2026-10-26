/**
 * « Ajouter un document » depuis un élément d'agenda — lien des documents
 * déposés (lot 85D, CDC v5 O-3 ; AC01).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE CHAÎNE : CELLE DU TIROIR DE L'ÉLÉMENT (84B)
 *
 * La fenêtre d'ajout reliait les documents déposés à un « événement » de
 * l'ancien modèle (`POST /api/events/[id]/documents`, table
 * `event_documents`) et pouvait en créer un (`POST /api/events`). Ces routes
 * sont retirées : le lien passe désormais par la route du tiroir
 * (`POST /api/documents/:id/agenda-liens { itemId }`), c'est-à-dire par
 * `linkDocumentToAgendaItem` (service unique de regroupement) — lien précis
 * `MANUAL_DIRECT` conservé, et le document rejoint l'ensemble de l'élément
 * (créé au besoin), propagé à l'événement de référence (AC01, AC05).
 *
 * Un échec de lien reste silencieux, comme avant : le document est déjà
 * enregistré, et l'utilisateur peut le relier depuis le tiroir. Le serveur
 * refuse le lien d'un compte en lecture seule (403) — cas qui n'arrive pas
 * ici, le dépôt lui-même étant refusé avant.
 *
 * Module sans dépendance serveur (importé par le client).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Envoi JSON (POST) ; rend au moins le statut HTTP. */
type PostJson = (url: string, body: unknown) => Promise<{ ok: boolean; status: number }>;

export const agendaLinkUrl = (fileId: number): string => `/api/documents/${fileId}/agenda-liens`;

/** Identifiant d'élément d'agenda exploitable, sinon null. */
export function agendaItemIdOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Relie chaque document déposé à l'élément d'agenda (un appel par document,
 * dans l'ordre : le premier crée l'ensemble au besoin, les suivants le
 * rejoignent). Rend les documents reliés et ceux dont le lien a échoué.
 */
export async function linkUploadedDocumentsToAgendaItem(
  itemId: number | null | undefined,
  fileIds: readonly number[],
  post: PostJson,
): Promise<{ linked: number[]; failed: number[] }> {
  const linked: number[] = [];
  const failed: number[] = [];
  const id = agendaItemIdOrNull(itemId);
  if (id === null) return { linked, failed };
  for (const fileId of fileIds) {
    try {
      const r = await post(agendaLinkUrl(fileId), { itemId: id });
      (r.ok ? linked : failed).push(fileId);
    } catch {
      failed.push(fileId);
    }
  }
  return { linked, failed };
}
