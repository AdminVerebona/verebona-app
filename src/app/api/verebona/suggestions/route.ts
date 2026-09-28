/**
 * GET /api/verebona/suggestions?route=… — suggestions initiales (CDC §8.1, §8.2).
 *
 * Priorité page > compte > générique : le catalogue validé (§8.3) est filtré
 * par la page, puis complété par des suggestions dérivées de l'état du
 * compte (éléments « À traiter » en attente, échéances à moins de 30 jours,
 * documents en analyse ou en erreur, exports prêts). Seuls des compteurs
 * sont lus, bornés au compte de la session ; aucun contenu n'est renvoyé,
 * seulement des libellés du catalogue.
 *
 * Conventions du §27 : entrée validée par schéma (`SuggestionsQuerySchema`),
 * requestId renvoyé (`x-request-id`), débit limité (limiteur des lectures).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';
import { loadAccountSuggestionState } from '@/services/verebona-assistant/core/account-state';
import { httpRequestId, parseWith, queryObject, readRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { SuggestionsQuerySchema } from '@/lib/verebona/api-schemas';

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
  const limite = readRateLimited(session.userId, accountId, httpId);
  if (limite) return limite;
  const q = parseWith(SuggestionsQuerySchema, queryObject(req), httpId);
  if (!q.ok) return q.response;

  await ensureMigrations();
  // État indisponible : suggestions de page et génériques, sans erreur.
  const state = await loadAccountSuggestionState(accountId).catch(() => null);
  return NextResponse.json({
    suggestions: suggestionsForRoute(q.data.route, state).map((s) => ({ id: s.id, label: s.label })),
  });
}
