import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, assetFiles, substructures, equipments } from '@/db/schema';
import { eq, and, isNull, inArray, or } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

  const assetId = parseInt(params.id, 10);
  if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

  // Verify asset belongs to account
  const [asset] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
    .limit(1);

  if (!asset) return apiError(404, 'NOT_FOUND', 'Asset not found');

  // Get substructure and equipment ids for indirect document ownership
  const subs = await db
    .select({ id: substructures.id })
    .from(substructures)
    .where(eq(substructures.assetId, assetId));

  const equips = await db
    .select({ id: equipments.id })
    .from(equipments)
    .where(and(eq(equipments.assetId, assetId), isNull(equipments.archivedAt)));

  const subIds = subs.map(s => s.id);
  const equipIds = equips.map(e => e.id);

  const scopeCondition = subIds.length > 0 && equipIds.length > 0
    ? or(
        eq(assetFiles.assetId, assetId),
        inArray(assetFiles.substructureId, subIds),
        inArray(assetFiles.equipmentId, equipIds),
      )
    : subIds.length > 0
    ? or(eq(assetFiles.assetId, assetId), inArray(assetFiles.substructureId, subIds))
    : equipIds.length > 0
    ? or(eq(assetFiles.assetId, assetId), inArray(assetFiles.equipmentId, equipIds))
    : eq(assetFiles.assetId, assetId);

  const items = await db
    .select({
      id: assetFiles.id,
      retainedFunctionCode: assetFiles.retainedFunctionCode,
      documentType: assetFiles.documentType,
      cilRubricCodes: assetFiles.cilRubricCodes,
      documentDate: assetFiles.documentDate,
      retainedTitle: assetFiles.retainedTitle,
      originalFilename: assetFiles.originalFilename,
    })
    .from(assetFiles)
    .where(and(
      scopeCondition!,
      isNull(assetFiles.deletedAt),
      eq(assetFiles.isDraft, false),
      eq(assetFiles.isIgnored, false),
      or(
        eq(assetFiles.uploadStatus, 'COMPLETED'),
        isNull(assetFiles.uploadStatus),
      ),
    ));

  return NextResponse.json({ items });
}
