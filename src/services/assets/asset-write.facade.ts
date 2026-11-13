/**
 * Lot 114B (Trello #753, CDC T2 §1.3-8, §13.7, §14.3 W01 / W03, M19-M21) —
 * FAÇADE D'ÉCRITURE DES BIENS : UNE SEULE LOGIQUE MÉTIER.
 *
 * La création et la suppression définitive d'un bien étaient codées dans la
 * route `/api/assets`. L'Assistant ne doit ni rappeler cette route par HTTP,
 * ni réécrire ses règles : elles sont déplacées ici, À L'IDENTIQUE, et la
 * route comme l'Assistant appellent cette façade. Mêmes validations, mêmes
 * quotas, mêmes événements, quelle que soit la porte d'entrée.
 *
 * Aucune règle nouvelle. Les messages et codes de refus sont ceux de la route.
 */
import { and, count, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, accounts as accountsTable } from '@/db/schema';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { ACCEPTED_ASSET_CATEGORY_CODES, getAssetCategories, normalizeAssetCategory } from '@/lib/asset-taxonomy';
import { ASSET_STATUSES } from '@/lib/asset-status';
import { getFeatureFlags, canCreateAsset } from '@/lib/feature-flags';
import { canCreateAsset as canCreateAssetEntitlement } from '@/services/entitlements.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { deleteAssetCompletely, getAssetDeletionSummary, type AssetDeletionSummary } from './asset-deletion.service';
import { isValidObjectCategory } from '@/types/domain';
import type { PlanType } from '@/types/domain';
import type { ErrorCode } from '@/lib/api-errors';

// Lot 30 : familles du référentiel (`asset-taxonomy`) — proposées + anciennes encore stockées.
export const VALID_ASSET_CATEGORIES: readonly string[] = ACCEPTED_ASSET_CATEGORY_CODES;
// Lot 32 (PO-Q11) : liste officielle — la même que la contrainte en base (migration 0278).
export const VALID_ASSET_STATUSES: readonly string[] = ASSET_STATUSES;
export const VALID_OBJECT_CATEGORIES: readonly string[] = getAssetCategories('OBJECT').map((c) => c.value);

/** Refus métier : statut HTTP, code stable et message — ceux de la route. */
export interface AssetWriteRefusal {
  ok: false;
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface CreateAssetInput {
  category?: unknown;
  subtype?: unknown;
  name?: unknown;
  purchaseDate?: unknown;
  purchasePriceCents?: unknown;
  status?: unknown;
  notes?: unknown;
  thumbnailUrl?: unknown;
  objectCategory?: unknown;
  objectDetails?: unknown;
  purchaseLocation?: unknown;
}

const refus = (status: number, code: ErrorCode, message: string, details?: Record<string, unknown>): AssetWriteRefusal =>
  ({ ok: false, status, code, message, ...(details ? { details } : {}) });

/**
 * Quota et droits de création, SANS écriture — même contrôle que la création
 * elle-même. Sert à l'Assistant avant de proposer un plan (CDC §10.1 : les
 * quotas s'appliquent avant confirmation ET à l'exécution).
 */
export async function checkAssetCreationAllowed(accountId: number): Promise<{ ok: true } | AssetWriteRefusal> {
  const [account] = await db
    .select({ id: accountsTable.id, planType: accountsTable.planType, featureFlags: accountsTable.featureFlags })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId))
    .limit(1);
  if (!account) return refus(404, 'ACCOUNT_NOT_FOUND', 'Account not found');

  const features = getFeatureFlags(account.planType as PlanType, account.featureFlags);
  const [assetCountResult] = await db.select({ count: count() }).from(assets).where(eq(assets.accountId, accountId));
  const currentAssetCount = assetCountResult?.count || 0;

  // CDC tarification §8.2 : quota de biens contrôlé côté serveur à partir des
  // droits effectifs (essai / Standard / Premium / Duo / restreint).
  const assetDecision = await canCreateAssetEntitlement(accountId, currentAssetCount);
  if (!assetDecision.allowed) {
    return refus(403, (assetDecision.reason ?? 'ASSET_LIMIT_REACHED') as ErrorCode, assetDecision.message ?? 'Quota atteint', {
      current_count: currentAssetCount,
      max_assets: assetDecision.limit,
    });
  }
  // Contrôle historique conservé le temps de la transition.
  if (!canCreateAsset(currentAssetCount, features)) {
    return refus(
      403,
      'ASSET_LIMIT_REACHED',
      `Vous avez atteint la limite de ${features.max_assets} biens du plan gratuit. Supprimez un bien ou passez au plan Premium pour gérer tous vos biens.`,
      { current_count: currentAssetCount, max_assets: features.max_assets, plan_type: account.planType },
    );
  }
  return { ok: true };
}

