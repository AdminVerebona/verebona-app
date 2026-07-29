/**
 * GET /api/analysis/check-pending
 * Vérifie si le compte a des documents non analysés avec du crédit disponible,
 * et déclenche leur analyse en arrière-plan.
 *
 * Appelé au chargement de l'app (côté client, une fois par session).
 * Réponse immédiate — l'analyse tourne en fire-and-forget.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { canConsumeAnalysis } from '@/services/commercial-model.service';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ pending: 0 });

    // Vérifier rapidement s'il y a du crédit
    const gate = await canConsumeAnalysis(accountId, 1);
    if (!gate.allowed) return NextResponse.json({ pending: 0, reason: gate.reason });

    // Compter les docs non analysés (analysisState null ou ANALYSIS_FAILED récupérable)
    const pending = await db
      .select({ id: assetFiles.id })
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.accountId, accountId),
          isNull(assetFiles.deletedAt),
          eq(assetFiles.uploadStatus, 'COMPLETED'),
          or(
            isNull(assetFiles.analysisState),
            eq(assetFiles.analysisState, 'ANALYSIS_FAILED'),
          ),
        ),
      )
      .limit(20);

    if (pending.length === 0) return NextResponse.json({ pending: 0 });

    // Déclencher en arrière-plan sans bloquer la réponse
    import('@/services/ai/source-analysis/entrypoint').then(({ analyzeFileSources }) => {
      void analyzeFileSources(pending.map(p => p.id), accountId, {
        origin: 'analysis/check-pending',
      });
    }).catch(() => {});

    return NextResponse.json({ pending: pending.length, queued: true });
  } catch (error) {
    const errMsg = (error as Error).message;
    if (errMsg === 'AUTH_REQUIRED' || errMsg === 'INVALID_TOKEN' || errMsg === 'ACCOUNT_SUSPENDED') {
      return NextResponse.json({ pending: 0 });
    }
    return NextResponse.json({ pending: 0 });
  }
}
