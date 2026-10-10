/**
 * /api/admin/ai/provider — CDC BO IA SCR-10.
 *
 * GET  : credentials connus, en aperçu masqué, et catalogue des modèles.
 * POST : enregistre une clé candidate.
 *
 * ── LA RÉPONSE NE PORTE JAMAIS DE SECRET ───────────────────────────────────
 * Le SCR-10 autorise l'affichage en clair, et une route dédiée le permet sur
 * demande. Mais le faire ici enverrait le credential à chaque chargement de
 * l'écran, dans chaque cache de navigateur et chaque outil de développement
 * ouvert. L'aperçu suffit à reconnaître une clé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listCredentials, addCandidate } from '@/services/ai/provider/credential.repository';
import { GEMINI_PUBLIC_CATALOG } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { getCachedPrice, getCacheState, loadPricingCache } from '@/services/ai/gateway/pricing/pricing.repository';
import { loadPriceStatuses } from '@/services/ai/gateway/pricing/pricing-sync.service';
import { getCatalogState } from '@/services/ai/provider/model-catalog.service';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    if (getCacheState().loadedAt === null) await loadPricingCache();
    // Lot 35B : tarifs du catalogue SYNCHRONISÉ (page officielle Google) pour
    // les modèles servis par la clé active ; sans tarif connu : UNKNOWN, sans
    // montant — jamais le relevé embarqué présenté comme tarif courant.
    const [state, statuts] = await Promise.all([
      getCatalogState().catch(() => ({ models: [] as Array<{ model: string; available: boolean }> })),
      loadPriceStatuses(),
    ]);
    const noms = [...new Set([
      ...state.models.filter((m) => m.available).map((m) => m.model),
      ...GEMINI_PUBLIC_CATALOG.map((e) => e.model),
    ])].sort();

    return NextResponse.json({
      credentials: await listCredentials(),
      catalog: noms.map((model) => {
        const price = getCachedPrice('gemini', model);
        const st = statuts.get(model);
        return {
          model,
          priced: price !== null,
          verified: price?.verified ?? false,
          inputPerMillion: price ? price.inputMicros : null,
          outputPerMillion: price ? price.outputMicros : null,
          pricingStatus: price ? 'KNOWN' : 'UNKNOWN',
          reason: price ? null : st?.reason ?? null,
          lastChangedAt: st?.lastChangedAt ?? null,
        };
      }),
      catalogLoadedAt: getCacheState().loadedAt,
      /** Vrai quand le cache tarifaire a été chargé en mode dégradé. */
      catalogStale: getCacheState().degraded,
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/provider');
  }
}

const Body = z.object({ secret: z.string().min(20).max(500) });

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_SECRET', message: 'Saisissez une clé complète.' },
      { status: 400 },
    );
  }

  try {
    const credential = await addCandidate(parsed.data.secret.trim(), guard.ctx.adminUserId);
    // Créée en candidate : le WF-21 interdit de remplacer l'active avant un
    // test réussi, et la route d'activation le vérifie en base.
    return NextResponse.json(credential, { status: 201 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider');
  }
}
