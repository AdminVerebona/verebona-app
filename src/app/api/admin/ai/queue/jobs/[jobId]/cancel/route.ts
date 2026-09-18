/**
 * POST /api/admin/ai/queue/jobs/[jobId]/cancel — CDC BO IA SCR-08.
 *
 * N'annule qu'un job encore en attente. Un job démarré est refusé en 409 :
 * le SCR-08 exige de « ne pas simuler une annulation silencieuse ». Laisser
 * croire qu'une exécution s'arrête alors qu'elle continue serait pire que le
 * refus — l'administrateur croirait le problème réglé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cancelJob } from '@/services/ai/queue/job-queue.repository';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { jobId } = await params;
  const id = parseVersionId(jobId);
  if (id === null) return invalidId(jobId);

  try {
    const done = await cancelJob(id, guard.ctx.adminUserId);
    if (!done) {
      return NextResponse.json(
        {
          error: 'JOB_NOT_PENDING',
          message: "Ce travail a déjà démarré ou est terminé : il ne peut plus être annulé.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ cancelled: true });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/queue/jobs/[jobId]/cancel');
  }
}
