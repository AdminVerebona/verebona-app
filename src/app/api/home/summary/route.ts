import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { buildHomeSummary, type HomeSummaryPayload } from '@/services/home/HomeSummaryService';
import { accountCacheKey, serverCacheGet, serverCacheSet, wantsFreshRead } from '@/lib/server-cache';
import { createKeyedSingleFlight } from '@/lib/home/summary-single-flight';

const HOME_SUMMARY_CACHE_TTL_MS = 30_000; // 30s cache serveur

/**
 * Un calcul par compte à la fois (APP-PERF-09) : les demandes rapprochées
 * — deux onglets, un compte Duo sur deux appareils, une rafale d'événements
 * — partagent le calcul en cours ; une demande « fraîche » arrivée pendant
 * un calcul en programme au plus UN nouveau. Le résultat est remis en cache.
 */
const summaryFlight = createKeyedSingleFlight<HomeSummaryPayload>(async (key) => {
  const accountId = Number(key);
  const payload = await buildHomeSummary(accountId);
  serverCacheSet(accountCacheKey(accountId, 'home-summary'), payload, HOME_SUMMARY_CACHE_TTL_MS);
  return payload;
});

export async function GET(req: NextRequest) {
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

    // Cache serveur : éviter les 18 queries DB HomeSummaryService pour des
    // requêtes rapprochées (ex: retour arrière dans la même page, polling client)
    //
    // Après une modification, le client envoie `x-verebona-fresh: 1` : le
    // résumé est recalculé (puis remis en cache), au lieu de servir l'état
    // d'avant l'action pendant jusqu'à 30 s. Voir `lib/data-freshness.ts`.
    // Clé isolée par compte, invalidée par toute écriture du compte sur
    // cette instance (APP-PERF-22, `lib/server-cache.ts`).
    const cacheKey = accountCacheKey(accountId, 'home-summary');
    const wantsFresh = wantsFreshRead(req.headers);
    const cached = wantsFresh ? null : serverCacheGet<object>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'private, no-cache' },
      });
    }

    const payload = await summaryFlight.run(String(accountId), { fresh: wantsFresh });

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, no-cache' },
    });
  } catch (err) {
    console.error('GET /api/home/summary error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
