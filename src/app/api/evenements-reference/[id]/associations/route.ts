/**
 * Carte #744, travaux D — écriture (CDC « Opérations / Agenda V2.0 » §7, §9,
 * §14, §19 ; AC49, AC50 pour leur partie « page »).
 *
 *   POST   /api/evenements-reference/:id/associations { otherId, nature?, direction? }
 *     ASSOCIER cet événement de référence à un autre du compte (façade
 *     `associateOperations`) — jamais une fusion, aucun montant ajouté.
 *     `nature` : ASSOCIATED (défaut, sans sens), FINANCING, CLAIM_REPAIR ;
 *     `direction` d'un lien orienté, lue depuis la page : OUTGOING (cet
 *     événement de référence est le financement / le sinistre) ou INCOMING.
 *   DELETE /api/evenements-reference/:id/associations?otherId=<id>
 *     DISSOCIER (façade `dissociateOperations`) : seul le lien change ; le
 *     refus est mémorisé (jamais recréé par une analyse sur les mêmes preuves).
 *
 * Garde `refuserSiLectureSeule` (403), compte actif de la session (un
 * identifiant d'un autre compte est « introuvable »), réponse en phrase
 * utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { parseReferenceEventAssociation, positiveIdOf } from '@/lib/reference-events/reference-event-write';
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
  const demande = parseReferenceEventAssociation(await readJsonBody(req));
  if (!demande) return invalidReferenceEventRequest();
  try {
    const { associateOperations } = await import('@/services/business-operations/operation-write.facade');
    // Sens du lien orienté : l'origine est cet événement de référence (OUTGOING) ou l'autre (INCOMING).
    const [fromOperationId, toOperationId] = demande.direction === 'INCOMING' ? [demande.otherId, scope.operationId] : [scope.operationId, demande.otherId];
    return referenceEventWriteResponse('associate', await associateOperations(scope.ctx, { fromOperationId, toOperationId, nature: demande.nature }));
  } catch (err) {
    return referenceEventRouteFailure('POST :id/associations', err);
  }
}

export async function DELETE(req: NextRequest, context: ReferenceEventRouteContext) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(req, context, { kind: 'operation' }); if (refusTransmis) return refusTransmis; }
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const otherId = positiveIdOf(req.nextUrl.searchParams.get('otherId'));
  if (otherId === null) return invalidReferenceEventRequest();
  try {
    const { dissociateOperations } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('dissociate', await dissociateOperations(scope.ctx, { operationAId: scope.operationId, operationBId: otherId }));
  } catch (err) {
    return referenceEventRouteFailure('DELETE :id/associations', err);
  }
}
