/**
 * Carte #744, travaux D — écriture (CDC « Opérations / Agenda V2.0 » §14, §19).
 *
 *   POST   /api/evenements-reference/:id/fournisseurs { supplierId }
 *     RELIER un fournisseur du compte (façade `linkSupplier`) : rôle par
 *     défaut de la façade (prestataire) ; aucun document, coût ni événement créé.
 *   DELETE /api/evenements-reference/:id/fournisseurs?supplierId=<id>
 *     RETIRER (façade `unlinkSupplier`) : seul le lien change ; la fiche du
 *     fournisseur reste ; le refus est mémorisé.
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

export async function POST(req: NextRequest, context: ReferenceEventRouteContext) {
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const body = await readJsonBody(req);
  const supplierId = positiveIdOf(body && typeof body === 'object' ? (body as Record<string, unknown>).supplierId : undefined);
  if (supplierId === null) return invalidReferenceEventRequest();
  try {
    const { linkSupplier } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('linkSupplier', await linkSupplier(scope.ctx, { operationId: scope.operationId, supplierId }));
  } catch (err) {
    return referenceEventRouteFailure('POST :id/fournisseurs', err);
  }
}

export async function DELETE(req: NextRequest, context: ReferenceEventRouteContext) {
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const supplierId = positiveIdOf(req.nextUrl.searchParams.get('supplierId'));
  if (supplierId === null) return invalidReferenceEventRequest();
  try {
    const { unlinkSupplier } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('unlinkSupplier', await unlinkSupplier(scope.ctx, { operationId: scope.operationId, supplierId }));
  } catch (err) {
    return referenceEventRouteFailure('DELETE :id/fournisseurs', err);
  }
}
