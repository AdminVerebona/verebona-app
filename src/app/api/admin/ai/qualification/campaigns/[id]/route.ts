/**
 * GET /api/admin/ai/qualification/campaigns/[id] — lot 86A (CDC Pilotage IA
 * V2 P5 : QUAL-01, R06, R13). Détail d'une campagne : demande, point de
 * restauration, résumé, preuves par couple (verdict, motifs par étape,
 * métriques) et cas (source de la vérité attendue, défauts par catégorie,
 * empreintes des sorties — jamais leur contenu, durée, modèle servi).
 * Administrateurs existants (décision 15). Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { id: raw } = await params;
    const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: 'INVALID_ID', message: 'Identifiant de campagne illisible.' }, { status: 400 });
    const { campaignDetail } = await import('@/services/ai/qualification/service');
    const d = await campaignDetail(id);
    if (!d) return NextResponse.json({ error: 'CAMPAIGN_NOT_FOUND', message: `Campagne ${id} introuvable.` }, { status: 404 });
    return NextResponse.json(d, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/qualification/campaigns/[id]');
  }
}
