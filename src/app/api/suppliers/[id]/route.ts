import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { suppliers, documentSuppliers, assetFiles, assets, supplierReviewItems } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { normalizeName } from '@/services/suppliers/supplier-service';

// GET /api/suppliers/[id] — full detail including iban (for drawer)
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
    const supplierId = parseInt(id);
    if (isNaN(supplierId)) return apiError(400, 'INVALID_INPUT', 'Invalid supplier id');

    const [supplier] = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.accountId, accountId)))
      .limit(1);

    if (!supplier) return apiError(404, 'NOT_FOUND', 'Supplier not found');

    // Fetch linked documents
    const linkedDocs = await db
      .select({
        documentId: documentSuppliers.documentId,
        role: documentSuppliers.role,
        isConfirmed: documentSuppliers.isConfirmed,
        filename: assetFiles.originalFilename,
        documentType: assetFiles.documentType,
        documentDate: assetFiles.documentDate,
        assetId: assetFiles.assetId,
        assetName: assets.name,
      })
      .from(documentSuppliers)
      .innerJoin(assetFiles, eq(assetFiles.id, documentSuppliers.documentId))
      .leftJoin(assets, eq(assets.id, assetFiles.assetId))
      .where(eq(documentSuppliers.supplierId, supplierId))
      .limit(50);

    // Fetch open review items
    const reviewItems = await db
      .select({
        id: supplierReviewItems.id,
        publicId: supplierReviewItems.publicId,
        itemType: supplierReviewItems.itemType,
        conflictingField: supplierReviewItems.conflictingField,
        currentValue: supplierReviewItems.currentValue,
        detectedValue: supplierReviewItems.detectedValue,
        detectedName: supplierReviewItems.detectedName,
        documentId: supplierReviewItems.documentId,
        status: supplierReviewItems.status,
      })
      .from(supplierReviewItems)
      .where(and(
        eq(supplierReviewItems.supplierId, supplierId),
        eq(supplierReviewItems.status, 'open'),
      ))
      .limit(20);

    // Full supplier data including iban (drawer only)
    return NextResponse.json({ supplier, documents: linkedDocs, reviewItems });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}

// PATCH /api/suppliers/[id] — update
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const supplierId = parseInt(id);
    if (isNaN(supplierId)) return apiError(400, 'INVALID_INPUT', 'Invalid supplier id');

    const [existing] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.accountId, accountId)))
      .limit(1);

    if (!existing) return apiError(404, 'NOT_FOUND', 'Supplier not found');

    const body = await request.json();
    const allowedFields = ['name', 'email', 'phone', 'website', 'addressLine1', 'addressLine2',
      'postalCode', 'city', 'country', 'siren', 'siret', 'vatNumber', 'iban', 'ibanHolderName'];

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const field of allowedFields) {
      if (field in body) {
        updates[field] = body[field]?.trim?.() || null;
      }
    }

    if (body.name) {
      updates.normalizedName = normalizeName(body.name.trim());
    }

    const [updated] = await db.update(suppliers)
      .set(updates as Partial<typeof suppliers.$inferInsert>)
      .where(eq(suppliers.id, supplierId))
      .returning();

    return NextResponse.json({ supplier: updated });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
