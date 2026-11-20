/**
 * GET /api/admin/ai/executions — CDC BO IA SCR-07, NFR-001, NFR-002.
 *
 * Recherche transversale des appels modèles, paginée côté serveur.
 *
 * ── LES FILTRES INCONNUS SONT IGNORÉS, PAS REFUSÉS ─────────────────────────
 * Un paramètre illisible — un compte qui n'est pas un nombre, un statut qui
 * n'existe pas — est écarté plutôt que de faire échouer la requête. Le SCR-07
 * dit que cet écran est atteint « depuis tous les écrans par liens filtrés » :
 * un lien un peu ancien ne doit pas rendre l'écran inaccessible, il doit
 * montrer moins de filtres.
 *
 * La limite, elle, est plafonnée côté service : un paramètre client ne peut pas
 * la lever.
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchExecutions } from '@/services/ai/telemetry/execution-log.repository';
import { executionApiFilters } from '@/services/ai/telemetry/execution-filters';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

function entier(v: string | null): number | undefined {
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
}

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const p = new URL(req.url).searchParams;

  try {
    // Carte #802 : traduction UNIQUE des filtres (`executionApiFilters`), partagée
    // avec l'export diagnostic — l'écran et l'export filtrent à l'identique.
    const page = await searchExecutions({
      ...executionApiFilters(p),
      limit: entier(p.get('limit')),
      offset: entier(p.get('offset')),
    });
    return NextResponse.json(page);
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/executions');
  }
}
