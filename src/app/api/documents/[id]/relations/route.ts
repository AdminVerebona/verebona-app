/**
 * Relations d'un document — lot 109A (ticket « Relations métier », §6
 * « Document ») : CONTRAT DE LECTURE UNIQUE (`services/relations/read-contract.ts`).
 *
 *   GET /api/documents/:id/relations
 *     → { contract, documentId, direct: { suppliers, assets, equipments, rooms, agendaItems },
 *         operations: [{ operationId, membership, suppliers, equipments, agendaItems }] }
 *
 * Rattachements DIRECTS (preuve propre au document ou décision de
 * l'utilisateur) et Opérations dont le document est membre, SANS confondre
 * liens hérités et liens prouvés ; un document multi-Opérations reste unique.
 * Compte actif seulement : un document d'un autre compte, supprimé ou
 * inexistant → 404, sans distinction. Lecture seule, aucune IA.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { getDocumentRelations } from '@/services/relations/read-contract';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
  const { id } = await context.params;
  if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Valid document ID required');
  try {
    const rel = await getDocumentRelations(session.currentAccountId, Number(id));
    if (!rel) return apiError(404, 'NOT_FOUND', 'Document not found');
    return NextResponse.json(rel, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/documents/:id/relations] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
