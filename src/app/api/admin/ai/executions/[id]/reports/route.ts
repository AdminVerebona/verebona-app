/**
 * GET /api/admin/ai/executions/[id]/reports — lot 58C : rapports T1 / T3
 * rattachés à une exécution du BO (même job de file ou même trace, dans le
 * compte de l'appel). Vide : exécution antérieure au lot 58C → « non tracé ».
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';
import { executionReportsReady, reportsForExecution } from '@/services/ai/execution-report/repository';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const rows = (await pgClient.unsafe(
      `SELECT account_id, job_id, asset_file_id, metadata->>'traceId' AS trace_id FROM ai_usage_event WHERE id = $1`,
      [Number(id)] as never[],
    )) as unknown as Array<{ account_id: number | null; job_id: number | null; asset_file_id: number | null; trace_id: string | null }>;
    const c = rows[0];
    if (!c) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    const reports = await reportsForExecution({ accountId: c.account_id, jobId: c.job_id, traceId: c.trace_id, fileId: c.asset_file_id });
    return NextResponse.json({ available: await executionReportsReady(), reports }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/executions/[id]/reports');
  }
}
