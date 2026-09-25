import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { buildHomeSummary } from '@/services/home/HomeSummaryService';
import { serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import { FRESH_HEADER } from '@/lib/data-freshness';

const HOME_SUMMARY_CACHE_TTL_MS = 30_000; // 30s cache serveur

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
    const cacheKey = `home:summary:${accountId}`;
    const wantsFresh = req.headers.get(FRESH_HEADER) === '1';
    const cached = wantsFresh ? null : serverCacheGet<object>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'private, no-cache' },
      });
    }

    const payload = await buildHomeSummary(accountId);
    serverCacheSet(cacheKey, payload, HOME_SUMMARY_CACHE_TTL_MS);

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, no-cache' },
    });
  } catch (err) {
    console.error('GET /api/home/summary error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
