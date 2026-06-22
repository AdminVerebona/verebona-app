/**
 * ImpactPropagationService
 * ─────────────────────────
 * Core event-driven propagation engine. Processes impact queue items by:
 *   1. Identifying the changed source fields
 *   2. Resolving the dependency graph for impacted targets
 *   3. Applying certain impacts automatically
 *   4. Creating inconsistency proposals/conflicts for probable/conflictual impacts
 *   5. Updating agenda items from date fields
 *   6. Triggering search index updates
 *   7. Marking exports as stale
 *
 * This replaces the heavy nightly AI batch with targeted, event-driven processing.
 */

import { db } from '@/db';
import { assets, assetFiles, agendaItems } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { enqueue, dequeueBatch, complete, fail, type ImpactQueueItem } from './impact-queue.service';
import { resolveImpacts, type DependencyRule } from './field-dependency.service';
import { computeHash, recordVersion } from './version-tracker.service';
import { determineAction, createInconsistency, autoResolveForField } from './inconsistency.service';
import { isFieldAllowedForCategory } from '@/lib/field-validator';

// ─── Types ────────────────────────────────────────────────────────────────

export interface PropagationResult {
  impactsResolved: number;
  fieldsApplied: number;
  fieldsProposed: number;
  fieldsConflicted: number;
  agendaItemsCreated: number;
  searchUpdatesTriggered: number;
  errors: number;
}

interface AssetData {
  id: number;
  accountId: number;
  name: string | null;
  category: string | null;
  keyCharacteristics: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && (v.trim() === '' || v.toLowerCase() === 'null' || v.toLowerCase() === 'n/a')) return true;
  return false;
}

