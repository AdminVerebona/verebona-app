/**
 * POST /api/assets/[id]/exports/[exportId]/retry
 * Relance une génération échouée ou bloquée en 'generating' depuis > 5 min
 *
 * Conditions : status='error' OR (status='generating' AND generation_started_at < now()-5min AND output_payload IS NULL)
 * Idempotence : vérifie output_payload IS NULL avant de relancer
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, exportGenerations, accounts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { isPremiumPlan } from '@/types/domain';
import { buildAssetSnapshot } from '@/services/export-snapshot.service';
import { buildExportManifest } from '@/services/export-manifest.service';
import type { ExportType, ExportOutput } from '@/services/export-manifest.service';
import { renderExportToPdf } from '@/services/pdf-renderer.service';
import { buildExportZip } from '@/services/export-zip.service';
import { uploadExportFile, buildExportS3Key, getExportSignedUrl } from '@/services/export-upload.service';

export async function POST(
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

    // Verify asset ownership
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    // Load export
    const [exportRow] = await db
      .select()
      .from(exportGenerations)
      .where(and(
        eq(exportGenerations.id, exportIdNum),
        eq(exportGenerations.assetId, assetId),
      ))
      .limit(1);

    if (!exportRow) return NextResponse.json({ error: 'EXPORT_NOT_FOUND' }, { status: 404 });

    // Check if retry is allowed
    const canRetry = exportRow.status === 'error' ||
      (exportRow.status === 'generating' &&
       exportRow.generationStartedAt != null &&
       new Date(exportRow.generationStartedAt).getTime() < Date.now() - 5 * 60 * 1000 &&
       !exportRow.outputPayload);

    if (!canRetry) {
      return NextResponse.json({
        error: 'RETRY_NOT_ALLOWED',
        status: exportRow.status,
        message: 'Export cannot be retried in its current state',
      }, { status: 400 });
    }

    // Idempotence guard: if output already exists, return current state
    if (exportRow.outputPayload) {
      return NextResponse.json({ exportId: exportIdNum, status: exportRow.status });
    }

    const now = new Date();
    const newAttemptCount = (exportRow.generationAttemptCount ?? 0) + 1;

    // Atomic lock for retry
    const lockResult = await db
      .update(exportGenerations)
      .set({
        status: 'generating',
        generationStartedAt: now,
        generationAttemptCount: newAttemptCount,
        errorPayload: null,
      })
      .where(and(
        eq(exportGenerations.id, exportIdNum),
        // Only retry if output_payload is still null
      ))
      .returning({ id: exportGenerations.id });

    if (lockResult.length === 0) {
      return NextResponse.json({ error: 'LOCK_FAILED' }, { status: 409 });
    }

    // Determine plan — source de vérité : accounts.planType
    const [accountRow] = await db
      .select({ planType: accounts.planType })
      .from(accounts)
      .where(eq(accounts.id, exportRow.accountId))
      .limit(1);
    const isPremium = isPremiumPlan(accountRow?.planType ?? '');

    // Parse options
    let manifestOptions: { customSections?: string[]; customDocIds?: number[]; includePhotos?: boolean; includeEquipments?: boolean } = {};
    if (exportRow.manifestPayload) {
      try { manifestOptions = JSON.parse(exportRow.manifestPayload); } catch {}
    }

    const outputs: ExportOutput[] = exportRow.requestedOutputs
      ? JSON.parse(exportRow.requestedOutputs)
      : ['PDF'];

    const exportType = exportRow.exportType as ExportType;

    try {
      const snapshot = await buildAssetSnapshot(assetId, session.userId);
      const manifest = buildExportManifest(exportType, snapshot, {
        ...manifestOptions,
        requestedOutputs: outputs,
        variant: exportRow.variant ?? undefined,
      });

      const outputPayload: Record<string, string | number> = {};

      if (exportType === 'EXPORT_BRUT') {
        const zipBuffer = await buildExportZip(manifest, snapshot, null, isPremium);
        const zipKey = buildExportS3Key(exportRow.accountId, assetId, exportIdNum, 'export_brut.zip');
        await uploadExportFile(zipBuffer, zipKey, 'application/zip');
        outputPayload.zipS3Key = zipKey;
        outputPayload.zipSize = zipBuffer.length;
      } else {
        const pdfBuffer = await renderExportToPdf(manifest, snapshot);
        const pdfKey = buildExportS3Key(exportRow.accountId, assetId, exportIdNum, `${exportType}.pdf`);
        await uploadExportFile(pdfBuffer, pdfKey, 'application/pdf');
        outputPayload.pdfS3Key = pdfKey;
        outputPayload.pdfSize = pdfBuffer.length;

        if (outputs.includes('ZIP') && isPremium) {
          const zipBuffer = await buildExportZip(manifest, snapshot, pdfBuffer, isPremium);
          const zipKey = buildExportS3Key(exportRow.accountId, assetId, exportIdNum, `${exportType}.zip`);
          await uploadExportFile(zipBuffer, zipKey, 'application/zip');
          outputPayload.zipS3Key = zipKey;
          outputPayload.zipSize = zipBuffer.length;
        }
      }

      await db
        .update(exportGenerations)
        .set({
          status: 'ready',
          snapshotPayload: JSON.stringify(snapshot),
          outputPayload: JSON.stringify(outputPayload),
          completedAt: new Date(),
        })
        .where(eq(exportGenerations.id, exportIdNum));

      let downloadUrl: string | null = null;
      let downloadZipUrl: string | null = null;
      if (outputPayload.pdfS3Key) downloadUrl = await getExportSignedUrl(String(outputPayload.pdfS3Key), 3600);
      if (outputPayload.zipS3Key) downloadZipUrl = await getExportSignedUrl(String(outputPayload.zipS3Key), 3600);

      return NextResponse.json({ exportId: exportIdNum, status: 'ready', downloadUrl, downloadZipUrl });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await db
        .update(exportGenerations)
        .set({
          status: 'error',
          errorPayload: JSON.stringify({ code: 'GENERATION_FAILED', message: errorMessage, supportEmailSent: true, attemptCount: newAttemptCount }),
          completedAt: new Date(),
        })
        .where(eq(exportGenerations.id, exportIdNum));

      console.error('[ExportRetry] Generation failed after retry:', { exportId: exportIdNum, errorMessage, attemptCount: newAttemptCount });

      return NextResponse.json({ exportId: exportIdNum, status: 'error', errorMessage }, { status: 500 });
    }
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
