/**
 * InconsistencyService
 * ─────────────────────
 * Manages the inconsistency registry — stores conflicts between AI-proposed
 * values and user-entered data, and between different document sources.
 *
 * Three confidence levels:
 *   - certain:     automatically applied (no conflict)
 *   - probable:    creates a proposal for user validation
 *   - conflictual: creates a conflict when the target field already has a value
 */

import { db } from '@/db';
import { inconsistencyRegistry } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export type InconsistencyType = 'certain' | 'probable' | 'conflictual';
export type InconsistencyStatus = 'open' | 'accepted' | 'rejected' | 'auto_resolved';

export interface InconsistencyEntry {
  id: number;
  publicId: string;
  accountId: number;
  assetId: number;
  fieldKey: string;
  currentValue: string | null;
  proposedValue: string | null;
  sourceType: string;
  sourceDetail: string | null;
  inconsistencyType: string;
  status: string;
  resolution: string | null;
  resolvedAt: Date | null;
  resolvedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create an inconsistency entry when AI proposes a value that conflicts
 * with existing user data or another source.
 */
export async function createInconsistency(input: {
  accountId: number;
  assetId: number;
  fieldKey: string;
  currentValue: string | null;
  proposedValue: string | null;
  sourceType: string;
  sourceDetail?: string;
  inconsistencyType: InconsistencyType;
}): Promise<InconsistencyEntry> {
  // If there's already an open inconsistency for this field, update it instead
  const existing = await db
    .select()
    .from(inconsistencyRegistry)
    .where(
      and(
        eq(inconsistencyRegistry.assetId, input.assetId),
        eq(inconsistencyRegistry.fieldKey, input.fieldKey),
        eq(inconsistencyRegistry.status, 'open'),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const [row] = await db
      .update(inconsistencyRegistry)
      .set({
        proposedValue: input.proposedValue,
        sourceDetail: input.sourceDetail ?? null,
        inconsistencyType: input.inconsistencyType,
        updatedAt: new Date(),
      } as any)
      .where(eq(inconsistencyRegistry.id, existing[0].id))
      .returning();

    return mapRow(row);
  }

  const [row] = await db
    .insert(inconsistencyRegistry)
    .values({
      accountId: input.accountId,
      assetId: input.assetId,
      fieldKey: input.fieldKey,
      currentValue: input.currentValue,
      proposedValue: input.proposedValue,
      sourceType: input.sourceType,
      sourceDetail: input.sourceDetail ?? null,
      inconsistencyType: input.inconsistencyType,
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    .returning();

  return mapRow(row);
}

/**
 * Resolve an inconsistency (accept proposed value or reject it).
 */
export async function resolveInconsistency(
  id: number,
  resolution: 'accepted' | 'rejected',
  resolvedBy?: number,
): Promise<void> {
  await db
    .update(inconsistencyRegistry)
    .set({
      status: resolution,
      resolution: resolution === 'accepted' ? 'accepted_by_user' : 'rejected_by_user',
      resolvedAt: new Date(),
      resolvedBy: resolvedBy ?? null,
      updatedAt: new Date(),
    } as any)
    .where(eq(inconsistencyRegistry.id, id));
}

/**
 * Auto-resolve all inconsistencies for a given field on an asset
 * (e.g., when the user manually updates the field).
 */
export async function autoResolveForField(
  assetId: number,
  fieldKey: string,
): Promise<number> {
  const result = await db
    .update(inconsistencyRegistry)
    .set({
      status: 'auto_resolved',
      resolution: 'auto_resolved_by_user_update',
      resolvedAt: new Date(),
      updatedAt: new Date(),
    } as any)
    .where(
      and(
        eq(inconsistencyRegistry.assetId, assetId),
        eq(inconsistencyRegistry.fieldKey, fieldKey),
        eq(inconsistencyRegistry.status, 'open'),
      ),
    );

  return result.count ?? 0;
}

/**
 * Get all open inconsistencies for an account or asset.
 */
export async function getOpenInconsistencies(options: {
  accountId?: number;
  assetId?: number;
  limit?: number;
}): Promise<InconsistencyEntry[]> {
  const conditions = [eq(inconsistencyRegistry.status, 'open')];
  if (options.accountId) conditions.push(eq(inconsistencyRegistry.accountId, options.accountId));
  if (options.assetId) conditions.push(eq(inconsistencyRegistry.assetId, options.assetId));

  const rows = await db
    .select()
    .from(inconsistencyRegistry)
    .where(and(...conditions))
    .limit(options.limit ?? 50);

  return rows.map(mapRow);
}

/**
 * Count open inconsistencies for an account.
 */
export async function countOpen(accountId: number): Promise<number> {
  const [row] = await db
    .select({ count: db.$count(inconsistencyRegistry) })
    .from(inconsistencyRegistry)
    .where(
      and(
        eq(inconsistencyRegistry.accountId, accountId),
        eq(inconsistencyRegistry.status, 'open'),
      ),
    );

  return row?.count ?? 0;
}

/**
 * Check if a field has an open inconsistency.
 */
export async function hasOpenInconsistency(
  assetId: number,
  fieldKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: inconsistencyRegistry.id })
    .from(inconsistencyRegistry)
    .where(
      and(
        eq(inconsistencyRegistry.assetId, assetId),
        eq(inconsistencyRegistry.fieldKey, fieldKey),
        eq(inconsistencyRegistry.status, 'open'),
      ),
    )
    .limit(1);

  return !!row;
}

/**
 * Determine the appropriate action for a proposed value:
 *   - 'apply': automatically apply (certain confidence, no existing value)
 *   - 'propose': create a proposal (probable confidence, or field empty but uncertain)
 *   - 'conflict': create a conflict (existing value differs from proposed)
 */
export async function determineAction(
  assetId: number,
  fieldKey: string,
  currentValue: unknown,
  proposedValue: unknown,
  confidence: 'certain' | 'probable' | 'conflictual',
): Promise<{ action: 'apply' | 'propose' | 'conflict'; reason: string }> {
  const currentStr = currentValue != null ? String(currentValue) : null;
  const proposedStr = proposedValue != null ? String(proposedValue) : null;

  // If no value was extracted, nothing to do
  if (!proposedStr || proposedStr.trim() === '') {
    return { action: 'apply', reason: 'no_value_extracted' };
  }

  // If current value is empty / null, apply if certain or probable
  if (!currentStr || currentStr.trim() === '' || currentStr.toLowerCase() === 'null') {
    if (confidence === 'certain') {
      return { action: 'apply', reason: 'empty_field_certain_source' };
    }
    return { action: 'propose', reason: 'empty_field_probable_source' };
  }

  // If same value, skip
  if (currentStr === proposedStr) {
    return { action: 'apply', reason: 'values_match' };
  }

  // User-entered data should never be auto-overwritten
  // Check if the current value was set by user (we trust manual input)
  if (confidence === 'certain') {
    // Even certain AI data shouldn't overwrite user data without conflict
    return { action: 'conflict', reason: 'ai_value_differs_from_user_value' };
  }

  // Probable or conflictual → always create a proposal/conflict
  if (confidence === 'conflictual' || confidence === 'probable') {
    return { action: 'conflict', reason: `proposed_value_differs_confidence_${confidence}` };
  }

  return { action: 'propose', reason: 'fallback_proposal' };
}

function mapRow(row: any): InconsistencyEntry {
  return {
    id: row.id,
    publicId: row.publicId,
    accountId: row.accountId,
    assetId: row.assetId,
    fieldKey: row.fieldKey,
    currentValue: row.currentValue,
    proposedValue: row.proposedValue,
    sourceType: row.sourceType,
    sourceDetail: row.sourceDetail,
    inconsistencyType: row.inconsistencyType,
    status: row.status,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
