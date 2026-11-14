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
 *
 *   Carte #766 (E09) — GET /api/documents/periodes?lignes=c:12,doc:34:5:0
 *     → { linePeriods: { "<ligne>": { start, end } } }
 *       période PROPRE à une ligne de dépense (composante financière ou
 *       montant d'un justificatif), quand T1 / T3 l'ont établie : elle sert à
 *       rattacher la dépense à LA période facturée qui la concerne sur un
 *       justificatif qui en porte plusieurs. Au plus 300 lignes ; lecture
 *       seule, bornée au compte. `ids` et `lignes` peuvent être combinés.
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
  const params = new URL(req.url).searchParams;
  const brut = params.get('ids') ?? '';
  const lignes = params.get('lignes') ?? '';
  const idsValides = /^\d{1,10}(,\d{1,10}){0,299}$/.test(brut);
  // Carte #766 (E09) : identifiants de lignes de dépense (formes connues seulement).
  const lignesValides = /^(c:\d{1,15}|doc:\d{1,10}:\d{1,15}:\d{1,3})(,(c:\d{1,15}|doc:\d{1,10}:\d{1,15}:\d{1,3})){0,299}$/.test(lignes);
  if ((brut && !idsValides) || (lignes && !lignesValides) || (!brut && !lignes)) return apiError(400, 'INVALID_INPUT', 'Valid document IDs required');
  try {
    const { readDocumentPeriodSummaries, readExpenseLinePeriods } = await import('@/services/documents/business-period-surfaces');
    const m = brut ? await readDocumentPeriodSummaries(session.currentAccountId, brut.split(',').map(Number)) : new Map();
    const l = lignes ? await readExpenseLinePeriods(session.currentAccountId, lignes.split(',')) : null;
    return NextResponse.json(
      { periods: Object.fromEntries(m), ...(l ? { linePeriods: Object.fromEntries(l) } : {}) },
      { headers: { 'Cache-Control': 'private, no-cache' } },
    );
  } catch (err) {
    console.error('[api/documents/periodes] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
