/**
 * PATCH /api/assets/[id]/exports/cil/resolutions
 * Marque un bloc CIL comme not_applicable ou unknown_confirmed
 * DELETE /api/assets/[id]/exports/cil/resolutions
 * Supprime la résolution d'un bloc (remet en statut calculé)
 *
 * Lot 75A : B6 ne peut pas être déclaré « Non applicable » quand des
 * équipements à incidence énergétique sont identifiés (règle partagée
 * `classifyCilEnergyEquipment`, même lecture que l'évaluation) : 409
 * `CIL_B6_ENERGY_EQUIPMENT_PRESENT`, rien n'est écrit. Une déclaration
 * antérieure devenue contradictoire n'est jamais supprimée ici : elle est
 * neutralisée dans l'état effectif (`evaluateCilB6`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { cilBlockResolutions } from '@/db/schema';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { eq, and } from 'drizzle-orm';
import {
  CIL_B6_NOT_APPLICABLE_REFUSED_CODE, cilB6EnergyEquipmentIds, cilB6NotApplicableRefusedMessage,
} from '@/services/exports/cil-preparation.service';
import { cilCatalogItem, cilItemNotApplicableAllowed } from '@/lib/cil/cil-catalog';

/**
 * Lot 111U — identifiants admis : blocs déclarables (§20 : B3 à B7, B9 —
 * même liste que la préparation) et DONNÉES du catalogue CIL autorisées
 * (`B4.gaz`, `B6.refroidissement`…). B1, B8 et toute autre valeur : 400.
 */
const CIL_BLOCKS_DECLARABLE = new Set(['B3', 'B4', 'B5', 'B6', 'B7', 'B9']);
const CIL_RESOLUTION_TARGET_INVALID = 'CIL_RESOLUTION_TARGET_INVALID';
const CIL_ITEM_DATA_PRESENT = 'CIL_ITEM_DATA_PRESENT';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    // Accès par compte (Duo compris).
    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const body = await request.json();
    const { blockId, resolution, justification } = body as {
      blockId: string;
      resolution: 'not_applicable' | 'unknown_confirmed';
      justification?: string;
    };

    if (!blockId || !resolution) {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }

    if (resolution !== 'not_applicable' && resolution !== 'unknown_confirmed') {
      return NextResponse.json({ error: 'INVALID_RESOLUTION' }, { status: 400 });
    }
    const isItem = blockId.includes('.');
    if (isItem ? !cilItemNotApplicableAllowed(blockId) || resolution !== 'not_applicable' : !CIL_BLOCKS_DECLARABLE.has(blockId)) {
      return NextResponse.json({ error: CIL_RESOLUTION_TARGET_INVALID, code: CIL_RESOLUTION_TARGET_INVALID }, { status: 400 });
    }
    // Une donnée déjà renseignée (ou partiellement) ne peut pas être déclarée non applicable.
    if (isItem) {
      const { getCilState } = await import('@/services/cil/state');
      const r = await getCilState({ id: assetId, accountId: asset.accountId });
      const it = r?.state.blocks.flatMap((b) => b.items).find((i) => i.id === blockId);
      if (it && (it.status === 'renseigne' || it.status === 'partiel')) {
        return NextResponse.json({
          error: CIL_ITEM_DATA_PRESENT, code: CIL_ITEM_DATA_PRESENT,
          message: `« ${cilCatalogItem(blockId)?.label ?? blockId} » est renseigné pour ce logement : il ne peut pas être déclaré non applicable.`,
        }, { status: 409 });
      }
    }

    if (blockId === 'B6' && resolution === 'not_applicable') {
      const ids = await cilB6EnergyEquipmentIds(assetId);
      if (ids.length > 0) {
        return NextResponse.json({
          error: CIL_B6_NOT_APPLICABLE_REFUSED_CODE,
          code: CIL_B6_NOT_APPLICABLE_REFUSED_CODE,
          message: cilB6NotApplicableRefusedMessage(ids.length),
          details: { energyEquipmentIds: ids },
        }, { status: 409 });
      }
    }

    // Upsert
    const existing = await db
      .select({ id: cilBlockResolutions.id })
      .from(cilBlockResolutions)
      .where(and(
        eq(cilBlockResolutions.assetId, assetId),
        eq(cilBlockResolutions.blockId, blockId),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(cilBlockResolutions)
        .set({ resolution, justification: justification ?? null, resolvedByUserId: session.userId, resolvedAt: new Date() })
        .where(and(
          eq(cilBlockResolutions.assetId, assetId),
          eq(cilBlockResolutions.blockId, blockId),
        ));
    } else {
      await db.insert(cilBlockResolutions).values({
        assetId,
        blockId,
        resolution,
        justification: justification ?? null,
        resolvedByUserId: session.userId,
        resolvedAt: new Date(),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[CIL resolutions PATCH]', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    // Accès par compte (Duo compris).
    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const blockId = searchParams.get('blockId');
    if (!blockId) return NextResponse.json({ error: 'MISSING_BLOCK_ID' }, { status: 400 });

    await db
      .delete(cilBlockResolutions)
      .where(and(
        eq(cilBlockResolutions.assetId, assetId),
        eq(cilBlockResolutions.blockId, blockId),
      ));

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[CIL resolutions DELETE]', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
