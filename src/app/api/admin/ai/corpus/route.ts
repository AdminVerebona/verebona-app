/**
 * /api/admin/ai/corpus — lot 100B (ticket #601, arbitrages A1 et C2) :
 * corpus de qualification certifié.
 *
 *   GET  ?treatment=T1    manifeste et statuts effectifs, matrice de couverture
 *                         (opération active × risque × difficulté × type de
 *                         test), verrou A1 par traitement, vue T2 (CDC 4 §35),
 *                         exclusions motivées, coûts mesurés (fournisseur /
 *                         cache), rapports de mutation et d'import.
 *   POST { action, caseId, … }  UN geste sur UN cas (jamais en masse) :
 *     · approve  { oracleFingerprint, sources[], comment?, channel } — approbation
 *                individuelle de l'oracle affiché, sur les sources vérifiées ;
 *     · revoke   { reason, channel } — révocation motivée ;
 *     · reject / restore { reason } — rejet / rétablissement motivé (aucune suppression).
 * Droits : administrateurs existants ; chaque geste est journalisé (journal IA).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

const TREATMENTS = ['T1', 'T2', 'T3', 'T4', 'T6'] as const;

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const t = req.nextUrl.searchParams.get('treatment');
    if (t && !(TREATMENTS as readonly string[]).includes(t)) return NextResponse.json({ error: 'INVALID_TREATMENT', message: 'Traitement invalide.' }, { status: 400 });
    const { corpusOverview } = await import('@/services/ai/governance/master-corpus/certification/service');
    return NextResponse.json(await corpusOverview({ treatment: (t as (typeof TREATMENTS)[number] | null) ?? null }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/corpus');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = b?.action;
    const caseId = typeof b?.caseId === 'string' ? b.caseId : '';
    // Un seul cas par geste : aucune liste acceptée (jamais d'approbation en masse).
    if (!caseId || Array.isArray(b?.caseId) || Array.isArray(b?.caseIds) || b?.caseIds !== undefined) {
      return NextResponse.json({ error: 'ONE_CASE_ONLY', message: 'Un seul cas par geste : aucune approbation ni décision en masse.' }, { status: 400 });
    }
    const channel = b?.channel === 'mobile' ? 'mobile' : 'desktop';
    const svc = await import('@/services/ai/governance/master-corpus/certification/service');
    const { recordConfigAudit } = await import('@/services/ai/config/config-entry.audit');
    try {
      if (action === 'approve') {
        const sources = Array.isArray(b?.sources) ? (b!.sources as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        const r = await svc.approveOracle({
          caseId, oracleFingerprint: String(b?.oracleFingerprint ?? ''), sources, comment: typeof b?.comment === 'string' ? b.comment : null,
          adminUserId: guard.ctx.adminUserId, channel,
        });
        await recordConfigAudit('ai_corpus_oracle_approved', guard.ctx.adminUserId, null, { caseId, sources, channel, approvalId: r.approvalId });
        return NextResponse.json({ ok: true, ...r });
      }
      if (action === 'revoke') {
        const r = await svc.revokeApproval({ caseId, reason: String(b?.reason ?? ''), adminUserId: guard.ctx.adminUserId, channel });
        await recordConfigAudit('ai_corpus_oracle_revoked', guard.ctx.adminUserId, null, { caseId, reason: String(b?.reason ?? '').slice(0, 300) });
        return NextResponse.json({ ok: true, ...r });
      }
      if (action === 'reject' || action === 'restore') {
        const r = await svc.setCaseRejected({ caseId, rejected: action === 'reject', reason: String(b?.reason ?? ''), adminUserId: guard.ctx.adminUserId });
        await recordConfigAudit(action === 'reject' ? 'ai_corpus_case_rejected' : 'ai_corpus_case_restored', guard.ctx.adminUserId, null, { caseId, reason: String(b?.reason ?? '').slice(0, 300) });
        return NextResponse.json({ ok: true, ...r });
      }
      return NextResponse.json({ error: 'INVALID_ACTION', message: 'Action attendue : approve, revoke, reject ou restore.' }, { status: 400 });
    } catch (e) {
      if (e instanceof svc.CorpusActionRefused) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
      throw e;
    }
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/corpus');
  }
}
