/**
 * GET /api/admin/ai/queue/jobs — CDC BO IA SCR-08, NFR-001, NFR-002.
 *
 * Liste filtrée et bornée. Le NFR-002 interdit de « charger massivement
 * l'ensemble des logs ou comptes sans filtre/limite » : la borne est appliquée
 * côté serveur et plafonnée, pour qu'un paramètre client ne puisse pas la lever.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listJobs, cleanJobIds } from '@/services/ai/queue/job-queue.repository';
import { executionPhase } from '@/services/ai/queue/supervision';
import { isTreatment } from '@/services/ai/config/treatments';
import { BUSINESS_RESULTS } from '@/services/ai/queue/queue-policy';
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
  // Lot 52A (COR-03) : recherche par identifiant(s) de job — `ids=12,57` ou
  // `jobId=12`. Prime sur les autres filtres (les jobs d'un lancement manuel
  // s'affichent quels que soient les filtres précédemment choisis).
  const idsBruts = [p.get('ids') ?? '', p.get('jobId') ?? ''].join(',').split(/[\s,;#]+/).filter(Boolean);
  const ids = idsBruts.length > 0 ? cleanJobIds(idsBruts) : null;

  try {
    const jobs = ids ? await listJobs({ ids, limit: 500 }) : await listJobs({
      treatment: treatment && isTreatment(treatment) ? treatment : undefined,
      status: status && STATUSES.has(status) ? (status as never) : undefined,
      accountId: accountId && /^\d+$/.test(accountId) ? Number(accountId) : undefined,
      limit: limit && /^\d+$/.test(limit) ? Number(limit) : undefined,
      // QUE-UI-04 : origine, déclencheur, période de création.
      origin: p.get('origin') === 'manual' || p.get('origin') === 'automatic' ? (p.get('origin') as 'manual' | 'automatic') : undefined,
      triggerCode: p.get('trigger') || undefined,
      createdFrom: date(p.get('from')),
      createdTo: date(p.get('to') ? `${p.get('to')}T23:59:59.999Z` : null),
      // Lot 31C : résultat métier d'un travail terminé.
      businessResult: (BUSINESS_RESULTS as readonly string[]).includes(p.get('result') ?? '') ? p.get('result')! : undefined,
      // Lot 52A (COR-03) : plus récents d'abord à l'écran ; `order=service`
      // montre l'ordre de service du boucleur (inchangé, FIFO).
      order: p.get('order') === 'service' ? 'service' : 'recent',
    });
    // COR-05 : phase lisible (créé non démarré, démarré, terminé avec / sans
    // modification, échec) — y compris pour un passage sans appel modèle.
    return NextResponse.json({ jobs: jobs.map((j) => ({ ...j, phase: executionPhase(j) })), count: jobs.length });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/queue/jobs');
  }
}
