import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentSuppliers, assetFiles, suppliers } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

// PUT /api/documents/[id]/supplier — associate a supplier to a document
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const documentId = parseInt(id);
    if (isNaN(documentId)) return apiError(400, 'INVALID_INPUT', 'Invalid document id');

    const [doc] = await db
      .select({ id: assetFiles.id, accountId: assetFiles.accountId })
      .from(assetFiles)
      .where(eq(assetFiles.id, documentId))
      .limit(1);

    if (!doc || doc.accountId !== accountId) return apiError(404, 'NOT_FOUND', 'Document not found');

    const body = await request.json();
    const { supplierId } = body;

    if (!supplierId) return apiError(400, 'INVALID_INPUT', 'supplierId is required');

    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.accountId, accountId)))
      .limit(1);

    if (!supplier) return apiError(404, 'NOT_FOUND', 'Supplier not found');

    // Upsert document_suppliers
    const existing = await db
      .select()
      .from(documentSuppliers)
      .where(and(
        eq(documentSuppliers.documentId, documentId),
        eq(documentSuppliers.supplierId, supplierId),
      ))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(documentSuppliers).values({
        documentId,
        supplierId,
        isConfirmed: true,
      });
    } else {
      await db.update(documentSuppliers)
        .set({ isConfirmed: true })
        .where(and(
          eq(documentSuppliers.documentId, documentId),
          eq(documentSuppliers.supplierId, supplierId),
        ));
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}

// DELETE /api/documents/[id]/supplier — dissociate a supplier from a document
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const documentId = parseInt(id);
    if (isNaN(documentId)) return apiError(400, 'INVALID_INPUT', 'Invalid document id');

    const [doc] = await db
      .select({ id: assetFiles.id, accountId: assetFiles.accountId })
      .from(assetFiles)
      .where(eq(assetFiles.id, documentId))
      .limit(1);

    if (!doc || doc.accountId !== accountId) return apiError(404, 'NOT_FOUND', 'Document not found');

    const { supplierId } = await request.json();
    if (!supplierId) return apiError(400, 'INVALID_INPUT', 'supplierId is required');

    await db.delete(documentSuppliers).where(and(
      eq(documentSuppliers.documentId, documentId),
      eq(documentSuppliers.supplierId, supplierId),
    ));

    return NextResponse.json({ success: true });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
