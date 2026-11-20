/**
 * Fiche d'un événement de référence — lot 113AB (Trello #725, §3
 * « Opérations / contrats »).
 *
 *   GET /api/evenements-reference/:id
 *     → { reference: { id, label, provider, coverages, documents, agendaItemId } }
 *       toutes les périodes de couverture établies, chronologiques, chacune
 *       reliée à son justificatif (même lecture que le tiroir Agenda et le
 *       tiroir du document, lot 113W), les justificatifs, et l'élément
 *       d'agenda relié s'il existe — la fiche est consultable SANS lui.
 *       Les périodes facturées n'y figurent pas (chaque dépense garde la
 *       sienne). Lecture seule, aucune IA, aucune réanalyse.
 * La correction passe par `PUT /api/documents/:fileId/periodes` (même fait).
 * Compte actif de la session seulement (un autre compte, un événement
 * invalidé sans regroupement → 404). Un compte en lecture seule consulte.
 *
 * Carte #744, travaux D — écriture (CDC « Opérations / Agenda V2.0 » §14, §19,
 * §20 ; décisions du PO du 15/11/2026) :
 *
 *   PATCH /api/evenements-reference/:id
 *         { expectedVersion?, label?, typeCode?, dates?: { plannedDate?, startDate?, realizedDate?, endDate? } }
 *     CORRIGER l'intitulé, le type ou les dates propres (on pose, on n'efface
 *     pas). Aucune déclaration, aucun motif demandé : la trace est l'image
 *     avant / après dans le journal du graphe (façade `correctOperation`).
 *   DELETE /api/evenements-reference/:id?version=<version attendue>
 *     SUPPRIMER un événement de référence créé à tort : invalidation logique
 *     (façade `invalidateOperation`) — rien n'est effacé ; les événements de
 *     l'Agenda saisis sont détachés et conservés. S'annule par
 *     `POST …/restauration` (sans rattacher de nouveau ces événements).
 *
 * Écritures : garde `refuserSiLectureSeule` (403), compte actif de la session,
 * version attendue (périmée → 409 avec une phrase claire), réponse en phrase
 * utilisateur (jamais un code brut à afficher).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { expectedVersionOf, parseReferenceEventCorrection } from '@/lib/reference-events/reference-event-write';
import {
  invalidReferenceEventRequest, openReferenceEventRoute, readJsonBody, referenceEventRouteFailure, referenceEventWriteResponse,
} from '../_shared/write-route';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
  const { id } = await context.params;
  if (!/^\d{1,15}$/.test(id) || !Number.isSafeInteger(Number(id))) return apiError(400, 'INVALID_INPUT', 'Valid reference event ID required');
  try {
    const { readReferenceEvent } = await import('@/services/documents/business-period-surfaces');
    const reference = await readReferenceEvent(session.currentAccountId, Number(id));
    if (!reference) return apiError(404, 'NOT_FOUND', 'Opération introuvable.');
    return NextResponse.json({ reference }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/evenements-reference/:id] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const demande = parseReferenceEventCorrection(await readJsonBody(req));
  if (!demande) return invalidReferenceEventRequest();
  try {
    const { BUSINESS_OPERATION_TYPE_CODES } = await import('@/services/business-operations/model');
    // Type : choisi dans le référentiel des types ; « Autre » choisi par l'utilisateur est une qualification certaine.
    const code = BUSINESS_OPERATION_TYPE_CODES.find((c) => c === demande.typeCode);
    if (demande.typeCode !== undefined && !code) return invalidReferenceEventRequest();
    const { correctOperation } = await import('@/services/business-operations/operation-write.facade');
    const result = await correctOperation(scope.ctx, {
      operationId: scope.operationId,
      ...(demande.expectedVersion !== undefined ? { expectedVersion: demande.expectedVersion } : {}),
      ...(demande.label !== undefined ? { label: demande.label } : {}),
      ...(code ? { type: code === 'OTHER' ? { code, qualification: { confidence: 'certain' as const, reason: 'USER_PAGE_CHOICE' } } : { code } } : {}),
      ...(demande.dates ? { attributes: demande.dates } : {}),
    });
    return referenceEventWriteResponse('correct', result);
  } catch (err) {
    return referenceEventRouteFailure('PATCH :id', err);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const version = expectedVersionOf(req.nextUrl.searchParams.get('version'));
  if (version === null) return invalidReferenceEventRequest();
  try {
    const { invalidateOperation } = await import('@/services/business-operations/operation-write.facade');
    const result = await invalidateOperation(scope.ctx, { operationId: scope.operationId, ...(version !== undefined ? { expectedVersion: version } : {}) });
    return referenceEventWriteResponse('delete', result);
  } catch (err) {
    return referenceEventRouteFailure('DELETE :id', err);
  }
}
