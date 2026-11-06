/**
 * GET /api/verebona/suggestions?route=… — route HISTORIQUE des suggestions
 * initiales (CDC §8.1, §8.2).
 *
 * Lot 112C : ALIGNÉE sur le service unique des suggestions partagées (lot
 * 108J, critère d'utilité 111L, questions « Exploiter » prouvées 112C) — la
 * MÊME sélection que GET /api/suggestions (mêmes éléments, même ordre, même
 * version, mêmes règles : stock prévalidé, utilité, preuve de réponse,
 * Standard / Premium). Auparavant elle servait encore le catalogue par page
 * (`suggestionsForRoute`), donc des simples listes (« Quels sont les documents
 * de X ? ») que plus aucun écran ne propose. Aucun écran ne l'appelle depuis
 * 108J / 110C ; elle reste compatible pour un client ancien : même forme
 * `{ suggestions: [{ id, label }] }` (plus `contract` et `version`).
 *
 * Le paramètre `route` reste validé (§27) mais ne change plus la sélection :
 * la sélection partagée ne dépend pas de la page. Compte et utilisateur de la
 * SESSION (isolation, Duo) ; aucun appel IA ; seuls des libellés du stock et
 * du catalogue validé sont renvoyés.
 *
 * Conventions du §27 : entrée validée par schéma (`SuggestionsQuerySchema`),
 * requestId renvoyé (`x-request-id`), débit limité (limiteur des lectures).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { getSharedSuggestions, publicSelectionOf } from '@/services/suggestions/shared/service';
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
  // Même service, mêmes règles que GET /api/suggestions (ne lève jamais : repli éditorial sûr).
  const { selection } = await getSharedSuggestions(accountId, session.userId);
  const pub = publicSelectionOf(selection);
  return NextResponse.json(
    { contract: pub.contract, version: pub.version, suggestions: pub.items.map((s) => ({ id: s.id, label: s.label })) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
