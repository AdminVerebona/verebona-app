/**
 * POST /api/admin/ai/config-imports/[id]/rollback — lot 86B (décision PO 07,
 * RUN-05) : retour à la configuration antérieure au DERNIER import appliqué
 * (version et révision remplacées réactivées avec leurs contrôles techniques,
 * interventions et routage rétablis). Production : `{ confirmEnvironment:
 * "production" }` exigé. Historisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { rollbackImport } from '@/services/ai/config/config-import.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const importId = parseVersionId(id);
  if (importId === null) return invalidId(id);
  try {
    const body = (await req.json().catch(() => ({}))) as { confirmEnvironment?: unknown };
    return NextResponse.json(await rollbackImport(importId, { confirmProduction: body?.confirmEnvironment === 'production' }, guard.ctx.adminUserId));
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-imports/[id]/rollback');
  }
}
