/**
 * POST /api/admin/ai/t1-completeness/[fileId]/repair — lot 113AN (Trello #741).
 *
 * Reprise CIBLÉE et BORNÉE des seules unités réellement non couvertes d'un
 * document (après réconciliation) : même passe que la reprise planifiée
 * (`repairDocumentSourceUnits`, texte persisté, `T1_REPAIR_MAX_CALLS` appels
 * au plus, une tentative consommée sur `T1_COMPLETENESS_MAX_RETRIES`), jamais
 * une réanalyse intégrale ni une relecture du fichier. Refus explicites :
 * reprise déjà programmée ou en cours (BUSY), plafond atteint
 * (NO_RETRY_LEFT), compte non éligible. Journalisée.
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
  try {
    const { loadDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/repository');
    const cov = await loadDocumentCoverage(fileId);
    if (!cov) return NextResponse.json({ error: 'NOT_FOUND', message: 'Aucune couverture T1 pour ce document.' }, { status: 404 });
    const { repairDocumentSourceUnits } = await import('@/services/ai/source-analysis/source-units/jobs');
    const r = await repairDocumentSourceUnits({ accountId: cov.accountId, fileId });
    await logAdminAction({
      adminId: guard.ctx.adminUserId, action: 'AI_EXECUTION_RELAUNCH', targetType: 'AI_EXECUTION', targetId: fileId, result: 'SUCCESS',
      details: { kind: 't1-coverage-repair', fileId, outcome: r.outcome, calls: r.calls, attempted: r.attempted.length, newFacts: r.newFacts, result: r.result },
    });
    return NextResponse.json({ outcome: r.outcome, calls: r.calls, attempted: r.attempted.length, newFacts: r.newFacts, result: r.result });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/t1-completeness/[fileId]/repair');
  }
}
