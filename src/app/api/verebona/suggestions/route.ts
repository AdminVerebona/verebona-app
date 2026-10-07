/**
 * GET /api/verebona/suggestions?route=… — suggestions initiales (CDC §8.1, §8.2).
 *
 * Priorité page > compte > générique : le catalogue validé (§8.3) est filtré
 * par la page, puis complété par des suggestions dérivées de l'état du
 * compte (éléments « À traiter » en attente, échéances à moins de 30 jours,
 * documents en analyse ou en erreur, exports prêts, documents non
 * rattachés). Lot 32 : sur la fiche d'un bien, les exemples NOMMENT le bien ;
 * hors fiche, ils peuvent nommer un vrai bien du compte. Tout est lu borné
 * au compte de la session ; seuls des libellés du catalogue sont renvoyés.
 *
 * Conventions du §27 : entrée validée par schéma (`SuggestionsQuerySchema`),
 * requestId renvoyé (`x-request-id`), débit limité (limiteur des lectures).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';
import { loadSuggestionContext } from '@/services/verebona-assistant/core/account-state';
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
  const limite = await readRateLimited(session.userId, accountId, httpId, req);
  if (limite) return limite;
  const q = parseWith(SuggestionsQuerySchema, queryObject(req), httpId);
  if (!q.ok) return q.response;

  await ensureMigrations();
  // Contexte indisponible : exemples indépendants des données, sans erreur.
  const ctx = await loadSuggestionContext(accountId, q.data.route).catch(() => null);
  return NextResponse.json({
    suggestions: suggestionsForRoute(q.data.route, ctx).map((s) => ({ id: s.id, label: s.label })),
  });
}
