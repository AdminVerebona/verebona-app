import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, ensureUnaccent } from '@/db';
import { globalSearch } from '@/services/search/global-search.service';

/**
 * Recherche LEXICALE du compte (biens, documents, échéances), toutes offres.
 *
 * Décision PO D-H2 (lot 16b-2) : le repli sémantique Gemini des comptes
 * Premium (`lib/gemini-search.ts`, usage historique n°6) et la recherche
 * intelligente (`/api/search/intelligent`, usage n°7) sont SUPPRIMÉS. La
 * recherche reste lexicale ; une question en langage naturel passe par
 * l'assistant (`/api/verebona/messages`). `aiPowered` est conservé dans la
 * réponse (toujours `false`) pour la compatibilité des clients.
 *
 * Lot 33 (ticket « T2 Recherche : empêcher les faux positifs ») : la route
 * délègue à `services/search/global-search.service.ts` — génération de
 * candidats, ÉLIGIBILITÉ (correspondance explicable obligatoire), puis
 * classement. Chaque résultat porte `match` (champ, valeur, type de
 * correspondance, scores, rang). `debug=1` ajoute les traces complètes,
 * rejets compris (`rejectionReason`) — données du seul compte de la session.
 * `instant=1` (suggestions pendant la frappe) : même réponse.
 */
export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    await ensureMigrations();
    await ensureUnaccent();

    const params = new URL(req.url).searchParams;
    const q = (params.get('q') ?? '').trim();
    if (!q) return NextResponse.json({ results: [], aiPowered: false });

    const out = await globalSearch(accountId, q, { debug: params.get('debug') === '1' });
    return NextResponse.json({ ...out, aiPowered: false });
  } catch (err) {
    console.error('[search] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
