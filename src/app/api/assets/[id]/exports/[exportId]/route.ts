/**
 * GET    /api/assets/[id]/exports/[exportId] — Statut d'un export (et liens de téléchargement)
 * DELETE /api/assets/[id]/exports/[exportId] — Supprime le fichier d'un export
 *
 * Accès par compte (Duo compris, DRH-002) via `findAccessibleAssetForExport`.
 *
 * DRH-004 : « La suppression manuelle supprime le fichier mais conserve
 * l'entrée d'historique. » L'ancien DELETE faisait l'inverse (entrée masquée,
 * fichier S3 conservé). Désormais :
 *   - les objets PDF/ZIP sont supprimés directement du stockage ; ceux dont la
 *     suppression échoue sont confiés à la file `pending_blob_deletions`
 *     (tâche quotidienne `daily-blob-purge`, avec backoff) ;
 *   - l'entrée reste dans l'historique avec le statut `deleted` (affiché
 *     « Fichier supprimé »), sans clé de stockage ni lien de téléchargement.
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { exportGenerations, pendingBlobDeletions } from '@/db/schema';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { getExportSignedUrl } from '@/services/export-upload.service';
import { exportStorageKeys } from '@/services/assets/asset-deletion.service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { deleteStorageObjects } from '@/services/storage/blob-purge.service';
import { safeExportErrorMessage, exportRouteError } from '@/services/exports/export-errors';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; exportId: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id, exportId } = await params;
    const assetId = parseInt(id);
    const exportIdNum = parseInt(exportId);

    if (isNaN(assetId) || isNaN(exportIdNum)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const [row] = await db
      .select()
      .from(exportGenerations)
      .where(and(
        eq(exportGenerations.id, exportIdNum),
        eq(exportGenerations.assetId, assetId),
      ))
      .limit(1);

    if (!row) return NextResponse.json({ error: 'EXPORT_NOT_FOUND' }, { status: 404 });

    let downloadUrl: string | null = null;
    let downloadZipUrl: string | null = null;

    if (row.status === 'ready' && row.outputPayload) {
      try {
        const output = JSON.parse(row.outputPayload);
        if (output.pdfS3Key) downloadUrl = await getExportSignedUrl(output.pdfS3Key, 3600);
        if (output.zipS3Key) downloadZipUrl = await getExportSignedUrl(output.zipS3Key, 3600);
      } catch {}
    }

    return NextResponse.json({
      id: row.id,
      publicId: row.publicId,
      exportType: row.exportType,
      variant: row.variant,
      status: row.status,
      requestedOutputs: row.requestedOutputs ? JSON.parse(row.requestedOutputs) : ['PDF'],
      // Message générique uniquement (le détail technique reste côté serveur).
      errorMessage: row.status === 'error' ? safeExportErrorMessage(row.errorPayload) : null,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      downloadUrl,
      downloadZipUrl,
    });
  } catch (error) {
    return exportRouteError(error, '[Exports GET one]');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; exportId: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id, exportId } = await params;
    const assetId = parseInt(id);
    const exportIdNum = parseInt(exportId);

    if (isNaN(assetId) || isNaN(exportIdNum)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const [row] = await db
      .select({ id: exportGenerations.id, status: exportGenerations.status, outputPayload: exportGenerations.outputPayload })
      .from(exportGenerations)
      .where(and(
        eq(exportGenerations.id, exportIdNum),
        eq(exportGenerations.assetId, assetId),
      ))
      .limit(1);

    if (!row) return NextResponse.json({ error: 'EXPORT_NOT_FOUND' }, { status: 404 });
    if (row.status === 'generating') {
      return NextResponse.json({
        error: 'EXPORT_IN_PROGRESS',
        code: 'EXPORT_IN_PROGRESS',
        message: 'Cet export est en cours de génération : il pourra être supprimé une fois terminé.',
      }, { status: 409 });
    }
    // Idempotent : fichier déjà supprimé, l'entrée reste telle quelle.
    if (row.status === 'deleted') return NextResponse.json({ success: true, fileDeleted: true });

    const keys = exportStorageKeys(row.outputPayload);
    const now = new Date();

    // Suppression directe, au mieux ; les échecs passent par la file.
    const { deleted, failed } = await deleteStorageObjects(keys);

    await db.transaction(async (tx) => {
      if (failed.length > 0) {
        const alreadyPending = await tx
          .select({ storagePath: pendingBlobDeletions.storagePath })
          .from(pendingBlobDeletions)
          .where(and(inArray(pendingBlobDeletions.storagePath, failed), isNull(pendingBlobDeletions.processedAt)));
        const pending = new Set(alreadyPending.map(r => r.storagePath));
        const toQueue = failed.filter(k => !pending.has(k));
        if (toQueue.length > 0) {
          // Échéance immédiate : repris au prochain passage de la purge
          // (tâche quotidienne), puis backoff en cas de nouvel échec.
          await tx.insert(pendingBlobDeletions).values(
            toQueue.map(storagePath => ({ fileId: null, storagePath, scheduledFor: now, createdAt: now })),
          );
        }
      }

      // L'entrée d'historique est conservée ; les clés de stockage sont
      // retirées (plus aucun lien possible vers un objet purgé).
      await tx
        .update(exportGenerations)
        .set({
          status: 'deleted',
          outputPayload: JSON.stringify({ fileDeletedAt: now.toISOString(), fileDeletedByUserId: session.userId }),
        })
        .where(eq(exportGenerations.id, exportIdNum));
    });

    return NextResponse.json({ success: true, fileDeleted: true, blobsDeleted: deleted.length, blobsScheduled: failed.length });
  } catch (error) {
    return exportRouteError(error, '[Exports DELETE]');
  }
}
