/**
 * ImpactQueueService
 * ──────────────────
 * Manages the impact queue: enqueue, dequeue, lock, retry, complete.
 * Supports priority-based ordering and scheduled processing.
 *
 * This is the central event bus for the impact propagation system.
 * All source events (document analysis, manual updates, agenda triggers)
 * are enqueued here and processed by the propagation engine.
 */

import { db } from '@/db';
import { impactQueue } from '@/db/schema';
import { eq, and, or, lt, isNull, sql } from 'drizzle-orm';

export type ImpactStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
export type TriggerType =
  | 'document_analyzed'
  | 'document_modified'
  | 'asset_updated'
  | 'user_field_edit'
  | 'agenda_item_created'
  | 'batch_catchup'
  | 'manual_request';

export interface EnqueueImpactInput {
  accountId: number;
  assetId?: number | null;
  documentId?: number | null;
  agendaItemId?: number | null;
  triggerType: TriggerType;
  triggerReason?: string;
  source: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  scheduledFor?: Date;
  requiresAiReview?: boolean;
}

export interface ImpactQueueItem {
  id: number;
  publicId: string;
  accountId: number;
  assetId: number | null;
  documentId: number | null;
  agendaItemId: number | null;
  triggerType: string;
  triggerReason: string | null;
  source: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  metadata: Record<string, unknown>;
  scheduledFor: Date | null;
  lockedUntil: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const QUEUE_LOCK_TIMEOUT_MS = 300_000; // 5 min before another worker can pick up

/**
 * Enqueue a new impact event.
 */
export async function enqueue(input: EnqueueImpactInput): Promise<ImpactQueueItem> {
  const metadata = { ...(input.metadata ?? {}) };
  if (input.requiresAiReview) {
    metadata.requires_ai_review = true;
  }

  const [row] = await db
    .insert(impactQueue)
    .values({
      accountId: input.accountId,
      assetId: input.assetId ?? null,
      documentId: input.documentId ?? null,
      agendaItemId: input.agendaItemId ?? null,
      triggerType: input.triggerType,
      triggerReason: input.triggerReason ?? null,
      source: input.source,
      status: 'pending',
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: 3,
      metadata: metadata as any,
      scheduledFor: input.scheduledFor ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)
    .returning();

  return mapRow(row);
}

/**
 * Enqueue multiple impact events in batch.
 */
export async function enqueueBatch(inputs: EnqueueImpactInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  const values = inputs.map(input => ({
    accountId: input.accountId,
    assetId: input.assetId ?? null,
    documentId: input.documentId ?? null,
    agendaItemId: input.agendaItemId ?? null,
    triggerType: input.triggerType,
    triggerReason: input.triggerReason ?? null,
    source: input.source,
    status: 'pending' as const,
    priority: input.priority ?? 0,
    attempts: 0,
    maxAttempts: 3,
    metadata: (input.metadata ?? {}) as any,
    scheduledFor: input.scheduledFor ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const result = await db.insert(impactQueue).values(values as any).returning({ id: impactQueue.id });
  return result.length;
}

/**
 * Convenience wrapper: enqueue an impact that requires an AI review pass.
 * These items get `requires_ai_review: true` in metadata so the hourly
 * enrichment cron can pick them up for targeted AI processing (rare).
 */
export async function enqueueForAiReview(input: EnqueueImpactInput): Promise<ImpactQueueItem> {
  return enqueue({ ...input, requiresAiReview: true });
}

/**
 * Dequeue pending items that are flagged for AI review.
 * Only dequeues up to `limit` items. Used by the hourly enrichment cron
 * to perform targeted AI calls only on items explicitly marked.
 */
export async function dequeueAiReviewItems(limit = 5): Promise<ImpactQueueItem[]> {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + QUEUE_LOCK_TIMEOUT_MS);

  // Find pending items with requires_ai_review flag in metadata
  const rows = await db
    .update(impactQueue)
    .set({
      status: 'processing',
      lockedUntil: lockUntil,
      attempts: sql`attempts + 1`,
      updatedAt: now,
    } as any)
    .where(
      and(
        eq(impactQueue.status, 'pending'),
        sql`metadata @> '{"requires_ai_review": true}'`,
        or(isNull(impactQueue.lockedUntil), lt(impactQueue.lockedUntil, now)),
        or(isNull(impactQueue.scheduledFor), lt(impactQueue.scheduledFor, sql`NOW()`)),
      ),
    )
    .returning();

  return rows.slice(0, limit).map(mapRow);
}

/**
 * Check if there are pending items flagged for AI review.
 */
export async function hasAiReviewItems(): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(impactQueue)
    .where(
      and(
        eq(impactQueue.status, 'pending'),
        sql`metadata @> '{"requires_ai_review": true}'`,
      ),
    )
    .limit(1);

  return (row?.count ?? 0) > 0;
}

/**
 * Dequeue the next pending impact, locking it atomically.
 * Returns null if no pending items.
 */
export async function dequeue(accountId?: number): Promise<ImpactQueueItem | null> {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + QUEUE_LOCK_TIMEOUT_MS);

  // Build conditions: pending + not locked + scheduled_for past or null
  const conditions = and(
    eq(impactQueue.status, 'pending'),
    or(isNull(impactQueue.lockedUntil), lt(impactQueue.lockedUntil, now)),
    or(isNull(impactQueue.scheduledFor), lt(impactQueue.scheduledFor, sql`NOW()`)),
  );

  const whereClause = accountId
    ? and(conditions, eq(impactQueue.accountId, accountId))
    : conditions;

  // Atomically lock one item
  const [row] = await db
    .update(impactQueue)
    .set({
      status: 'processing',
      lockedUntil: lockUntil,
      attempts: sql`attempts + 1`,
      updatedAt: now,
    } as any)
    .where(whereClause)
    .returning();

  if (!row) return null;
  return mapRow(row);
}

/**
 * Dequeue multiple pending impacts in batch.
 */
export async function dequeueBatch(limit = 10, accountId?: number): Promise<ImpactQueueItem[]> {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + QUEUE_LOCK_TIMEOUT_MS);

  const conditions = and(
    eq(impactQueue.status, 'pending'),
    or(isNull(impactQueue.lockedUntil), lt(impactQueue.lockedUntil, now)),
    or(isNull(impactQueue.scheduledFor), lt(impactQueue.scheduledFor, sql`NOW()`)),
  );

  const whereClause = accountId
    ? and(conditions, eq(impactQueue.accountId, accountId))
    : conditions;

  const rows = await db
    .update(impactQueue)
    .set({
      status: 'processing',
      lockedUntil: lockUntil,
      attempts: sql`attempts + 1`,
      updatedAt: now,
    } as any)
    .where(whereClause)
    .returning();

  return rows.slice(0, limit).map(mapRow);
}

/**
 * Mark an impact as completed.
 */
export async function complete(id: number, resultMetadata?: Record<string, unknown>): Promise<void> {
  await db
    .update(impactQueue)
    .set({
      status: 'completed',
      completedAt: new Date(),
      lockedUntil: null,
      metadata: resultMetadata ? sql`metadata || ${JSON.stringify(resultMetadata)}::jsonb` : undefined,
      updatedAt: new Date(),
    } as any)
    .where(eq(impactQueue.id, id));
}

/**
 * Mark an impact as failed. Will be retried if attempts < maxAttempts.
 */
export async function fail(id: number, error: string): Promise<void> {
  const [row] = await db
    .select({ attempts: impactQueue.attempts, maxAttempts: impactQueue.maxAttempts })
    .from(impactQueue)
    .where(eq(impactQueue.id, id))
    .limit(1);

  if (!row) return;

  const isFinal = row.attempts >= row.maxAttempts;

  await db
    .update(impactQueue)
    .set({
      status: isFinal ? 'failed' : 'pending',
      lastError: error,
      lockedUntil: null,
      updatedAt: new Date(),
    } as any)
    .where(eq(impactQueue.id, id));
}

/**
 * Mark an impact as skipped (no-op).
 */
export async function skip(id: number, reason: string): Promise<void> {
  await db
    .update(impactQueue)
    .set({
      status: 'skipped',
      lastError: reason,
      lockedUntil: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    } as any)
    .where(eq(impactQueue.id, id));
}

/**
 * Get queue statistics for monitoring.
 */
export async function getQueueStats(accountId?: number): Promise<{
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
}> {
  const whereClause = accountId ? eq(impactQueue.accountId, accountId) : undefined;

  const rows = await db
    .select({
      status: impactQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(impactQueue)
    .where(whereClause)
    .groupBy(impactQueue.status);

  const result = { pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 };
  for (const r of rows) {
    const key = r.status as keyof typeof result;
    if (key in result) result[key] = r.count;
  }
  return result;
}

/**
 * Recover stale processing items (e.g., after a crash).
 */
export async function recoverStaleItems(olderThanMs = QUEUE_LOCK_TIMEOUT_MS): Promise<number> {
  const threshold = new Date(Date.now() - olderThanMs);

  const result = await db
    .update(impactQueue)
    .set({
      status: 'pending',
      lockedUntil: null,
      lastError: 'recovered after timeout',
      updatedAt: new Date(),
    } as any)
    .where(
      and(
        eq(impactQueue.status, 'processing'),
        lt(impactQueue.lockedUntil, threshold),
      ),
    );

  return result.count ?? 0;
}

function mapRow(row: any): ImpactQueueItem {
  return {
    id: row.id,
    publicId: row.publicId,
    accountId: row.accountId,
    assetId: row.assetId,
    documentId: row.documentId,
    agendaItemId: row.agendaItemId,
    triggerType: row.triggerType,
    triggerReason: row.triggerReason,
    source: row.source,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    metadata: row.metadata ?? {},
    scheduledFor: row.scheduledFor,
    lockedUntil: row.lockedUntil,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
