/**
 * POST /api/admin/ai/config-versions/[id]/rollback — compatibilité (lot 54).
 *
 * « Restaurer une ancienne version » = la réactiver : même geste que
 * `/activate` (dernier état enregistré, ancienne active conservée et
 * réactivable). Plus d'interruption ni de remise en file : les exécutions
 * démarrées gardent la révision figée à leur démarrage.
 */
import { NextRequest, NextResponse } from 'next/server';
import { rollback } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const body = (await req.json().catch(() => ({}))) as { confirmEnvironment?: unknown };
    const r = await rollback(versionId, guard.ctx.adminUserId, { confirmProduction: body?.confirmEnvironment === 'production' });
    return NextResponse.json({
      activated: true, previousVersionId: r.previousId, revisionNumber: r.revisionNumber,
      interrupts: false, requeuedJobs: 0,
    });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/rollback');
  }
}
