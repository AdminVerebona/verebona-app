import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { assets, substructures } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { parseEquipmentCents } from '@/lib/equipment-amounts';
import { isValidEquipmentStatus, assetSupportsStructuralFeatures } from '@/types/domain';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { parseEquipmentCategory, parseEquipmentEnergyUsage } from '@/lib/cil/energy-equipment';

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
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    const results = await db.$client<{ id: number; name: string; type: string | null; category: string | null; energyUsage: string | null; status: string; substructureId: number | null; purchasePriceCents: number | null; estimatedValueCents: number | null; archivedAt: string | null }[]>`
      SELECT id, name, type, category, energy_usage AS "energyUsage", status,
             substructure_id AS "substructureId",
             purchase_price_cents AS "purchasePriceCents",
             estimated_value_cents AS "estimatedValueCents",
             archived_at AS "archivedAt"
      FROM equipments
      WHERE asset_id = ${assetId} AND archived_at IS NULL
    `;

    return NextResponse.json(results);
  } catch (error) {
    console.error('GET equipments error:', error);
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
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    const assetData = asset[0];

    // Vérifier si le bien supporte les équipements
    const supportsFeatures = assetSupportsStructuralFeatures(assetData);
    if (!supportsFeatures) {
      return apiError(400, 'FORBIDDEN', 'Ce type de bien ne supporte pas la gestion des équipements');
    }

    // Au-dessus du quota après un changement d'offre : modification suspendue (GAP-11).
    const refusQuota = await refuserSiModificationBiensSuspendue(session.currentAccountId);
    if (refusQuota) return refusQuota;

    // Gestion des équipements : Premium et Premium Duo (essai compris). Le client
    // ouvre la fenêtre d'offre avant la saisie ; ce contrôle en est la
    // garantie, et son refus est lu par `parseWriteBlocked`.
    const premium = await canUsePremiumFeature(session.currentAccountId);
    if (!premium.allowed) {
      return NextResponse.json(
        { error: premium.reason, code: premium.reason, message: premium.message },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { name, type, category, status, substructureId, purchasePriceCents, estimatedValueCents } = body;

    if (!name || !name.trim()) {
      return apiError(400, 'MISSING_FIELD', 'Name is required');
    }

    if (status && !isValidEquipmentStatus(status)) {
      return apiError(400, 'INVALID_INPUT', 'Invalid equipment status');
    }

    // Lot 70B : usage énergétique déclaré (choix fermé, null = non renseigné)
    // et `category`, lue depuis toujours mais jamais écrite.
    const energyUsage = parseEquipmentEnergyUsage(body.energyUsage);
    if (energyUsage === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid energy usage');
    const categoryValue = parseEquipmentCategory(category);
    if (categoryValue === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid category');

    // Lot 75G (D2) : montants fournis à la création, en centimes ENTIERS
    // (strict) ; absents : vides. Écrits sur l'ÉQUIPEMENT seul, jamais sur le bien.
    const ppc = parseEquipmentCents('purchasePriceCents', purchasePriceCents, 'strict');
    const evc = parseEquipmentCents('estimatedValueCents', estimatedValueCents, 'strict');
    if (ppc === 'INVALID' || evc === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid amount (integer cents expected)');

    // If substructureId is provided, verify it belongs to the same asset
    if (substructureId) {
      const subRows = await db
        .select({ id: substructures.id })
        .from(substructures)
        .where(and(eq(substructures.id, substructureId), eq(substructures.assetId, assetId)))
        .limit(1);
      if (subRows.length === 0) {
        return apiError(400, 'INVALID_INPUT', 'Substructure not found for this asset');
      }
    }

    const now = new Date().toISOString();

    // Lot 75G (D1) : INSERT … RETURNING — l'identifiant rendu est TOUJOURS
    // celui de la ligne créée, même en cas de créations concurrentes (l'ancien
    // « dernier équipement du bien » pouvait rendre celui d'une autre requête).
    const [newEquipment] = await db.$client<{
      id: number; name: string; type: string | null; energyUsage: string | null; status: string; substructureId: number | null;
    }[]>`
      INSERT INTO equipments (asset_id, substructure_id, name, type, category, energy_usage, status,
                              purchase_price_cents, estimated_value_cents, created_at, updated_at)
      VALUES (${assetId}, ${substructureId || null}, ${name.trim()}, ${type || null}, ${categoryValue ?? null}, ${energyUsage ?? null},
              ${status || 'EN_SERVICE'}, ${ppc ?? null}, ${evc ?? null}, ${now}, ${now})
      RETURNING id, name, type, energy_usage AS "energyUsage", status, substructure_id AS "substructureId"
    `;
    if (!newEquipment) {
      return apiError(500, 'INTERNAL_ERROR', 'Failed to create equipment');
    }

    // Lot 75G (D2) : montants saisis → origine USER dans la fiche canonique de
    // l'ÉQUIPEMENT (comme la modification, lot 18) ; vue « avant » = aucun montant.
    if (ppc != null || evc != null) {
      const cible = { type: 'EQUIPMENT' as const, id: newEquipment.id };
      const { getCanonicalEntityState, recordManualEntityEdit } = await import('@/services/canonical/entity-state');
      const vue = await getCanonicalEntityState(cible, session.currentAccountId!);
      if (vue) {
        const { acquisitionPrice: _p, estimatedValue: _v, ...autres } = vue.fields;
        await recordManualEntityEdit({
          target: cible, accountId: session.currentAccountId!, actorUserId: session.userId ?? null,
          before: { ...vue, fields: autres },
          after: { ...(ppc != null ? { acquisitionPrice: ppc / 100 } : {}), ...(evc != null ? { estimatedValue: evc / 100 } : {}) },
        });
      }
    }

    // Lot 75G (D3) : rapprochement documents / agenda / fournisseurs en file
    // DURABLE (reprise, déduplication, observabilité) — mise en file attendue.
    try {
      const { requestEquipmentDocumentSync } = await import('@/services/equipment/equipment-document-queue');
      await requestEquipmentDocumentSync(session.currentAccountId!, newEquipment.id, { reason: 'created' });
    } catch (e) {
      // File indisponible : repli sur l'exécution directe (non bloquante), journalisé.
      console.error(`[equipments] mise en file du rapprochement de l'équipement ${newEquipment.id} impossible :`, (e as Error).message);
      const { runEquipmentAutoLink } = await import('@/services/equipment/equipment-auto-link.service');
      runEquipmentAutoLink(newEquipment.id, session.currentAccountId!).catch((err: Error) => console.error('[equipments] rapprochement direct :', err.message));
    }

    // CDC Assistant §25.7, §31.7 : équipement ajouté au bien.
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: session.currentAccountId!, entityId: assetId });
    // Lot 34E : nouvel équipement → réconciliation continue T3 (faits sans
    // cible par n° de série, documents ouverts), temporisée et dédupliquée.
    const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    notifyCoherenceEvent(session.currentAccountId!, { event: 'entity_updated', objectType: 'equipment', objectId: newEquipment.id });
    return NextResponse.json({
      id: newEquipment.id,
      name: newEquipment.name,
      status: newEquipment.status,
      type: newEquipment.type,
      energyUsage: newEquipment.energyUsage,
      substructureId: newEquipment.substructureId,
      assetId
    }, { status: 201 });
  } catch (error) {
    console.error('POST equipment error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
