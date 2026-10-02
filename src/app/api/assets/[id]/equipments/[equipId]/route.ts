/**
 * PUT / DELETE d'un équipement d'un bien.
 *
 * ⚠️ RUPTURE (lot 18, CDC 15 T3-02) — `purchasePriceCents` et
 * `estimatedValueCents` étaient lus du corps mais JAMAIS écrits. Ils le sont
 * désormais (`equipments.purchase_price_cents`, `estimated_value_cents`) :
 *   · unité : CENTIMES, entier ≥ 0, ou `null` pour effacer ;
 *   · un nombre DÉCIMAL est encore accepté (ancien client API qui enverrait
 *     des euros ou un montant calculé) : arrondi au centime entier, avec un
 *     avertissement journalisé — il n'est pas converti d'euros en centimes ;
 *   · négatif, non numérique : 400 INVALID_INPUT.
 * Une valeur réellement modifiée (comparée à la vue canonique de
 * l'équipement : fiche puis colonne) reçoit l'origine USER dans la fiche
 * canonique de l'équipement (hors commutateur) : aucune écriture automatique
 * ne la remplacera.
 *
 * Lot 20 (CDC 15, D-D) : `fiche` — caractéristiques canoniques saisies dans
 * le tiroir (puissance, COP, fluide frigorigène, compteur horaire,
 * `EQUIPMENT_FICHE_FIELDS`), écrites par le même chemin (origine USER, clés
 * réellement modifiées seulement). Valeur invalide : 400 VALIDATION_ERROR.
 */
