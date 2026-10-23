/**
 * GET /api/admin/ai/business-executions/[id]/export — lot 84D (CDC Pilotage
 * IA V2 P3 : EXP-01, EXP-03, LOG-07, décision PO 15).
 *
 * Export UNITAIRE d'une exécution métier en JSON structuré
 * (`verebona.ai-business-execution/1`) : exécution, ce qui manque, TOUS ses
 * appels (colonnes du collecteur 77C, état de capture), travaux, rapports et
 * métadonnées des écritures, lus dans un même instantané. `?contenus=1` :
 * avec le contenu des échanges capturés (prompt, contexte, réponse) —
 * réservé à l'accès existant `AI_MODEL_OUTPUT_ADMIN_IDS` (403 sinon, refus
 * journalisé). `?download=1` : proposé en fichier. Chaque export journalisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';
import { parseExecutionId } from '@/services/ai/business-execution/identity';
import { isModelOutputAccessAllowed } from '@/services/ai/telemetry/model-output-access';
import { logAdminAction } from '@/lib/admin-audit';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  if (!parseExecutionId(id)) return NextResponse.json({ error: 'INVALID_EXECUTION_ID' }, { status: 400 });
  const sensitive = req.nextUrl.searchParams.get('contenus') === '1';
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: guard.ctx.adminUserId, action: 'AI_EXECUTIONS_EXPORT', targetType: 'AI_EXECUTIONS_EXPORT', targetId: null, result,
    details: { scope: 'unitaire', executionId: id, contenusSensibles: sensitive, ...details },
  });
  if (sensitive && !isModelOutputAccessAllowed(guard.ctx.adminUserId)) {
    await audit('DENIED', { code: 'SENSITIVE_CONTENT_FORBIDDEN' });
    // Même journal que toute lecture refusée des échanges (AI_MODEL_OUTPUT_READ).
    await logAdminAction({ adminId: guard.ctx.adminUserId, action: 'AI_MODEL_OUTPUT_READ', targetType: 'AI_EXECUTION', targetId: null, result: 'DENIED', details: { purpose: 'export', executionId: id } });
    return NextResponse.json({ error: 'FORBIDDEN', message: 'Contenus des échanges IA réservés aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).' }, { status: 403 });
  }
  try {
    const { buildExecutionUnitExport } = await import('@/services/ai/business-execution/export');
    const body = await buildExecutionUnitExport(id, { sensitive });
    if (!body) {
      await audit('FAILURE', { code: 'NOT_FOUND' });
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Exécution introuvable ou non déterminable.' }, { status: 404 });
    }
    const calls = Array.isArray(body.calls) ? body.calls.length : 0;
    await audit('SUCCESS', { calls });
    if (sensitive) {
      await logAdminAction({ adminId: guard.ctx.adminUserId, action: 'AI_MODEL_OUTPUT_READ', targetType: 'AI_EXECUTION', targetId: null, result: 'SUCCESS', details: { purpose: 'export', executionId: id, captures: calls } });
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
    if (req.nextUrl.searchParams.get('download') === '1') {
      const { contentDisposition } = await import('@/lib/download-filename');
      headers['content-disposition'] = contentDisposition(`verebona-execution-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    }
    return new NextResponse(`${JSON.stringify(body, null, 2)}\n`, { status: 200, headers });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/business-executions/[id]/export');
  }
}
