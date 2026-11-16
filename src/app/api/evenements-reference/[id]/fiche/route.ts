/**
 * Page entière d'un événement de référence — carte #744, travaux D (CDC
 * « Opérations / Agenda V2.0 » §14 ; AC01, AC22, AC41).
 *
 *   GET /api/evenements-reference/:id/fiche
 *     → { fiche: ReferenceEventPageView } : titre, dates propres qualifiées,
 *       déclarations de l'utilisateur, biens, équipements, fournisseurs,
 *       périodes de couverture, justificatifs, événements de l'Agenda (chacun
 *       à sa date) et événements de référence associés — lus dans le graphe.
 *
 * Lecture seule, aucune IA, aucune réanalyse, aucune écriture. Consultable
 * sans événement de l'Agenda, sans bien, sans document et sans date.
 * Compte actif de la session seulement : un autre compte, un identifiant
 * inconnu ou un événement invalidé sans regroupement → 404 (jamais 403 : on
 * ne révèle pas qu'il existe ailleurs). Un ancien identifiant regroupé rend
 * la fiche courante avec `redirectedFrom`. Un compte en lecture seule consulte.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { referenceEventIdFromParam } from '@/lib/reference-events/reference-event-page';

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
  const operationId = referenceEventIdFromParam(id);
  if (operationId === null) return apiError(400, 'INVALID_INPUT', 'Valid reference event ID required');
  try {
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    const fiche = await readReferenceEventPage(session.currentAccountId, operationId);
    if (!fiche) return apiError(404, 'NOT_FOUND', 'Événement de référence introuvable.');
    return NextResponse.json({ fiche }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/evenements-reference/:id/fiche] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
