/**
 * NOTE LIBRE de l'utilisateur sur un événement de référence — carte #744,
 * travaux D « contenu » (CDC « Opérations / Agenda V2.0 » §5, §14 ; AC42),
 * migration 1722.
 *
 *   PUT /api/evenements-reference/:id/notes
 *       { notes: string | null, expectedVersion?: number }
 *     ENREGISTRE le texte « Notes / Description », ou le RETIRE quand il est
 *     vide ou `null` (choix explicite de l'utilisateur : la note disparaît,
 *     rien d'autre). Façade `setOperationNotes` — seul écrivain de ce texte,
 *     réservé à l'utilisateur : aucun traitement automatique ne le réécrit.
 *
 * Ce texte n'entre dans AUCUN calcul (ni montant, ni date, ni consolidation).
 * Garde `refuserSiLectureSeule` (403) dans ce fichier (audit `l85d`), compte
 * actif de la session, version attendue (périmée → 409), réponse en phrase
 * utilisateur — jamais un code brut à afficher.
 */
import { NextRequest, NextResponse } from 'next/server';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { expectedVersionOf } from '@/lib/reference-events/reference-event-write';
import { parseReferenceEventNotes } from '@/lib/reference-events/reference-event-summary';
import {
  invalidReferenceEventRequest, openReferenceEventRoute, readJsonBody, referenceEventRouteFailure, referenceEventWriteResponse,
} from '../../_shared/write-route';

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, context: RouteContext) {
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const refus = await refuserSiLectureSeule(scope.accountId);
  if (refus) return refus;
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidReferenceEventRequest();
  const champs = body as Record<string, unknown>;
  if (Object.keys(champs).some((k) => k !== 'notes' && k !== 'expectedVersion')) return invalidReferenceEventRequest();
  // Le champ est TOUJOURS porté par la demande : une demande sans `notes` n'efface rien par mégarde.
  if (!('notes' in champs)) return invalidReferenceEventRequest();
  const version = expectedVersionOf(champs.expectedVersion);
  if (version === null) return invalidReferenceEventRequest();
  const lu = parseReferenceEventNotes(champs.notes);
  if (!lu.ok) return invalidReferenceEventRequest();
  try {
    const { setOperationNotes } = await import('@/services/business-operations/operation-write.facade');
    const result = await setOperationNotes(scope.ctx, {
      operationId: scope.operationId, notes: lu.notes,
      ...(version !== undefined ? { expectedVersion: version } : {}),
    });
    return referenceEventWriteResponse(lu.notes === null ? 'notesCleared' : 'notes', result);
  } catch (err) {
    return referenceEventRouteFailure('PUT :id/notes', err);
  }
}
