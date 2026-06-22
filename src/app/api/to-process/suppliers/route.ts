import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { supplierReviewItems, suppliers, assetFiles, accounts } from '@/db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { serverCacheGet, serverCacheSet } from '@/lib/server-cache';

// GET /api/to-process/suppliers — list review items (iban excluded from cards)
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    // Cache serveur 30s pour les suppliers à traiter (rarement modifiés)
    const cacheKey = `to-process:suppliers:${accountId}`;
    const cached = serverCacheGet<object>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' },
      });
    }

    // Standard: no AI-generated review items, return empty
    const [account] = await db
      .select({ planType: accounts.planType })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account || account.planType === 'STANDARD') {
      return NextResponse.json({ reviewItems: [] });
    }

    const rows = await db
      .select({
        id: supplierReviewItems.id,
        publicId: supplierReviewItems.publicId,
        itemType: supplierReviewItems.itemType,
        status: supplierReviewItems.status,
        detectedName: supplierReviewItems.detectedName,
        conflictingField: supplierReviewItems.conflictingField,
        currentValue: supplierReviewItems.currentValue,
        detectedValue: supplierReviewItems.detectedValue,
        supplierId: supplierReviewItems.supplierId,
        supplierName: suppliers.name,
        documentId: supplierReviewItems.documentId,
        documentFilename: assetFiles.originalFilename,
        candidateSupplierIds: supplierReviewItems.candidateSupplierIds,
        createdAt: supplierReviewItems.createdAt,
      })
      .from(supplierReviewItems)
      .leftJoin(suppliers, eq(suppliers.id, supplierReviewItems.supplierId))
      .leftJoin(assetFiles, eq(assetFiles.id, supplierReviewItems.documentId))
      .where(and(
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
        isNotNull(supplierReviewItems.detectedValue),
      ))
      .limit(100);

    // Strip actual values for IBAN (security: never expose raw IBAN in API)
    const safeRows = rows.map(row => {
      if (row.conflictingField === 'iban') {
        return { ...row, currentValue: null, detectedValue: null };
      }
      return row;
    });

    const responseData = { reviewItems: safeRows };
    serverCacheSet(cacheKey, responseData, 30_000);

    return NextResponse.json(responseData, {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' },
    });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
