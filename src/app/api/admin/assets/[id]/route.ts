import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, users, assetFiles, events, deadlines, adminAuditLog, assetTypes, assetTransmissions } from '@/db/schema';
import { eq, and, sql, isNull, desc } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(request);

    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Session required', code: 'SESSION_REQUIRED' }, { status: 401 });
    }

    const { id } = await params;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ error: 'Valid asset ID is required', code: 'INVALID_ID' }, { status: 400 });
    }

    const assetId = parseInt(id);
    const body = await request.json();
    const { status, archivedReason } = body;

    const validStatuses = ['EN_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF', 'VENDU', 'DETRUIT', 'ARCHIVED', 'TRANSMIS'];
    if (!status || !validStatuses.includes(status)) {
      return NextResponse.json({ error: 'Invalid status', code: 'INVALID_STATUS' }, { status: 400 });
    }

    const existing = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (existing.length === 0) {
      return NextResponse.json({ error: 'Asset not found', code: 'ASSET_NOT_FOUND' }, { status: 404 });
    }

    await db.update(assets).set({
      status,
      archivedReason: status === 'ARCHIVED' ? (archivedReason ?? 'user') : null,
      updatedAt: new Date(),
    }).where(eq(assets.id, assetId));

    try {
      await db.insert(adminAuditLog).values({
        timestamp: new Date(),
        adminUserId: session.userId,
        adminEmail: session.email,
        actionType: 'ASSET_STATUS_CHANGE',
        targetType: 'ASSET',
        targetId: assetId,
        details: JSON.stringify({
          assetName: existing[0].name,
          previousStatus: existing[0].status,
          newStatus: status,
        }),
      });
    } catch (auditErr) {
      console.error('PATCH admin asset audit log error (non-fatal):', auditErr);
    }

    return NextResponse.json({ success: true, status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg === 'INSUFFICIENT_PERMISSIONS') return NextResponse.json({ error: msg }, { status: 403 });
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(msg)) return NextResponse.json({ error: msg }, { status: 401 });
    console.error('PATCH admin asset error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + msg },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate and authorize admin
    await requireAdmin(request);

    // Get session for audit log
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json(
        { error: 'Session required', code: 'SESSION_REQUIRED' },
        { status: 401 }
      );
    }

    const { id } = await params;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid asset ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const assetId = parseInt(id);

    const body = await request.json();
    const { confirmId } = body;

    if (!confirmId || confirmId !== assetId) {
      return NextResponse.json(
        { error: 'Confirmation ID must match asset ID for safety', code: 'CONFIRM_ID_MISMATCH' },
        { status: 400 }
      );
    }

    const adminUserId = session.userId;
    const adminEmail = session.email;

    const assetToDelete = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

    if (assetToDelete.length === 0) {
      return NextResponse.json(
        { error: 'Asset not found', code: 'ASSET_NOT_FOUND' },
        { status: 404 }
      );
    }

    const asset = assetToDelete[0];

    // Soft delete files
    const now = new Date();
    const deletedFiles = await db
      .update(assetFiles)
      .set({
        deletedAt: now,
        updatedAt: now
      })
      .where(
        and(
          eq(assetFiles.assetId, assetId),
          isNull(assetFiles.deletedAt)
        )
      )
      .returning();

    const deletedEvents = await db
      .delete(events)
      .where(eq(events.assetId, assetId))
      .returning();

    const deletedDeadlines = await db
      .delete(deadlines)
      .where(eq(deadlines.assetId, assetId))
      .returning();

    // Null out FK references from transmissions before hard delete
    await db
      .update(assetTransmissions)
      .set({ duplicatedAssetId: null })
      .where(eq(assetTransmissions.duplicatedAssetId, assetId));

    const deletedAsset = await db
      .delete(assets)
      .where(eq(assets.id, assetId))
      .returning();

    const auditDetails = {
      assetName: asset.name,
      assetCategory: asset.category,
      cascadeDeleted: {
        filesCount: deletedFiles.length,
        eventsCount: deletedEvents.length,
        deadlinesCount: deletedDeadlines.length,
      },
    };

    try {
      await db.insert(adminAuditLog).values({
        timestamp: new Date(),
        adminUserId,
        adminEmail,
        actionType: 'ASSET_DELETE',
        targetType: 'ASSET',
        targetId: assetId,
        details: JSON.stringify(auditDetails),
      });
    } catch (auditErr) {
      console.error('DELETE admin asset audit log error (non-fatal):', auditErr);
    }

    return NextResponse.json({
      message: 'Asset and all related records deleted successfully',
      deletedAsset: deletedAsset[0],
      cascadeDeleted: {
        files: deletedFiles.length,
        events: deletedEvents.length,
        deadlines: deletedDeadlines.length,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg === 'INSUFFICIENT_PERMISSIONS') return NextResponse.json({ error: msg }, { status: 403 });
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(msg)) return NextResponse.json({ error: msg }, { status: 401 });
    console.error('DELETE admin asset error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + msg },
      { status: 500 }
    );
  }
}