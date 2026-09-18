/**
 * POST /api/admin/ai/config-versions/[id]/validate — CDC BO IA WF-03.
 *
 * La version « À tester » devient Active et reçoit son numéro visible vN.
 * Les contrôles sont rejoués : la configuration n'a pas pu changer, mais les
 * catalogues oui — un modèle peut avoir été retiré par le fournisseur entre
 * les tests et la validation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { validate } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const { visibleNumber } = await validate(versionId, guard.ctx.adminUserId);
    return NextResponse.json({ activated: true, visibleNumber });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/validate');
  }
}
