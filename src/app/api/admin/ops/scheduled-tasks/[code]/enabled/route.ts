import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { listScheduledTasks, setTaskAdminDisabled } from '@/services/scheduling/scheduled-task-runner';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const MAX_REASON = 500;

/**
 * POST /api/admin/ops/scheduled-tasks/:code/enabled — suspendre ou réactiver
 * une tâche planifiée interne depuis le BO (lot 65A, décision PO du 16/10).
 *
 * Corps : `{ enabled: boolean, confirmed?: true, reason?: string }`.
 * La suspension exige `confirmed: true` (confirmation explicite de
 * l'interface). Une tâche suspendue n'est ni planifiée ni exécutable à la
 * main ; une exécution en cours n'est pas interrompue. Les tâches CRITIQUES
 * (alerte de Supervision) ne se suspendent pas ici : 409 TASK_CRITICAL — leur
 * arrêt d'urgence reste la variable SCHEDULED_TASK_<CODE>=off.
 *   200 { changed, task } · 400 INVALID_BODY | CONFIRMATION_REQUIRED
 *   404 TASK_NOT_FOUND · 409 TASK_CRITICAL · 503 STATE_UNAVAILABLE
 * Idempotente. Journalisée dans l'audit admin (auteur, motif, résultat).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    return NextResponse.json({ error: 'Vérification impossible', code: 'GUARD_FAILED' }, { status: 500, headers: NO_STORE });
  }

  const code = String((await params).code ?? '').slice(0, 80);
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const body = (await request.json().catch(() => null)) as { enabled?: unknown; confirmed?: unknown; reason?: unknown } | null;
  if (!body || typeof body.enabled !== 'boolean' || (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string')) {
    return NextResponse.json(
      { error: 'Corps attendu : { enabled: boolean, confirmed?: true, reason?: string }', code: 'INVALID_BODY' },
      { status: 400, headers: NO_STORE },
    );
  }
  const enabled = body.enabled;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, MAX_REASON) : null;
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId, adminEmail, action: enabled ? 'SCHEDULED_TASK_ENABLE' : 'SCHEDULED_TASK_DISABLE',
    targetType: 'SCHEDULED_TASK', targetId: null, result, details: { code, reason, ...details },
  });
  if (!enabled && body.confirmed !== true) {
    return NextResponse.json(
      { error: 'La suspension d’une tâche exige une confirmation explicite.', code: 'CONFIRMATION_REQUIRED' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const r = await setTaskAdminDisabled(code, !enabled, adminId);
    switch (r.status) {
      case 'not_found':
        return NextResponse.json({ error: 'Tâche inconnue', code: 'TASK_NOT_FOUND' }, { status: 404, headers: NO_STORE });
      case 'critical':
        await audit('DENIED', { reason: 'TASK_CRITICAL' });
        return NextResponse.json(
          { error: 'Tâche critique : elle ne peut pas être suspendue depuis le back-office.', code: 'TASK_CRITICAL' },
          { status: 409, headers: NO_STORE },
        );
      case 'unavailable':
        return NextResponse.json({ error: 'État des tâches indisponible', code: 'STATE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
      case 'ok': {
        await audit('SUCCESS', { changed: r.changed, adminDisabled: r.adminDisabled });
        const task = (await listScheduledTasks()).find((t) => t.code === code) ?? null;
        return NextResponse.json({ changed: r.changed, task }, { headers: NO_STORE });
      }
    }
  } catch (error) {
    console.error(`[admin/ops/scheduled-tasks] suspension ${code} :`, (error as Error).message);
    await audit('FAILURE', { reason: 'TOGGLE_FAILED' });
    return NextResponse.json(
      { error: 'Modification impossible (migration 0463 passée ?)', code: 'SCHEDULED_TASK_TOGGLE_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