/** Validation des champs d'un nouveau bien (pure, testée) — mêmes règles et messages que la route. */
export function validateNewAsset(body: CreateAssetInput): { ok: true } | AssetWriteRefusal {
  const { category, name, objectCategory, status, purchasePriceCents } = body;
  if (!category) return refus(400, 'MISSING_FIELD', 'category is required');
  if (!name) return refus(400, 'MISSING_FIELD', 'name is required');
  if (typeof name !== 'string' || !name.trim()) return refus(400, 'INVALID_INPUT', 'name cannot be empty');
  if (!VALID_ASSET_CATEGORIES.includes(category as string)) {
    return refus(400, 'INVALID_INPUT', `category must be one of: ${VALID_ASSET_CATEGORIES.join(', ')}`);
  }
  if (category === 'OBJECT') {
    if (!objectCategory) return refus(400, 'MISSING_FIELD', 'objectCategory is required for OBJECT type');
    if (!isValidObjectCategory(objectCategory as string)) {
      return refus(400, 'INVALID_INPUT', `objectCategory must be one of: ${VALID_OBJECT_CATEGORIES.join(', ')}`);
    }
  }
  if (status && !VALID_ASSET_STATUSES.includes(status as string)) {
    return refus(400, 'INVALID_INPUT', `status must be one of: ${VALID_ASSET_STATUSES.join(', ')}`);
  }
  if (purchasePriceCents !== undefined && purchasePriceCents !== null) {
    const priceInt = parseInt(purchasePriceCents as string);
    if (isNaN(priceInt) || priceInt < 0) return refus(400, 'INVALID_INPUT', 'purchasePriceCents must be a positive integer');
  }
  return { ok: true };
}

/**
 * Crée un bien : quota et droits, validation, insertion, puis événements
 * (entonnoir d'activation, caches de l'Assistant, réconciliation T3, achat
 * saisi → Acquisition). Corps de `POST /api/assets`, déplacé sans changement.
 */
