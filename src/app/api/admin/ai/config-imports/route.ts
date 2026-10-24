/**
 * /api/admin/ai/config-imports — lot 86B (CDC Pilotage IA V2 P6, décision
 * PO 07) : import manuel COMPLET et ATOMIQUE de la configuration IA globale.
 *
 * GET  : historique des imports (appliqués, refusés) et des retours arrière,
 *        dernier import appliqué (référence de la production).
 * POST : `{ content, expectedBase, confirmEnvironment? }` — confirme l'import
 *        prévisualisé (`/preview`) : mêmes contrôles sur le même fichier,
 *        base inchangée, une transaction. 201 `{ outcome: 'applied' }` ou
 *        200 `{ outcome: 'recognized' }` (même fichier déjà appliqué : rien
 *        n'est écrit). Refus : 422 (format retiré, contrôles bloquants — la
 *        configuration active est inchangée), 409 (prévisualisation périmée,
 *        confirmation de production manquante).
 * Droits : administrateurs existants (décision 15) ; chaque geste au journal
 * d'administration IA.
 */
import { NextRequest, NextResponse } from 'next/server';
import { applyImport, lastAppliedImport, listImports } from '@/services/ai/config/config-import.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const environment = getAiEnvironment();
    const [imports, last] = await Promise.all([listImports(environment, 30), lastAppliedImport(environment)]);
    return NextResponse.json({ environment, lastApplied: last, imports });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-imports');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const body = (await req.json().catch(() => ({}))) as { content?: unknown; expectedBase?: unknown; confirmEnvironment?: unknown };
    const r = await applyImport(typeof body.content === 'string' ? body.content : '', {
      expectedBase: typeof body.expectedBase === 'string' ? body.expectedBase : '',
      confirmProduction: body.confirmEnvironment === 'production',
    }, guard.ctx.adminUserId);
    return NextResponse.json(r, { status: r.outcome === 'applied' ? 201 : 200 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-imports');
  }
}
