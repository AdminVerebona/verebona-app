/**
 * GET /api/admin/ai/accounts
 * Liste des comptes avec leur consommation IA
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { pgClient } from '@/db';
import { accounts, users, aiOperation, aiSecurityLock, accountAnalysisCounters } from '@/db/schema';
import { eq, sql, and, like, isNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, parseInt(searchParams.get('limit') || '50'));
    const offset = (page - 1) * limit;
    const currentYear = new Date().getFullYear();

    const allAccounts = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        planType: accounts.planType,
        ownerEmail: users.email,
      })
      .from(accounts)
      .leftJoin(users, eq(accounts.ownerUserId, users.id))
      .where(search ? like(accounts.name, `%${search}%`) : undefined)
      .orderBy(accounts.name)
      .limit(limit)
      .offset(offset);

    const accountIds = allAccounts.map(a => a.id);

    if (accountIds.length === 0) {
      return NextResponse.json({ accounts: [], total: 0, page, limit });
    }

    const idsClause = sql.raw(`ARRAY[${accountIds.join(',')}]::int[]`);

    // Compteurs réels (account_analysis_counters = source de vérité)
    const counters = await db
      .select({
        accountId: accountAnalysisCounters.accountId,
        documentsAnalyzedCount: accountAnalysisCounters.includedConsumed,
        documentsAnalyzedQuota: accountAnalysisCounters.includedQuota,
      })
      .from(accountAnalysisCounters)
      .where(
        and(
          sql`${accountAnalysisCounters.accountId} = ANY(${idsClause})`,
          isNull(accountAnalysisCounters.periodEndAt),
        )
      );

    // Coût par catégorie cette année — toutes les opérations (y compris cron enrichissement/cohérence)
    const costsByCategory = await db
      .select({
        accountId: aiOperation.accountId,
        category: aiOperation.operationCategory,
        totalCostMicros: sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
        lastOp: sql<string>`max(started_at)`,
      })
      .from(aiOperation)
      .where(
        and(
          sql`${aiOperation.accountId} = ANY(${idsClause})`,
          sql`EXTRACT(YEAR FROM started_at) = ${currentYear}`,
        )
      )
      .groupBy(aiOperation.accountId, aiOperation.operationCategory);

    // Coût recherches intelligentes (ai_search_log) cette année
    const searchCostMap: Record<number, number> = {};
    try {
      const searchCostsRaw = await pgClient.unsafe<{ account_id: number; total_micros: string }[]>(`
        SELECT account_id, COALESCE(SUM(cost_micros), 0)::bigint AS total_micros
        FROM ai_search_log
        WHERE account_id = ANY(ARRAY[${accountIds.join(',')}]::int[])
          AND EXTRACT(YEAR FROM created_at) = ${currentYear}
        GROUP BY account_id
      `);
      for (const r of searchCostsRaw) searchCostMap[r.account_id] = Number(r.total_micros);
    } catch { /* table may not exist yet */ }

    // Blocages actifs
    const locks = await db
      .select({
        accountId: aiSecurityLock.accountId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(aiSecurityLock)
      .where(
        and(
          sql`${aiSecurityLock.accountId} = ANY(${idsClause})`,
          eq(aiSecurityLock.isResolved, false),
        )
      )
      .groupBy(aiSecurityLock.accountId);

    // Index
    const counterMap: Record<number, { documentsAnalyzedCount: number; documentsAnalyzedQuota: number }> = {};
    // costMap[accountId][category] = { totalCostMicros, lastOp }
    const costMap: Record<number, { analysis: number; search: number; other: number; lastOp: string | null }> = {};
    const lockMap: Record<number, number> = {};
    for (const c of counters) counterMap[c.accountId] = c;
    for (const c of costsByCategory) {
      if (!c.accountId) continue;
      if (!costMap[c.accountId]) costMap[c.accountId] = { analysis: 0, search: 0, other: 0, lastOp: null };
      const bucket = c.category === 'document_analysis' ? 'analysis' : c.category === 'search' ? 'search' : 'other';
      costMap[c.accountId][bucket] += c.totalCostMicros;
      if (!costMap[c.accountId].lastOp || (c.lastOp && c.lastOp > costMap[c.accountId].lastOp!)) {
        costMap[c.accountId].lastOp = c.lastOp;
      }
    }
    for (const l of locks) if (l.accountId) lockMap[l.accountId] = l.cnt;

    const result = allAccounts.map(a => {
      const cm = costMap[a.id];
      return {
        accountId: a.id,
        accountName: a.name,
        planCode: a.planType,
        ownerEmail: a.ownerEmail,
        periodYear: currentYear,
        documentsAnalyzedCount: counterMap[a.id]?.documentsAnalyzedCount ?? 0,
        documentsAnalyzedQuota: counterMap[a.id]?.documentsAnalyzedQuota ?? 0,
        costAnalysisMicros: cm?.analysis ?? 0,
        costSearchMicros: (cm?.search ?? 0) + (searchCostMap[a.id] ?? 0),
        costOtherMicros: cm?.other ?? 0,
        totalCostMicrosThisYear: (cm?.analysis ?? 0) + (cm?.search ?? 0) + (cm?.other ?? 0) + (searchCostMap[a.id] ?? 0),
        lastOperationAt: cm?.lastOp ?? null,
        hasActiveLock: (lockMap[a.id] ?? 0) > 0,
      };
    });

    return NextResponse.json({ accounts: result, page, limit });
  } catch (error: any) {
    if (error?.message === 'INSUFFICIENT_PERMISSIONS') {
      return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
    }
    console.error('[GET /api/admin/ai/accounts]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
