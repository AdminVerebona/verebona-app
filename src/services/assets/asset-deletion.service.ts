/**
 * Suppression définitive d'un bien — règle produit « tout est supprimé ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 * Supprimer un bien supprime TOUT ce qui lui est rattaché : documents et
 * photos (`asset_files`, y compris ceux liés à une de ses pièces), échéances,
 * événements, pièces, sous-ensembles, équipements, exports… Aucune option
 * « conserver les documents » : elle n'a jamais été appliquée par l'API.
 *
 * Les lignes partent par les clés étrangères `ON DELETE CASCADE`. Les OBJETS
 * du stockage (S3/OVH), eux, ne sont pas couverts par la cascade : ils sont
 * mis en file de purge (`pending_blob_deletions`) DANS la même transaction,
 * AVANT la suppression qui efface leurs références — exactement comme la
 * suppression de compte (scheduled-deletion.service). Le cron
 * `/api/cron/purge-blobs` les supprime ensuite physiquement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import {
  assets,
  assetFiles,
  assetPhotos,
  assetTransmissions,
  deadlines,
  documentVersions,
  equipments,
  events,
  exportGenerations,
  pendingBlobDeletions,
  rooms,
} from '@/db/schema';
import { and, count, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';

/** Décompte présenté avant confirmation (DeleteAssetDialog). */
export interface AssetDeletionSummary {
  documents: number;
  photos: number;
  deadlines: number;
  events: number;
  rooms: number;
  equipments: number;
}

/* ── Fonctions pures (testées unitairement) ─────────────────────────────── */

/**
 * Clé de stockage d'une vignette. La vignette est enregistrée soit comme clé
 * brute, soit (historique) comme URL S3 path-style ou virtual-host.
 */
export function thumbnailStorageKey(thumbnailUrl: string | null | undefined, bucket?: string | null): string | null {
  if (!thumbnailUrl) return null;
  const value = thumbnailUrl.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value;
  if (!bucket) return null;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (url.hostname.startsWith(`${bucket}.`)) return path || null;
    if (path.startsWith(`${bucket}/`)) return path.slice(bucket.length + 1) || null;
  } catch {
    // URL invalide : rien à purger de façon sûre.
  }
  return null;
}

