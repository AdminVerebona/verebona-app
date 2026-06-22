/**
 * GET /api/assets/[id]/exports/[exportId] — Statut d'un export spécifique
 * DELETE /api/assets/[id]/exports/[exportId] — Supprime (soft) un export
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, exportGenerations } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getExportSignedUrl } from '@/services/export-upload.service';

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

    // Verify asset ownership
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
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
      errorMessage: row.errorPayload ? JSON.parse(row.errorPayload)?.message : null,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      downloadUrl,
      downloadZipUrl,
    });
  } catch (error) {
    return SessionService.handleSessionError(error);
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

    // Verify asset ownership
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const [row] = await db
      .select({ id: exportGenerations.id, status: exportGenerations.status })
      .from(exportGenerations)
      .where(and(
        eq(exportGenerations.id, exportIdNum),
        eq(exportGenerations.assetId, assetId),
      ))
      .limit(1);

    if (!row) return NextResponse.json({ error: 'EXPORT_NOT_FOUND' }, { status: 404 });
    if (row.status === 'generating') {
      return NextResponse.json({ error: 'EXPORT_IN_PROGRESS' }, { status: 409 });
    }

    await db
      .update(exportGenerations)
      .set({ status: 'deleted' })
      .where(eq(exportGenerations.id, exportIdNum));

    return NextResponse.json({ success: true });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
