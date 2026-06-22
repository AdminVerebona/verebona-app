/**
 * GET /api/admin/ai/accounts/[accountId]
 * Détail d'un compte — historique opérations, coûts, blocages, audit
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, pgClient } from '@/db';
import { accounts, users, aiUsageAccountCounter, aiOperation, aiSecurityLock, aiAdminAuditLog, accountAnalysisCounters } from '@/db/schema';
import { isNull } from 'drizzle-orm';
import { eq, sql, and, desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { SUBSCRIPTION_LIMITS } from '@/lib/subscription-limits';

const ANALYSIS_QUOTAS: Record<string, { yearly: number; trial: number }> = {
  standard:    { yearly: 50,     trial: 10 },
  premium:     { yearly: 200,    trial: 30 },
  premium_duo: { yearly: 300,    trial: 50 },
  pro:         { yearly: 999999, trial: 999999 },
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    await requireAdmin(request);
    const { accountId: accountIdStr } = await params;
    const accountId = parseInt(accountIdStr);
    if (isNaN(accountId)) return NextResponse.json({ error: 'ID invalide' }, { status: 400 });

    const currentYear = new Date().getFullYear();

    const [account, counter, operations, locks, auditLogs, costByProvider, activeCounter, costByCategory, clientCostYear] = await Promise.all([
      db.select({
        id: accounts.id,
        name: accounts.name,
        planType: accounts.planType,
        ownerEmail: users.email,
      })
        .from(accounts)
        .leftJoin(users, eq(accounts.ownerUserId, users.id))
        .where(eq(accounts.id, accountId))
        .limit(1)
        .then(r => r[0]),

      db.select()
        .from(aiUsageAccountCounter)
        .where(and(eq(aiUsageAccountCounter.accountId, accountId), eq(aiUsageAccountCounter.periodYear, currentYear)))
        .limit(1)
        .then(r => r[0]),

      db.select({
        id: aiOperation.id,
        publicId: aiOperation.publicId,
        accountId: aiOperation.accountId,
        assetFileId: aiOperation.assetFileId,
        operationCategory: aiOperation.operationCategory,
        businessResult: aiOperation.businessResult,
        origin: aiOperation.origin,
        providerPrimary: aiOperation.providerPrimary,
        usedFallback: aiOperation.usedFallback,
        totalCostMicros: aiOperation.totalCostMicros,
        totalInputTokens: aiOperation.totalInputTokens,
        totalOutputTokens: aiOperation.totalOutputTokens,
        durationMs: aiOperation.durationMs,
        isReanalysis: aiOperation.isReanalysis,
        environment: aiOperation.environment,
        startedAt: aiOperation.startedAt,
        completedAt: aiOperation.completedAt,
      })
        .from(aiOperation)
        .where(eq(aiOperation.accountId, accountId))
        .orderBy(desc(aiOperation.startedAt))
        .limit(50),

      db.select({
        id: aiSecurityLock.id,
        accountId: aiSecurityLock.accountId,
        assetFileId: aiSecurityLock.assetFileId,
        lockType: aiSecurityLock.lockType,
        triggeredAt: aiSecurityLock.triggeredAt,
        triggerDetails: aiSecurityLock.triggerDetails,
        isResolved: aiSecurityLock.isResolved,
        resolvedAt: aiSecurityLock.resolvedAt,
        resolutionNotes: aiSecurityLock.resolutionNotes,
      })
        .from(aiSecurityLock)
        .where(eq(aiSecurityLock.accountId, accountId))
        .orderBy(desc(aiSecurityLock.triggeredAt))
        .limit(20),

      db.select({
        id: aiAdminAuditLog.id,
        adminEmail: aiAdminAuditLog.adminEmail,
        actionType: aiAdminAuditLog.actionType,
        beforeValue: aiAdminAuditLog.beforeValue,
        afterValue: aiAdminAuditLog.afterValue,
        reason: aiAdminAuditLog.reason,
        createdAt: aiAdminAuditLog.createdAt,
      })
        .from(aiAdminAuditLog)
        .where(eq(aiAdminAuditLog.targetAccountId, accountId))
        .orderBy(desc(aiAdminAuditLog.createdAt))
        .limit(30),

      db.select({
        provider: aiOperation.providerPrimary,
        totalCostMicros: sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
      })
        .from(aiOperation)
        .where(
          and(
            eq(aiOperation.accountId, accountId),
            sql`EXTRACT(YEAR FROM started_at) = ${currentYear}`,
            sql`${aiOperation.userId} IS NOT NULL`,
          )
        )
        .groupBy(aiOperation.providerPrimary),

      // Compteur actif (source de vérité pour quota et consommation réelle)
      db.select()
        .from(accountAnalysisCounters)
        .where(and(eq(accountAnalysisCounters.accountId, accountId), isNull(accountAnalysisCounters.periodEndAt)))
        .orderBy(desc(accountAnalysisCounters.periodStartAt))
        .limit(1)
        .then(r => r[0]),

      // Coût & nb ops par catégorie (uniquement opérations utilisateur réel)
      db.select({
        operationCategory: aiOperation.operationCategory,
        opsCount: sql<number>`count(*)::int`,
        totalCostMicros: sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
        successCount: sql<number>`sum(CASE WHEN business_result IN ('success','success_with_warning') THEN 1 ELSE 0 END)::int`,
      })
        .from(aiOperation)
        .where(
          and(
            eq(aiOperation.accountId, accountId),
            sql`EXTRACT(YEAR FROM started_at) = ${currentYear}`,
            sql`${aiOperation.userId} IS NOT NULL`,
          )
        )
        .groupBy(aiOperation.operationCategory),

      // Coût client uniquement (userId non null) pour l'année en cours
      db.select({ total: sql<number>`COALESCE(sum(total_cost_micros),0)::int` })
        .from(aiOperation)
        .where(
          and(
            eq(aiOperation.accountId, accountId),
            sql`EXTRACT(YEAR FROM started_at) = ${currentYear}`,
            sql`user_id IS NOT NULL`,
          )
        )
        .then(r => r[0]?.total ?? 0),
    ]);

    // Recherches intelligentes (ai_search_log) — table optionnelle
    let searchLogs: any[] = [];
    let searchStats = { count: 0, costMicros: 0, answerCount: 0, noResultCount: 0, avgDurationMs: 0, inputTokens: 0, outputTokens: 0 };
    try {
      const [logsRaw, statsRaw] = await Promise.all([
        pgClient.unsafe(`
          SELECT id, public_id, query_text, response_mode, answer_text, sources_count,
                 offer_code, cost_micros, input_tokens, output_tokens, duration_ms,
                 provider, model, business_result, block_reason, created_at
          FROM ai_search_log
          WHERE account_id = ${accountId}
          ORDER BY created_at DESC
          LIMIT 30
        `),
        pgClient.unsafe(`
          SELECT
            COUNT(*)::int AS count,
            COALESCE(SUM(cost_micros),0)::bigint AS cost_micros,
            SUM(CASE WHEN response_mode = 'answer' THEN 1 ELSE 0 END)::int AS answer_count,
            SUM(CASE WHEN response_mode = 'no_result' THEN 1 ELSE 0 END)::int AS no_result_count,
            COALESCE(AVG(duration_ms),0)::int AS avg_duration_ms,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens
          FROM ai_search_log
          WHERE account_id = ${accountId}
            AND EXTRACT(YEAR FROM created_at) = ${currentYear}
        `),
      ]);
      searchLogs = logsRaw.map((r: any) => ({
        id: r.id,
        publicId: r.public_id,
        queryText: r.query_text,
        responseMode: r.response_mode,
        answerText: r.answer_text,
        sourcesCount: r.sources_count,
        offerCode: r.offer_code,
        costMicros: Number(r.cost_micros),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        durationMs: r.duration_ms,
        provider: r.provider,
        model: r.model,
        businessResult: r.business_result,
        blockReason: r.block_reason,
        createdAt: r.created_at,
      }));
      const s = statsRaw[0] as any;
      if (s) searchStats = {
        count: Number(s.count),
        costMicros: Number(s.cost_micros),
        answerCount: Number(s.answer_count),
        noResultCount: Number(s.no_result_count),
        avgDurationMs: Number(s.avg_duration_ms),
        inputTokens: Number(s.input_tokens),
        outputTokens: Number(s.output_tokens),
      };
    } catch { /* ai_search_log may not exist yet */ }

    if (!account) return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });

    const planKey = account.planType.toLowerCase();
    const planQuota = ANALYSIS_QUOTAS[planKey] ?? ANALYSIS_QUOTAS['standard'];
    const planSubKey = account.planType.toUpperCase() as keyof typeof SUBSCRIPTION_LIMITS;
    const planSub = SUBSCRIPTION_LIMITS[planSubKey] ?? SUBSCRIPTION_LIMITS['STANDARD'];

    return NextResponse.json({
      accountId,
      accountName: account.name,
      planCode: account.planType,
      ownerEmail: account.ownerEmail,
      periodYear: currentYear,
      documentsAnalyzedCount: activeCounter?.includedConsumed ?? counter?.documentsAnalyzedCount ?? 0,
      documentsAnalyzedQuota: activeCounter?.includedQuota || planQuota.yearly,
      maxAssets: planSub.maxAssets,
      trialDocumentsCount: counter?.trialDocumentsCount ?? 0,
      trialDocumentsQuota: counter?.trialDocumentsQuota ?? 0,
      totalCostMicrosThisYear: (clientCostYear as number) + searchStats.costMicros,
      lastOperationAt: operations[0]?.startedAt ?? null,
      hasActiveLock: locks.some(l => !l.isResolved),
      recentOperations: operations,
      activeSecurityLocks: locks,
      costByProvider: Object.fromEntries(
        costByProvider.filter(c => c.provider).map(c => [c.provider!, c.totalCostMicros])
      ),
      costByCategory: costByCategory.map(r => ({
        category: r.operationCategory,
        opsCount: r.opsCount,
        successCount: r.successCount,
        totalCostMicros: r.totalCostMicros,
      })),
      auditLogs,
      searchLogs,
      searchStats,
    });
  } catch (error: any) {
    if (error?.message === 'INSUFFICIENT_PERMISSIONS') {
      return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
    }
    console.error('[GET /api/admin/ai/accounts/[accountId]]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
