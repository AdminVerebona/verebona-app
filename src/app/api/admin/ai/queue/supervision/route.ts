/**
 * GET /api/admin/ai/queue/supervision — lot 52A (ticket « [P1] T3 —
 * non-déclenchement des exécutions manuelles et horaires », COR-04).
 *
 * État du boucleur agrégé sur TOUTES les instances (battements en base),
 * disponibilité de l'exécutant T3 et motif, derniers passages T3 manuel et
 * automatique (horodatages, durée, objets examinés / modifiés, résultat
 * métier, appels modèle), prochain balayage planifié.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getT3Supervision } from '@/services/ai/queue/supervision';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await getT3Supervision());
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/queue/supervision');
  }
}
