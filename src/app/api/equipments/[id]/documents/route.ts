import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, assets, documentTypes } from '@/db/schema';
import { eq, and, isNull, or } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

// GET /api/equipments/[id]/documents — documents linked to an equipment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const equipmentId = parseInt(id);
    if (isNaN(equipmentId)) return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');

    // Load document type labels
    const allDocTypes = await db.select({ code: documentTypes.code, label: documentTypes.label }).from(documentTypes);
    const typeLabels: Record<string, string> = {};
    for (const dt of allDocTypes) typeLabels[dt.code] = dt.label;

    const rows = await db
      .select({
        id: assetFiles.id,
        publicId: assetFiles.publicId,
        fileName: assetFiles.filename,
        originalFilename: assetFiles.originalFilename,
        retainedTitle: assetFiles.retainedTitle,
        documentType: assetFiles.documentType,
        retainedFunctionCode: assetFiles.retainedFunctionCode,
        documentDate: assetFiles.documentDate,
        mimeType: assetFiles.mimeType,
        assetId: assetFiles.assetId,
        assetName: assets.name,
        webLinkUrl: assetFiles.webLinkUrl,
        createdAt: assetFiles.createdAt,
      })
      .from(assetFiles)
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .where(
        and(
          eq(assetFiles.accountId, accountId),
          eq(assetFiles.equipmentId, equipmentId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt)
        )
      );

    const documents = rows.map(doc => ({
      id: doc.id,
      publicId: doc.publicId,
      title: doc.retainedTitle ?? doc.originalFilename ?? doc.fileName ?? 'Document',
      documentType: doc.retainedFunctionCode ?? doc.documentType,
      documentTypeLabel: doc.retainedFunctionCode
        ? (typeLabels[doc.retainedFunctionCode] ?? doc.retainedFunctionCode)
        : doc.documentType
          ? (typeLabels[doc.documentType] ?? doc.documentType)
          : null,
      documentDate: doc.documentDate,
      mimeType: doc.mimeType,
      assetId: doc.assetId,
      assetName: doc.assetName,
      webLinkUrl: doc.webLinkUrl,
      createdAt: doc.createdAt,
    }));

    return NextResponse.json({ documents });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
