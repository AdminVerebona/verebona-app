import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { listScheduledTasks, runTaskNow } from '@/services/scheduling/scheduled-task-runner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * POST /api/admin/ops/scheduled-tasks/:code/run — exécution manuelle
 * immédiate d'une tâche planifiée interne (lot 25).
 *
 * Même exclusivité que le planificateur : refusée si une exécution est déjà
 * en cours (sur n'importe quelle instance). Attend la fin au plus 20 s :
 *   200 { result: 'finished', status: 'ok' | 'error', skipped, error, durationMs, task }
 *   202 { result: 'running', task }       — se poursuit en arrière-plan
 *   404 TASK_NOT_FOUND · 409 TASK_RUNNING · 409 TASK_DISABLED (arrêt d'urgence)
 * L'échéance planifiée n'est pas modifiée. Journalisé dans l'audit admin
 * (AUD-001 : administrateur et son e-mail, tentative, refus, résultat).
 * Corps facultatif : `{ reason?: string }` — motif libre (500 caractères au
 * plus), consigné dans l'audit.
 */

const MAX_REASON = 500;
export async function POST(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    return NextResponse.json({ error: 'Vérification impossible', code: 'GUARD_FAILED' }, { status: 500, headers: NO_STORE });
  }

  const code = String((await params).code ?? '').slice(0, 80);
  // E-mail de la session (évite une lecture en base ; à défaut, le journal la fait).
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
  if (body?.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    return NextResponse.json({ error: 'Motif invalide', code: 'INVALID_REASON' }, { status: 400, headers: NO_STORE });
  }
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, MAX_REASON) : null;
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId, adminEmail, action: 'SCHEDULED_TASK_RUN', targetType: 'SCHEDULED_TASK', targetId: null, result,
    details: { code, reason, ...details },
  });
  const view = async () => (await listScheduledTasks()).find((t) => t.code === code) ?? null;

  try {
    const r = await runTaskNow(code, { waitMs: 20_000 });
    switch (r.status) {
      case 'not_found':
        return NextResponse.json({ error: 'Tâche inconnue', code: 'TASK_NOT_FOUND' }, { status: 404, headers: NO_STORE });
      case 'disabled':
        await audit('DENIED', { reason: 'TASK_DISABLED' });
        return NextResponse.json(
          { error: 'Cette tâche est arrêtée par une variable d’environnement.', code: 'TASK_DISABLED' },
          { status: 409, headers: NO_STORE },
        );
      case 'busy':
        await audit('DENIED', { reason: 'TASK_RUNNING' });
        return NextResponse.json(
          { error: 'Une exécution de cette tâche est déjà en cours.', code: 'TASK_RUNNING', task: await view() },
          { status: 409, headers: NO_STORE },
        );
      case 'running':
        await audit('SUCCESS', { runId: r.runId, outcome: 'running' });
        return NextResponse.json({ result: 'running', runId: r.runId, task: await view() }, { status: 202, headers: NO_STORE });
      case 'finished':
        await audit(r.outcome.status === 'ok' ? 'SUCCESS' : 'FAILURE', {
          runId: r.runId, outcome: r.outcome.skipped ? 'skipped' : r.outcome.status, durationMs: r.outcome.durationMs, error: r.outcome.error,
        });
        return NextResponse.json({
          result: 'finished',
          runId: r.runId,
          status: r.outcome.status,
          skipped: r.outcome.skipped,
          error: r.outcome.error,
          durationMs: r.outcome.durationMs,
          task: await view(),
        }, { headers: NO_STORE });
    }
  } catch (error) {
    console.error(`[admin/ops/scheduled-tasks] exécution ${code} :`, (error as Error).message);
    await audit('FAILURE', { reason: 'RUN_FAILED' });
    return NextResponse.json(
      { error: 'Exécution impossible', code: 'SCHEDULED_TASK_RUN_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
