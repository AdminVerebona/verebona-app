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
import { isTreatment } from '@/services/ai/config/treatments';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

function entier(v: string | null): number | undefined {
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
}

function date(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const p = new URL(req.url).searchParams;
  const treatment = p.get('treatment');
  const status = p.get('status');

  try {
    const page = await searchExecutions({
      treatment: treatment && isTreatment(treatment) ? treatment : undefined,
      status: status === 'success' || status === 'error' ? status : undefined,
      accountId: entier(p.get('accountId')),
      model: p.get('model') ?? undefined,
      configVersionId: entier(p.get('configVersionId')),
      operationCode: p.get('operationCode') ?? undefined,
      errorsOnly: p.get('errorsOnly') === '1',
      since: date(p.get('since')),
      until: date(p.get('until')),
      minDurationMs: entier(p.get('minDurationMs')),
      limit: entier(p.get('limit')),
      offset: entier(p.get('offset')),
    });
    return NextResponse.json(page);
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/executions');
  }
}
