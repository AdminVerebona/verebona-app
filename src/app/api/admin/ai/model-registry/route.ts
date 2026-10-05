/**
 * GET /api/admin/ai/model-registry — registre des modèles, lecture seule
 * (CDC Assistant §15.12, §15.13, §15.14, §32.6 ; lot 23) : alias de
 * l'assistant, modèles déclarés (statut, dates d'activation et de fin,
 * capacités, prix, limites, prompts compatibles, rollback), usage effectif,
 * cohérence de la configuration, verdict du contrôle de démarrage.
 *
 * Le registre est déclaré dans le code (`services/ai/registry/models.ts`) ;
 * les alias se modifient par une version de configuration IA, le statut
 * preview en production par le réglage à double validation (lot 21).
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildModelRegistryView } from '@/services/ai/registry/model-registry-view';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await buildModelRegistryView());
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/model-registry');
  }
}
