/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W04 – W09, §14.4 « Équipements » et
 * « Pièces ») — FAÇADE MÉTIER des écritures de la structure d'un bien :
 * pièces (création, renommage, suppression) et équipements (création,
 * modification, archivage).
 *
 * Extraite des routes `assets/[id]/substructures`, `…/substructures/[subId]`,
 * `assets/[id]/equipments` et `…/equipments/[equipId]`, qui l'appellent
 * désormais : les écrans et l'Assistant Verebona passent par le MÊME code —
 * mêmes validations, même origine USER des montants et de la fiche d'un
 * équipement, même rapprochement durable (documents, Agenda, fournisseurs),
 * mêmes événements (ASSET_UPDATED, file T3). Aucune règle n'a été modifiée
 * par l'extraction.
 *
 * Les contrôles d'ACCÈS restent aux appelants (session, bien du compte,
 * lecture seule) ; les contrôles d'OFFRE communs sont ici
 * (`structureCreationRefusal`).
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, substructures } from '@/db/schema';
import { apiError } from '@/lib/api-errors';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { parseEquipmentFiche } from '@/lib/asset-detail-rules';
import { parseEquipmentCategory, parseEquipmentEnergyUsage } from '@/lib/cil/energy-equipment';
import { parseEquipmentCents } from '@/lib/equipment-amounts';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { assetSupportsStructuralFeatures, isValidEquipmentStatus } from '@/types/domain';

/** Session de l'appelant : utilisateur et compte actif (déjà contrôlés). */
export interface StructureWriteSession { userId: number | null; currentAccountId: number }

// ══════════════════════════════════════════════════════════════════════════
// Contrôles d'offre communs (pièces et équipements)
// ══════════════════════════════════════════════════════════════════════════

/**
 * La création d'une pièce ou d'un équipement sur ce bien est-elle permise ?
 * Mêmes contrôles, dans le même ordre, que les routes : type de bien
 * compatible, modification non suspendue par le quota de biens (GAP-11),
 * fonctionnalité Premium. `null` : permis ; sinon le refus de l'offre.
 */
export async function structureCreationRefusal(
  accountId: number, asset: { category: string; subtype?: string | null }, kind: 'room' | 'equipment',
): Promise<{ status: number; code: string; message: string } | null> {
  if (!assetSupportsStructuralFeatures(asset)) {
    return { status: 400, code: 'FORBIDDEN', message: kind === 'room' ? 'Ce type de bien ne supporte pas la gestion des pièces' : 'Ce type de bien ne supporte pas la gestion des équipements' };
  }
  const refusQuota = await refuserSiModificationBiensSuspendue(accountId);
  if (refusQuota) {
    const j = await refusQuota.clone().json().catch(() => ({})) as { code?: string; message?: string };
    return { status: 403, code: j.code ?? 'ASSET_QUOTA_EXCEEDED', message: j.message ?? 'Modification non autorisée' };
  }
  const premium = await canUsePremiumFeature(accountId);
  if (!premium.allowed) return { status: 403, code: premium.reason ?? 'PREMIUM_REQUIRED', message: premium.message ?? 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' };
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// PIÈCES (W07 – W09)
// ══════════════════════════════════════════════════════════════════════════

/** Crée une pièce du bien (nom obligatoire, déjà rogné par l'appelant ou ici). */
export async function createRoomForAccount(accountId: number, assetId: number, name: string):
  Promise<{ id: number; name: string; asset_id: number; order_index: number }> {
  const now = new Date().toISOString();
  const [newSubstructure] = await db.$client<{ id: number; name: string; asset_id: number; order_index: number }[]>`
    INSERT INTO substructures (asset_id, name, order_index, scope, public_id, created_at, updated_at)
    VALUES (${assetId}, ${name.trim()}, 0, 'personal', gen_random_uuid(), ${now}, ${now})
    RETURNING id, name, asset_id, order_index
  `;

  // CDC Assistant §25.7, §31.7 : pièce ajoutée au bien.
  await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });
  // Lot 84E (CDC v5 O-6, §9.3) : nouvelle Pièce → reconsolidation ciblée (file T3 Opérations, non bloquante).
  const { notifyOperationsEvent } = await import('@/services/business-operations/consolidation/queue');
  notifyOperationsEvent(accountId, { trigger: 'asset_updated', assetId, roomId: Number(newSubstructure.id) });
  return newSubstructure;
}

/** Renomme une pièce du bien ; `null` : pièce absente de ce bien. */
export async function renameRoomForAccount(accountId: number, assetId: number, roomId: number, name: string):
  Promise<{ id: number; name: string; asset_id: number } | null> {
  const rows = await db.$client<{ id: number; name: string; asset_id: number }[]>`
    UPDATE substructures
    SET name = ${name.trim()}, updated_at = NOW()
    WHERE id = ${roomId} AND asset_id = ${assetId}
    RETURNING id, name, asset_id
  `;
  if (!rows.length) return null;
  // CDC Assistant §25.7, §31.7 : pièce modifiée.
  await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });
  return rows[0];
}

/**
 * Supprime une pièce du bien ; `false` : pièce absente de ce bien. Les
 * documents et les équipements qui y étaient rattachés RESTENT dans le bien
 * (rattachement à la pièce retiré par la base) ; ses liens d'Agenda et
 * d'événements de référence sont retirés avec elle.
 */
