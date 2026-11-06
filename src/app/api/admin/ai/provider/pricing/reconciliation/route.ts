/**
 * GET /api/admin/ai/provider/pricing/reconciliation — lot 113O (carte #713,
 * §2 « diagnostic exigé avant correction ») : rapport de réconciliation
 * tarifaire de chaque identifiant signalé (cause prouvée par catégorie,
 * appels, prix réellement applicable ou motif de non-calcul, action).
 *
 * Paramètres : `format=csv` (export « ; », UTF-8 avec BOM) sinon JSON ;
 * `models=a,b` (identifiants supplémentaires à réconcilier, ex. ceux d'une
 * capture du BO). Administrateurs seulement ; lecture seule ; aucun secret,
 * aucun contenu d'appel, aucun identifiant de compte. Corps de la page reçue :
 * route `…/pricing/snapshot`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildPricingReconciliation, reconciliationCsv } from '@/services/ai/gateway/pricing/pricing-reconciliation';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const p = new URL(req.url).searchParams;
    const extra = (p.get('models') ?? '').split(/[\s,;]+/).map((m) => m.trim()).filter((m) => /^[a-z0-9][a-z0-9.\-]{1,120}$/i.test(m)).slice(0, 100);
    const r = await buildPricingReconciliation({ extraModels: extra });
    const jour = r.generatedAt.slice(0, 10);
    if (p.get('format') === 'csv') {
      return new NextResponse(reconciliationCsv(r), {
        headers: {
          'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
          'content-disposition': `attachment; filename="reconciliation-tarifs-ia-${jour}.csv"`,
        },
      });
    }
    return NextResponse.json(r, {
      headers: { 'cache-control': 'no-store', ...(p.get('download') === '1' ? { 'content-disposition': `attachment; filename="reconciliation-tarifs-ia-${jour}.json"` } : {}) },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/provider/pricing/reconciliation');
  }
}
