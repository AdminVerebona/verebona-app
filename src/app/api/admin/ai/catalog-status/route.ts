/**
 * /api/admin/ai/catalog-status — lot 35B, ticket « Catalogue IA dynamique
 * Google : modèles, tarifs, Preview et alertes BO ».
 *
 * GET  : en-tête de Configuration IA — modèles Gemini nouvellement
 *        disponibles (bandeau, non acquittés) et modèles ACTIFS devenus
 *        inutilisables (anomalie, jamais remplacés automatiquement).
 *        Lecture seule, aucun appel fournisseur.
 * POST : `{ acknowledge: string[] }` — ferme le bandeau : acquitte EN BASE,
 *        en une action, les modèles qu'il affichait (persistant, survit à
 *        une reconnexion, vaut pour tous les administrateurs).
 *
 * Réservé aux administrateurs (`requireAdminContext`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';
import { acknowledgeAnnouncedModels, bannerText, listAnnouncedModels } from '@/services/ai/provider/new-models.service';
import { anomalyMessage, detectActiveModelAnomalies, loadActiveChains } from '@/services/ai/provider/active-model-anomalies';
import { loadUsableModelsContext } from '@/services/ai/registry/usable-models';
import { getCatalogState } from '@/services/ai/provider/model-catalog.service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const ctx = await loadUsableModelsContext();
    const [newModels, chains, state] = await Promise.all([
      listAnnouncedModels(ctx),
      loadActiveChains().catch(() => []),
      getCatalogState().catch(() => null),
    ]);
    const anomalies = detectActiveModelAnomalies(chains, ctx).map((a) => ({ ...a, message: anomalyMessage(a) }));
    return NextResponse.json({
      newModels,
      banner: bannerText(newModels),
      anomalies,
      catalogRefreshedAt: state?.refreshedAt ?? null,
      lastSyncAt: state?.lastSyncAt ?? null,
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/catalog-status');
  }
}

const Body = z.object({ acknowledge: z.array(z.string().min(1).max(200)).min(1).max(200) });

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_BODY', message: 'Liste de modèles à acquitter attendue.' }, { status: 400 });
  }
  try {
    const acknowledged = await acknowledgeAnnouncedModels(parsed.data.acknowledge, guard.ctx.adminUserId);
    return NextResponse.json({ acknowledged });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/catalog-status');
  }
}
