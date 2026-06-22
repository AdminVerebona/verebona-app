import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, users, accounts as accountsTable, substructures, equipments, assetTransmissions } from '@/db/schema';
import { eq, like, and, lt, desc, count, isNull, notInArray } from 'drizzle-orm';
import { parsePaginationParams, buildPaginationResponse, getCursorId } from '@/lib/pagination';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { getFeatureFlags, canCreateAsset } from '@/lib/feature-flags';
import { isValidObjectCategory } from '@/types/domain';
import type { PlanType } from '@/types/domain';

const VALID_CATEGORIES = ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT', 'AUTRE'];
const VALID_STATUSES = ['EN_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'VENDU', 'DETRUIT', 'INACTIF', 'ARCHIVED', 'TRANSMIS'];
const VALID_OBJECT_CATEGORIES = ['OBJECT_CATEGORY_TECH', 'OBJECT_CATEGORY_SPORT', 'OBJECT_CATEGORY_HOME'];

export async function GET(request: NextRequest) {
  try {
    // Auth check with proper error handling
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    // Single asset by ID
    if (id) {
      if (!id || isNaN(parseInt(id))) {
        return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
      }

      const asset = await db
        .select()
        .from(assets)
        .where(eq(assets.id, parseInt(id)))
        .limit(1);

      if (asset.length === 0) {
        return apiError(404, 'NOT_FOUND', 'Asset not found');
      }

      const assetData = asset[0];

      // Check ownership via accountId
      if (!session.currentAccountId) {
        return apiError(401, 'UNAUTHORIZED', 'No account selected');
      }
      if (assetData.accountId !== session.currentAccountId) {
        return apiError(403, 'FORBIDDEN', 'Access denied');
      }

      // Fetch substructures and equipments (select only real DB columns)
      const assetSubstructures = await db.$client<{ id: number; name: string; orderIndex: number; assetId: number }[]>`
        SELECT id, name, order_index AS "orderIndex", asset_id AS "assetId"
        FROM substructures WHERE asset_id = ${assetData.id}
        ORDER BY order_index ASC
      `;

      const assetEquipments = await db.$client<{ id: number; name: string; type: string | null; status: string; substructureId: number | null; archivedAt: string | null }[]>`
        SELECT id, name, type, status, substructure_id AS "substructureId", archived_at AS "archivedAt"
        FROM equipments WHERE asset_id = ${assetData.id} AND archived_at IS NULL
      `;

      return NextResponse.json({
        ...assetData,
        substructures: assetSubstructures,
        equipments: assetEquipments
      }, { status: 200 });
    }

    // List assets with cursor-based pagination
    const { limit, cursor } = parsePaginationParams(searchParams);
    const category = searchParams.get('category');
    const status = searchParams.get('status');
    const search = searchParams.get('search');

    const conditions = [];

    const cursorId = getCursorId(cursor);
    if (cursorId !== null) {
      conditions.push(lt(assets.id, cursorId));
    }

      // Force accountId to match session (security)
      if (!session.currentAccountId) {
        return apiError(401, 'UNAUTHORIZED', 'Aucun compte associé à cette session. Reconnectez-vous.');
      }
      conditions.push(eq(assets.accountId, session.currentAccountId));

    if (category) {
      if (VALID_CATEGORIES.includes(category)) {
        conditions.push(eq(assets.category, category));
      }
    }

    const includeArchived = searchParams.get('includeArchived') === 'true';

    if (status) {
      if (VALID_STATUSES.includes(status)) {
        conditions.push(eq(assets.status, status));
      }
    } else if (!includeArchived) {
      // By default, exclude archived/transmitted assets from list (they don't appear in dropdowns)
      conditions.push(notInArray(assets.status, ['ARCHIVED', 'TRANSMIS']));
    }

    // Also exclude soft-deleted
    conditions.push(isNull(assets.deletedAt));

    if (search) {
      conditions.push(like(assets.name, `%${search}%`));
    }

    let query = db.select().from(assets).$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    // Fetch limit + 1 to detect if there are more pages
    const results = await query
      .orderBy(desc(assets.id))
      .limit(limit + 1);

    const paginatedResponse = buildPaginationResponse(results, limit);

    return NextResponse.json(paginatedResponse, {
      status: 200,
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('GET error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function POST(request: NextRequest) {
  try {
    // Auth check with proper error handling
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

      if (!session) {
        return apiError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      if (!session.currentAccountId) {
        return apiError(401, 'UNAUTHORIZED', 'No account selected');
      }

      const [account] = await db
        .select({
          id: accountsTable.id,
          planType: accountsTable.planType,
          featureFlags: accountsTable.featureFlags,
        })
        .from(accountsTable)
        .where(eq(accountsTable.id, session.currentAccountId))
        .limit(1);

      if (!account) {
        return apiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      }

      // Récupérer les feature flags de l'utilisateur (en priorité) ou du compte
      const features = getFeatureFlags(account.planType as PlanType, account.featureFlags);

      // Compter le nombre de biens actuels du compte
      const [assetCountResult] = await db
        .select({ count: count() })
        .from(assets)
        .where(eq(assets.accountId, session.currentAccountId));

    const currentAssetCount = assetCountResult?.count || 0;

    // SPECS V1: Vérifier la limite de biens
    if (!canCreateAsset(currentAssetCount, features)) {
      return apiError(
        403,
        'ASSET_LIMIT_REACHED',
        `Vous avez atteint la limite de ${features.max_assets} biens du plan gratuit. Supprimez un bien ou passez au plan Premium pour gérer tous vos biens.`,
        {
          current_count: currentAssetCount,
          max_assets: features.max_assets,
          plan_type: account.planType,
        }
      );
    }

    const body = await request.json();
    const { 
      category, 
      subtype, 
      name, 
      purchaseDate, 
      purchasePriceCents, 
      status, 
      notes, 
      thumbnailUrl,
      objectCategory,
      objectDetails,
      purchaseLocation,
    } = body;

      // Use accountId from session
      const accountIdInt = session.currentAccountId;

      if (!category) {
      return apiError(400, 'MISSING_FIELD', 'category is required');
    }

    if (!name) {
      return apiError(400, 'MISSING_FIELD', 'name is required');
    }

    // Validate name is not empty
    if (!name.trim()) {
      return apiError(400, 'INVALID_INPUT', 'name cannot be empty');
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return apiError(400, 'INVALID_INPUT', `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }

    // Validation for OBJECT type
    if (category === 'OBJECT') {
      if (!objectCategory) {
        return apiError(400, 'MISSING_FIELD', 'objectCategory is required for OBJECT type');
      }
      if (!isValidObjectCategory(objectCategory)) {
        return apiError(400, 'INVALID_INPUT', `objectCategory must be one of: ${VALID_OBJECT_CATEGORIES.join(', ')}`);
      }
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return apiError(400, 'INVALID_INPUT', `status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    if (purchasePriceCents !== undefined && purchasePriceCents !== null) {
      const priceInt = parseInt(purchasePriceCents);
      if (isNaN(priceInt) || priceInt < 0) {
        return apiError(400, 'INVALID_INPUT', 'purchasePriceCents must be a positive integer');
      }
    }

    // Sanitize inputs
    const sanitizedName = name.trim();

      // Prepare insert data
        const now = new Date();
        const insertData: any = {
          userId: session.userId,
          accountId: accountIdInt,
          category,
          name: sanitizedName,
          status: status || 'EN_SERVICE',
          createdAt: now,
          updatedAt: now,
        };

    if (subtype) insertData.subtype = subtype;
    if (purchaseDate) insertData.purchaseDate = purchaseDate;
    if (purchasePriceCents !== undefined && purchasePriceCents !== null) {
      insertData.purchasePriceCents = parseInt(purchasePriceCents);
    }
    if (notes) insertData.notes = notes;
    if (thumbnailUrl) insertData.thumbnailUrl = thumbnailUrl;
    if (purchaseLocation) insertData.purchaseLocation = purchaseLocation;

    // Object-specific fields
    if (category === 'OBJECT') {
      insertData.objectCategory = objectCategory;
      if (objectDetails) {
        insertData.objectDetails = typeof objectDetails === 'string' 
          ? objectDetails 
          : JSON.stringify(objectDetails);
      }
    }

    const newAsset = await db.insert(assets).values(insertData).returning();

    return NextResponse.json(newAsset[0], { status: 201 });
  } catch (error) {
    console.error('POST error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function PUT(request: NextRequest) {
  try {
    // Auth check with proper error handling
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    const assetId = parseInt(id);

    const existingAsset = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

      if (existingAsset.length === 0) {
        return apiError(404, 'NOT_FOUND', 'Asset not found');
      }

      // Check ownership via accountId
      if (!session.currentAccountId) {
        return apiError(401, 'UNAUTHORIZED', 'No account selected');
      }
      if (existingAsset[0].accountId !== session.currentAccountId) {
        return apiError(403, 'FORBIDDEN', 'Access denied');
      }

      const body = await request.json();
    const { 
      category, 
      subtype, 
      name, 
      purchaseDate, 
      purchasePriceCents, 
      status, 
      notes, 
      thumbnailUrl,
      // New premium fields
      generalCondition,
      estimatedValueCents,
      mileageOrHours,
      purchaseLocation,
      warrantyEndDate,
      lastMaintenanceDate,
      dimensions,
      engineInfo,
      equipmentList,
      keyCharacteristics,
      // Object-specific fields
      objectCategory,
      objectDetails,
    } = body;

    // Determine the final category
    const finalCategory = category !== undefined ? category : existingAsset[0].category;

    if (category && !VALID_CATEGORIES.includes(category)) {
      return apiError(400, 'INVALID_INPUT', `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }

    // Validation for OBJECT type
    if (finalCategory === 'OBJECT') {
      const finalObjectCategory = objectCategory !== undefined ? objectCategory : existingAsset[0].objectCategory;
      if (!finalObjectCategory) {
        return apiError(400, 'MISSING_FIELD', 'objectCategory is required for OBJECT type');
      }
      if (objectCategory !== undefined && !isValidObjectCategory(objectCategory)) {
        return apiError(400, 'INVALID_INPUT', `objectCategory must be one of: ${VALID_OBJECT_CATEGORIES.join(', ')}`);
      }
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return apiError(400, 'INVALID_INPUT', `status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    if (purchasePriceCents !== undefined && purchasePriceCents !== null) {
      const priceInt = parseInt(purchasePriceCents);
      if (isNaN(priceInt) || priceInt < 0) {
        return apiError(400, 'INVALID_INPUT', 'purchasePriceCents must be a positive integer');
      }
    }

    if (estimatedValueCents !== undefined && estimatedValueCents !== null) {
      const valueInt = parseInt(estimatedValueCents);
      if (isNaN(valueInt) || valueInt < 0) {
        return apiError(400, 'INVALID_INPUT', 'estimatedValueCents must be a positive integer');
      }
    }

    if (mileageOrHours !== undefined && mileageOrHours !== null) {
      const mileageInt = parseInt(mileageOrHours);
      if (isNaN(mileageInt) || mileageInt < 0) {
        return apiError(400, 'INVALID_INPUT', 'mileageOrHours must be a positive integer');
      }
    }

    // Prepare update data
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (category !== undefined) updateData.category = category;
    if (subtype !== undefined) updateData.subtype = subtype;
    if (name !== undefined) updateData.name = name.trim();
    if (purchaseDate !== undefined) updateData.purchaseDate = purchaseDate;
    if (purchasePriceCents !== undefined) {
      updateData.purchasePriceCents = purchasePriceCents !== null ? parseInt(purchasePriceCents) : null;
    }
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (thumbnailUrl !== undefined) updateData.thumbnailUrl = thumbnailUrl;
    
    // New premium fields
    if (generalCondition !== undefined) updateData.generalCondition = generalCondition;
    if (estimatedValueCents !== undefined) {
      updateData.estimatedValueCents = estimatedValueCents !== null ? parseInt(estimatedValueCents) : null;
    }
    if (mileageOrHours !== undefined) {
      updateData.mileageOrHours = mileageOrHours !== null ? parseInt(mileageOrHours) : null;
    }
    if (purchaseLocation !== undefined) updateData.purchaseLocation = purchaseLocation;
    if (warrantyEndDate !== undefined) updateData.warrantyEndDate = warrantyEndDate;
    if (lastMaintenanceDate !== undefined) updateData.lastMaintenanceDate = lastMaintenanceDate;
    if (dimensions !== undefined) updateData.dimensions = dimensions;
    if (engineInfo !== undefined) updateData.engineInfo = engineInfo;
    if (equipmentList !== undefined) updateData.equipmentList = equipmentList;
    if (keyCharacteristics !== undefined) updateData.keyCharacteristics = keyCharacteristics;

    // Object-specific fields
    if (objectCategory !== undefined) updateData.objectCategory = objectCategory;
    if (objectDetails !== undefined) {
      updateData.objectDetails = objectDetails !== null 
        ? (typeof objectDetails === 'string' ? objectDetails : JSON.stringify(objectDetails))
        : null;
    }

    const updatedAsset = await db
      .update(assets)
      .set(updateData)
      .where(eq(assets.id, assetId))
      .returning();

    return NextResponse.json(updatedAsset[0], { status: 200 });
  } catch (error) {
    console.error('PUT error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Auth check with proper error handling
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const keepDocuments = searchParams.get('keepDocuments') === 'true';
    const keepEvents = searchParams.get('keepEvents') === 'true';

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    const assetId = parseInt(id);

    // Check if asset exists
    const existingAsset = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

      if (existingAsset.length === 0) {
        return NextResponse.json(
          {
            message: 'Asset already deleted or does not exist',
            assetId: assetId,
          },
          { status: 200 }
        );
      }

      // Check ownership via accountId
      if (!session.currentAccountId) {
        return apiError(401, 'UNAUTHORIZED', 'No account selected');
      }
      if (existingAsset[0].accountId !== session.currentAccountId) {
        return apiError(403, 'FORBIDDEN', 'Access denied');
      }

    // If NOT keeping documents, delete them (soft delete via deletedAt)
    if (!keepDocuments) {
      // Would need to handle document deletion here based on your schema
      // For now: documents may be handled separately or soft-deleted
    }

    // If NOT keeping events, delete them (soft delete via deletedAt)
    if (!keepEvents) {
      // Would need to handle event deletion here based on your schema
      // For now: events may be handled separately or soft-deleted
    }

    // Null out FK reference from transmissions before deleting
    await db
      .update(assetTransmissions)
      .set({ duplicatedAssetId: null })
      .where(eq(assetTransmissions.duplicatedAssetId, assetId));

    const deletedAsset = await db
      .delete(assets)
      .where(eq(assets.id, assetId))
      .returning();

    return NextResponse.json(
      {
        message: 'Asset deleted successfully',
        asset: deletedAsset[0],
        options: { keepDocuments, keepEvents }
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('DELETE error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + (error as Error).message);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }
    if (!session?.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');
    }
    const assetId = parseInt(id);

    const [existing] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!existing) return apiError(404, 'NOT_FOUND', 'Asset not found');

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return apiError(400, 'INVALID_INPUT', 'Invalid JSON body');
    }

    const updatePayload: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if ('status' in body) {
      if (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status)) {
        return apiError(400, 'INVALID_INPUT', `status must be one of: ${VALID_STATUSES.join(', ')}`);
      }
      updatePayload.status = body.status;
    }

    if ('name' in body) {
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return apiError(400, 'INVALID_INPUT', 'name cannot be empty');
      }
      updatePayload.name = (body.name as string).trim();
    }

    await db.update(assets).set(updatePayload as any).where(eq(assets.id, assetId));

    return NextResponse.json({ updated: true });
  } catch (error) {
    console.error('PATCH /api/assets error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
