/**
 * GET  /api/admin/ai/provider/catalog — état du catalogue des modèles
 *      (date du dernier rafraîchissement, échec éventuel, modèles).
 * POST /api/admin/ai/provider/catalog — « Actualiser le catalogue » :
 *      interroge le fournisseur avec la clé active (CDC BO IA E-04,
 *      PROV-UI-06 à 08, WF-29, WF-40). En échec, le catalogue précédent est
 *      conservé et signalé obsolète ; la réponse est 502 avec la cause.
 *      Lot 35B : déclenche IMMÉDIATEMENT la synchronisation complète du
 *      catalogue IA — la MÊME fonction métier que la tâche planifiée
 *      `ai-catalog-sync` (`syncAiCatalog` : modèles, qualification, statut
 *      opérationnel, tarifs, alertes).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCatalogState } from '@/services/ai/provider/model-catalog.service';
import { syncAiCatalog, summaryOf } from '@/services/ai/provider/ai-catalog-sync.service';
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
    const r = await syncAiCatalog({ trigger: 'manual', userId: guard.ctx.adminUserId });
    if (r.skipped) {
      return NextResponse.json(
        { error: 'SYNC_IN_PROGRESS', message: 'Une synchronisation du catalogue est déjà en cours. Réessayez dans un instant.', state: await getCatalogState() },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: r.ok,
      modelsSeen: r.catalog.modelsSeen,
      disappeared: r.catalog.disappeared,
      discovered: r.catalog.discovered,
      ...(r.catalog.error ? { error: r.catalog.error, message: r.catalog.error } : {}),
      summary: summaryOf(r),
      state: await getCatalogState(),
    }, { status: r.ok ? 200 : 502 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/catalog');
  }
}
