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
import { getEntitlements } from '@/services/entitlements.service';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ pending: 0 });

    // Essai terminé : aucune analyse ne doit repartir.
    const entitlements = await getEntitlements(accountId);
    if (!entitlements.canWrite) return NextResponse.json({ pending: 0, reason: 'READ_ONLY' });

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
            // Mis en file avant un redémarrage du serveur : jamais analysé.
            eq(assetFiles.analysisState, 'UPLOADED'),
            eq(assetFiles.analysisState, 'ANALYSIS_FAILED'),
          ),
        ),
      )
      .limit(20);

    if (pending.length === 0) return NextResponse.json({ pending: 0 });

    // ══════════════════════════════════════════════════════════════════
    // UN FICHIER PAR ANALYSE, VIA LA FILE
    //
    // Les vingt fichiers partaient dans UNE analyse, qui commençait par un
    // regroupement IA et supprimait les fichiers jugés « secondaires » :
    // des documents distincts pouvaient disparaître à la reprise. La file
    // les traite un par un, avec un parallélisme borné.
    // ══════════════════════════════════════════════════════════════════
    import('@/services/ai/source-analysis/analysis-queue').then(({ enqueueFileAnalyses }) =>
      enqueueFileAnalyses(pending.map(p => p.id), accountId, {
        userId: session.userId,
        origin: 'analysis/check-pending',
      }),
    ).catch(() => {});

    return NextResponse.json({ pending: pending.length, queued: true });
  } catch (error) {
    const errMsg = (error as Error).message;
    if (errMsg === 'AUTH_REQUIRED' || errMsg === 'INVALID_TOKEN' || errMsg === 'ACCOUNT_SUSPENDED') {
      return NextResponse.json({ pending: 0 });
    }
    return NextResponse.json({ pending: 0 });
  }
}
