/**
 * POST /api/documents/analyze-batch
 * Lance le pipeline d'analyse unifié sur un ensemble de fileIds existants.
 * Utilisé par les actions "Analyser la sélection" dans les pages UI.
 * Fire-and-forget côté serveur — retourne immédiatement.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const body = await request.json();
    const fileIds: number[] = Array.isArray(body.fileIds) ? body.fileIds.map(Number) : [];
    if (fileIds.length === 0) {
      return NextResponse.json({ error: 'MISSING_FILE_IDS' }, { status: 400 });
    }

    // Fire-and-forget
    import('@/services/document-ai/unified-analysis-pipeline').then(({ runUnifiedAnalysisPipeline }) => {
      runUnifiedAnalysisPipeline(fileIds, accountId).catch((err: Error) => {
        console.error('[analyze-batch] pipeline failed:', err);
      });
    }).catch(() => {});

    return NextResponse.json({ queued: true, count: fileIds.length });
  } catch (error) {
    if (error instanceof Response) return error;
    const errMsg = (error as Error).message;
    if (errMsg === 'AUTH_REQUIRED' || errMsg === 'INVALID_TOKEN' || errMsg === 'ACCOUNT_SUSPENDED') {
      const { SessionService } = await import('@/lib/session-service');
      return SessionService.handleSessionError(error);
    }
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
