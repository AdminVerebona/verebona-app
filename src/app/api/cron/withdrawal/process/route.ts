/**
 * GET /api/cron/withdrawal/process — CDC 6 §10 et §21.
 *
 * Traite les déclarations en attente et reprend celles qui ont échoué.
 *
 * Deux populations :
 *   · `received`  — confirmées mais jamais traitées. Cas nominal : la
 *     déclaration est écrite en synchrone, le traitement Stripe en différé
 *     (§7.4) ;
 *   · `failed`    — reprise automatique. Le §10 prévoit « le traitement des
 *     erreurs et les reprises automatiques ».
 *
 * Répond **409** dès qu'une demande reste en échec après reprise, ou qu'une
 * demande attend depuis plus de vingt-quatre heures. Le §21 fait de ces
 * situations des anomalies à détecter — sans ce signal, une demande bloquée
 * resterait invisible jusqu'à la réclamation du consommateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, ensureMigrations } from '@/db';
import { withdrawalRequests } from '@/db/schema';
import { and, inArray, lt } from 'drizzle-orm';
import { processWithdrawal } from '@/services/withdrawal/withdrawal-processor.service';

/** Au-delà, une demande non traitée est une anomalie (§21). */
const STALE_HOURS = 24;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();
  const now = new Date();

  const pending = await db
    .select({
      publicReference: withdrawalRequests.publicReference,
      status: withdrawalRequests.status,
      requestedAt: withdrawalRequests.requestedAt,
    })
    .from(withdrawalRequests)
    .where(inArray(withdrawalRequests.status, ['received', 'failed', 'processing']))
    .limit(50);

  const outcome = { completed: 0, processing: 0, failed: 0, skipped: 0 };
  const failures: Array<{ reference: string; code?: string }> = [];

  for (const item of pending) {
    const result = await processWithdrawal(item.publicReference, { now });
    if (result.status === 'completed') outcome.completed += 1;
    else if (result.status === 'processing') outcome.processing += 1;
    else if (result.status === 'failed') {
      outcome.failed += 1;
      failures.push({ reference: item.publicReference, code: result.failureCode });
    } else outcome.skipped += 1;
  }

  // Demandes anciennes toujours non réglées : anomalie du §21.
  const staleThreshold = new Date(now.getTime() - STALE_HOURS * 3600 * 1000);
  const stale = await db
    .select({
      publicReference: withdrawalRequests.publicReference,
      requestedAt: withdrawalRequests.requestedAt,
      status: withdrawalRequests.status,
    })
    .from(withdrawalRequests)
    .where(
      and(
        inArray(withdrawalRequests.status, ['received', 'failed', 'processing']),
        lt(withdrawalRequests.requestedAt, staleThreshold),
      ),
    );

  return NextResponse.json(
    { processed: pending.length, outcome, failures, stale },
    { status: outcome.failed > 0 || stale.length > 0 ? 409 : 200 },
  );
}