export async function deleteRoomForAccount(accountId: number, assetId: number, roomId: number): Promise<boolean> {
  const [deletedSubstructure] = await db
    .delete(substructures)
    .where(and(eq(substructures.id, roomId), eq(substructures.assetId, assetId)))
    .returning();
  if (!deletedSubstructure) return false;
  // CDC Assistant §25.7, §31.7 : pièce supprimée.
  await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// ÉQUIPEMENTS (W04 – W06) — corps des routes, déplacés tels quels
// ══════════════════════════════════════════════════════════════════════════

/** Crée un équipement du bien (corps de `POST /api/assets/[id]/equipments`, après ses contrôles d'accès et d'offre). */
export async function createEquipmentForAccount(session: StructureWriteSession, assetId: number, body: any): Promise<NextResponse> {
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
    const vue = await getCanonicalEntityState(cible, session.currentAccountId);
    if (vue) {
      const { acquisitionPrice: _p, estimatedValue: _v, ...autres } = vue.fields;
      await recordManualEntityEdit({
        target: cible, accountId: session.currentAccountId, actorUserId: session.userId ?? null,
        before: { ...vue, fields: autres },
        after: { ...(ppc != null ? { acquisitionPrice: ppc / 100 } : {}), ...(evc != null ? { estimatedValue: evc / 100 } : {}) },
      });
    }
  }

  // Lot 75G (D3) : rapprochement documents / agenda / fournisseurs en file
  // DURABLE (reprise, déduplication, observabilité) — mise en file attendue.
  try {
    const { requestEquipmentDocumentSync } = await import('@/services/equipment/equipment-document-queue');
    await requestEquipmentDocumentSync(session.currentAccountId, newEquipment.id, { reason: 'created' });
  } catch (e) {
    // File indisponible : repli sur l'exécution directe (non bloquante), journalisé.
    console.error(`[equipments] mise en file du rapprochement de l'équipement ${newEquipment.id} impossible :`, (e as Error).message);
    const { runEquipmentAutoLink } = await import('@/services/equipment/equipment-auto-link.service');
    runEquipmentAutoLink(newEquipment.id, session.currentAccountId).catch((err: Error) => console.error('[equipments] rapprochement direct :', err.message));
  }

  // CDC Assistant §25.7, §31.7 : équipement ajouté au bien.
  await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: session.currentAccountId, entityId: assetId });
  // Lot 34E : nouvel équipement → réconciliation continue T3 (faits sans
  // cible par n° de série, documents ouverts), temporisée et dédupliquée.
  const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
  notifyCoherenceEvent(session.currentAccountId, { event: 'entity_updated', objectType: 'equipment', objectId: newEquipment.id });
  return NextResponse.json({
    id: newEquipment.id,
    name: newEquipment.name,
    status: newEquipment.status,
    type: newEquipment.type,
    energyUsage: newEquipment.energyUsage,
    substructureId: newEquipment.substructureId,
    assetId
  }, { status: 201 });
}

/** Modifie un équipement du bien (corps de `PUT /api/assets/[id]/equipments/[equipId]`, après ses contrôles d'accès). */
export async function updateEquipmentForAccount(session: StructureWriteSession, assetId: number, equipmentId: number, body: any): Promise<NextResponse> {
  const { name, type, category, status, substructureId, newAssetId } = body;
  let { purchasePriceCents, estimatedValueCents } = body;

  // Determine the effective assetId after potential transfer
  let effectiveAssetId = assetId;

  // Handle optional asset transfer
  if (newAssetId !== undefined && newAssetId !== null && newAssetId !== assetId) {
    const newAsset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, newAssetId), eq(assets.accountId, session.currentAccountId)))
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
    ? await (await import('@/services/canonical/entity-state')).getCanonicalEntityState(cibleEquipement, session.currentAccountId)
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
      target: cibleEquipement, accountId: session.currentAccountId,
      actorUserId: session.userId ?? null, before: vueAvant, after,
    });
    // La saisie tranche une carte « À traiter » ouverte sur ce champ (ENTITY-FIELD).
    if (saisies.length) {
      const { resolveActionsForData } = await import('@/services/to-process/to-process-action.service');
      for (const k of saisies) {
        await resolveActionsForData(session.currentAccountId, 'EQUIPMENT', equipmentId, k, 'USER_COMPLETED')
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
        await requestEquipmentDocumentSync(session.currentAccountId, equipmentId, { reason: deplace ? 'moved' : 'renamed' });
      } catch (e) {
        console.error(`[equipments] mise en file du rapprochement de l'équipement ${equipmentId} impossible :`, (e as Error).message);
      }
    }
  }

  // CDC Assistant §25.7, §31.7 : équipement modifié.
  await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: session.currentAccountId, entityId: effectiveAssetId });
  // Lot 34E : équipement modifié (nom, n° de série…) → réconciliation continue T3.
  const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
  notifyCoherenceEvent(session.currentAccountId, { event: 'entity_updated', objectType: 'equipment', objectId: equipmentId });
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
}

/**
 * Retire un équipement du bien : ARCHIVAGE logique (aucune suppression —
 * documents, échéances et historique conservés) ; `false` : équipement absent
 * de ce bien.
 */
export async function archiveEquipmentForAccount(accountId: number, assetId: number, equipmentId: number): Promise<boolean> {
  // Logical archival via raw SQL to avoid ORM type issues
  const now = new Date().toISOString();
  const rows = await db.$client.unsafe<{ id: number }[]>(
    `UPDATE equipments SET archived_at = $1, substructure_id = NULL, updated_at = $2 WHERE id = $3 AND asset_id = $4 RETURNING id`,
    [now, now, equipmentId, assetId] as any
  );
  if (!rows.length) return false;
  // CDC Assistant §25.7, §31.7 : équipement archivé.
  await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });
  return true;
}