/** Clés des fichiers générés d'un export (`output_payload` JSON). */
export function exportStorageKeys(outputPayload: string | null | undefined): string[] {
  if (!outputPayload) return [];
  try {
    const parsed = JSON.parse(outputPayload) as Record<string, unknown>;
    return ['pdfS3Key', 'zipS3Key']
      .map((k) => parsed?.[k])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Clés à programmer : dédoublonnées, sans la valeur provisoire `temp` du
 * presign, sans celles encore référencées par un fichier qui survit, et sans
 * celles déjà en attente de purge.
 */
export function selectBlobKeysToPurge(input: {
  candidates: Array<string | null | undefined>;
  stillReferenced?: Iterable<string>;
  alreadyPending?: Iterable<string>;
}): string[] {
  const excluded = new Set<string>([...(input.stillReferenced ?? []), ...(input.alreadyPending ?? [])]);
  const out = new Set<string>();
  for (const key of input.candidates) {
    if (!key || key === 'temp' || excluded.has(key)) continue;
    out.add(key);
  }
  return [...out];
}

/* ── Accès base ─────────────────────────────────────────────────────────── */

function roomIdsOf(assetId: number) {
  return db.select({ id: rooms.id }).from(rooms).where(eq(rooms.assetId, assetId));
}

/** Tout ce que la cascade emporte parmi les fichiers : bien, bien lié, pièce du bien. */
function filesScope(assetId: number) {
  return or(
    eq(assetFiles.assetId, assetId),
    eq(assetFiles.linkedAssetId, assetId),
    inArray(assetFiles.linkedRoomId, roomIdsOf(assetId)),
  );
}

export async function getAssetDeletionSummary(assetId: number): Promise<AssetDeletionSummary> {
  const photoFileIds = db.select({ id: assetPhotos.fileId }).from(assetPhotos).where(eq(assetPhotos.assetId, assetId));

  const [docRows, photoRows, deadlineRows, eventRows, roomRows, equipmentRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(assetFiles)
      .where(and(
        filesScope(assetId),
        isNull(assetFiles.deletedAt),
        or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
        notInArray(assetFiles.id, photoFileIds),
      )),
    db.select({ n: count() }).from(assetPhotos).where(eq(assetPhotos.assetId, assetId)),
    db
      .select({ n: count() })
      .from(deadlines)
      .where(and(
        or(
          eq(deadlines.assetId, assetId),
          eq(deadlines.linkedAssetId, assetId),
          inArray(deadlines.linkedRoomId, roomIdsOf(assetId)),
        ),
        eq(deadlines.isDraft, false),
      )),
    db
      .select({ n: count() })
      .from(events)
      .where(and(
        or(
          eq(events.assetId, assetId),
          eq(events.linkedAssetId, assetId),
          inArray(events.linkedRoomId, roomIdsOf(assetId)),
        ),
        eq(events.isDraft, false),
      )),
    db.select({ n: count() }).from(rooms).where(eq(rooms.assetId, assetId)),
    db.select({ n: count() }).from(equipments).where(eq(equipments.assetId, assetId)),
  ]);

  const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  return {
    documents: n(docRows),
    photos: n(photoRows),
    deadlines: n(deadlineRows),
    events: n(eventRows),
    rooms: n(roomRows),
    equipments: n(equipmentRows),
  };
}

/**
 * Supprime le bien et tout son contenu ; programme la purge des objets de
 * stockage. Retourne le nombre d'objets programmés.
 */
export async function deleteAssetCompletely(asset: {
  id: number;
  thumbnailUrl?: string | null;
}): Promise<{ blobsScheduled: number }> {
  const assetId = asset.id;
  const bucket = process.env.OVH_S3_BUCKET ?? null;

  return db.transaction(async (tx) => {
    const roomIds = tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.assetId, assetId));

    // 1. Objets de stockage, relevés AVANT la cascade.
    const files = await tx
      .select({ id: assetFiles.id, s3Key: assetFiles.s3Key })
      .from(assetFiles)
      .where(or(
        eq(assetFiles.assetId, assetId),
        eq(assetFiles.linkedAssetId, assetId),
        inArray(assetFiles.linkedRoomId, roomIds),
      ));
    const fileIds = files.map((f) => f.id);

    const versions = fileIds.length
      ? await tx
          .select({ s3Key: documentVersions.s3Key })
          .from(documentVersions)
          .where(inArray(documentVersions.fileId, fileIds))
      : [];

    const exportsRows = await tx
      .select({ outputPayload: exportGenerations.outputPayload })
      .from(exportGenerations)
      .where(eq(exportGenerations.assetId, assetId));

    const candidates = [
      ...files.map((f) => f.s3Key),
      ...versions.map((v) => v.s3Key),
      ...exportsRows.flatMap((e) => exportStorageKeys(e.outputPayload)),
      thumbnailStorageKey(asset.thumbnailUrl, bucket),
    ].filter((k): k is string => !!k && k !== 'temp');

    let keys: string[] = [];
    if (candidates.length > 0) {
      const unique = [...new Set(candidates)];
      // Garde-fou : un objet encore référencé par un fichier qui survit
      // (hors du périmètre supprimé) n'est jamais purgé.
      const survivorsWhere = fileIds.length
        ? and(inArray(assetFiles.s3Key, unique), notInArray(assetFiles.id, fileIds))
        : inArray(assetFiles.s3Key, unique);
      const stillReferenced = await tx
        .select({ s3Key: assetFiles.s3Key })
        .from(assetFiles)
        .where(survivorsWhere);
      const alreadyPending = await tx
        .select({ storagePath: pendingBlobDeletions.storagePath })
        .from(pendingBlobDeletions)
        .where(and(inArray(pendingBlobDeletions.storagePath, unique), isNull(pendingBlobDeletions.processedAt)));

      keys = selectBlobKeysToPurge({
        candidates: unique,
        stillReferenced: stillReferenced.map((r) => r.s3Key).filter((k): k is string => !!k),
        alreadyPending: alreadyPending.map((r) => r.storagePath),
      });
    }

    const now = new Date();
    if (keys.length > 0) {
      // `fileId` nul : la ligne `asset_files` disparaît dans la même transaction.
      // Purge immédiate (comme la suppression de compte) : l'utilisateur a
      // confirmé une action annoncée comme irréversible.
      await tx.insert(pendingBlobDeletions).values(
        keys.map((storagePath) => ({ fileId: null, storagePath, scheduledFor: now, createdAt: now })),
      );
    }

    // 2. Seule clé étrangère sans cascade vers `assets`.
    await tx
      .update(assetTransmissions)
      .set({ duplicatedAssetId: null })
      .where(eq(assetTransmissions.duplicatedAssetId, assetId));

    // 3. Le bien ; la cascade emporte tout le reste.
    await tx.delete(assets).where(eq(assets.id, assetId));

    return { blobsScheduled: keys.length };
  });
}
