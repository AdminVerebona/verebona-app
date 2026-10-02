/**
 * GET /api/verebona/search-results?t=<jeton> — action OPEN_SEARCH_RESULTS
 * (CDC Assistant §22.4 ; D-J3, lot 21).
 *
 * Résout le jeton signé préparé par le serveur : signature, expiration
 * (30 min) et COMPTE de la session (`search-token.ts`), puis REVÉRIFIE dans
 * le compte chaque document et chaque bien du jeton — un document supprimé
 * ou déplacé depuis disparaît des résultats. Redirige (303) vers Mes
 * documents filtrés (`?resultats=`) ou l'agenda filtré par biens.
 *
 * Jeton invalide, expiré ou d'un autre compte : redirection vers la page de
 * la portée sans filtre (ou Mes documents), jamais d'erreur technique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';
import { httpRequestId, readRateLimited, withRequestId } from '@/lib/verebona/api-guard';
import { searchResultsTarget, verifySearchToken } from '@/services/verebona-assistant/core/search-token';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const httpId = httpRequestId(req);
  return withRequestId(await ouvrir(req, httpId), httpId);
}

async function ouvrir(req: NextRequest, httpId: string): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  const limite = await readRateLimited(session.userId, accountId, httpId, req);
  if (limite) return limite;

  const versPage = (path: string) => NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
  const check = verifySearchToken(req.nextUrl.searchParams.get('t'), accountId);
  if (!check.ok) {
    console.warn(`[verebona][${httpId}] résultats de recherche refusés : ${check.reason}`);
    return versPage('/documents');
  }
  const { s: scope, ids, assets } = check.payload;
  await ensureMigrations();

  // Revérification par compte (§22.4 « lié au compte ») : seuls les objets
  // ENCORE dans le compte de la session sont montrés.
  const docs = scope === 'documents' && ids.length
    ? ((await pgClient.unsafe(
      `SELECT id FROM asset_files WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`,
      [ids, accountId] as never[],
    )) as unknown as Array<{ id: number }>).map((r) => Number(r.id))
    : [];
  const biens = assets.length
    ? ((await pgClient.unsafe(
      `SELECT id FROM assets WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`,
      [assets, accountId] as never[],
    )) as unknown as Array<{ id: number }>).map((r) => Number(r.id))
    : [];
  const ordre = (liste: number[], gardes: number[]) => liste.filter((id) => gardes.includes(id));
  return versPage(searchResultsTarget(scope, ordre(ids, docs), ordre(assets, biens), ids.length));
}
