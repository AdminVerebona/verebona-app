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

function date(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

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
      // QUE-UI-04 : origine, déclencheur, période de création.
      origin: p.get('origin') === 'manual' || p.get('origin') === 'automatic' ? (p.get('origin') as 'manual' | 'automatic') : undefined,
      triggerCode: p.get('trigger') || undefined,
      createdFrom: date(p.get('from')),
      createdTo: date(p.get('to') ? `${p.get('to')}T23:59:59.999Z` : null),
    });
    return NextResponse.json({ jobs, count: jobs.length });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/queue/jobs');
  }
}
