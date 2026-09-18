/**
 * GET /api/admin/ai/queue/jobs — CDC BO IA SCR-08, NFR-001, NFR-002.
 *
 * Liste filtrée et bornée. Le NFR-002 interdit de « charger massivement
 * l'ensemble des logs ou comptes sans filtre/limite » : la borne est appliquée
 * côté serveur et plafonnée, pour qu'un paramètre client ne puisse pas la lever.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listJobs } from '@/services/ai/queue/job-queue.repository';
import { isTreatment } from '@/services/ai/config/treatments';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

const STATUSES = new Set(['PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED']);

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const p = new URL(req.url).searchParams;
  const treatment = p.get('treatment');
  const status = p.get('status');
  const accountId = p.get('accountId');
  const limit = p.get('limit');

  try {
    const jobs = await listJobs({
      treatment: treatment && isTreatment(treatment) ? treatment : undefined,
      status: status && STATUSES.has(status) ? (status as never) : undefined,
      accountId: accountId && /^\d+$/.test(accountId) ? Number(accountId) : undefined,
      limit: limit && /^\d+$/.test(limit) ? Number(limit) : undefined,
    });
    return NextResponse.json({ jobs, count: jobs.length });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/queue/jobs');
  }
}
