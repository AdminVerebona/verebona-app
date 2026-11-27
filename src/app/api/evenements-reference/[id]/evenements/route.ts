/**
 * Carte #744, travaux D — écriture (CDC « Opérations / Agenda V2.0 » §4, §14,
 * §19).
 *
 *   POST   /api/evenements-reference/:id/evenements { agendaItemId }
 *     RATTACHER un événement de l'Agenda du compte (façade `linkAgendaItem`) :
 *     il garde sa date, ses rappels, ses documents ; déjà rattaché à un autre
 *     événement de référence, il est PARTAGÉ (jamais déplacé ni copié).
 *   DELETE /api/evenements-reference/:id/evenements?agendaItemId=<id>
 *     DÉTACHER (façade `unlinkAgendaItem`) : seul ce lien change ; l'événement
 *     reste dans l'Agenda ; le refus est mémorisé (jamais recréé par une analyse).
 *
 * Garde `refuserSiLectureSeule` (403), compte actif de la session (un
 * identifiant d'un autre compte est « introuvable »), réponse en phrase
 * utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { positiveIdOf } from '@/lib/reference-events/reference-event-write';
import { refuserSiRequeteSurBienTransmis } from '@/lib/asset-read-only-guard';
import {
  invalidReferenceEventRequest, openReferenceEventRoute, readJsonBody, referenceEventRouteFailure, referenceEventWriteResponse,
  type ReferenceEventRouteContext,
} from '../../_shared/write-route';

export async function POST(req: NextRequest, context: ReferenceEventRouteContext) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(req, context, { kind: 'operation' }); if (refusTransmis) return refusTransmis; }
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const body = await readJsonBody(req);
  const agendaItemId = positiveIdOf(body && typeof body === 'object' ? (body as Record<string, unknown>).agendaItemId : undefined);
  if (agendaItemId === null) return invalidReferenceEventRequest();
  try {
    const { linkAgendaItem } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('linkAgenda', await linkAgendaItem(scope.ctx, { operationId: scope.operationId, agendaItemId }));
  } catch (err) {
    return referenceEventRouteFailure('POST :id/evenements', err);
  }
}

export async function DELETE(req: NextRequest, context: ReferenceEventRouteContext) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(req, context, { kind: 'operation' }); if (refusTransmis) return refusTransmis; }
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const agendaItemId = positiveIdOf(req.nextUrl.searchParams.get('agendaItemId'));
  if (agendaItemId === null) return invalidReferenceEventRequest();
  try {
    const { unlinkAgendaItem } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('unlinkAgenda', await unlinkAgendaItem(scope.ctx, { operationId: scope.operationId, agendaItemId }));
  } catch (err) {
    return referenceEventRouteFailure('DELETE :id/evenements', err);
  }
}
