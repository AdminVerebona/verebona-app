import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, assets, documentTypes } from '@/db/schema';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';
import { equipmentInAccount } from '@/services/security/account-ownership';

// GET /api/equipments/[id]/documents — documents linked to an equipment
// Lot 71A (point B) : colonne historique `equipment_id` OU lien N-N actif
// (`document_asset_links`, cible équipement, rôle PRIMARY / SECONDARY —
// rapprochement automatique, plusieurs équipements possibles). Chaque document
// une seule fois (condition d'appartenance, pas de jointure).
// Lot 49 (SEC-06) : équipement du compte vérifié AVANT la lecture ; documents
// et bien joint bornés au compte.
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
    if (!(await equipmentInAccount(accountId, equipmentId))) return apiError(404, 'NOT_FOUND', 'Equipment not found');

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
      .leftJoin(assets, and(eq(assetFiles.assetId, assets.id), eq(assets.accountId, accountId)))
      .where(
        and(
          eq(assetFiles.accountId, accountId),
          or(
            eq(assetFiles.equipmentId, equipmentId),
            sql`${assetFiles.id} IN (SELECT l.file_id FROM document_asset_links l
                                     WHERE l.account_id = ${accountId} AND l.equipment_id = ${equipmentId}
                                       AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY'))`,
          ),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt)
        )
      );

    const documents = rows.map(doc => ({
      id: doc.id,
      publicId: doc.publicId,
      title: displayDocumentTitle(doc, 'Document'),
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
