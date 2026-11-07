/**
 * Historique de couverture de l'événement de référence d'un élément
 * d'agenda — lot 113W (Trello #724).
 *
 *   GET /api/agenda/:id/periodes
 *     → { history: { coverages: [...] } | null }
 *       toutes les périodes de couverture établies, chronologiques, chacune
 *       reliée à son justificatif (document) ; null : l'élément n'est relié à
 *       aucun événement de référence. Les périodes facturées des dépenses n'y
 *       figurent pas (chaque dépense garde la sienne). Lecture seule, aucune IA.
 * La correction passe par `PUT /api/documents/:fileId/periodes` (même fait).
 * Compte actif de la session seulement (un élément d'un autre compte → 404).
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
  if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Valid agenda item ID required');
  try {
    const { operationOfAgendaItem, readOperationCoverageHistory } = await import('@/services/documents/business-periods/service');
    const op = await operationOfAgendaItem(session.currentAccountId, Number(id));
    if (op === undefined) return apiError(404, 'NOT_FOUND', 'Événement introuvable.');
    const h = op === null ? null : await readOperationCoverageHistory(session.currentAccountId, op);
    // L'identifiant interne de l'événement de référence n'est pas exposé à l'écran.
    return NextResponse.json({ history: h ? { coverages: h.coverages } : null }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/agenda/:id/periodes] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
