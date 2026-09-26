/**
 * POST /api/admin/ai/reconciliation/accounts/[accountId] — lance T3 sur un
 *   compte (déclenchement manuel, tracé avec l'administrateur). Corps
 *   optionnel : { scope: 'full' | 'incremental' } (défaut : full).
 * GET  /api/admin/ai/reconciliation/accounts/[accountId] — dernières
 *   exécutions T3 du compte, avec leur résultat consolidé.
 *
 * CDC BO IA WF-11, T3-011, OPS-001 (lot IA 2) : le lancement manuel MET EN
 * FILE DURABLE un travail `origin = manual` (toujours une nouvelle exécution,
 * sans déduplication) au lieu d'exécuter la réconciliation dans la requête
 * HTTP — qui expirait sur un gros compte et échappait au backoff, à la relance
 * et à l'écran File IA. Réponse 202 avec l'identifiant du job.
 *
 * Refus explicite (409 AI_BLOCKED) si T3 est coupé ou l'arrêt d'urgence
 * engagé : la demande ne serait pas exécutée, l'accepter tromperait l'admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { ensureMigrations, pgClient } from '@/db';
import { canStart } from '@/services/ai/queue/job-queue.repository';
import { enqueueT3Manual } from '@/services/ai/reconciliation/t3-queue';

type Ctx = { params: Promise<{ accountId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  let adminId: number;
  try { adminId = await requireAdmin(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  await ensureMigrations();

  const accountId = Number((await params).accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) return NextResponse.json({ error: 'INVALID_ACCOUNT' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const scope = body.scope === 'incremental' ? 'incremental' : 'full';

  if (!(await canStart('T3'))) {
    return NextResponse.json({ error: 'AI_BLOCKED', message: 'T3 est désactivé, suspendu, ou l’arrêt d’urgence est engagé.' }, { status: 409 });
  }
  // Déclencheur manuel tracé : { type: 'manual', requestedByUserId: adminId }
  // est reconstitué par l'exécutant à partir du contexte du job.
  const jobId = await enqueueT3Manual(accountId, adminId, scope);
  return NextResponse.json({ queued: true, jobId, accountId, scope }, { status: 202 });
}

export async function GET(req: NextRequest, { params }: Ctx) {
  try { await requireAdmin(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  await ensureMigrations();
  const accountId = Number((await params).accountId);
  const runs = await pgClient.unsafe(
    `SELECT id, trigger_type, trigger_event, scope, status, requested_by_user_id, started_at, finished_at,
            objects_examined, objects_modified, decisions_applied, conflicts_created, arbitrations_needed,
            errors, ai_calls, details_json
       FROM account_reconciliation_runs WHERE account_id = $1 ORDER BY id DESC LIMIT 20`,
    [accountId] as never[],
  );
  return NextResponse.json({ runs });
}
