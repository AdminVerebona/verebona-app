/**
 * POST /api/admin/ai/config-versions/[id]/activate — CDC BO IA WF-05.
 *
 * Activation NORMALE : elle n'interrompt aucune exécution en cours. Les
 * démarrages suivants — y compris les jobs déjà en file mais non partis —
 * utilisent la nouvelle Active.
 *
 * Pour revenir en arrière, c'est `/rollback` : il interrompt. Deux routes
 * distinctes parce que ce sont deux opérations distinctes, et qu'un paramètre
 * partagé laisserait interrompre la production en croyant activer.
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
    const r = await activate(versionId, guard.ctx.adminUserId);
    return NextResponse.json({ activated: true, previousVersionId: r.previousId, interrupts: false });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/activate');
  }
}
