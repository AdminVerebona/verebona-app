/**
 * GET /api/admin/withdrawals — CDC 6 §16 et §22.
 *
 * Liste des demandes, filtrable par statut. Les demandes à traiter — examen
 * manuel, échec, ancienneté — sont remontées en tête : c'est ce que la
 * supervision du §22 cherche à rendre visible.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db, ensureMigrations } from '@/db';
import { withdrawalRequests } from '@/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';

/** Au-delà, une demande non close est une anomalie (§21). */
const STALE_HOURS = 24;

export async function GET(req: NextRequest) {
  try {
    await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  const statusFilter = req.nextUrl.searchParams.get('status');
  const base = db.select().from(withdrawalRequests).orderBy(desc(withdrawalRequests.requestedAt)).limit(200);
  const rows = statusFilter
    ? await base.where(eq(withdrawalRequests.status, statusFilter))
    : await base;

  const now = Date.now();
  const staleThreshold = now - STALE_HOURS * 3600 * 1000;

  const items = rows.map((r) => ({
    publicReference: r.publicReference,
    status: r.status,
    channel: r.channel,
    requestedAt: r.requestedAt,
    consumerName: `${r.consumerFirstName ?? ''} ${r.consumerLastName ?? ''}`.trim(),
    accountId: r.accountId,
    cancellationStatus: r.cancellationStatus,
    amountExpected: r.amountExpected,
    amountRefunded: r.amountRefunded,
    currency: r.currency,
    failureCode: r.failureCode,
    receiptSentAt: r.receiptSentAt,
    dataDeletionScheduledAt: r.dataDeletionScheduledAt,
    // Signalé plutôt que calculé côté client : le seuil est une règle métier,
    // pas une préférence d'affichage.
    needsAttention:
      ['manual_review', 'failed'].includes(r.status) ||
      (['received', 'processing'].includes(r.status) &&
        r.requestedAt.getTime() < staleThreshold),
  }));

  // Ce qui appelle une intervention d'abord.
  items.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention));

  const counts = await db
    .select({ status: withdrawalRequests.status })
    .from(withdrawalRequests)
    .where(inArray(withdrawalRequests.status,
      ['received', 'manual_review', 'processing', 'completed', 'failed', 'rejected']));

  const byStatus: Record<string, number> = {};
  for (const c of counts) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  return NextResponse.json({
    items,
    byStatus,
    needsAttention: items.filter((i) => i.needsAttention).length,
  });
}
