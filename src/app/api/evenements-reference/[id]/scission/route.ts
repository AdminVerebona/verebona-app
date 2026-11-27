/**
 * Carte #744 — SCISSION d'un événement de référence (CDC « Opérations /
 * Agenda V2.0 » §7 « Scission explicite depuis la fiche », §14 « Actions »,
 * §19, §20 ; critère AC46). Décision du PO du 16/11/2026 : « Scinder : oui,
 * maintenant. »
 *
 *   POST /api/evenements-reference/:id/scission
 *        { expectedVersion?, label, agendaItemIds?, fileIds?, supplierIds? }
 *     Crée un SECOND événement de référence et y DÉPLACE les faits désignés
 *     (façade `splitOperation`, une seule transaction) : rien n'est perdu,
 *     aucun fichier n'est copié, aucun événement de l'Agenda n'est créé ni
 *     redaté, les deux événements de référence restent associés et la
 *     séparation est mémorisée.
 *
 * Garde `refuserSiLectureSeule` (403), compte actif de la session (un
 * identifiant d'un autre compte est « introuvable »), réponse en phrase
 * utilisateur — jamais un code. Aucune règle métier ici.
 */
import { NextRequest, NextResponse } from 'next/server';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { parseReferenceEventSplit } from '@/lib/reference-events/reference-event-write';
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
  const demande = parseReferenceEventSplit(await readJsonBody(req));
  if (!demande) return invalidReferenceEventRequest();
  try {
    const { splitOperation } = await import('@/services/business-operations/operation-write.facade');
    return referenceEventWriteResponse('split', await splitOperation(scope.ctx, {
      operationId: scope.operationId,
      ...(demande.expectedVersion !== undefined ? { expectedVersion: demande.expectedVersion } : {}),
      ...(demande.label !== undefined ? { label: demande.label } : {}),
      ...(demande.agendaItemIds ? { agendaItemIds: demande.agendaItemIds } : {}),
      ...(demande.fileIds ? { fileIds: demande.fileIds } : {}),
      ...(demande.supplierIds ? { supplierIds: demande.supplierIds } : {}),
    }));
  } catch (err) {
    return referenceEventRouteFailure('POST :id/scission', err);
  }
}
