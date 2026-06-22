import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { assetSupportsStructuralFeatures } from '@/types/domain';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);

    if (isNaN(assetId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID is required');
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Verify asset ownership
    const [assetRow] = await db.$client<{ id: number }[]>`
      SELECT id FROM assets WHERE id = ${assetId} AND account_id = ${session.currentAccountId} AND deleted_at IS NULL LIMIT 1
    `;

    if (!assetRow) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Raw query : on sélectionne uniquement les colonnes présentes en DB
    // (public_id et scope peuvent ne pas exister sur les anciens environnements)
    const results = await db.$client<{
      id: number;
      name: string;
      assetId: number;
      orderIndex: number;
      createdAt: string | null;
      updatedAt: string | null;
    }[]>`
      SELECT id, name, asset_id AS "assetId", order_index AS "orderIndex",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM substructures
      WHERE asset_id = ${assetId}
      ORDER BY order_index ASC
    `;

    return NextResponse.json(results);
  } catch (error) {
    console.error('GET substructures error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);

    if (isNaN(assetId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID is required');
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Verify asset ownership
    const [assetData] = await db.$client<{ id: number; category: string; subtype: string | null }[]>`
      SELECT id, category, subtype FROM assets WHERE id = ${assetId} AND account_id = ${session.currentAccountId} AND deleted_at IS NULL LIMIT 1
    `;

    if (!assetData) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Vérifier si le bien supporte les fonctionnalités structurelles
    if (!assetSupportsStructuralFeatures(assetData)) {
      return apiError(400, 'FORBIDDEN', 'Ce type de bien ne supporte pas la gestion des pièces');
    }

    const body = await request.json();
    const { name } = body;

    if (!name || !name.trim()) {
      return apiError(400, 'MISSING_FIELD', 'Name is required');
    }

    const now = new Date().toISOString();
    const [newSubstructure] = await db.$client<{ id: number; name: string; asset_id: number; order_index: number }[]>`
      INSERT INTO substructures (asset_id, name, order_index, scope, public_id, created_at, updated_at)
      VALUES (${assetId}, ${name.trim()}, 0, 'personal', gen_random_uuid(), ${now}, ${now})
      RETURNING id, name, asset_id, order_index
    `;

    return NextResponse.json({ id: newSubstructure.id, name: newSubstructure.name, assetId: newSubstructure.asset_id, orderIndex: newSubstructure.order_index }, { status: 201 });
  } catch (error) {
    console.error('POST substructure error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
