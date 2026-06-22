/**
 * GET /api/admin/ai/overview
 * Vue globale de la consommation IA pour le backoffice
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiOperation, aiUsageAccountCounter, aiSecurityLock, accounts } from '@/db/schema';
import { eq, sql, and, gte, isNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const [
      operationsToday,
      operationsMonth,
      costToday,
      costMonth,
      costYear,
      byResult,
      byProvider,
      activeLocks,
      techOpsToday,
      techOpsMonth,
      techOpsYear,
      topCosts,
    ] = await Promise.all([
      // Total opérations aujourd'hui
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(aiOperation)
        .where(gte(aiOperation.startedAt, todayStart))
        .then(r => r[0]?.cnt ?? 0),

      // Total opérations ce mois
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(aiOperation)
        .where(gte(aiOperation.startedAt, monthStart))
        .then(r => r[0]?.cnt ?? 0),

      // Coût aujourd'hui — client uniquement (userId non null)
      db.select({ total: sql<number>`COALESCE(sum(total_cost_micros),0)::int` })
        .from(aiOperation)
        .where(and(gte(aiOperation.startedAt, todayStart), sql`user_id IS NOT NULL`))
        .then(r => r[0]?.total ?? 0),

      // Coût ce mois — client uniquement (userId non null)
      db.select({ total: sql<number>`COALESCE(sum(total_cost_micros),0)::int` })
        .from(aiOperation)
        .where(and(gte(aiOperation.startedAt, monthStart), sql`user_id IS NOT NULL`))
        .then(r => r[0]?.total ?? 0),

      // Coût cette année — client uniquement
      db.select({ total: sql<number>`COALESCE(sum(total_cost_micros),0)::int` })
        .from(aiOperation)
        .where(and(gte(aiOperation.startedAt, yearStart), sql`user_id IS NOT NULL`))
        .then(r => r[0]?.total ?? 0),

      // Par résultat métier
      db.select({
        businessResult: aiOperation.businessResult,
        cnt: sql<number>`count(*)::int`,
      })
        .from(aiOperation)
        .where(gte(aiOperation.startedAt, monthStart))
        .groupBy(aiOperation.businessResult),

      // Par provider (ce mois)
      db.select({
        provider: aiOperation.providerPrimary,
        cnt: sql<number>`count(*)::int`,
        fallback1Cnt: sql<number>`sum(case when used_fallback and provider_fallback = 'gemini-2.5-flash' then 1 else 0 end)::int`,
        fallback2Cnt: sql<number>`sum(case when used_fallback and provider_fallback = 'gemini-2.5-pro' then 1 else 0 end)::int`,
        fallbackCnt: sql<number>`sum(case when used_fallback then 1 else 0 end)::int`,
      })
        .from(aiOperation)
        .where(gte(aiOperation.startedAt, monthStart))
        .groupBy(aiOperation.providerPrimary),

      // Blocages sécurité actifs
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(aiSecurityLock)
        .where(eq(aiSecurityLock.isResolved, false))
        .then(r => r[0]?.cnt ?? 0),

      // Opérations techniques/test aujourd'hui (userId null = debug/script)
      db.select({
        cnt: sql<number>`count(*)::int`,
        totalCostMicros: sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
      })
        .from(aiOperation)
        .where(and(gte(aiOperation.startedAt, todayStart), isNull(aiOperation.userId)))
        .then(r => r[0] ?? { cnt: 0, totalCostMicros: 0 }),

      // Opérations techniques/test ce mois
      db.select({
        cnt: sql<number>`count(*)::int`,
        totalCostMicros: sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
      })
        .from(aiOperation)
        .where(and(gte(aiOperation.startedAt, monthStart), isNull(aiOperation.userId)))
        .then(r => r[0] ?? { cnt: 0, totalCostMicros: 0 }),

      // Opérations techniques/test cette année
      db.select({
        cnt: sql<number>`count(*)::int`,
        totalCostMicros: sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
      })
        .from(aiOperation)
        .where(and(gte(aiOperation.startedAt, yearStart), isNull(aiOperation.userId)))
        .then(r => r[0] ?? { cnt: 0, totalCostMicros: 0 }),

      // Top 5 comptes coûteux ce mois — client uniquement (userId non null)
      db.select({
        accountId: aiOperation.accountId,
        totalCostMicros: sql<number>`sum(total_cost_micros)::int`,
      })
        .from(aiOperation)
        .where(and(gte(aiOperation.startedAt, monthStart), sql`user_id IS NOT NULL`))
        .groupBy(aiOperation.accountId)
        .orderBy(sql`sum(total_cost_micros) DESC`)
        .limit(5),
    ]);

    // Résoudre les noms de comptes
    const topAccountIds = topCosts.map(t => t.accountId).filter(Boolean) as number[];
    const accountNames: Record<number, string> = {};
    if (topAccountIds.length > 0) {
      const accountRows = await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(sql`${accounts.id} = ANY(${sql.raw(`ARRAY[${topAccountIds.join(',')}]::int[]`)})`)
      for (const a of accountRows) accountNames[a.id] = a.name;
    }

    const operationsByResult: Record<string, number> = {};
    for (const r of byResult) {
      operationsByResult[r.businessResult] = r.cnt;
    }

    const operationsByProvider: Record<string, number> = {};
    let totalFallback1 = 0;
    let totalFallback2 = 0;
    let totalOperations = 0;
    for (const r of byProvider) {
      if (r.provider) {
        operationsByProvider[r.provider] = r.cnt;
        totalFallback1 += r.fallback1Cnt;
        totalFallback2 += r.fallback2Cnt;
        totalOperations += r.cnt;
      }
    }

    const fallback1Rate = totalOperations > 0 ? Math.round((totalFallback1 / totalOperations) * 100) : 0;
    const fallback2Rate = totalOperations > 0 ? Math.round((totalFallback2 / totalOperations) * 100) : 0;
    const fallbackRate = fallback1Rate + fallback2Rate;

    return NextResponse.json({
      totalOperationsToday: operationsToday,
      totalOperationsThisMonth: operationsMonth,
      clientCostMicrosToday: costToday,
      clientCostMicrosThisMonth: costMonth,
      clientCostMicrosThisYear: costYear,
      techOperationsToday: techOpsToday.cnt,
      techOperationsThisMonth: techOpsMonth.cnt,
      techOperationsThisYear: techOpsYear.cnt,
      techCostMicrosToday: techOpsToday.totalCostMicros,
      techCostMicrosThisMonth: techOpsMonth.totalCostMicros,
      techCostMicrosThisYear: techOpsYear.totalCostMicros,
      // legacy aliases conservés pour la CostsTab
      totalCostMicrosToday: costToday,
      totalCostMicrosThisMonth: costMonth,
      operationsByResult,
      operationsByProvider,
      fallbackRate,
      fallback1Rate,
      fallback2Rate,
      activeSecurityLocks: activeLocks,
      topCostAccounts: topCosts.map(t => ({
        accountId: t.accountId,
        accountName: t.accountId ? (accountNames[t.accountId] ?? `#${t.accountId}`) : 'Inconnu',
        totalCostMicros: t.totalCostMicros,
      })),
    });
  } catch (error: any) {
    if (error?.message === 'INSUFFICIENT_PERMISSIONS') {
      return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
    }
    console.error('[GET /api/admin/ai/overview]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