import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { isValidEquipmentStatus } from '@/types/domain';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { parseEquipmentFiche } from '@/lib/asset-detail-rules';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; equipId: string }> }
) {
  try {
    const { id, equipId } = await params;
    const assetId = parseInt(id);
    const equipmentId = parseInt(equipId);

    if (isNaN(assetId) || isNaN(equipmentId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and equipment ID are required');
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
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Au-dessus du quota après un changement d'offre : modification suspendue (GAP-11).
    const refusQuota = await refuserSiModificationBiensSuspendue(session.currentAccountId);
    if (refusQuota) return refusQuota;

    const body = await request.json();
    const { name, type, category, status, substructureId, newAssetId } = body;
    let { purchasePriceCents, estimatedValueCents } = body;

    // Determine the effective assetId after potential transfer
    let effectiveAssetId = assetId;

    // Handle optional asset transfer
    if (newAssetId !== undefined && newAssetId !== null && newAssetId !== assetId) {
      const newAsset = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, newAssetId), eq(assets.accountId, session.currentAccountId!)))
        .limit(1);
      if (newAsset.length === 0) return apiError(404, 'NOT_FOUND', 'Target asset not found');
      effectiveAssetId = newAssetId;
    }

    // Build update object
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      if (!name.trim()) return apiError(400, 'INVALID_INPUT', 'Name cannot be empty');
      updateData.name = name.trim();
    }

    // Montants en centimes : entier ≥ 0 ou null ; un décimal est arrondi
    // (avertissement) pour ne pas casser un client API existant (en-tête).
    const centimes = (champ: string, v: unknown): number | null | undefined | 'INVALID' => {
      if (v === undefined || v === null) return v as null | undefined;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 'INVALID';
      if (Number.isInteger(v)) return v;
      console.warn(`[equipments] ${champ} décimal (${v}) arrondi au centime entier — attendu : entier en centimes.`);
      return Math.round(v);
    };
    const ppc = centimes('purchasePriceCents', purchasePriceCents);
    const evc = centimes('estimatedValueCents', estimatedValueCents);
    if (ppc === 'INVALID' || evc === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid amount');
    const fiche = parseEquipmentFiche(body.fiche);
    if (fiche.errors.length) {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', message: fiche.errors.map((e) => e.message).join(' '), fields: fiche.errors },
        { status: 400 },
      );
    }
    const ficheSaisie = Object.keys(fiche.values).length > 0;
    purchasePriceCents = ppc;
    estimatedValueCents = evc;

    if (type !== undefined) updateData.type = type;
    if (category !== undefined) updateData.category = category;
    if (purchasePriceCents !== undefined) updateData.purchasePriceCents = purchasePriceCents;
    if (estimatedValueCents !== undefined) updateData.estimatedValueCents = estimatedValueCents;
    if (newAssetId !== undefined) updateData.assetId = effectiveAssetId;

    if (status !== undefined) {
      if (!isValidEquipmentStatus(status)) return apiError(400, 'INVALID_INPUT', 'Invalid status');
      updateData.status = status;
    }

    if (substructureId !== undefined) {
      if (substructureId !== null) {
        // Verify substructure belongs to the effective asset
        const rows = await db.$client<{ id: number }[]>`
          SELECT id FROM substructures WHERE id = ${substructureId} AND asset_id = ${effectiveAssetId} LIMIT 1
        `;
        if (!rows.length) return apiError(400, 'INVALID_INPUT', 'Substructure not found for this asset');
      }
      updateData.substructureId = substructureId;
    }

    // Vue canonique AVANT modification (fiche puis colonne) : seules les clés
    // RÉELLEMENT modifiées reçoivent l'origine USER (lot 18). Null sans 0227.
    const montants = purchasePriceCents !== undefined || estimatedValueCents !== undefined;
    const cibleEquipement = { type: 'EQUIPMENT' as const, id: equipmentId };
    const vueAvant = montants || ficheSaisie
      ? await (await import('@/services/canonical/entity-state')).getCanonicalEntityState(cibleEquipement, session.currentAccountId!)
      : null;

    // Build SET clause using raw SQL — same proven pattern as DELETE handler
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = $1'];
    const vals: unknown[] = [now];
    let p = 2;

    if (name !== undefined)          { sets.push(`name = $${p++}`);            vals.push(name.trim()); }
    if (type !== undefined)          { sets.push(`type = $${p++}`);            vals.push(type); }
    if (status !== undefined)        { sets.push(`status = $${p++}`);          vals.push(status); }
    if (updateData.substructureId !== undefined) { sets.push(`substructure_id = $${p++}`); vals.push(updateData.substructureId ?? null); }
    if (newAssetId !== undefined)    { sets.push(`asset_id = $${p++}`);        vals.push(effectiveAssetId); }
    // Prix d'achat et valeur estimée : lus du corps depuis toujours, mais
    // jamais écrits jusqu'ici (lot 18 — signalé).
    if (purchasePriceCents !== undefined)  { sets.push(`purchase_price_cents = $${p++}`);  vals.push(purchasePriceCents); }
    if (estimatedValueCents !== undefined) { sets.push(`estimated_value_cents = $${p++}`); vals.push(estimatedValueCents); }

    // WHERE params
    vals.push(equipmentId); // $p
    vals.push(assetId);     // $p+1

    const rows = await db.$client.unsafe<{ id: number; name: string; status: string; type: string | null; substructure_id: number | null; asset_id: number }[]>(
      `UPDATE equipments SET ${sets.join(', ')} WHERE id = $${p} AND asset_id = $${p + 1} RETURNING id, name, status, type, substructure_id, asset_id`,
      vals as any
    );

    if (!rows.length) {
      return apiError(404, 'NOT_FOUND', 'Equipment not found');
    }

    // CDC 15 T3-02 (lot 18, hors commutateur) : saisie de l'écran → origine
    // USER dans la fiche canonique de l'équipement, sur les clés modifiées.
    if ((montants || ficheSaisie) && vueAvant) {
      const euros = (c: number | null | undefined) => (c === null || c === undefined ? null : c / 100);
      const after: Record<string, unknown> = { ...fiche.values };
      if (purchasePriceCents !== undefined) after.acquisitionPrice = euros(purchasePriceCents);
      if (estimatedValueCents !== undefined) after.estimatedValue = euros(estimatedValueCents);
      const { recordManualEntityEdit } = await import('@/services/canonical/entity-state');
      const saisies = await recordManualEntityEdit({
        target: cibleEquipement, accountId: session.currentAccountId!,
        actorUserId: session.userId ?? null, before: vueAvant, after,
      });
      // La saisie tranche une carte « À traiter » ouverte sur ce champ (ENTITY-FIELD).
      if (saisies.length) {
        const { resolveActionsForData } = await import('@/services/to-process/to-process-action.service');
        for (const k of saisies) {
          await resolveActionsForData(session.currentAccountId!, 'EQUIPMENT', equipmentId, k, 'USER_COMPLETED')
            .catch((e: Error) => console.error(`[equipments] carte ${k} non close :`, e.message));
        }
      }
    }

    // CDC Assistant §25.7, §31.7 : équipement modifié.
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: session.currentAccountId!, entityId: effectiveAssetId });
    return NextResponse.json({
      id: rows[0].id,
      name: rows[0].name,
      status: rows[0].status,
      type: rows[0].type,
      substructureId: rows[0].substructure_id,
      assetId: rows[0].asset_id,
    });
  } catch (error: any) {
    console.error('PUT equipment error:', error?.message ?? error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', detail: error?.message ?? String(error) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; equipId: string }> }
) {
  try {
    const { id, equipId } = await params;
    const assetId = parseInt(id);
    const equipmentId = parseInt(equipId);

    if (isNaN(assetId) || isNaN(equipmentId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and equipment ID are required');
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
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Logical archival via raw SQL to avoid ORM type issues
    const now = new Date().toISOString();
    const rows = await db.$client.unsafe<{ id: number }[]>(
      `UPDATE equipments SET archived_at = $1, substructure_id = NULL, updated_at = $2 WHERE id = $3 AND asset_id = $4 RETURNING id`,
      [now, now, equipmentId, assetId] as any
    );

    if (!rows.length) {
      return apiError(404, 'NOT_FOUND', 'Equipment not found');
    }

    // CDC Assistant §25.7, §31.7 : équipement archivé.
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: session.currentAccountId!, entityId: assetId });
    return NextResponse.json({ message: 'Equipment archived successfully' });
  } catch (error) {
    console.error('DELETE equipment error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
