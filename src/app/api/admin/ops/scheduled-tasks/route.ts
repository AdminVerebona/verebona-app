import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { listScheduledTasks } from '@/services/scheduling/scheduled-task-runner';
import { schedulerDisabled } from '@/services/scheduling/scheduled-tasks.catalog';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * GET /api/admin/ops/scheduled-tasks — tâches planifiées internes (lot 25).
 *
 * Réponse : `{ tasks: [...], schedulerEnabled, generatedAt }`, chaque tâche
 * `{ code, label, frequency, lastRunAt, lastStatus ('ok' | 'error' |
 * 'running' | null), lastDurationMs, lastError, nextRunAt,
 * consecutiveFailures, enabled }` (+ `lastInstance`, `lastTrigger`,
 * `lastSuccessAt`, `critical`). `enabled` reflète les variables d'arrêt
 * (SCHEDULED_TASKS_DISABLED, SCHEDULED_TASK_<CODE>=off). Messages d'erreur
 * courts, sans donnée sensible. Réservé aux administrateurs.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const tasks = await listScheduledTasks();
    return NextResponse.json(
      { tasks, schedulerEnabled: !schedulerDisabled(), generatedAt: new Date().toISOString() },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/ops/scheduled-tasks] lecture :', (error as Error).message);
    return NextResponse.json(
      { error: 'Chargement des tâches planifiées impossible', code: 'SCHEDULED_TASKS_LOAD_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
