/**
 * POST /api/admin/ai/config-versions/[id]/rollback — CDC BO IA WF-06.
 *
 * Restauration d'une version antérieurement Active. À la différence de
 * l'activation normale, le WF-06 exige d'interrompre immédiatement les
 * exécutions concernées et de remettre les jobs batch en tête de file.
 *
 * Les exécutions batch en cours sont remises en tête de file et reprendront
 * depuis le début avec la version restaurée. La réponse rend leur nombre :
 * l'écran doit pouvoir dire ce qui a été interrompu, pas seulement que quelque
 * chose l'a été.
 *
 * La confirmation renforcée du WF-06 appartient à l'écran : le serveur ne peut
 * pas la vérifier, et prétendre le contraire donnerait une fausse assurance.
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
    const r = await rollback(versionId, guard.ctx.adminUserId);
    return NextResponse.json({
      activated: true,
      previousVersionId: r.previousId,
      interrupts: r.interrupts,
      requeuedJobs: r.requeuedJobs,
    });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/rollback');
  }
}
