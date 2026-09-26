/**
 * GET  /api/admin/ai/provider/catalog — état du catalogue des modèles
 *      (date du dernier rafraîchissement, échec éventuel, modèles).
 * POST /api/admin/ai/provider/catalog — « Actualiser le catalogue » :
 *      interroge le fournisseur avec la clé active (CDC BO IA E-04,
 *      PROV-UI-06 à 08, WF-29, WF-40). En échec, le catalogue précédent est
 *      conservé et signalé obsolète ; la réponse est 502 avec la cause.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCatalogState, refreshModelCatalog } from '@/services/ai/provider/model-catalog.service';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await getCatalogState());
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/provider/catalog');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const r = await refreshModelCatalog(guard.ctx.adminUserId);
    return NextResponse.json({ ...r, state: await getCatalogState() }, { status: r.ok ? 200 : 502 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/catalog');
  }
}
