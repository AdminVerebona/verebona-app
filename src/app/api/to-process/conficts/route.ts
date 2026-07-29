/**
 * GET /api/to-process/conflicts
 *
 * Conflits de réconciliation ouverts, au format des cartes « À arbitrer »
 * (CDC §7.1, critère d'acceptation n°13).
 *
 * Alimente l'onglet d'arbitrage de la page « À traiter », aux côtés des revues
 * fournisseurs, sur le même modèle que `/api/to-process/suppliers`. Aucun
 * onglet supplémentaire : le CDC place la refonte de cette page hors périmètre,
 * seule son alimentation est demandée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { listOpenReconciliationConflicts } from '@/services/ai/reconciliation/to-process-conflicts';

export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    // Ne lève jamais : une table absente rend une liste vide. La page
    // « À traiter » est un écran de tous les jours, elle ne doit pas tomber
    // parce qu'une migration du chantier IA n'est pas encore passée.
    const items = await listOpenReconciliationConflicts(accountId);

    return NextResponse.json({ items, total: items.length });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
