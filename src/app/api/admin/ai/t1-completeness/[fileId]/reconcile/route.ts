/**
 * POST /api/admin/ai/t1-completeness/[fileId]/reconcile — lot 113AN (Trello #741).
 *
 * Réconciliation de la couverture d'un document déjà analysé, SANS IA
 * (faits, décisions de valeur, métadonnées et tableaux persistés). Corps :
 * `{ apply?: boolean }` — absent ou false : simulation (rien n'est écrit) ;
 * true : application (unités requalifiées avec leur provenance, rapport de
 * complétude recalculé), journalisée (`AI_EXECUTION_RELAUNCH`,
 * kind `t1-coverage-reconcile`). Idempotente.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';
import { logAdminAction } from '@/lib/admin-audit';

export async function POST(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { fileId: raw } = await params;
  const fileId = Number(raw);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { apply?: unknown } | null;
  const apply = body?.apply === true;
  try {
    const { loadDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/repository');
    const cov = await loadDocumentCoverage(fileId);
    if (!cov) return NextResponse.json({ error: 'NOT_FOUND', message: 'Aucune couverture T1 pour ce document.' }, { status: 404 });
    const { reconcileStoredDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/stored-reconciliation');
    const r = await reconcileStoredDocumentCoverage({ accountId: cov.accountId, fileId, apply, origin: `admin:${guard.ctx.adminUserId}` });
    if (apply) {
      await logAdminAction({
        adminId: guard.ctx.adminUserId, action: 'AI_EXECUTION_RELAUNCH', targetType: 'AI_EXECUTION', targetId: fileId, result: 'SUCCESS',
        details: { kind: 't1-coverage-reconcile', fileId, outcome: r.outcome, requalified: r.requalified.length, before: r.before, after: r.after },
      });
    }
    return NextResponse.json(r);
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/t1-completeness/[fileId]/reconcile');
  }
}
