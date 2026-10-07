import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { listToProcessScanRuns } from '@/services/to-process/to-process-scan.job';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * GET /api/admin/ops/to-process-scan — trace du balayage fonctionnel
 * « À traiter » (lot 28, ticket P0).
 *
 * Réponse : `{ runs: [...], generatedAt }`, du plus récent au plus ancien ;
 * chaque passage `{ id, trigger ('schedule' | 'manual' | 'startup' |
 * 'route'), status ('running' | 'ok' | 'partial' | 'error'), startedAt,
 * finishedAt, durationMs, accounts, created, updated, closed, promoted,
 * demoted, errors, errorSample, nextCursor }`. `?limit=` (1 à 100, défaut 20).
 * Table absente (migration 0256 pas encore passée) : `runs: []` et
 * `available: false`. Réservé aux administrateurs.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const limit = Number(request.nextUrl.searchParams.get('limit')) || 20;
    try {
      const runs = await listToProcessScanRuns(limit);
      return NextResponse.json({ runs, available: true, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
    } catch (e) {
      if ((e as { code?: string }).code === '42P01') {
        return NextResponse.json({ runs: [], available: false, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
      }
      throw e;
    }
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/ops/to-process-scan] lecture :', (error as Error).message);
    return NextResponse.json(
      { error: 'Lecture de la trace du balayage impossible', code: 'TO_PROCESS_SCAN_LOAD_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
