/**
 * /api/admin/ai/queue/to-process-relevance — lot 61 (tickets « À traiter » :
 * écarts résiduels du 58B et pertinence des cartes).
 *
 *   GET  : configuration T4 effective (contrat de sortie), campagnes de
 *          réévaluation rétroactive (bilan AVANT / APRÈS, issues), issues
 *          par carte d'une campagne (filtres compte, issue), recettes T4
 *          réelles (résultat attendu / obtenu par cas).
 *   POST : { action: 'campaign' } — nouvelle campagne (poursuivie par la
 *          tâche planifiée interne `to-process-relevance-reevaluation`, un
 *          premier lot est traité tout de suite) ;
 *          { action: 'recette' } — recette du corpus livré avec le VÉRITABLE
 *          T4 de l'environnement (exécutée en arrière-plan, suivie par GET).
 * Aucun SQL, aucune commande pour le PO.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const q = req.nextUrl.searchParams;
    const n = (k: string) => (q.get(k) && /^\d+$/.test(q.get(k)!) ? Number(q.get(k)) : null);
    const [{ listRelevanceCampaigns, listCampaignItems, campaignTablesReady }, { listRecetteRuns, recetteTableReady, RELEVANCE_RECETTE_CASES }, ev] = await Promise.all([
      import('@/services/to-process/relevance-campaign.service'), import('@/services/to-process/relevance-recette'),
      import('@/services/to-process/document-field-evidence'),
    ]);
    const campaigns = await listRelevanceCampaigns(10);
    const campaignId = n('campaignId') ?? campaigns[0]?.id ?? null;
    const outcome = q.get('outcome') && /^[A-Z_]{1,40}$/.test(q.get('outcome')!) ? q.get('outcome') : null;
    return NextResponse.json({
      config: await ev.t4AssessmentConfig(),
      engineVersion: ev.DOCUMENT_RULE_ENGINE_VERSION,
      migrations: { decisions0444: await ev.relevanceColumnsReady(), campaigns0445: await campaignTablesReady(), recette0446: await recetteTableReady() },
      campaigns,
      items: campaignId ? await listCampaignItems(campaignId, { accountId: n('accountId'), outcome, limit: 100 }) : [],
      recetteCases: RELEVANCE_RECETTE_CASES.map((c) => ({ id: c.id, label: c.label, deterministic: c.deterministic })),
      recetteRuns: await listRecetteRuns(5),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/queue/to-process-relevance');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    let body: { action?: string } = {};
    try { body = await req.json(); } catch { body = {}; }
    if (body.action === 'campaign') {
      const { startRelevanceCampaign, runRelevanceCampaign } = await import('@/services/to-process/relevance-campaign.service');
      const c = await startRelevanceCampaign({ code: `l61-pertinence-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`, trigger: 'manual', requestedBy: guard.ctx.adminUserId });
      if (!c) return NextResponse.json({ error: 'MIGRATION_MISSING', message: 'Migration 0445 absente : réessayez après la mise à jour de la base.' }, { status: 503 });
      // Premier lot tout de suite (borné) ; la tâche planifiée poursuit.
      const r = await runRelevanceCampaign({ deadline: Date.now() + 20_000, trigger: 'manual' });
      return NextResponse.json({ ok: true, campaign: c, firstRun: r });
    }
    if (body.action === 'recette') {
      const session = await SessionService.getSession(req);
      if (!session.currentAccountId) {
        return NextResponse.json({ error: 'NO_ACCOUNT_SELECTED', message: 'Sélectionnez un compte : les appels IA de la recette lui sont imputés.' }, { status: 400 });
      }
      const { startRelevanceRecette } = await import('@/services/to-process/relevance-recette');
      const r = await startRelevanceRecette({ accountId: session.currentAccountId, userId: guard.ctx.adminUserId });
      if (r.runId === null) return NextResponse.json({ error: 'MIGRATION_MISSING', message: 'Migration 0446 absente : réessayez après la mise à jour de la base.' }, { status: 503 });
      // Exécution en arrière-plan : l'écran suit l'avancement (GET).
      void r.done.catch((e: Error) => console.error('[to-process] recette T4 en échec :', e.message));
      return NextResponse.json({ ok: true, runId: r.runId });
    }
    return NextResponse.json({ error: 'UNKNOWN_ACTION' }, { status: 400 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/queue/to-process-relevance');
  }
}
