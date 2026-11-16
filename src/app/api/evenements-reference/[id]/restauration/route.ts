/**
 * Carte #744, travaux D — écriture (CDC « Opérations / Agenda V2.0 » §19 ;
 * décision du PO du 15/11/2026, n° 1).
 *
 *   POST /api/evenements-reference/:id/restauration { expectedVersion? }
 *     ANNULER la suppression d'un événement de référence (façade
 *     `restoreOperation`). Il revient SANS ses événements de l'Agenda détachés
 *     à la suppression : ils ne sont pas rattachés de nouveau (leurs
 *     identifiants restent dans le journal). Refusé avec une phrase claire
 *     s'il n'a pas été supprimé par l'utilisateur ou n'a plus de fondement.
 *
 * Garde `refuserSiLectureSeule` (403), compte actif de la session, version
 * attendue (périmée → 409), réponse en phrase utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { expectedVersionOf } from '@/lib/reference-events/reference-event-write';
import {
  invalidReferenceEventRequest, openReferenceEventRoute, readJsonBody, referenceEventRouteFailure, referenceEventWriteResponse,
  type ReferenceEventRouteContext,
} from '../../_shared/write-route';

export async function POST(req: NextRequest, context: ReferenceEventRouteContext) {
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const body = await readJsonBody(req);
  const version = expectedVersionOf(body && typeof body === 'object' ? (body as Record<string, unknown>).expectedVersion : undefined);
  if (version === null) return invalidReferenceEventRequest();
  try {
    const { restoreOperation } = await import('@/services/business-operations/operation-write.facade');
    const result = await restoreOperation(scope.ctx, { operationId: scope.operationId, ...(version !== undefined ? { expectedVersion: version } : {}) });
    return referenceEventWriteResponse('restore', result);
  } catch (err) {
    return referenceEventRouteFailure('POST :id/restauration', err);
  }
}
