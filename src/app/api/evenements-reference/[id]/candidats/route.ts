/**
 * Carte #744, travaux D — écriture : CANDIDATS proposés par la page d'un
 * événement de référence (choix d'un objet à relier).
 *
 *   GET /api/evenements-reference/:id/candidats?kind=agenda|document|supplier|reference&q=<texte>
 *     → { items: [{ id, title, date, typeCode }], more }
 *       objets DU COMPTE pas encore reliés à cet événement de référence,
 *       filtrés par titre ou nom ; `more` : d'autres résultats existent.
 *   GET /api/evenements-reference/:id/candidats?kind=type
 *     → { types: [{ code, label }] } : référentiel des types, nom utilisateur existant.
 *
 * Lecture seule, aucune IA, aucune écriture. Compte actif de la session
 * seulement : un événement de référence d'un autre compte, supprimé ou
 * regroupé → 404. Un compte en lecture seule consulte.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { isReferenceEventCandidateKind, type ReferenceEventTypeOption } from '@/lib/reference-events/reference-event-write';
import { REFERENCE_EVENT_PAGE_LABELS } from '@/lib/reference-events/reference-event-page';
import { invalidReferenceEventRequest, openReferenceEventRoute, type ReferenceEventRouteContext } from '../../_shared/write-route';

export async function GET(req: NextRequest, context: ReferenceEventRouteContext) {
  const scope = await openReferenceEventRoute(req, context);
  if (scope instanceof NextResponse) return scope;
  const kind = req.nextUrl.searchParams.get('kind');
  try {
    if (kind === 'type') {
      const { BUSINESS_OPERATION_TYPE_CODES } = await import('@/services/business-operations/model');
      const { referenceEventLabel } = await import('@/services/documents/business-period-surfaces');
      const types: ReferenceEventTypeOption[] = BUSINESS_OPERATION_TYPE_CODES.map((code) => ({ code, label: referenceEventLabel({ typeCode: code, technicalLabel: null }) }));
      return NextResponse.json({ types }, { headers: { 'Cache-Control': 'private, no-cache' } });
    }
    if (!isReferenceEventCandidateKind(kind)) return invalidReferenceEventRequest();
    const { readReferenceEventCandidates } = await import('@/services/business-operations/graph/reference-event-candidates');
    const liste = await readReferenceEventCandidates(scope.accountId, scope.operationId, kind, req.nextUrl.searchParams.get('q') ?? '');
    if (!liste) return apiError(404, 'NOT_FOUND', REFERENCE_EVENT_PAGE_LABELS.notFound);
    return NextResponse.json(liste, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/evenements-reference/:id/candidats] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
