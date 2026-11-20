/**
 * Carte Trello #806, volet B §8 — LISTE DES OPÉRATIONS du compte.
 *
 *   GET /api/evenements-reference?q=&type=&bien=&etat=&tri=&page=&taille=
 *     → { items, total, totalAll, page, pageSize, pages, query, types, assets }
 *       toutes les opérations ACTIVES du compte actif de la session qui
 *       répondent à la demande, triées, par pages (25 par défaut, 100 au
 *       plus) ; `total` dit combien il y en a en tout — rien n'est coupé en
 *       silence.
 *
 * Lecture seule : aucune écriture, aucune IA ; un compte en lecture seule
 * consulte. Compte actif de la session seulement : aucune opération d'un autre
 * compte, même en nommant un de ses biens dans le filtre.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { operationListQueryOf } from '@/lib/reference-events/operation-list';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
  try {
    const { readOperationList } = await import('@/services/business-operations/graph/reference-event-list');
    const page = await readOperationList(Number(session.currentAccountId), operationListQueryOf(req.nextUrl.searchParams));
    return NextResponse.json(page, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/evenements-reference] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
