import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { supplierReviewItems, suppliers, documentSuppliers } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

// POST /api/to-process/suppliers/[id]/resolve
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const reviewItemId = parseInt(id);
    if (isNaN(reviewItemId)) return apiError(400, 'INVALID_INPUT', 'Invalid review item id');

    const [item] = await db
      .select()
      .from(supplierReviewItems)
      .where(and(
        eq(supplierReviewItems.id, reviewItemId),
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
      ))
      .limit(1);

    if (!item) return apiError(404, 'NOT_FOUND', 'Review item not found');

    const body = await request.json();
    // resolution: 'merged' | 'created_new' | 'ignored' | 'modified' | 'keep_current' | 'use_detected'
    const { resolution, targetSupplierId } = body;

    if (!resolution) return apiError(400, 'INVALID_INPUT', 'resolution is required');

    // Conflit de coordonnées : l'utilisateur choisit la valeur à garder
    if (resolution === 'use_detected' && item.conflictingField && item.detectedValue && item.supplierId) {
      const SUPPLIER_FIELD_MAP: Record<string, string> = {
        email: 'email', phone: 'phone', website: 'website',
        addressLine1: 'address_line1', addressLine2: 'address_line2',
        postalCode: 'postal_code', city: 'city', country: 'country',
        siren: 'siren', siret: 'siret', vatNumber: 'vat_number',
        ibanHolderName: 'iban_holder_name',
      };
      const colName = SUPPLIER_FIELD_MAP[item.conflictingField] ?? item.conflictingField;
      // Drizzle dynamic update via raw sql
      await db.execute(
        sql`UPDATE suppliers SET ${sql.raw(colName)} = ${item.detectedValue}, updated_at = NOW() WHERE id = ${item.supplierId}`
      );
    }

    if (resolution === 'merged' && targetSupplierId && item.supplierId && item.supplierId !== targetSupplierId) {
      // Migrate document links from item.supplierId to targetSupplierId
      const docLinks = await db
        .select({ documentId: documentSuppliers.documentId })
        .from(documentSuppliers)
        .where(eq(documentSuppliers.supplierId, item.supplierId));

      for (const { documentId } of docLinks) {
        const existingTarget = await db
          .select()
          .from(documentSuppliers)
          .where(and(
            eq(documentSuppliers.documentId, documentId),
            eq(documentSuppliers.supplierId, targetSupplierId),
          ))
          .limit(1);

        if (existingTarget.length === 0) {
          await db.insert(documentSuppliers).values({
            documentId,
            supplierId: targetSupplierId,
            isConfirmed: true,
          });
        }
        await db.delete(documentSuppliers).where(and(
          eq(documentSuppliers.documentId, documentId),
          eq(documentSuppliers.supplierId, item.supplierId),
        ));
      }

      // Archive old supplier
      await db.update(suppliers)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(suppliers.id, item.supplierId));
    }

    await db.update(supplierReviewItems)
      .set({
        status: 'resolved',
        resolution,
        resolvedByUserId: session.userId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(supplierReviewItems.id, reviewItemId));

    return NextResponse.json({ success: true });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
