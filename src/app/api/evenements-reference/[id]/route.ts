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
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

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
    if (!reference) return apiError(404, 'NOT_FOUND', 'Événement de référence introuvable.');
    return NextResponse.json({ reference }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/evenements-reference/:id] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