function normalizeFieldValue(key: string, raw: unknown): unknown {
  if (isEmptyValue(raw)) return null;
  const numericFields = ['acquisitionPrice', 'estimatedValue', 'monthlyRent', 'charges', 'livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'powerKw', 'ptac', 'seats', 'mileage', 'weight', 'year', 'fiscalHp'];
  if (numericFields.includes(key)) {
    const n = Number(raw);
    return isNaN(n) ? null : n;
  }
  const dateFields = ['acquisitionDate', 'estimatedValueDate', 'dpeDate', 'firstRegistrationDate', 'mileageDate', 'insuranceExpiry', 'nextInspection', 'lastRevision', 'valuationDate', 'warrantyEnd'];
  if (dateFields.includes(key)) {
    const s = String(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    try { const d = new Date(s); if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]; } catch {}
    return null;
  }
  return raw;
}

// ─── Core Propagation Logic ────────────────────────────────────────────────

/**
 * Extract the relevant changed fields from an impact event.
 * Returns a map of field_key → new_value.
 */
async function extractChangedFields(
  item: ImpactQueueItem,
): Promise<Record<string, unknown>> {
  switch (item.triggerType) {
    case 'document_analyzed':
    case 'document_modified':
      return extractDocumentFields(item);
    case 'asset_updated':
    case 'user_field_edit':
      return extractAssetChangedFields(item);
    case 'agenda_item_created':
      return extractAgendaFields(item);
    case 'batch_catchup':
    case 'manual_request':
      return item.metadata?.changedFields as Record<string, unknown> ?? {};
    default:
      return {};
  }
}

async function extractDocumentFields(item: ImpactQueueItem): Promise<Record<string, unknown>> {
  if (!item.documentId) return {};

  const [doc] = await db
    .select({
      documentType: assetFiles.documentType,
      extractedText: assetFiles.extractedText,
      retainedTitle: assetFiles.retainedTitle,
      description: assetFiles.description,
    })
    .from(assetFiles)
    .where(
      and(
        eq(assetFiles.id, item.documentId),
        eq(assetFiles.accountId, item.accountId),
        isNull(assetFiles.deletedAt),
      ),
    )
    .limit(1);

  if (!doc) return {};
  if (!doc.extractedText) return {};

  let analysisFields: Record<string, unknown> = {};

  // Use AI-extracted fields from the enrich pipeline
  if (item.metadata?.aiExtractedFields) {
    const aiFields = item.metadata.aiExtractedFields as Record<string, unknown>;
    // Prefix them as document_extracted_* for the dependency graph
    for (const [k, v] of Object.entries(aiFields)) {
      if (!isEmptyValue(v) && !analysisFields[`document_extracted_${k}`]) {
        analysisFields[`document_extracted_${k}`] = v;
      }
    }
  }

  return analysisFields;
}

function extractFieldsFromAnalysis(
  analysis: Record<string, unknown>,
  documentType?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  // Map analysis result fields to document_extracted_* prefixes
  const fieldMappings: Record<string, string[]> = {
    document_extracted_name: ['name', 'title', 'subject'],
    document_extracted_address: ['address', 'address1', 'streetAddress'],
    document_extracted_city: ['city', 'town', 'commune'],
    document_extracted_postal_code: ['postalCode', 'postal_code', 'zipCode'],
    document_extracted_surface: ['livingArea', 'surface', 'area', 'squareMeters'],
    document_extracted_land_surface: ['landArea', 'landSurface', 'terrain'],
    document_extracted_rooms: ['roomCount', 'rooms', 'pieces'],
    document_extracted_bedrooms: ['bedroomCount', 'bedrooms', 'chambres'],
    document_extracted_construction_year: ['constructionYear', 'yearBuilt', 'anneeConstruction'],
    document_extracted_dpe: ['dpeClass', 'dpe', 'energyClass'],
    document_extracted_ges: ['gesClass', 'ges', 'ghgClass'],
    document_extracted_vin: ['vin', 'chassisNumber'],
    document_extracted_registration: ['registrationNumber', 'registration', 'immatriculation'],
    document_extracted_make: ['make', 'marque', 'brand'],
    document_extracted_model: ['model', 'modele'],
    document_extracted_year: ['year', 'annee', 'modelYear'],
    document_extracted_mileage: ['mileage', 'kilometrage', 'odometer'],
    document_extracted_fuel: ['fuelType', 'fuel', 'carburant'],
    document_extracted_power: ['fiscalHp', 'power', 'puissance', 'cv'],
    document_extracted_brand: ['brand', 'marque', 'make'],
    document_extracted_serial_number: ['serialNumber', 'serial', 'serialNo', 'numeroSerie'],
    document_extracted_condition: ['condition', 'etat', 'state'],
  };

  for (const [docField, candidates] of Object.entries(fieldMappings)) {
    for (const candidate of candidates) {
      const val = analysis[candidate] ?? analysis[candidate.toLowerCase()];
      if (!isEmptyValue(val)) {
        fields[docField] = normalizeFieldValue(docField.replace('document_extracted_', ''), val);
        break;
      }
    }
  }

  return fields;
}

async function extractAssetChangedFields(item: ImpactQueueItem): Promise<Record<string, unknown>> {
  return item.metadata?.changedFields as Record<string, unknown> ?? {};
}

async function extractAgendaFields(item: ImpactQueueItem): Promise<Record<string, unknown>> {
  if (!item.agendaItemId) return {};

  const [agendaItem] = await db
    .select()
    .from(agendaItems)
    .where(eq(agendaItems.id, item.agendaItemId))
    .limit(1);

  if (!agendaItem) return {};

  // An agenda item change can trigger re-evaluation of associated asset
  return {
    agenda_date: agendaItem.startDate?.split('T')[0],
    agenda_type: agendaItem.originType,
  };
}

async function loadAsset(assetId: number, accountId: number): Promise<AssetData | null> {
  const [row] = await db
    .select({
      id: assets.id,
      accountId: assets.accountId,
      name: assets.name,
      category: assets.category,
      keyCharacteristics: assets.keyCharacteristics,
    })
    .from(assets)
    .where(
      and(
        eq(assets.id, assetId),
        eq(assets.accountId, accountId),
        isNull(assets.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  let kc: Record<string, unknown> = {};
  try { kc = row.keyCharacteristics ? JSON.parse(row.keyCharacteristics) : {}; } catch {}

  return {
    id: row.id,
    accountId: row.accountId!,
    name: row.name,
    category: row.category,
    keyCharacteristics: kc,
  };
}

// ─── Agenda Item Creation ──────────────────────────────────────────────────

async function createOrUpdateAgendaItem(
  accountId: number,
  assetId: number,
  fieldKey: string,
  dateValue: string,
  triggerType: string,
): Promise<boolean> {
  // Map field to event type
  const eventTypeMap: Record<string, string> = {
    acquisitionDate: 'acquisition',
    insuranceExpiry: 'assurance_expiration',
    nextInspection: 'controle_technique',
    warrantyEnd: 'garantie_expiration',
    lastRevision: 'revision',
    leaseEnd: 'bail_expiration',
  };

  const eventType = eventTypeMap[fieldKey] ?? 'echeance';
  const labelMap: Record<string, string> = {
    acquisitionDate: 'Date d\'acquisition',
    insuranceExpiry: 'Échéance assurance',
    nextInspection: 'Prochain contrôle technique',
    warrantyEnd: 'Fin de garantie',
    lastRevision: 'Dernière révision',
    leaseEnd: 'Fin de bail',
  };
  const label = labelMap[fieldKey] ?? `Échéance ${fieldKey}`;

  const date = new Date(dateValue);
  if (isNaN(date.getTime())) return false;

  // Check if agenda item already exists for this asset + event type + date
  const [existing] = await db
    .select({ id: agendaItems.id })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.accountId, accountId),
        // @ts-expect-error — assetId, eventType exist in DB but not in drizzle schema
        eq(agendaItems.assetId, assetId),
        // @ts-expect-error — same reason
        eq(agendaItems.eventType, eventType),
      ) as any,
    )
    .orderBy(agendaItems.startDate)
    .limit(1);

  if (existing) {
    // Update existing agenda item
    await db
      .update(agendaItems)
      .set({
        startDate: date,
        updatedAt: new Date() as any,
      } as any)
      .where(eq(agendaItems.id, existing.id));
    return true;
  }

  // Create new agenda item
  await db.insert(agendaItems).values({
    accountId,
    startDate: date,
    eventType,
    label,
    originType: 'asset_field',
    source: 'impact_propagation',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
  return true;
}

// ─── Main Processor ────────────────────────────────────────────────────────

/**
 * Process a single impact queue item through the propagation engine.
 */
export async function processImpact(item: ImpactQueueItem): Promise<PropagationResult> {
  const result: PropagationResult = {
    impactsResolved: 0,
    fieldsApplied: 0,
    fieldsProposed: 0,
    fieldsConflicted: 0,
    agendaItemsCreated: 0,
    searchUpdatesTriggered: 0,
    errors: 0,
  };

  try {
    // 1. Extract changed fields from the event
    const changedFields = await extractChangedFields(item);
    const fieldKeys = Object.keys(changedFields);
    if (fieldKeys.length === 0) {
      await complete(item.id, { reason: 'no_changed_fields' });
      return result;
    }

    // 2. If this is about a specific asset, process asset-level impacts
    if (item.assetId) {
      const assetData = await loadAsset(item.assetId, item.accountId);
      if (!assetData) {
        await complete(item.id, { reason: 'asset_not_found_or_deleted' });
        return result;
      }

      // 3. Compute a hash of current state to avoid redundant processing
      const currentStateHash = computeHash({
        assetId: assetData.id,
        category: assetData.category,
        kc: assetData.keyCharacteristics,
        changedFields,
      });

      // 4. Apply each changed field through the dependency graph
      for (const [sourceField, newValue] of Object.entries(changedFields)) {
        if (isEmptyValue(newValue)) continue;

        // 5. Resolve dependencies for this source field
        const deps = await resolveImpacts(sourceField, assetData.category);
        result.impactsResolved += deps.length;

        for (const dep of deps) {
          try {
            await processDependency(
              dep,
              assetData,
              sourceField,
              newValue,
              result,
            );
          } catch (err) {
            result.errors++;
            console.error(`[impact-propagation] Error processing dep ${dep.sourceField}→${dep.targetField} for asset ${assetData.id}:`, err);
          }
        }
      }

      // 6. Record version for change tracking
      await recordVersion('asset', item.assetId, item.accountId, currentStateHash, {
        triggerType: item.triggerType,
        lastProcessed: new Date().toISOString(),
      });
    }

    // 7. If this is a document-level event without asset linkage, just record version
    if (item.documentId && !item.assetId) {
      await recordVersion('document', item.documentId, item.accountId, computeHash({ changedFields }), {
        triggerType: item.triggerType,
      });
    }

    // 8. Mark the impact as completed
    await complete(item.id, {
      fieldsApplied: result.fieldsApplied,
      fieldsProposed: result.fieldsProposed,
      fieldsConflicted: result.fieldsConflicted,
      agendaItemsCreated: result.agendaItemsCreated,
    });

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[impact-propagation] Fatal error processing impact ${item.id}:`, errorMsg);
    await fail(item.id, errorMsg);
    result.errors++;
  }

  return result;
}

async function processDependency(
  dep: DependencyRule,
  asset: AssetData,
  sourceField: string,
  newValue: unknown,
  result: PropagationResult,
): Promise<void> {
  const targetField = dep.targetField;

  switch (dep.impactType) {
    case 'propagation':
      await handleFieldPropagation(dep, asset, targetField, newValue, result);
      break;

    case 'agenda_creation':
      if (typeof newValue === 'string' || typeof newValue === 'number') {
        const dateStr = String(newValue);
        if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
          const created = await createOrUpdateAgendaItem(
            asset.accountId, asset.id, targetField, dateStr, dep.sourceField,
          );
          if (created) result.agendaItemsCreated++;
        }
      }
      break;

    case 'recalculation':
      // Mark for recalculation — triggers a lightweight re-evaluation
      await queueRecalculation(asset, targetField, newValue, dep.confidence, result);
      break;

    case 'index_update':
      // Trigger search index update
      result.searchUpdatesTriggered++;
      break;
  }
}

async function handleFieldPropagation(
  dep: DependencyRule,
  asset: AssetData,
  targetField: string,
  newValue: unknown,
  result: PropagationResult,
): Promise<void> {
  // Get the current value from keyCharacteristics or asset-level columns
  const currentValue = getCurrentFieldValue(asset, targetField);

  // Determine what action to take
  const { action, reason } = await determineAction(
    asset.id, targetField, currentValue, newValue, dep.confidence as 'certain' | 'probable' | 'conflictual',
  );

  switch (action) {
    case 'apply':
      // Auto-apply: update the field value
      if (reason === 'values_match') {
        // No change needed
        return;
      }
      await applyFieldValue(asset, targetField, newValue, dep.sourceField);
      result.fieldsApplied++;
      break;

    case 'propose':
      // Create a proposal for user validation
      await createInconsistency({
        accountId: asset.accountId,
        assetId: asset.id,
        fieldKey: targetField,
        currentValue: currentValue != null ? String(currentValue) : null,
        proposedValue: String(newValue),
        sourceType: 'ai_extraction',
        sourceDetail: `from "${dep.sourceField}" (confidence: ${dep.confidence})`,
        inconsistencyType: 'probable',
      });
      result.fieldsProposed++;
      break;

    case 'conflict':
      // Create a real conflict
      await createInconsistency({
        accountId: asset.accountId,
        assetId: asset.id,
        fieldKey: targetField,
        currentValue: currentValue != null ? String(currentValue) : null,
        proposedValue: String(newValue),
        sourceType: 'ai_extraction',
        sourceDetail: `from "${dep.sourceField}" (confidence: ${dep.confidence}) — conflict with existing value`,
        inconsistencyType: 'conflictual',
      });
      result.fieldsConflicted++;
      break;
  }
}

function getCurrentFieldValue(asset: AssetData, fieldKey: string): unknown {
  // Check asset-level columns
  const assetColumnMap: Record<string, keyof typeof assets> = {
    name: 'name',
    address: 'address',
    city: 'city',
    postalCode: 'postalCode',
    registrationNumber: 'registrationNumber',
  };

  const dbColumn = assetColumnMap[fieldKey];
  if (dbColumn) {
    const raw = asset[dbColumn as keyof AssetData] as unknown;
    if (!isEmptyValue(raw)) return raw;
  }

  // Check keyCharacteristics
  if (fieldKey in asset.keyCharacteristics) {
    return asset.keyCharacteristics[fieldKey];
  }

  return null;
}

async function applyFieldValue(
  asset: AssetData,
  fieldKey: string,
  value: unknown,
  sourceField: string,
): Promise<void> {
  // Protection : ne jamais écrire un champ qui n'appartient pas à la catégorie du bien
  if (fieldKey !== 'name' && !isFieldAllowedForCategory(fieldKey, asset.category)) return;

  const normalized = normalizeFieldValue(fieldKey, value);
  if (normalized === null) return;

  // Auto-resolve any existing inconsistency for this field
  await autoResolveForField(asset.id, fieldKey);

  // Apply to asset-level columns
  const assetColumnUpdates: Record<string, unknown> = {};
  const assetColumnMap: Record<string, string> = {
    name: 'name',
    address: 'address',
    city: 'city',
    postalCode: 'postalCode',
    registrationNumber: 'registrationNumber',
  };

  if (assetColumnMap[fieldKey]) {
    assetColumnUpdates[assetColumnMap[fieldKey]] = normalized;
  }

  // Apply to keyCharacteristics
  const updatedKc = { ...asset.keyCharacteristics };
  if (!assetColumnMap[fieldKey]) {
    updatedKc[fieldKey] = normalized;
  }
  assetColumnUpdates.keyCharacteristics = JSON.stringify(updatedKc);
  assetColumnUpdates.updatedAt = new Date();

  // Also trigger propagation for updated fields (chain reaction)
  // This field itself becomes the source for downstream dependencies

  await db.update(assets)
    .set(assetColumnUpdates as any)
    .where(and(eq(assets.id, asset.id), eq(assets.accountId, asset.accountId)));

  // Enqueue chained impacts for downstream fields
  const changedFields: Record<string, unknown> = {};
  changedFields[fieldKey] = normalized;
  await enqueue({
    accountId: asset.accountId,
    assetId: asset.id,
    triggerType: 'asset_updated',
    source: `impact_propagation:${sourceField}→${fieldKey}`,
    metadata: { changedFields },
    priority: -1, // Chained impacts run at lower priority
  });
}

async function queueRecalculation(
  asset: AssetData,
  fieldKey: string,
  value: unknown,
  confidence: string,
  result: PropagationResult,
): Promise<void> {
  // For recalculations, we just mark the field and let the nightly catch-up handle it
  // or the user can trigger a recalculation manually
  if (fieldKey === 'valuation' && confidence === 'certain') {
    // High-confidence recalculation → immediate
    await enqueue({
      accountId: asset.accountId,
      assetId: asset.id,
      triggerType: 'asset_updated',
      source: `recalculation:${fieldKey}`,
      metadata: {
        changedFields: { estimatedValue: value },
        requiresRevaluation: true,
      },
      priority: 0,
    });
  }
}

// ─── Batch Processing ──────────────────────────────────────────────────────

/**
 * Process pending impacts in batch, up to the specified limit.
 * Returns aggregated results.
 */
export async function processPendingImpacts(
  limit = 25,
  accountId?: number,
): Promise<PropagationResult> {
  const result: PropagationResult = {
    impactsResolved: 0,
    fieldsApplied: 0,
    fieldsProposed: 0,
    fieldsConflicted: 0,
    agendaItemsCreated: 0,
    searchUpdatesTriggered: 0,
    errors: 0,
  };

  const items = await dequeueBatch(limit, accountId);

  for (const item of items) {
    try {
      const itemResult = await processImpact(item);
      aggregateResults(result, itemResult);
    } catch (err) {
      result.errors++;
      console.error(`[impact-propagation] Batch error on item ${item.id}:`, err);
      await fail(item.id, err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return result;
}

function aggregateResults(target: PropagationResult, source: PropagationResult): void {
  target.impactsResolved += source.impactsResolved;
  target.fieldsApplied += source.fieldsApplied;
  target.fieldsProposed += source.fieldsProposed;
  target.fieldsConflicted += source.fieldsConflicted;
  target.agendaItemsCreated += source.agendaItemsCreated;
  target.searchUpdatesTriggered += source.searchUpdatesTriggered;
  target.errors += source.errors;
}

// ─── Event Emitters ────────────────────────────────────────────────────────

/**
 * Emit an impact event when a document is analyzed.
 * Called by the document analysis pipeline after successful analysis.
 */
export async function emitDocumentAnalyzed(
  accountId: number,
  documentId: number,
  assetId?: number | null,
  aiExtractedFields?: Record<string, unknown>,
): Promise<void> {
  await enqueue({
    accountId,
    assetId: assetId ?? null,
    documentId,
    triggerType: 'document_analyzed',
    source: 'document_analysis_pipeline',
    priority: 10, // High priority — documents usually bring fresh data
    metadata: { aiExtractedFields: aiExtractedFields ?? {} },
  });
}

/**
 * Emit an impact event when a user edits asset fields manually.
 */
export async function emitUserFieldEdit(
  accountId: number,
  assetId: number,
  changedFields: Record<string, unknown>,
): Promise<void> {
  // User edits auto-resolve any existing inconsistencies for the changed fields
  for (const fieldKey of Object.keys(changedFields)) {
    await autoResolveForField(assetId, fieldKey);
  }

  await enqueue({
    accountId,
    assetId,
    triggerType: 'user_field_edit',
    source: 'user_manual_edit',
    priority: 5,
    metadata: { changedFields },
  });
}

/**
 * Emit an impact event when an asset is updated by the AI enrichment pipeline.
 */
export async function emitAssetUpdated(
  accountId: number,
  assetId: number,
  changedFields: Record<string, unknown>,
): Promise<void> {
  await enqueue({
    accountId,
    assetId,
    triggerType: 'asset_updated',
    source: 'ai_enrichment_pipeline',
    priority: 5,
    metadata: { changedFields },
  });
}

/**
 * Emit an impact event when an agenda item is created.
 */
export async function emitAgendaItemCreated(
  accountId: number,
  assetId: number,
  agendaItemId: number,
): Promise<void> {
  await enqueue({
    accountId,
    assetId,
    agendaItemId,
    triggerType: 'agenda_item_created',
    source: 'agenda_pipeline',
    priority: 3,
    metadata: {},
  });
}

/**
 * Trigger a manual re-propagation for a specific asset.
 */
export async function emitManualRePropagation(
  accountId: number,
  assetId: number,
): Promise<void> {
  await enqueue({
    accountId,
    assetId,
    triggerType: 'manual_request',
    source: 'user_manual_request',
    priority: 10,
    metadata: { fullRePropagation: true },
  });
}
