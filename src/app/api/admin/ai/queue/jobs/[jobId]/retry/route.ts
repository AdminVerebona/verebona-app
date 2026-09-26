/**
 * POST /api/admin/ai/queue/jobs/[jobId]/retry — CDC BO IA MOD-006, OPS-018,
 * SCR-07/SCR-08 : relance manuelle d'un échec définitif.
 *
 * FAILED → PENDING, tentatives remises à zéro, origine `manual` : la relance
 * repart du modèle principal et retrouve ses cinq cycles de reprise. Tout
 * autre statut est refusé (409) : relancer un job vivant le doublerait.
 * Refus explicite (409 AI_BLOCKED) si le traitement est coupé : la relance
 * attendrait sans le dire.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';
import { retryFailedJob, canStart } from '@/services/ai/queue/job-queue.repository';
import type { Treatment } from '@/services/ai/config/treatments';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { jobId } = await params;
  const id = parseVersionId(jobId);
  if (id === null) return invalidId(jobId);

  try {
    const [row] = (await pgClient.unsafe(
      `SELECT treatment FROM ai_job_queue WHERE id = $1`, [id] as never[],
    )) as unknown as Array<{ treatment: Treatment }>;
    if (!row) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (!(await canStart(row.treatment))) {
      return NextResponse.json(
        { error: 'AI_BLOCKED', message: `${row.treatment} est coupé ou l'arrêt d'urgence est engagé : la relance n'est pas acceptée.` },
        { status: 409 },
      );
    }
    const done = await retryFailedJob(id);
    if (!done) {
      return NextResponse.json(
        { error: 'JOB_NOT_FAILED', message: 'Seul un travail en échec définitif peut être relancé.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ retried: true });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/queue/jobs/[jobId]/retry');
  }
}
