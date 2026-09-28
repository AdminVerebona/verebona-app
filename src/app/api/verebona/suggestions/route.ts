/**
 * GET /api/verebona/suggestions?route=… — suggestions initiales (CDC §8.1, §8.2).
 *
 * Priorité page > compte > générique : le catalogue validé (§8.3) est filtré
 * par la page, puis complété par des suggestions dérivées de l'état du
 * compte (éléments « À traiter » en attente, échéances à moins de 30 jours,
 * documents en analyse ou en erreur, exports prêts). Seuls des compteurs
 * sont lus, bornés au compte de la session ; aucun contenu n'est renvoyé,
 * seulement des libellés du catalogue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';
import { loadAccountSuggestionState } from '@/services/verebona-assistant/core/account-state';

export async function GET(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  // Route de page : chemin interne seulement, borné (jamais une URL).
  const brut = req.nextUrl.searchParams.get('route') ?? '/';
  const route = /^\/[\w\-/]{0,200}$/.test(brut) ? brut : '/';
  // État indisponible : suggestions de page et génériques, sans erreur.
  const state = await loadAccountSuggestionState(accountId).catch(() => null);
  return NextResponse.json({
    suggestions: suggestionsForRoute(route, state).map((s) => ({ id: s.id, label: s.label })),
  });
}
