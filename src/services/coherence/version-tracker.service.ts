/**
 * VersionTrackerService
 * ──────────────────────
 * Tracks content hashes and versions for objects (assets, documents, agenda items)
 * to avoid reprocessing unchanged data. The nightly batch must not re-process
 * objects whose hash hasn't changed.
 *
 * Hash strategy: SHA-256 of a canonical JSON serialisation of the object's
 * relevant fields. Only fields that can actually impact propagation are included.
 */

import { db } from '@/db';
import { objectVersions } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { createHash } from 'crypto';

export type ObjectType = 'asset' | 'document' | 'agenda_item' | 'equipment' | 'supplier';

interface VersionEntry {
  id: number;
  objectType: ObjectType;
  objectId: number;
  accountId: number;
  contentHash: string;
  version: number;
  lastVerifiedAt: Date | null;
  lastChangedAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Compute a deterministic hash for an object given its relevant fields.
 * Only include fields that can trigger impact propagation.
 */
export function computeHash(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Check if an object has changed by comparing its current hash with the stored one.
 * Returns true if the object is unchanged (same hash).
 */
export async function isUnchanged(
  objectType: ObjectType,
  objectId: number,
  accountId: number,
  currentHash: string,
): Promise<boolean> {
  const [row] = await db
    .select({ contentHash: objectVersions.contentHash })
    .from(objectVersions)
    .where(
      and(
        eq(objectVersions.objectType, objectType),
        eq(objectVersions.objectId, objectId),
        eq(objectVersions.accountId, accountId),
      ),
    )
    .limit(1);

  if (!row) return false;
  return row.contentHash === currentHash;
}

/**
 * Record or update the version entry for an object.
 * Increments the version counter only if the hash changed.
 */
export async function recordVersion(
  objectType: ObjectType,
  objectId: number,
  accountId: number,
  contentHash: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const existing = await db
    .select()
    .from(objectVersions)
    .where(
      and(
        eq(objectVersions.objectType, objectType),
        eq(objectVersions.objectId, objectId),
        eq(objectVersions.accountId, accountId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    const hashChanged = row.contentHash !== contentHash;

    await db
      .update(objectVersions)
      .set({
        contentHash,
        version: hashChanged ? sql`version + 1` : row.version,
        lastChangedAt: hashChanged ? new Date() : row.lastChangedAt,
        lastVerifiedAt: new Date(),
        metadata: { ...(row.metadata as Record<string, unknown>), ...metadata },
        updatedAt: new Date(),
      } as any)
      .where(eq(objectVersions.id, row.id));
  } else {
    await db.insert(objectVersions).values({
      objectType,
      objectId,
      accountId,
      contentHash,
      version: 1,
      lastChangedAt: new Date(),
      lastVerifiedAt: new Date(),
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  }
}

/**
 * Get version info for an object.
 */
export async function getVersion(
  objectType: ObjectType,
  objectId: number,
  accountId: number,
): Promise<VersionEntry | null> {
  const [row] = await db
    .select()
    .from(objectVersions)
    .where(
      and(
        eq(objectVersions.objectType, objectType),
        eq(objectVersions.objectId, objectId),
        eq(objectVersions.accountId, accountId),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    objectType: row.objectType as ObjectType,
    objectId: row.objectId,
    accountId: row.accountId,
    contentHash: row.contentHash,
    version: row.version,
    lastVerifiedAt: row.lastVerifiedAt,
    lastChangedAt: row.lastChangedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

/**
 * Mark a batch of objects as verified without changing their hash.
 * Used by the nightly catch-up to reset staleness tracking.
 */
export async function markVerified(
  objectType: ObjectType,
  accountId: number,
  olderThan: Date,
): Promise<number> {
  const result = await db
    .update(objectVersions)
    .set({ lastVerifiedAt: new Date(), updatedAt: new Date() } as any)
    .where(
      and(
        eq(objectVersions.objectType, objectType),
        eq(objectVersions.accountId, accountId),
        sql`${objectVersions.lastVerifiedAt} IS NULL OR ${objectVersions.lastVerifiedAt} < ${olderThan}`,
      ),
    );

  return result.count ?? 0;
}
