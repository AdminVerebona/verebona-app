/**
 * POST /api/admin/ai/config-versions/[id]/revisions/[revisionId]/restore —
 * lot 54 (54C), « Restaurer cette révision ».
 *
 * Crée une NOUVELLE révision reprenant exactement la configuration de la
 * révision choisie ; l'historique n'est jamais réécrit (r6, r7, r8 restent
 * après une restauration de r6 en r9). Version active : appliquée aux
 * prochaines exécutions sans réactivation. `baseRevision` facultatif :
 * refus 409 si la version a été enregistrée entre-temps.
 */
import { NextRequest, NextResponse } from 'next/server';
import { restoreRevision } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; revisionId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id, revisionId } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);
  const revId = parseVersionId(revisionId);
  if (revId === null) return invalidId(revisionId);

  try {
    const body = (await req.json().catch(() => ({}))) as { baseRevision?: unknown; comment?: unknown };
    const base = Number.isSafeInteger(body.baseRevision) ? (body.baseRevision as number) : null;
    const r = await restoreRevision(versionId, revId, guard.ctx.adminUserId, {
      expectedRevision: base,
      comment: typeof body.comment === 'string' ? body.comment.slice(0, 1000) : null,
    });
    return NextResponse.json({ restored: true, ...r });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/revisions/[revisionId]/restore');
  }
}
