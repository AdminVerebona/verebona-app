/**
 * GET /api/admin/ai/search-logs
 * Liste des logs de recherche intelligente — Admin Suivi IA
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient, ensureMigrations } from '@/db';
import { requireAdmin } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  try {
    await ensureMigrations();

    const { searchParams } = new URL(request.url);
    const search = (searchParams.get('search') || '').trim();
    const offerCode = searchParams.get('offer_code') || '';
    const responseMode = searchParams.get('response_mode') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, parseInt(searchParams.get('limit') || '50'));
    const offset = (page - 1) * limit;

    // Vérifier que la table existe avant de requêter
    const tableCheck = await pgClient`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'ai_search_log'
      ) AS exists
    `;
    if (!tableCheck[0]?.exists) {
      return NextResponse.json({
        logs: [],
        stats: { totalCount: 0, totalCostMicros: 0, avgDurationMs: 0, answerCount: 0, noResultCount: 0, upgradeHintCount: 0, errorCount: 0, totalInputTokens: 0, totalOutputTokens: 0 },
        page, limit, total: 0,
      });
    }

    // Construction dynamique du WHERE
    const conditions: string[] = [];
    const params: any[] = [];
    let pi = 1;

    if (search)       { conditions.push(`l.query_text ILIKE $${pi++}`);    params.push(`%${search}%`); }
    if (offerCode)    { conditions.push(`l.offer_code = $${pi++}`);        params.push(offerCode); }
    if (responseMode) { conditions.push(`l.response_mode = $${pi++}`);     params.push(responseMode); }

    const whereSQL = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, statsRows] = await Promise.all([
      pgClient.unsafe(
        `SELECT l.id, l.public_id, l.account_id, a.name AS account_name,
                l.query_text, l.response_mode, l.answer_text, l.sources_count,
                l.offer_code, l.cost_micros, l.input_tokens, l.output_tokens,
                l.duration_ms, l.provider, l.model, l.business_result,
                l.block_reason, l.tracking_id, l.created_at
         FROM ai_search_log l
         LEFT JOIN accounts a ON a.id = l.account_id
         ${whereSQL}
         ORDER BY l.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      pgClient.unsafe(
        `SELECT
           count(*)::int                                                AS "totalCount",
           COALESCE(sum(cost_micros), 0)::int                          AS "totalCostMicros",
           COALESCE(avg(duration_ms), 0)::int                          AS "avgDurationMs",
           count(*) FILTER (WHERE response_mode = 'answer')::int       AS "answerCount",
           count(*) FILTER (WHERE response_mode = 'no_result')::int    AS "noResultCount",
           count(*) FILTER (WHERE response_mode = 'upgrade_hint')::int AS "upgradeHintCount",
           count(*) FILTER (WHERE business_result = 'error')::int      AS "errorCount",
           COALESCE(sum(input_tokens), 0)::int                         AS "totalInputTokens",
           COALESCE(sum(output_tokens), 0)::int                        AS "totalOutputTokens"
         FROM ai_search_log l
         ${whereSQL}`,
        params
      ),
    ]);

    const stats = (statsRows as any[])[0] ?? {};

    const logs = (rows as any[]).map(r => ({
      id: r.id,
      publicId: r.public_id,
      accountId: r.account_id,
      accountName: r.account_name,
      queryText: r.query_text,
      responseMode: r.response_mode,
      answerText: r.answer_text,
      sourcesCount: r.sources_count,
      offerCode: r.offer_code,
      costMicros: r.cost_micros,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      durationMs: r.duration_ms,
      provider: r.provider,
      model: r.model,
      businessResult: r.business_result,
      blockReason: r.block_reason,
      trackingId: r.tracking_id,
      createdAt: r.created_at,
    }));

    return NextResponse.json({ logs, stats, page, limit, total: stats.totalCount ?? 0 });

  } catch (error: any) {
    console.error('[GET /api/admin/ai/search-logs]', error);
    return NextResponse.json({ error: 'Erreur serveur', detail: error?.message }, { status: 500 });
  }
}
