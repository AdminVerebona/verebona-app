/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * GEN-001 / SEC-003 : le BO consulte un bien pour diagnostic, il ne le modifie ni ne le supprime.
 * Les handlers PATCH et DELETE ont été supprimés (ainsi que `transfer`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, users, assetFiles, events, deadlines, assetTypes, assetTransmissions } from '@/db/schema';
import { eq, and, sql, isNull, desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate and authorize admin
    await requireAdmin(request);

    const { id } = await params;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid asset ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const assetId = parseInt(id);

    const assetResult = await db
      .select({
        id: assets.id,
        userId: assets.userId,
        accountId: assets.accountId,
        category: assets.category,
        subtype: assets.subtype,
        name: assets.name,
        status: assets.status,
        archivedReason: assets.archivedReason,
        createdAt: assets.createdAt,
        updatedAt: assets.updatedAt,
        deletedAt: assets.deletedAt,
        categoryLabel: assetTypes.label,
        categoryCode: assetTypes.code,
        ownerId: users.id,
        ownerEmail: users.email,
        ownerFirstName: users.firstName,
        ownerLastName: users.lastName,
      })
      .from(assets)
      .leftJoin(users, eq(assets.userId, users.id))
      .leftJoin(assetTypes, eq(assets.category, assetTypes.code))
      .where(eq(assets.id, assetId))
      .limit(1);

    if (assetResult.length === 0) {
      return NextResponse.json(
        { error: 'Asset not found', code: 'ASSET_NOT_FOUND' },
        { status: 404 }
      );
    }

    const row = assetResult[0];

    // Fetch transmission history for this asset
    const transmissions = await db
      .select({
        id: assetTransmissions.id,
        status: assetTransmissions.status,
        recipientEmail: assetTransmissions.recipientEmail,
        keepActiveAfter: assetTransmissions.keepActiveAfter,
        sentAt: assetTransmissions.sentAt,
        acceptedAt: assetTransmissions.acceptedAt,
        refusedAt: assetTransmissions.refusedAt,
        cancelledAt: assetTransmissions.cancelledAt,
        duplicatedAssetId: assetTransmissions.duplicatedAssetId,
      })
      .from(assetTransmissions)
      .where(eq(assetTransmissions.assetId, assetId))
      .orderBy(desc(assetTransmissions.createdAt));

    const asset = {
      id: row.id,
      userId: row.userId,
      accountId: row.accountId,
      category: row.category,
      categoryLabel: row.categoryLabel ?? row.category ?? 'Type inconnu',
      subtype: row.subtype,
      name: row.name,
      status: row.status,
      archivedReason: row.archivedReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      transmissions,
      owner: {
        id: row.ownerId ?? 0,
        email: row.ownerEmail ?? 'utilisateur.supprime@inconnu.com',
        firstName: row.ownerFirstName ?? 'Utilisateur',
        lastName: row.ownerLastName ?? 'supprimé',
      },
    };

    // Count documents (files) - only COMPLETED and not deleted
    const documentsCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.assetId, assetId),
          eq(assetFiles.uploadStatus, 'COMPLETED'),
          isNull(assetFiles.deletedAt)
        )
      );

    const eventsCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(eq(events.assetId, assetId));

    const deadlinesCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deadlines)
      .where(eq(deadlines.assetId, assetId));

    const documentsCount = Number(documentsCountResult[0]?.count || 0);
    const eventsCount = Number(eventsCountResult[0]?.count || 0);
    const deadlinesCount = Number(deadlinesCountResult[0]?.count || 0);

    return NextResponse.json({
      asset,
      stats: {
        documentsCount,
        eventsCount,
        deadlinesCount,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg === 'INSUFFICIENT_PERMISSIONS') return NextResponse.json({ error: msg }, { status: 403 });
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(msg)) return NextResponse.json({ error: msg }, { status: 401 });
    console.error('GET admin asset details error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + msg },
      { status: 500 }
    );
  }
}

