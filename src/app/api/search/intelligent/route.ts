/**
 * POST /api/search/intelligent
 * Recherche intelligente en langage naturel — CDC Verebona V1
 *
 * Body : { query, context_type?, context_id? }
 * Response : IntelligentSearchResponse
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { intelligentSearch } from '@/lib/intelligent-search';
import { shouldRunLegacy } from '@/services/ai/flags/ai-feature-flags';
import { ensureMigrations } from '@/db';
import { refuserSiPasDIA } from '@/lib/write-access-guard';

export async function POST(req: NextRequest) {
  // ══════════════════════════════════════════════════════════════════════
  // AIGUILLAGE DE BASCULE — CDC §10.4, critères n°15 et n°16
  //
  // Cette route exécute `intelligentSearch`, l'usage historique n°7. Dès que
  // `AI_INTELLIGENT_ASSISTANT` est basculé, elle doit sortir du chemin
  // d'exécution : laisser coexister deux moteurs de réponse sur les mêmes
  // questions est exactement ce que le §10.4 interdit, et le critère n°16
  // exige qu'aucune ancienne route de recherche IA ne soit plus appelée.
  //
  // 410 et non 404 : une interface déployée peut encore appeler cette URL, et
  // un 404 laisserait croire à une panne. Le fichier disparaît au lot 5, où
  // `check-legacy-ai.mjs` l'interdit déjà.
  // ══════════════════════════════════════════════════════════════════════
  if (!shouldRunLegacy('AI_INTELLIGENT_ASSISTANT')) {
    return NextResponse.json(
      {
        error: 'ROUTE_REMOVED',
        message: "La recherche intelligente est remplacée par l'assistant Verebona.",
        replacement: '/api/verebona/messages',
      },
      { status: 410, headers: { Link: '</api/verebona/messages>; rel="successor-version"' } },
    );
  }

  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }

    const accountId = session.currentAccountId;

    if (!accountId) {
      return NextResponse.json({ error: 'No account selected' }, { status: 400 });
    }

    // Refusé si l'essai est terminé (§9.2). Le contrôle est ici et non dans
    // l'interface : une règle appliquée par le seul navigateur n'est pas
    // appliquée.
    const refus = await refuserSiPasDIA(accountId);
    if (refus) return refus;

    await ensureMigrations();

    const body = await req.json().catch(() => ({}));
    const query = typeof body.query === 'string' ? body.query.trim() : '';

    if (!query || query.length < 3) {
      return NextResponse.json({ error: 'Query too short' }, { status: 400 });
    }
    if (query.length > 500) {
      return NextResponse.json({ error: 'Query too long' }, { status: 400 });
    }

    const result = await intelligentSearch({
      query,
      accountId,
      userId: session.userId ?? null,
      offerCode: session.planType ?? 'STANDARD',
      contextType: body.context_type ?? undefined,
      contextId: typeof body.context_id === 'number' ? body.context_id : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[POST /api/search/intelligent]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