export async function createAssetForAccount(
  ctx: { accountId: number; userId: number },
  body: CreateAssetInput,
): Promise<{ ok: true; asset: typeof assets.$inferSelect } | AssetWriteRefusal> {
  const droit = await checkAssetCreationAllowed(ctx.accountId);
  if (!droit.ok) return droit;
  const valide = validateNewAsset(body);
  if (!valide.ok) return valide;

  const { category, subtype, name, purchaseDate, purchasePriceCents, status, notes, thumbnailUrl, objectCategory, objectDetails, purchaseLocation } = body;
  const now = new Date();
  // Colonnes facultatives posées une à une, comme la route d'origine.
  const insertData: Record<string, unknown> = {
    userId: ctx.userId,
    accountId: ctx.accountId,
    category,
    name: (name as string).trim(),
    status: status || 'EN_SERVICE',
    createdAt: now,
    updatedAt: now,
  };
  // Anciens libellés (« Garage », « Local commercial »…) → catégories actuelles.
  if (subtype) insertData.subtype = normalizeAssetCategory(subtype as string);
  if (purchaseDate) insertData.purchaseDate = purchaseDate;
  if (purchasePriceCents !== undefined && purchasePriceCents !== null) insertData.purchasePriceCents = parseInt(purchasePriceCents as string);
  if (notes) insertData.notes = notes;
  if (thumbnailUrl) insertData.thumbnailUrl = thumbnailUrl;
  if (purchaseLocation) insertData.purchaseLocation = purchaseLocation;
  if (category === 'OBJECT') {
    insertData.objectCategory = objectCategory;
    if (objectDetails) insertData.objectDetails = typeof objectDetails === 'string' ? objectDetails : JSON.stringify(objectDetails);
  }

  const newAsset = await db.insert(assets).values(insertData as typeof assets.$inferInsert).returning();

  // CDC §17 : activation — premier bien enregistré (dédoublonné en base).
  void trackFunnelEvent({ event: 'first_asset_added', accountId: ctx.accountId });
  // CDC Assistant §25.7 : événement métier (caches de l'assistant). §31.7 :
  // attendu (ne lève jamais) — l'invalidation précède la réponse.
  await emitBusinessEvent({ type: 'ASSET_CREATED', accountId: ctx.accountId, entityId: newAsset[0]?.id ?? null });
  // Lot 34E : nouveau bien → la réconciliation continue T3 reprend les
  // documents et faits encore ouverts du compte (temporisée, dédupliquée).
  if (newAsset[0]?.id) {
    const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    notifyCoherenceEvent(ctx.accountId, { event: 'asset_updated', objectType: 'asset', objectId: newAsset[0].id });
    // Lot 43 (TRG-008) : achat saisi à la création → Acquisition (source ASSET_DATA).
    const { notifyOperationsEvent } = await import('@/services/business-operations/consolidation/queue');
    notifyOperationsEvent(ctx.accountId, { trigger: 'asset_updated', assetId: newAsset[0].id });
  }
  return { ok: true, asset: newAsset[0] };
}

/**
 * Décompte de ce que la suppression emportera, pour un bien DU COMPTE —
 * `null` si le bien n'existe pas ou appartient à un autre compte (sans les
 * distinguer). Même décompte que la boîte de suppression de la fiche.
 */
export async function readAssetDeletionSummary(accountId: number, assetId: number): Promise<(AssetDeletionSummary & { name: string }) | null> {
  const [asset] = await db.select({ id: assets.id, name: assets.name })
    .from(assets).where(and(eq(assets.id, assetId), eq(assets.accountId, accountId))).limit(1);
  if (!asset) return null;
  return { ...(await getAssetDeletionSummary(assetId)), name: asset.name };
}

/**
 * Suppression définitive d'un bien DÉJÀ contrôlé (compte, écriture permise) :
 * le bien et tout son contenu, puis le retrait des preuves sur les autres
 * biens et l'événement métier. Suite de `DELETE /api/assets`, déplacée sans
 * changement. Aucune option de conservation partielle n'existe.
 */
export async function deleteAssetForAccount(
  ctx: { accountId: number; userId: number },
  asset: { id: number; thumbnailUrl?: string | null },
): Promise<{ blobsScheduled: number }> {
  const { blobsScheduled, fileIds } = await deleteAssetCompletely(asset);
  // CDC 15 T3-03 : preuves des documents emportés retirées sur les AUTRES
  // biens (documents multi-biens), qui sont réconciliés (ne lève jamais).
  {
    const { onAssetDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    await onAssetDeleted({ accountId: ctx.accountId, userId: ctx.userId, assetId: asset.id, fileIds: fileIds ?? [] });
  }
  // CDC Assistant §25.7 : événement métier (caches de l'assistant, §31.4).
  await emitBusinessEvent({ type: 'ASSET_DELETED', accountId: ctx.accountId, entityId: asset.id });
  return { blobsScheduled };
}
