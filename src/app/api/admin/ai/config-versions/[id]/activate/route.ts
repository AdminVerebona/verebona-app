/**
 * POST /api/admin/ai/config-versions/[id]/activate — lot 54 (54C).
 *
 * « Activer en préproduction » (ou réactiver une version précédente) : le
 * dernier état enregistré de la version devient la configuration des
 * nouvelles exécutions ; l'ancienne active est désactivée dans la même
 * transaction. Les exécutions déjà démarrées terminent avec la révision
 * figée à leur démarrage (aucune interruption).
 *
 * Console de PRODUCTION (paramétrage indépendant) : `{ confirmEnvironment:
 * "production" }` exigé, vérifié par le serveur. Rien ici n'agit sur un
 * autre environnement que celui de la console.
 */
import { NextRequest, NextResponse } from 'next/server';
import { activate } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const body = (await req.json().catch(() => ({}))) as { confirmEnvironment?: unknown };
    const r = await activate(versionId, guard.ctx.adminUserId, { confirmProduction: body?.confirmEnvironment === 'production' });
    return NextResponse.json({
      activated: true, alreadyActive: r.alreadyActive, previousVersionId: r.previousId,
      revisionNumber: r.revisionNumber, interrupts: false, warnings: r.warnings ?? [],
    });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/activate');
  }
}
