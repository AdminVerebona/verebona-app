/**
 * /api/admin/ai/queue/to-process-relevance — lot 61 (tickets « À traiter » :
 * écarts résiduels du 58B et pertinence des cartes).
 *
 *   GET  : configuration T4 effective (contrat de sortie), campagnes de
 *          réévaluation rétroactive (bilan AVANT / APRÈS, issues), issues
 *          par carte d'une campagne (filtres compte, issue), recettes T4
 *          réelles (résultat attendu / obtenu par cas).
 *   POST : { action: 'recette' } — recette du corpus livré avec le VÉRITABLE
 *          T4 de l'environnement (exécutée en arrière-plan, suivie par GET) ;
 *          lot 76 : { action: 'retry-traces' } — relance des traces de
 *          décision abandonnées (0582) ; lot 98B : { action: 'retry-held' }
 *          — nouvelle tentative sur les cartes RETENUES (maintien technique).
 *          Lot 83E (C-Q9) : les actions « campaign » et « retry-errors » sont
 *          RETIRÉES avec le moteur de campagne — la réévaluation est faite
 *          par le contrôle de cohérence (registre, tâche `coherence-control`) ;
 *          les campagnes passées restent consultables (GET, historique).
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
    const [{ listRelevanceCampaigns, listCampaignItems, campaignTablesReady, campaignMultiFamilyReady }, { listRecetteRuns, recetteTableReady, RELEVANCE_RECETTE_CASES }, ev] = await Promise.all([
      import('@/services/to-process/relevance-campaign.service'), import('@/services/to-process/relevance-recette'),
      import('@/services/to-process/document-field-evidence'),
    ]);
    const campaigns = await listRelevanceCampaigns(10);
    const campaignId = n('campaignId') ?? campaigns[0]?.id ?? null;
    const outcome = q.get('outcome') && /^[A-Z_]{1,40}$/.test(q.get('outcome')!) ? q.get('outcome') : null;
    return NextResponse.json({
      config: await ev.t4AssessmentConfig(),
      engineVersion: ev.DOCUMENT_RULE_ENGINE_VERSION,
      migrations: {
        decisions0444: await ev.relevanceColumnsReady(), campaigns0445: await campaignTablesReady(), recette0446: await recetteTableReady(),
        // Lot 72 : traçabilité des décisions (0516), campagne multi-familles (0517).
        ecarts0516: await ev.decisionKindColumnReady(), campagne0517: await campaignMultiFamilyReady(),
        // Lot 76 : reprise des erreurs de campagne (0581), reprise des traces (0582).
        reprise0581: await (await import('@/services/to-process/relevance-campaign.service')).campaignRetryReady(),
        traces0582: await (await import('@/services/to-process/trace-retries')).traceRetriesReady(),
      },
      campaigns,
      items: campaignId ? await listCampaignItems(campaignId, { accountId: n('accountId'), outcome, limit: 100 }) : [],
      recetteCases: RELEVANCE_RECETTE_CASES.map((c) => ({ id: c.id, label: c.label, deterministic: c.deterministic })),
      recetteRuns: await listRecetteRuns(5),
      // Lot 75I (D) : décisions prudentes en attente d'une configuration T4 compatible (signalées, réévaluées à l'activation).
      incompatibleDecisions: await ev.countIncompatibleDecisions(),
      // Lot 76 (C8) : décisions appliquées NON tracées (reprise identifiable).
      traceRetries: await (await import('@/services/to-process/trace-retries')).traceRetryOverview({ accountId: n('accountId'), limit: 50 }),
      // Lot 98B (P0-E) : cartes ouvertes RETENUES (maintien technique), non publiées — cause par cause.
      heldCards: await (async () => {
        const { heldCardsOverview, HOLD_CAUSE_LABELS } = await import('@/services/to-process/publishability');
        return (await heldCardsOverview({ accountId: n('accountId') })).map((g) => ({ ...g, label: HOLD_CAUSE_LABELS[g.cause] }));
      })(),
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
    if (body.action === 'campaign' || body.action === 'retry-errors') {
      // Lot 83E (C-Q9) : une seule chaîne — le contrôle de cohérence.
      return NextResponse.json({
        error: 'CAMPAIGN_RETIRED',
        message: 'La campagne de pertinence est remplacée par le contrôle de cohérence (tâche « coherence-control ») : rien à lancer ici.',
      }, { status: 410 });
    }
    if (body.action === 'retry-traces') {
      const { requeueAbandonedTraces, replayPendingTraces } = await import('@/services/to-process/trace-retries');
      const relances = await requeueAbandonedTraces();
      return NextResponse.json({ ok: true, requeued: relances, run: await replayPendingTraces({ limit: 100, deadline: Date.now() + 20_000 }) });
    }
    if (body.action === 'retry-held') {
      // Lot 98B (P0-E) : nouvelle tentative de décision sur les cartes retenues (décision centrale, budget IA du compte).
      const { retryHeldCards } = await import('@/services/to-process/publishability');
      return NextResponse.json({ ok: true, run: await retryHeldCards({ limit: 50, deadline: Date.now() + 25_000 }) });
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
