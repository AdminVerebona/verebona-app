/**
 * POST /api/admin/ai/config-versions/[id]/package — CDC BO IA WF-04.
 *
 * Prépare un package immuable à partir d'une version validée. Ne déploie rien :
 * le §1.4 exclut tout push Git depuis le BO, et c'est la chaîne GitHub →
 * Scalingo qui transporte l'artefact.
 */
import { NextRequest, NextResponse } from 'next/server';
import { preparePackage, exportPackage } from '@/services/ai/config/config-package.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const pkg = await preparePackage(versionId, guard.ctx.adminUserId);
    const exported = await exportPackage(pkg.uid);
    return NextResponse.json({ package: pkg, payload: exported?.payload ?? null }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/package');
  }
}
