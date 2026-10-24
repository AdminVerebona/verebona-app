/**
 * /api/admin/ai/qualification — lot 86A (CDC Pilotage IA V2 P5 : ACT-02,
 * BO-06, BO-10, R05, R06 ; décisions PO n° 12, 14, 15).
 *
 *   GET  ?versionId=N  vue Configuration IA › Qualification par couple :
 *                      seuils (code, LECTURE seule), couples de la version
 *                      (active par défaut) et leur état — jamais testé, en
 *                      test, admissible, refusée, non concluante, obsolète ;
 *                      « non testé » pour un choix manuel —, candidates
 *                      automatiques, campagnes récentes.
 *   POST { couple: { versionId?, treatment, operationCode, rank }, reason? }
 *                      TEST MANUEL d'un couple (facultatif, jamais exigé pour
 *                      activer) : campagne créée et exécutée en tâche de fond
 *                      (202 + identifiant) ; point de restauration 82E pris
 *                      avant tout appel ; refusé en production.
 * Droits : administrateurs existants (`requireAdminContext`), aucun rôle
 * nouveau (décision 15) ; chaque test est journalisé (journal IA).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const raw = req.nextUrl.searchParams.get('versionId');
    const versionId = raw ? Number(raw) : null;
    if (raw && (!Number.isInteger(versionId) || versionId! <= 0)) return NextResponse.json({ error: 'INVALID_VERSION_ID', message: 'versionId invalide' }, { status: 400 });
    const { qualificationOverview } = await import('@/services/ai/qualification/service');
    return NextResponse.json(await qualificationOverview({ versionId }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/qualification');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const body = (await req.json().catch(() => null)) as { couple?: Record<string, unknown>; reason?: unknown } | null;
    const c = body?.couple;
    if (!c || typeof c.treatment !== 'string' || typeof c.operationCode !== 'string' || typeof c.rank !== 'number') {
      return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Couple attendu : { treatment, operationCode, rank, versionId? }.' }, { status: 400 });
    }
    const { requestManualCoupleTest, QualificationRefused } = await import('@/services/ai/qualification/campaign');
    try {
      const r = await requestManualCoupleTest({
        adminUserId: guard.ctx.adminUserId, reason: typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null,
        couple: { treatment: c.treatment as never, operationCode: c.operationCode, rank: c.rank, versionId: typeof c.versionId === 'number' ? c.versionId : null },
      });
      const { recordConfigAudit } = await import('@/services/ai/config/config-entry.audit');
      await recordConfigAudit('ai_qualification_manual_test', guard.ctx.adminUserId, null, { campaignId: r.campaignId, couple: c });
      return NextResponse.json({ campaignId: r.campaignId, status: 'PENDING' }, { status: 202 });
    } catch (e) {
      if (e instanceof QualificationRefused) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'PRODUCTION_REFUSED' ? 409 : 400 });
      throw e;
    }
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/qualification');
  }
}
