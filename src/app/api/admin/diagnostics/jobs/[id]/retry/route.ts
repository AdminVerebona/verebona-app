import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE } from '../../../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/diagnostics/jobs/:id/retry — lot 107G : « Relancer » une
 * génération terminée (FAILED, PARTIAL, CANCELLED…) : NOUVEAU travail, même
 * demande, rattaché au précédent (`parent_id` : parenté conservée). Sans
 * double demande : deux clics rendent le même enfant. 409 si la génération
 * est encore en file ou en cours. Journalisé ; jamais mis en cache.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const { id } = await params;
  const requestId = randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: 'Diagnostic introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (result: 'SUCCESS' | 'FAILURE', details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: 'TECH_DIAGNOSTIC_JOB', targetType: 'TECH_DIAGNOSTIC', targetId: null, result,
    details: { requestId, operation: 'retry', parentId: id, ...details },
  });
  const { retryDiagnosticJob } = await import('@/services/admin/diagnostic-jobs/repository');
  const r = await retryDiagnosticJob(id, g.adminId, requestId);
  if ('refused' in r) {
    await audit('FAILURE', { code: r.refused });
    return r.refused === 'NOT_FOUND'
      ? NextResponse.json({ error: 'Diagnostic introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE })
      : NextResponse.json({ error: 'Génération encore en file ou en cours : rien à relancer.', code: 'STILL_ACTIVE' }, { status: 409, headers: NO_STORE });
  }
  await audit('SUCCESS', { jobId: r.job.id, duplicate: r.duplicate, replaced: r.replaced.map((x) => ({ id: x.id, from: x.previousStatus, outcome: x.outcome })) });
  const { nudgeDiagnosticWorker } = await import('@/services/admin/diagnostic-jobs/worker');
  nudgeDiagnosticWorker();
  return NextResponse.json({ jobId: r.job.id, parentId: id, status: r.job.status, duplicate: r.duplicate, replaced: r.replaced, requestId }, { status: 202, headers: NO_STORE });
}
