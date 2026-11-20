/**
 * Événements de référence d'un document — lot 113AB (Trello #725).
 *
 *   GET /api/documents/:id/evenements-reference
 *     → { references: [{ id, label, hasAgenda, coverageCount }] }
 *       événements de référence ACTIFS dont le document est membre : le
 *       tiroir du document ouvre leur fiche (`GET /api/evenements-reference/:id`),
 *       y compris quand aucun élément d'agenda ne les représente.
 *   GET /api/documents/:id/evenements-reference?candidats=1&q=<texte>
 *     → { candidates: [{ id, title, meta }], more }
 *       carte #806, volet B §7 : opérations ACTIVES du compte auxquelles le
 *       document n'appartient pas encore (geste « Rattacher à une opération »
 *       du tiroir du document) ; `more` : d'autres existent (jamais de coupe
 *       muette). Le rattachement et le retrait passent par les routes
 *       existantes `POST` / `DELETE /api/evenements-reference/:id/documents`
 *       (façade d'écriture : compte, droits, lecture seule, refus mémorisé).
 * Compte actif de la session seulement (document d'un autre compte → 404).
 * Lecture seule : aucune écriture, aucune IA.
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
  if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Valid document ID required');
  try {
    const params = req.nextUrl.searchParams;
    if (params.has('candidats')) {
      const { readDocumentOperationCandidates } = await import('@/services/business-operations/graph/document-links');
      const liste = await readDocumentOperationCandidates(session.currentAccountId, Number(id), (params.get('q') ?? '').slice(0, 120));
      if (!liste) return apiError(404, 'NOT_FOUND', 'Document introuvable.');
      return NextResponse.json(liste, { headers: { 'Cache-Control': 'private, no-cache' } });
    }
    const { referenceEventsOfDocument } = await import('@/services/documents/business-period-surfaces');
    const references = await referenceEventsOfDocument(session.currentAccountId, Number(id));
    if (!references) return apiError(404, 'NOT_FOUND', 'Document introuvable.');
    return NextResponse.json({ references }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/documents/:id/evenements-reference] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
