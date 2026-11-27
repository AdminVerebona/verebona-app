/**
 * Carte #744, travaux D — écriture (CDC « Opérations / Agenda V2.0 » §14,
 * §19 ; AC44, AC45).
 *
 *   POST   /api/evenements-reference/:id/documents { fileId }
 *     RATTACHER un document du compte (façade `linkDocument`).
 *   DELETE /api/evenements-reference/:id/documents?fileId=<id>
 *     RETIRER un document (façade `unlinkDocument`) : seul le lien change ; le
 *     fichier, ses liens aux événements de l'Agenda et ses autres
 *     rattachements restent ; le refus est mémorisé.
 *   PATCH  /api/evenements-reference/:id/documents
 *     RETIRÉ — carte #806 §1, décision du PO du 17/11/2026 : le geste « Déplacer
 *     un document vers une autre opération » n'existe plus (écran, API,
 *     Assistant). Un ancien client reçoit 410 et une phrase qui dit de retirer
 *     le document puis de le rattacher ; RIEN n'est lu ni écrit.
 *
 * Garde `refuserSiLectureSeule` (403), compte actif de la session (un
 * identifiant d'un autre compte est « introuvable »), réponse en phrase
 * utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { positiveIdOf, REFERENCE_EVENT_MOVE_REMOVED } from '@/lib/reference-events/reference-event-write';
import { refuserSiRequeteSurBienTransmis } from '@/lib/asset-read-only-guard';
import {
  invalidReferenceEventRequest, openReferenceEventRoute, readJsonBody, referenceEventRouteFailure, referenceEventWriteResponse,
  type ReferenceEventRouteContext,
} from '../../_shared/write-route';

const champ = (body: unknown, nom: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[nom] : undefined);

export async function POST(req: NextRequest, context: ReferenceEventRouteContext) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(req, context, { kind: 'operation' }); if (refusTransmis) return refusTransmis; }
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const fileId = positiveIdOf(champ(await readJsonBody(req), 'fileId'));
  if (fileId === null) return invalidReferenceEventRequest();
  try {
    const { linkDocument } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('linkDocument', await linkDocument(scope.ctx, { operationId: scope.operationId, fileId }));
  } catch (err) {
    return referenceEventRouteFailure('POST :id/documents', err);
  }
}

export async function DELETE(req: NextRequest, context: ReferenceEventRouteContext) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(req, context, { kind: 'operation' }); if (refusTransmis) return refusTransmis; }
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const fileId = positiveIdOf(req.nextUrl.searchParams.get('fileId'));
  if (fileId === null) return invalidReferenceEventRequest();
  try {
    const { unlinkDocument } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('unlinkDocument', await unlinkDocument(scope.ctx, { operationId: scope.operationId, fileId }));
  } catch (err) {
    return referenceEventRouteFailure('DELETE :id/documents', err);
  }
}

export async function PATCH(req: NextRequest, context: ReferenceEventRouteContext) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(req, context, { kind: 'operation' }); if (refusTransmis) return refusTransmis; }
  // Session et identifiant contrôlés comme pour les autres gestes : un appel sans session reste un 401.
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  return apiError(410, 'UNSUPPORTED', REFERENCE_EVENT_MOVE_REMOVED);
}
