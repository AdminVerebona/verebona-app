/**
 * GET /api/suggestions — suggestions PARTAGÉES (lot 108J).
 *
 * Source unique des trois suggestions affichées sous la bulle de l'accueil
 * ET dans l'état initial de « Demander à Verebona » (ordinateur et mobile) :
 * mêmes éléments, même ordre, même version pour un même utilisateur et un
 * même état du compte. Compte et utilisateur de la SESSION (Duo : guide
 * propre à chaque membre, questions personnelles du compte partagé).
 *
 * Aucun appel IA (stock prévalidé, rotation déterministe). Ne renvoie
 * jamais une liste vide sans raison : en dernier recours, repli éditorial
 * sûr. Le diagnostic reste côté BO (rapport T6 « Suggestions partagées »).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { httpRequestId, readRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { getSharedSuggestions, publicSelectionOf } from '@/services/suggestions/shared/service';

export async function GET(req: NextRequest) {
  const httpId = httpRequestId(req);
  return withRequestId(await lire(req, httpId), httpId);
}

async function lire(req: NextRequest, httpId: string): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  const limite = await readRateLimited(session.userId, accountId, httpId, req);
  if (limite) return limite;
  const t0 = Date.now();
  const { selection, diagnostic } = await getSharedSuggestions(accountId, session.userId);
  return NextResponse.json(publicSelectionOf(selection), {
    headers: {
      'Cache-Control': 'private, no-store',
      // Visible dans l'onglet Réseau : état et cache, jamais de contenu.
      'Server-Timing': `suggestions;dur=${Date.now() - t0};desc="${diagnostic.code}-${diagnostic.cache}"`,
    },
  });
}
