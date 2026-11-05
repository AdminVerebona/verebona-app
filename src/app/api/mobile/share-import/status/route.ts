import { NextRequest, NextResponse } from 'next/server';
import { getSession, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { apiError } from '@/lib/api-errors';
import { parseOperationIds, shareImportStatuses } from '@/services/mobile/share-import/status';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/share-import/status?ops=<id>,<id> — lot 110A.
 *
 * État SERVEUR des imports du partage natif tirés par ce téléphone, pour
 * l'utilisateur ET l'espace de la session uniquement : « pas encore reçu »,
 * « réception », « enregistré » (+ document, statut de traitement), « supprimé ».
 * Un identifiant d'un autre compte est rendu « pas encore reçu ».
 */
export async function GET(request: NextRequest) {
  let session;
  try { session = await getSession(request); } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    throw e;
  }
  if (!session.currentAccountId) return apiError(409, 'ACCOUNT_NOT_FOUND', 'Aucun espace sélectionné.');
  const ids = parseOperationIds(request.nextUrl.searchParams.get('ops'));
  const items = await shareImportStatuses(session.userId, session.currentAccountId, ids);
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
}
