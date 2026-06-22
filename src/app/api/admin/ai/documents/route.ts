/**
 * GET /api/admin/ai/documents
 * Liste des analyses documentaires avec statistiques globales
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiOperation, assetFiles, accounts } from '@/db/schema';
import { eq, and, sql, gte, desc, or, ilike } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(200, parseInt(searchParams.get('limit') || '100'));
    const offset = (page - 1) * limit;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart  = new Date(now.getFullYear(), 0, 1);

    // ── Statistiques globales (ce mois / cette année) ──────────────────────────
    const [statsMonth, statsYear, statsByResult] = await Promise.all([
      db.select({
        total:       sql<number>`count(*)::int`,
        success:     sql<number>`sum(case when business_result in ('success','success_with_warning') then 1 else 0 end)::int`,
        errors:      sql<number>`sum(case when business_result = 'error' then 1 else 0 end)::int`,
        reanalyses:  sql<number>`sum(case when is_reanalysis then 1 else 0 end)::int`,
        avgCost:     sql<number>`round(avg(total_cost_micros))::int`,
        avgDuration: sql<number>`round(avg(duration_ms))::int`,
        totalCost:   sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
      })
        .from(aiOperation)
        .where(and(
          eq(aiOperation.operationCategory, 'document_analysis'),
          gte(aiOperation.startedAt, monthStart),
          sql`${aiOperation.userId} IS NOT NULL`,
        ))
        .then(r => r[0]),

      db.select({
        total:       sql<number>`count(*)::int`,
        success:     sql<number>`sum(case when business_result in ('success','success_with_warning') then 1 else 0 end)::int`,
        errors:      sql<number>`sum(case when business_result = 'error' then 1 else 0 end)::int`,
        reanalyses:  sql<number>`sum(case when is_reanalysis then 1 else 0 end)::int`,
        avgCost:     sql<number>`round(avg(total_cost_micros))::int`,
        avgDuration: sql<number>`round(avg(duration_ms))::int`,
        totalCost:   sql<number>`COALESCE(sum(total_cost_micros),0)::int`,
      })
        .from(aiOperation)
        .where(and(
          eq(aiOperation.operationCategory, 'document_analysis'),
          gte(aiOperation.startedAt, yearStart),
          sql`${aiOperation.userId} IS NOT NULL`,
        ))
        .then(r => r[0]),

      db.select({
        businessResult: aiOperation.businessResult,
        cnt: sql<number>`count(*)::int`,
      })
        .from(aiOperation)
        .where(and(
          eq(aiOperation.operationCategory, 'document_analysis'),
          gte(aiOperation.startedAt, monthStart),
        ))
        .groupBy(aiOperation.businessResult),
    ]);

    // ── Liste des analyses ─────────────────────────────────────────────────────
    const rows = await db
      .select({
        operationId:       aiOperation.id,
        assetFileId:       aiOperation.assetFileId,
        accountId:         aiOperation.accountId,
        accountName:       accounts.name,
        originalFilename:  assetFiles.originalFilename,
        retainedTitle:     assetFiles.retainedTitle,
        businessResult:    aiOperation.businessResult,
        isReanalysis:      aiOperation.isReanalysis,
        usedFallback:      aiOperation.usedFallback,
        totalCostMicros:   aiOperation.totalCostMicros,
        durationMs:        aiOperation.durationMs,
        startedAt:         aiOperation.startedAt,
        errorMessage:      aiOperation.errorMessage,
      })
      .from(aiOperation)
      .leftJoin(assetFiles, eq(aiOperation.assetFileId, assetFiles.id))
      .leftJoin(accounts, eq(aiOperation.accountId, accounts.id))
      .where(and(
        eq(aiOperation.operationCategory, 'document_analysis'),
        sql`${aiOperation.userId} IS NOT NULL`,
        search
          ? or(
              ilike(assetFiles.retainedTitle, `%${search}%`),
              ilike(assetFiles.originalFilename, `%${search}%`),
              ilike(accounts.name, `%${search}%`),
            )
          : undefined,
      ))
      .orderBy(desc(aiOperation.startedAt))
      .limit(limit)
      .offset(offset);

    const resultsByResult: Record<string, number> = {};
    for (const r of statsByResult) resultsByResult[r.businessResult] = r.cnt;

    return NextResponse.json({
      statsMonth: { ...statsMonth, byResult: resultsByResult },
      statsYear,
      analyses: rows.map(r => ({
        operationId:     r.operationId,
        assetFileId:     r.assetFileId,
        accountId:       r.accountId,
        accountName:     r.accountName ?? `#${r.accountId}`,
        documentTitle:   r.retainedTitle || r.originalFilename || `Fichier #${r.assetFileId}`,
        businessResult:  r.businessResult,
        isReanalysis:    r.isReanalysis,
        usedFallback:    r.usedFallback,
        totalCostMicros: r.totalCostMicros,
        durationMs:      r.durationMs,
        startedAt:       r.startedAt,
        errorMessage:    r.errorMessage,
      })),
      page,
      limit,
    });
  } catch (error: any) {
    if (error?.message === 'INSUFFICIENT_PERMISSIONS') {
      return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
    }
    console.error('[GET /api/admin/ai/documents]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
