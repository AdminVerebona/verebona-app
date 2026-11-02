/**
 * /api/admin/ai/corpus-account — lot 103G : compte technique de qualification
 * IA depuis le BO (sans accès base, sans CRON_SECRET).
 *
 *   GET                          diagnostic en lecture seule (même service que
 *                                la route cron et le diagnostic global) ;
 *   POST { action: 'check' }     contrôle immédiat (anomalie de Supervision
 *                                signalée ou résolue) ;
 *   POST { action: 'provision' } provisionnement / réparation IDEMPOTENT
 *                                (mécanisme unique : crée, ou marque le compte
 *                                existant à l'identité dédiée ; jamais de
 *                                doublon, jamais un compte client).
 * Droits : administrateurs existants ; chaque geste est journalisé
 * (`ai_admin_audit_log`). Les incompatibilités et campagnes bloquées par ce
 * prérequis reprennent AUTOMATIQUEMENT au passage suivant (aucun autre clic).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { corpusAccountDiagnostic } = await import('@/services/ai/qualification/technical-account-diagnostic');
    return NextResponse.json(await corpusAccountDiagnostic(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/corpus-account');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
    const ta = await import('@/services/ai/qualification/technical-account');
    const { recordConfigAudit } = await import('@/services/ai/config/config-entry.audit');
    if (body?.action === 'check') {
      const st = await ta.checkCorpusAccount({ report: true, impact: { source: `BO admin:${guard.ctx.adminUserId}` } });
      await recordConfigAudit('ai_corpus_account_check', guard.ctx.adminUserId, null, { code: st.code, accountId: st.accountId });
      return NextResponse.json({ status: st });
    }
    if (body?.action === 'provision') {
      const avant = ta.assessCorpusAccount(await ta.readCorpusAccountSnapshot());
      const r = await ta.provisionCorpusAccount({ actor: `admin:${guard.ctx.adminUserId}` });
      const apres = await ta.checkCorpusAccount({ report: true, impact: { source: `BO admin:${guard.ctx.adminUserId}` } });
      await recordConfigAudit('ai_corpus_account_provision', guard.ctx.adminUserId,
        { code: avant.code, accountId: avant.accountId ?? avant.markedAccountId },
        { result: r.status, accountId: r.accountId, code: apres.code, message: r.message });
      return NextResponse.json({ result: r.status, message: r.message, accountId: r.accountId, status: apres }, { status: r.status === 'refused' ? 409 : 200 });
    }
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Action attendue : { action: "check" } ou { action: "provision" }.' }, { status: 400 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/corpus-account');
  }
}
