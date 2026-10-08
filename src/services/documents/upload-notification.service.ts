/**
 * Notification « envoi réussi » — lot 32 (décisions PO du 07/10/2026, Q18/Q19).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « MÊME COMPORTEMENT POUR TOUS : UNE NOTIFICATION »
 *
 * Le lot 31 a retiré les toasts de succès (« Lien web ajouté »…) : un envoi
 * réussi fermait la fenêtre sans autre retour, et les comptes Standard n'en
 * avaient aucun. Désormais, après un envoi réussi — fichiers ou lien web —
 * l'utilisateur qui a envoyé reçoit UNE notification par lot d'envoi, quel
 * que soit son offre : cloche toujours, push et e-mail selon ses préférences
 * de la catégorie « Documents ». Aucun toast.
 *
 * UNE SEULE PAR LOT : la clé de déduplication de l'outbox porte l'identifiant
 * du lot (choisi par la file d'envoi) ; une reprise tardive d'un fichier du
 * même lot ne crée pas de seconde notification. Sans identifiant de lot,
 * l'ensemble trié des documents en tient lieu.
 *
 * Seuls les documents du compte, non supprimés et dont le dépôt est confirmé
 * comptent : un appel forgé ne peut ni nommer le document d'un autre compte,
 * ni annoncer un envoi inachevé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { and, eq, inArray, isNull, or, ne } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { emit } from '@/lib/notifications';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';

/** Taille maximale d'un lot annoncé (au-delà, les identifiants sont ignorés). */
export const MAX_UPLOAD_NOTIFICATION_IDS = 500;

export interface UploadNotificationInput {
  userId: number;
  accountId: number;
  fileIds: unknown;
  /** Identifiant du lot d'envoi (file côté client), facultatif. */
  lotId?: unknown;
}

export interface UploadNotificationResult {
  emitted: boolean;
  count: number;
}

/** Identifiants valides, uniques, bornés (pur). */
export function sanitizeFileIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, MAX_UPLOAD_NOTIFICATION_IDS);
}

/** Clé de déduplication du lot, sans l'utilisateur (le moteur l'ajoute) — pure. */
export function uploadDedupeKey(accountId: number, lotId: unknown, fileIds: number[]): string {
  const lot = typeof lotId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(lotId) ? lotId : null;
  const empreinte = lot ?? createHash('sha256').update([...fileIds].sort((a, b) => a - b).join(',')).digest('hex').slice(0, 32);
  return `documents:upload:${accountId}:${empreinte}`;
}

export async function notifyUploadCompleted(input: UploadNotificationInput): Promise<UploadNotificationResult> {
  const ids = sanitizeFileIds(input.fileIds);
  if (ids.length === 0) return { emitted: false, count: 0 };

  const rows = await db
    .select({
      id: assetFiles.id,
      retainedTitle: assetFiles.retainedTitle,
      originalFilename: assetFiles.originalFilename,
      isWebLink: assetFiles.isWebLink,
    })
    .from(assetFiles)
    .where(and(
      inArray(assetFiles.id, ids),
      eq(assetFiles.accountId, input.accountId),
      isNull(assetFiles.deletedAt),
      or(isNull(assetFiles.uploadStatus), ne(assetFiles.uploadStatus, 'PENDING')),
    ));
  if (rows.length === 0) return { emitted: false, count: 0 };

  const seul = rows.length === 1 ? rows[0] : null;
  const titre = seul ? (displayDocumentTitle(seul, '') || undefined) : undefined;

  await emit({
    type: 'DOCUMENT_UPLOAD_COMPLETED',
    recipientUserIds: [input.userId],
    accountId: input.accountId,
    actorUserId: input.userId,
    entityType: 'document_upload',
    entityId: seul ? seul.id : null,
    payload: {
      count: rows.length,
      ...(seul ? { assetFileId: seul.id } : {}),
      ...(titre ? { documentTitle: titre.slice(0, 200) } : {}),
      kind: rows.every((r) => r.isWebLink) ? 'web_link' : 'file',
    },
    dedupeKey: uploadDedupeKey(input.accountId, input.lotId, rows.map((r) => r.id)),
  });
  return { emitted: true, count: rows.length };
}
