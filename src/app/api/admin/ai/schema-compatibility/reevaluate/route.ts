/**
 * POST /api/admin/ai/schema-compatibility/reevaluate — lot 114 (carte #776,
 * travail 11).
 *
 * Réévaluation À LA DEMANDE des alertes de compatibilité de schéma — la même
 * que le passage quotidien automatique : ciblée, paginée, idempotente. Clôt
 * les seules alertes dont la cause a disparu (schéma accepté de nouveau, ou
 * couple qui n'est plus transmis) ; conserve les autres. Aucun appel au
 * fournisseur, aucune réanalyse de document, aucune suppression. Rend le
 * bilan (examinées, résolues par motif, conservées, levées) ; chaque
 * résolution porte son motif sur l'alerte.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { reevaluateSchemaCompatAlerts } = await import('@/services/ai/gateway/schema-compat/alerts');
    const bilan = await reevaluateSchemaCompatAlerts();
    // Trace serveur (compteurs seulement) ; chaque résolution porte son motif sur l'alerte elle-même.
    console.info(`[schema-compat] réévaluation demandée au BO (admin ${guard.ctx.adminUserId}) :`, JSON.stringify(bilan));
    return NextResponse.json(bilan);
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/schema-compatibility/reevaluate');
  }
}
