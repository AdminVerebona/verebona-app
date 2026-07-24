import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const { userId } = session;
    const sessionAccountId = (session as any).currentAccountId as number | undefined;

    const body = await request.json();
    const {
      fileId,
      fileIds: batchFileIds,
      assetId,
      documentType,
      documentDate,
      description,
      supplier,
      amountCents,
      substructureId,
      equipmentId,
    } = body;

    if (!fileId) {
      return NextResponse.json(
        { error: 'MISSING_FIELD', message: 'fileId requis' },
        { status: 400 }
      );
    }

    // Validate fileId is a valid number
    const fileIdInt = parseInt(fileId);
    if (isNaN(fileIdInt)) {
      return NextResponse.json(
        { error: 'Invalid fileId', code: 'INVALID_FILE_ID' },
        { status: 400 }
      );
    }

    // Fetch the file record
    const fileRecords = await db
      .select()
      .from(assetFiles)
      .where(eq(assetFiles.id, fileIdInt))
      .limit(1);

    // Check if file exists
    if (fileRecords.length === 0) {
      return NextResponse.json(
        { error: 'File not found', code: 'FILE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const fileRecord = fileRecords[0];

    // Verify user owns the file
    if (fileRecord.userId !== userId) {
      return NextResponse.json(
        { error: 'You do not have permission to access this file', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // Check file is in PENDING status
    if (fileRecord.uploadStatus !== 'PENDING') {
      return NextResponse.json(
        { 
          error: `File is not in PENDING status. Current status: ${fileRecord.uploadStatus}`,
          code: 'INVALID_STATUS'
        },
        { status: 400 }
      );
    }

    // Update the file record to COMPLETED
    const updateData: any = {
      uploadStatus: 'COMPLETED',
      sha256Hash: fileRecord.sha256Hash,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    };

    // Save metadata if provided in body
    if (assetId !== undefined) {
      updateData.assetId = assetId === 0 || assetId === '0' || assetId === null ? null : parseInt(assetId.toString());
    }
    if (documentType) updateData.documentType = documentType;
    if (documentDate) updateData.documentDate = documentDate;
    if (description) updateData.description = description;
    if (supplier) updateData.supplier = supplier;
    if (amountCents !== undefined && amountCents !== null) {
      updateData.amountCents = parseInt(amountCents.toString());
    }
    if (substructureId !== undefined && substructureId !== null) {
      updateData.substructureId = parseInt(substructureId.toString());
    }
    if (equipmentId !== undefined && equipmentId !== null) {
      updateData.equipmentId = parseInt(equipmentId.toString());
    }

    const updatedFiles = await db
      .update(assetFiles)
      .set(updateData)
      .where(
        and(
          eq(assetFiles.id, fileIdInt),
          eq(assetFiles.userId, userId)
        )
      )
      .returning();

    if (updatedFiles.length === 0) {
      return NextResponse.json(
        { error: 'Failed to update file record', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    const confirmedFile = updatedFiles[0];

    // ── Pipeline d'analyse unifié (fire-and-forget) ─────────────────────────
    // Déclenché pour tous les plans avec analyse IA.
    // Accepte un batch (fileIds[]) ou un fichier unique (fileId).
    const accountId = confirmedFile.accountId ?? sessionAccountId;
    if (accountId) {
      // Construire la liste complète des fileIds du batch
      const allFileIds: number[] = Array.isArray(batchFileIds) && batchFileIds.length > 0
        ? batchFileIds.map(Number)
        : [fileIdInt];
      import('@/services/document-ai/unified-analysis-pipeline').then(({ runUnifiedAnalysisPipeline }) => {
        runUnifiedAnalysisPipeline(allFileIds, accountId).catch((err: Error) => {
          console.error('[confirm] unified-analysis-pipeline failed:', err);
        });
      }).catch(() => {});
    }

    // ── Détection fusion (fire-and-forget) ──────────────────────────────────
    if (accountId && confirmedFile.sha256Hash) {
      (async () => {
        try {
          const { detectFusionCandidates } = await import('@/services/document-ai/fusion-detector');
          await detectFusionCandidates(fileIdInt, accountId);
        } catch { /* non-blocking */ }
      })();
    }

    // CDC §17 : activation — premier document enregistre
    void trackFunnelEvent({ event: 'first_document_added', accountId });

    return NextResponse.json(
      {
        success: true,
        file: confirmedFile,
      },
      { status: 200 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    const errMsg = (error as Error).message;
    if (errMsg === 'AUTH_REQUIRED' || errMsg === 'INVALID_TOKEN' || errMsg === 'ACCOUNT_SUSPENDED') {
      const { SessionService } = await import('@/lib/session-service');
      return SessionService.handleSessionError(error);
    }

    console.error('POST /api/files/confirm error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}