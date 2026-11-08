/**
 * Périodes métier de PLUSIEURS documents — lot 113AB (Trello #725, §3
 * « Dépenses »).
 *
 *   GET /api/documents/periodes?ids=12,34,56
 *     → { periods: { "<fileId>": { principal, secondary, billing } } }
 *       lue par le détail des dépenses (TCO) : la période FACTURÉE du
 *       justificatif d'une dépense, corrigeable par
 *       `PUT /api/documents/:fileId/periodes` (même fait que la fiche du
 *       document : la correction se voit partout, sans toucher la couverture,
 *       la durée contractuelle ni l'imputation TCO). Une requête, au plus
 *       300 documents ; documents d'un autre compte ou supprimés : absents.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
  const brut = new URL(req.url).searchParams.get('ids') ?? '';
  if (!/^\d{1,10}(,\d{1,10}){0,299}$/.test(brut)) return apiError(400, 'INVALID_INPUT', 'Valid document IDs required');
  try {
    const { readDocumentPeriodSummaries } = await import('@/services/documents/business-period-surfaces');
    const m = await readDocumentPeriodSummaries(session.currentAccountId, brut.split(',').map(Number));
    return NextResponse.json({ periods: Object.fromEntries(m) }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/documents/periodes] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
