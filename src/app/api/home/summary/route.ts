import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { buildHomeSummary } from '@/services/home/HomeSummaryService';
import { serverCacheGet, serverCacheSet } from '@/lib/server-cache';

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
    const cacheKey = `home:summary:${accountId}`;
    const cached = serverCacheGet<object>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' },
      });
    }

    const payload = await buildHomeSummary(accountId);
    serverCacheSet(cacheKey, payload, HOME_SUMMARY_CACHE_TTL_MS);

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' },
    });
  } catch (err) {
    console.error('GET /api/home/summary error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
