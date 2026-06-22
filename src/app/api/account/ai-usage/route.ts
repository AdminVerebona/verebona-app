/**
 * GET /api/account/ai-usage
 * Retourne les quotas IA pour l'affichage dans Mon compte > Abonnement
 * CDC §3 — uniquement "Nombre de biens" et "Documents analysés"
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts, assets, aiUsageAccountCounter, accountAnalysisCounters, accountMemberships } from '@/db/schema';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { SUBSCRIPTION_LIMITS } from '@/lib/subscription-limits';

// Quotas documentaires par plan (CDC V2)
const ANALYSIS_QUOTAS: Record<string, { yearly: number; trial: number }> = {
  standard:    { yearly: 50,  trial: 10 },
  premium:     { yearly: 200, trial: 30 },
  premium_duo: { yearly: 300, trial: 50 },
  pro:         { yearly: 999999, trial: 999999 },
};

export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const userId = session.userId;

    // Récupère le compte de l'utilisateur
    const membership = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(and(eq(accountMemberships.userId, userId), eq(accountMemberships.status, 'active')))
      .limit(1)
      .then(r => r[0]);

    const accountId = membership?.accountId ?? session.currentAccountId;
    if (!accountId) {
      return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
    }

    const currentYear = new Date().getFullYear();

    // Plan du compte
    const account = await db
      .select({ planType: accounts.planType })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
      .then(r => r[0]);

    if (!account) {
      return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
    }

    // Quotas du plan depuis SUBSCRIPTION_LIMITS + ANALYSIS_QUOTAS
    const planKey = (account.planType || 'STANDARD').toUpperCase() as keyof typeof SUBSCRIPTION_LIMITS;
    const planQuotaKey = (account.planType || 'standard').toLowerCase();
    const limits = SUBSCRIPTION_LIMITS[planKey] ?? SUBSCRIPTION_LIMITS.STANDARD;
    const analysisQuota = ANALYSIS_QUOTAS[planQuotaKey] ?? ANALYSIS_QUOTAS.standard;

    const assetsQuota = limits.maxAssets;
    const documentsAnalyzedQuota = analysisQuota.yearly;
    const trialDocumentsQuota = analysisQuota.trial;

    // Nombre de biens actifs (hors archivés/supprimés)
    const assetsCountResult = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(assets)
      .where(
        and(
          eq(assets.accountId, accountId),
          isNull(assets.deletedAt),
          ne(assets.status, 'ARCHIVED'),
          ne(assets.lockState, 'HARD'),
        )
      )
      .then(r => r[0]?.cnt ?? 0);

    // Compteur documents analysés (table ai_usage_account_counter si dispo, sinon account_analysis_counters)
    let documentsAnalyzedCount = 0;
    let trialDocumentsCount = 0;

    const aiCounter = await db
      .select({
        documentsAnalyzedCount: aiUsageAccountCounter.documentsAnalyzedCount,
        trialDocumentsCount: aiUsageAccountCounter.trialDocumentsCount,
        documentsAnalyzedQuotaStored: aiUsageAccountCounter.documentsAnalyzedQuota,
        trialDocumentsQuotaStored: aiUsageAccountCounter.trialDocumentsQuota,
      })
      .from(aiUsageAccountCounter)
      .where(
        and(
          eq(aiUsageAccountCounter.accountId, accountId),
          eq(aiUsageAccountCounter.periodYear, currentYear),
        )
      )
      .limit(1)
      .then(r => r[0]);

    if (aiCounter) {
      documentsAnalyzedCount = aiCounter.documentsAnalyzedCount;
      trialDocumentsCount = aiCounter.trialDocumentsCount;
    } else {
      // Fallback sur les anciens compteurs account_analysis_counters
      const legacyCounters = await db
        .select({
          periodType: accountAnalysisCounters.periodType,
          includedConsumed: accountAnalysisCounters.includedConsumed,
        })
        .from(accountAnalysisCounters)
        .where(
          and(
            eq(accountAnalysisCounters.accountId, accountId),
            isNull(accountAnalysisCounters.periodEndAt),
          )
        );

      for (const c of legacyCounters) {
        if (c.periodType === 'annual') documentsAnalyzedCount = c.includedConsumed;
        if (c.periodType === 'trial') trialDocumentsCount = c.includedConsumed;
      }
    }

    const assetsPercent = Math.min(100, Math.round((assetsCountResult / assetsQuota) * 100));
    const documentsPercent = Math.min(100, Math.round((documentsAnalyzedCount / (documentsAnalyzedQuota || 1)) * 100));

    const shouldShowUpgradeCta = assetsPercent >= 90 || documentsPercent >= 90;
    const isAnyQuotaBlocked = assetsCountResult >= assetsQuota || documentsAnalyzedCount >= documentsAnalyzedQuota;

    return NextResponse.json({
      accountId,
      periodYear: currentYear,
      assetsCount: assetsCountResult,
      assetsQuota,
      documentsAnalyzedCount,
      documentsAnalyzedQuota,
      trialDocumentsCount,
      trialDocumentsQuota,
      shouldShowUpgradeCta,
      isAnyQuotaBlocked,
      assetsPercent,
      documentsPercent,
    });
  } catch (error: any) {
    if (error?.message === 'AUTH_REQUIRED' || error?.message === 'INVALID_TOKEN') {
      return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    }
    console.error('[GET /api/account/ai-usage]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
