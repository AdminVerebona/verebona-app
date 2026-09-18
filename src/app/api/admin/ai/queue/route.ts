/**
 * GET /api/admin/ai/queue — CDC BO IA SCR-08.
 *
 * Résumé de la file, états opérationnels et arrêt d'urgence : les trois
 * informations dont l'écran a besoin pour répondre à « pourquoi cet élément
 * n'avance pas ? », son second critère d'acceptation.
 *
 * Un job peut stagner pour trois raisons distinctes — traitement désactivé,
 * traitement suspendu, arrêt d'urgence — et seul le rapprochement des trois
 * permet de le dire. Les servir en trois routes obligerait l'écran à les
 * recomposer, ou à en oublier une.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getQueueSummary, getTreatmentStates, getEmergencyStop,
} from '@/services/ai/queue/job-queue.repository';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    const [summary, states, stop] = await Promise.all([
      getQueueSummary(), getTreatmentStates(), getEmergencyStop(),
    ]);
    return NextResponse.json({ summary, states, emergencyStop: stop });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/queue');
  }
}
