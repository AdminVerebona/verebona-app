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
 *   PATCH  /api/evenements-reference/:id/documents { fileId, toId }
 *     DÉPLACER un document de CET événement de référence vers un autre du
 *     compte (façade `moveDocument`), en une transaction : aucun fichier
 *     copié, aucune composante financière copiée.
 *
 * Garde `refuserSiLectureSeule` (403), compte actif de la session (un
 * identifiant d'un autre compte est « introuvable »), réponse en phrase
 * utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { positiveIdOf } from '@/lib/reference-events/reference-event-write';
import {
  invalidReferenceEventRequest, openReferenceEventRoute, readJsonBody, referenceEventRouteFailure, referenceEventWriteResponse,
  type ReferenceEventRouteContext,
} from '../../_shared/write-route';

const champ = (body: unknown, nom: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[nom] : undefined);

export async function POST(req: NextRequest, context: ReferenceEventRouteContext) {
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
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const body = await readJsonBody(req);
  const fileId = positiveIdOf(champ(body, 'fileId'));
  const toId = positiveIdOf(champ(body, 'toId'));
  if (fileId === null || toId === null) return invalidReferenceEventRequest();
  try {
    const { moveDocument } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('moveDocument', await moveDocument(scope.ctx, { fileId, fromOperationId: scope.operationId, toOperationId: toId }));
  } catch (err) {
    return referenceEventRouteFailure('PATCH :id/documents', err);
  }
}
