/**
 * POST /api/admin/ai/reconciliation/accounts/[accountId] — lance T3 sur un
 *   compte (déclenchement manuel, tracé avec l'administrateur). Corps
 *   optionnel : { scope: 'full' | 'incremental' } (défaut : full).
 * GET  /api/admin/ai/reconciliation/accounts/[accountId] — dernières
 *   exécutions T3 du compte, avec leur résultat consolidé.
 *
 * T3 rejoue la cohérence à partir des connaissances persistées : aucune
 * extraction, aucune relecture de fichier. Une exécution déjà en cours sur le
 * compte → 409 (pas de run concurrent).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { ensureMigrations, pgClient } from '@/db';
import { reconcileAccount } from '@/services/ai/reconciliation/account-reconciliation.service';

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

  const result = await reconcileAccount(accountId, { type: 'manual', requestedByUserId: adminId }, { scope });
  if (result.status === 'skipped_concurrent') {
    return NextResponse.json({ error: 'RUN_IN_PROGRESS', message: 'Une exécution T3 est déjà en cours sur ce compte.' }, { status: 409 });
  }
  return NextResponse.json(result);
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
