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
 *
 * Lot 70B (décision PO 19/10) :
 *   · `energyUsage` — usage énergétique déclaré dans le tiroir (choix fermé,
 *     `EQUIPMENT_ENERGY_USAGE_OPTIONS` ; `null` = non renseigné), écrit dans
 *     `equipments.energy_usage`, lu en priorité par la règle B6 du CIL.
 *     Valeur hors liste : 400 INVALID_INPUT. Absent : inchangé.
 *   · `category` — lue du corps depuis toujours mais JAMAIS écrite : elle
 *     l'est désormais (texte rogné, `''` ou `null` = effacée, 100 car. max).
 *     Absente : inchangée (aucun autre champ n'est touché).
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
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { parseEquipmentFiche } from '@/lib/asset-detail-rules';
import { parseEquipmentCategory, parseEquipmentEnergyUsage } from '@/lib/cil/energy-equipment';
import { parseEquipmentCents } from '@/lib/equipment-amounts';

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
    // Lot 75G : même analyseur que la création (bornes de la colonne integer).
    const ppc = parseEquipmentCents('purchasePriceCents', purchasePriceCents, 'legacy');
    const evc = parseEquipmentCents('estimatedValueCents', estimatedValueCents, 'legacy');
    if (ppc === 'INVALID' || evc === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid amount');
    const fiche = parseEquipmentFiche(body.fiche);
    if (fiche.errors.length) {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', message: fiche.errors.map((e) => e.message).join(' '), fields: fiche.errors },
        { status: 400 },
      );
    }
    const ficheSaisie = Object.keys(fiche.values).length > 0;
    const energyUsage = parseEquipmentEnergyUsage(body.energyUsage);
    if (energyUsage === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid energy usage');
    const categoryValue = parseEquipmentCategory(category);
    if (categoryValue === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid category');
    purchasePriceCents = ppc;
    estimatedValueCents = evc;

    if (type !== undefined) updateData.type = type;
    if (categoryValue !== undefined) updateData.category = categoryValue;
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
    // Lot 70B : `category` était lue sans être écrite ; usage énergétique déclaré.
    if (categoryValue !== undefined) { sets.push(`category = $${p++}`);        vals.push(categoryValue); }
    if (energyUsage !== undefined)   { sets.push(`energy_usage = $${p++}`);    vals.push(energyUsage); }
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

    // Lot 75G (écart D) : valeurs AVANT modification relues dans la même
    // instruction (verrou de ligne) — le rapprochement n'est relancé que sur
    // un changement EFFECTIF du nom ou du bien parent.
    const rows = await db.$client.unsafe<{ id: number; name: string; status: string; type: string | null; category: string | null; energy_usage: string | null; substructure_id: number | null; asset_id: number; old_name: string; old_asset_id: number }[]>(
      `WITH avant AS (SELECT id, name AS old_name, asset_id AS old_asset_id FROM equipments WHERE id = $${p} AND asset_id = $${p + 1} FOR UPDATE)
       UPDATE equipments SET ${sets.join(', ')} FROM avant WHERE equipments.id = avant.id
       RETURNING equipments.id, equipments.name, equipments.status, equipments.type, equipments.category, equipments.energy_usage,
                 equipments.substructure_id, equipments.asset_id, avant.old_name, avant.old_asset_id`,
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

    // Lot 71A (point B), lot 75G (écart D) : nom ou bien parent EFFECTIVEMENT
    // modifiés → les documents sont rapprochés de nouveau, en file DURABLE
    // (déterministe seul, aucun appel IA). Marque, modèle, n° de série :
    // déclenchés par l'écrivain canonique de l'équipement. Le type seul
    // n'entre dans aucune règle : aucun rapprochement relancé pour lui.
    {
      const r0 = rows[0];
      const renomme = r0.name.trim().toLowerCase() !== String(r0.old_name ?? '').trim().toLowerCase();
      const deplace = Number(r0.asset_id) !== Number(r0.old_asset_id);
      if (renomme || deplace) {
        try {
          const { requestEquipmentDocumentSync } = await import('@/services/equipment/equipment-document-queue');
          await requestEquipmentDocumentSync(session.currentAccountId!, equipmentId, { reason: deplace ? 'moved' : 'renamed' });
        } catch (e) {
          console.error(`[equipments] mise en file du rapprochement de l'équipement ${equipmentId} impossible :`, (e as Error).message);
        }
      }
    }

    // CDC Assistant §25.7, §31.7 : équipement modifié.
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: session.currentAccountId!, entityId: effectiveAssetId });
    // Lot 34E : équipement modifié (nom, n° de série…) → réconciliation continue T3.
    const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    notifyCoherenceEvent(session.currentAccountId!, { event: 'entity_updated', objectType: 'equipment', objectId: equipmentId });
    return NextResponse.json({
      id: rows[0].id,
      name: rows[0].name,
      status: rows[0].status,
      type: rows[0].type,
      category: rows[0].category,
      energyUsage: rows[0].energy_usage,
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

    // Lot 85D : retirer un équipement est une écriture — refusée en lecture seule.
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;

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
