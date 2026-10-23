/**
 * Lot 82A — éligibilité stricte des comptes (décision PO C-Q10 et §3.3 du
 * 23/10/2026), sur base réelle (PostgreSQL 16). Assertions limitées aux
 * comptes créés par ce fichier ; dates de référence injectées.
 *
 *   L82A-E01 parité règle TypeScript ↔ règle SQL (matrice de tous les états) ;
 *   L82A-E02 fin d'essai pendant un travail en file (programmé avant) :
 *            exécution neutralisée, mise en file refusée ;
 *   L82A-E03 suspension BO pendant un travail EN COURS et pendant une
 *            campagne « À traiter » : jeton révoqué, campagne sans le compte ;
 *   L82A-E04 lecture seule (rétractation) : aucun T1/T3/T4/T6, aucune
 *            pré-génération, aucun impact de cohérence, aucune notification
 *            de contenu (émission ET envoi), passerelle IA refusée ;
 *   L82A-E05 tâches planifiées déjà programmées (pré-génération, impact) :
 *            jamais prises tant que le compte est non éligible, reprises ensuite ;
 *   L82A-E06 réactivation : reprise des travaux neutralisés SANS doublon et
 *            déclenchement du contrôle de rattrapage (`onAccountReactivated`,
 *            étape remplaçable par 82B), une seule fois ;
 *   L82A-E07 opérations indispensables non bloquées (compte, facturation,
 *            consultation / export, réactivation BO).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const NOW = new Date();
const JOUR = 86_400_000;

scenario('L82A', 'Éligibilité stricte des comptes aux traitements (C-Q10)', ({ sql, make }) => {
  const ecartes = new Set<number>();
  let repo: typeof import('@/services/ai/queue/job-queue.repository');
  let worker: typeof import('@/services/ai/queue/queue-worker');
  let E: typeof import('@/services/account/processing-eligibility');
  let L: typeof import('@/services/account/processing-lifecycle');
  const executes: number[] = [];

  beforeAll(async () => {
    repo = await import('@/services/ai/queue/job-queue.repository');
    worker = await import('@/services/ai/queue/queue-worker');
    E = await import('@/services/account/processing-eligibility');
    L = await import('@/services/account/processing-lifecycle');
    // Exécutant de test du traitement T4 : trace l'exécution, n'écrit rien.
    worker.registerJobHandler('T4', async (job) => { executes.push(job.id); });
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterAll(async () => {
    if (ecartes.size) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${[...ecartes]}) AND status = 'PENDING'`;
    vi.restoreAllMocks();
  });

  /** Seul `id` est prélevable parmi les travaux T4 (base partagée entre scénarios). */
  const seul = async (id: number) => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T4' AND status = 'PENDING' AND available_at <= now() AND id <> ${id} RETURNING id`;
    for (const r of rows) ecartes.add(Number(r.id));
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${id} AND status = 'PENDING'`;
  };
  const job = async (id: number) => (await sql<Array<Record<string, unknown>>>`SELECT * FROM ai_job_queue WHERE id = ${id}`)[0];
  const travail = async (accountId: number, cible: number, delaySeconds = 0) => repo.enqueue({
    treatment: 'T4', scope: { accountId, targetType: 'e2e_cible', targetId: cible },
    triggerCode: 'source_analyzed', payload: { e2e: 'l82a', cible }, ...(delaySeconds ? { delaySeconds } : {}),
  });
  const essai = async (finDansMs: number) => {
    const c = await make.account({ plan: null });
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_consumed, trial_started_at, trial_ends_at)
              VALUES (${c.id}, 'trial', 'trialing', true, ${new Date(NOW.getTime() - 6 * JOUR).toISOString()}, ${new Date(NOW.getTime() + finDansMs).toISOString()})`;
    await sql`UPDATE accounts SET subscription_status = 'TRIALING' WHERE id = ${c.id}`;
    return c;
  };
  const etat = async (accountId: number) => (await sql<Array<Record<string, unknown>>>`SELECT * FROM account_processing_states WHERE account_id = ${accountId}`)[0];

  it('L82A-E01 — même règle en TypeScript et en SQL, pour chaque état de compte', async () => {
    const actif = await make.account({ plan: 'premium' });
    const standard = await make.account();
    const essaiEnCours = await essai(2 * JOUR);
    const essaiEchuParDate = await essai(-JOUR); // statut encore « trialing »
    const essaiBascule = await essai(-JOUR);
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${essaiBascule.id}`;
    const retracte = await make.account({ plan: 'premium' });
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${retracte.id}`;
    await sql`UPDATE accounts SET subscription_status = 'WITHDRAWN' WHERE id = ${retracte.id}`;
    const impaye = await make.account({ plan: 'premium' });
    await sql`UPDATE account_subscriptions SET status = 'past_due' WHERE account_id = ${impaye.id}`;
    const resilie = await make.account({ plan: 'premium' });
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${resilie.id}`;
    const sansAbonnement = await make.account({ plan: null });
    const suspendu = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET is_active = false WHERE id = ${suspendu.id}`;
    const neutralise = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET archived_at = now() WHERE id = ${neutralise.id}`;

    const attendu: Array<[number, boolean, string | null]> = [
      [actif.id, true, null], [standard.id, true, null], [essaiEnCours.id, true, null],
      [essaiEchuParDate.id, false, 'TRIAL_EXPIRED'], [essaiBascule.id, false, 'TRIAL_EXPIRED'], [retracte.id, false, 'WITHDRAWN'],
      [impaye.id, false, 'UNPAID'], [resilie.id, false, 'SUBSCRIPTION_ENDED'], [sansAbonnement.id, false, 'NO_SUBSCRIPTION'],
      [suspendu.id, false, 'ACCOUNT_SUSPENDED'], [neutralise.id, false, 'ACCOUNT_ARCHIVED'],
    ];
    const sqlOk = await E.filterEligibleAccountIds(attendu.map(([id]) => id), NOW);
    for (const [id, eligible, reason] of attendu) {
      expect(await E.getAccountProcessingEligibility(id, NOW), `compte ${id}`).toEqual({ eligible, reason });
      expect(sqlOk.has(id), `SQL compte ${id}`).toBe(eligible);
    }
    // Date de référence injectée : l'essai en cours est échu dans 3 jours, des deux côtés.
    const plusTard = new Date(NOW.getTime() + 3 * JOUR);
    expect((await E.getAccountProcessingEligibility(essaiEnCours.id, plusTard)).reason).toBe('TRIAL_EXPIRED');
    expect((await E.filterEligibleAccountIds([essaiEnCours.id], plusTard)).size).toBe(0);
  });

  it('L82A-E02 — fin des 7 jours d’essai pendant un travail en file (programmé avant) : exécution neutralisée, nouvelle mise en file refusée', async () => {
    const c = await essai(JOUR);
    const r = await travail(c.id, 1, 0);
    expect(r).toMatchObject({ decision: 'create', reasonCode: null });
    const id = r.jobId!;
    // Fin d'essai par la DATE (la tâche `expire-trials` n'est pas encore passée).
    await sql`UPDATE account_subscriptions SET trial_ends_at = now() - interval '1 minute' WHERE account_id = ${c.id}`;
    await seul(id);
    executes.length = 0;
    expect(await worker.runOne('T4')).toBe(true);
    expect(executes).toEqual([]);
    const j = await job(id);
    expect(j).toMatchObject({ status: 'CANCELLED', execution_id: null });
    expect(String(j.last_error)).toMatch(/^Compte non éligible : essai terminé sans souscription/);
    expect((j.payload as Record<string, unknown>).accountIneligible).toMatchObject({ reason: 'TRIAL_EXPIRED', previousStatus: 'RUNNING' });
    expect(Number(j.attempts)).toBe(0);
    // Mise en file refusée, rien n'est écrit.
    const refus = await travail(c.id, 2);
    expect(refus).toEqual({ decision: 'skip', jobId: null, reasonCode: 'ACCOUNT_INELIGIBLE' });
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${c.id} AND target_id = '2'`).toHaveLength(0);
    // La tâche de fin d'essai bascule ensuite le statut et trace la transition (une fois).
    const s = await L.syncAccountEligibility(c.id, { source: 'trial_expiry', now: new Date() });
    expect(s.transition).toBe('first_seen');
    expect(await etat(c.id)).toMatchObject({ eligible: false, reason: 'TRIAL_EXPIRED' });
  });

  it('L82A-E03 — suspension BO pendant un travail EN COURS et pendant une campagne « À traiter »', async () => {
    const { suspendAccount } = await import('@/services/admin/account-status.service');
    const { runArbitrationReprise } = await import('@/services/to-process/arbitration-equivalence-reprise');
    const c = await make.account({ plan: 'premium' });
    await L.syncAccountEligibility(c.id, { source: 'e2e', now: new Date() });
    // Travail en cours (prélevé) + travail programmé plus tard.
    const enCours = (await travail(c.id, 10)).jobId!;
    const programme = (await travail(c.id, 11, 3600)).jobId!;
    await seul(enCours);
    const pris = await repo.claimNext('T4', 'e2e-82a', 60);
    expect(pris?.id).toBe(enCours);
    // Campagne « À traiter » : une carte d'arbitrage du compte.
    const bien = await make.asset(c);
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, proposals_json)
              VALUES (${c.id}, 'ASSET', ${bien.id}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix ?',
                      ${JSON.stringify([{ value: 100 }, { value: 100 }])}::jsonb)`;
    const avant = await runArbitrationReprise({ apply: false, accountId: c.id });
    expect(avant.counters.scanned).toBe(1);

    expect(await suspendAccount(c.id)).toMatchObject({ ok: true, isActive: false });

    // En cours : annulé, jeton révoqué — l'exécution ne peut plus clore ni écrire.
    expect(await job(enCours)).toMatchObject({ status: 'CANCELLED', execution_id: null });
    expect(await repo.isExecutionActive(enCours, pris!.executionId!)).toBe(false);
    expect((await repo.completeJob(enCours, pris!.executionId!)).stale).toBe(true);
    // Programmé : neutralisé aussi.
    expect(await job(programme)).toMatchObject({ status: 'CANCELLED' });
    expect((await job(programme)).payload).toMatchObject({ accountIneligible: { reason: 'ACCOUNT_SUSPENDED', previousStatus: 'PENDING' } });
    // La campagne ne traite plus le compte (aucun contrôle, même en simple constat).
    expect((await runArbitrationReprise({ apply: false, accountId: c.id })).counters.scanned).toBe(0);
    expect(await etat(c.id)).toMatchObject({ eligible: false, reason: 'ACCOUNT_SUSPENDED' });
    expect((await etat(c.id)).last_neutralized).toMatchObject({ aiJobsPending: 1, aiJobsRunning: 1, source: 'admin_suspend' });
    // Production « À traiter » : compte exclu du balayage.
    const { runToProcessFullScan } = await import('@/services/to-process/to-process-scan.job');
    const scan = await runToProcessFullScan({ accountId: c.id, trigger: 'manual' });
    if (scan) expect(scan.accounts).toBe(0);
  });

  it('L82A-E04 — lecture seule (rétractation) : aucun traitement IA, aucune pré-génération, aucun impact, aucune notification de contenu', async () => {
    const c = await make.account({ plan: 'premium' });
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${c.id}`;
    await sql`UPDATE accounts SET subscription_status = 'WITHDRAWN' WHERE id = ${c.id}`;
    E.invalidateProcessingEligibility();
    // File IA (T1 / T3 / T4…) : refus à la mise en file, quel que soit le traitement.
    for (const t of ['T1', 'T3', 'T4'] as const) {
      expect(await repo.enqueue({ treatment: t, scope: { accountId: c.id }, triggerCode: 'manual', origin: 'manual', payload: {} }))
        .toMatchObject({ jobId: null, reasonCode: 'ACCOUNT_INELIGIBLE' });
    }
    // Passerelle IA : aucun appel modèle (T6, T2… hors file compris).
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const { T1_TEST_OPERATION, t1TestVariables, t1Schema } = await import('@/services/ai/gateway/__tests__/t1-master-request');
    const { z } = await import('zod');
    await expect(AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: c.id,
      promptVariables: t1TestVariables('facture'), outputSchema: t1Schema({ title: z.string() }), idempotencyKey: `l82a-${c.id}`,
    })).rejects.toMatchObject({ code: 'ACCOUNT_INELIGIBLE', reason: 'WITHDRAWN' });
    // Pré-génération de la mascotte : aucune demande.
    const { requestMascotPregeneration } = await import('@/services/home/mascot/pregen-queue');
    await requestMascotPregeneration(c.id, 'e2e');
    expect(await sql`SELECT 1 FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`).toHaveLength(0);
    // Notification de contenu : non émise…
    const { emit } = await import('@/lib/notifications');
    await emit({ type: 'DEADLINE_DUE_IN_7_DAYS', accountId: c.id, payload: { count: 1, date: '2026-10-30' }, dedupeKey: `l82a:j7:${c.id}` });
    expect(await sql`SELECT 1 FROM notification_outbox WHERE account_id = ${c.id} AND event_type = 'DEADLINE_DUE_IN_7_DAYS'`).toHaveLength(0);
    // … et, déjà en file avant la bascule, ignorée à l'envoi (cause tracée).
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, payload_json, priority, dedupe_key, status)
      VALUES ('DEADLINE_DUE_IN_7_DAYS', 'deadlines', ${c.id}, ${c.ownerUserId}, ${JSON.stringify({ count: 1, date: '2026-10-30' })}::jsonb, 'normal', ${`l82a:j7:file:${c.id}`}, 'pending')
      RETURNING id`;
    const { processOutboxIds } = await import('@/lib/notifications/dispatcher');
    await processOutboxIds([o.id]);
    const [apres] = await sql<{ status: string; outcome_reason: string | null }[]>`SELECT status, outcome_reason FROM notification_outbox WHERE id = ${o.id}`;
    expect(apres).toEqual({ status: 'skipped', outcome_reason: 'account_ineligible:WITHDRAWN' });
    expect(await sql`SELECT 1 FROM notification_deliveries WHERE outbox_id = ${o.id} AND status = 'sent'`).toHaveLength(0);
  });

  it('L82A-E05 — tâches déjà programmées (pré-génération, rattrapage de cohérence) : jamais prises tant que le compte est non éligible, reprises sans doublon ensuite', async () => {
    const c = await make.account({ plan: 'premium' });
    await L.syncAccountEligibility(c.id, { source: 'e2e', now: new Date() });
    const { requestMascotPregeneration, processMascotPregenerationFor } = await import('@/services/home/mascot/pregen-queue');
    await requestMascotPregeneration(c.id, 'e2e');
    await sql`UPDATE home_mascot_pregen_requests SET requested_at = now() - interval '1 hour' WHERE account_id = ${c.id}`;

    // Lecture seule (impayé) : rien n'est pris.
    await sql`UPDATE account_subscriptions SET status = 'past_due' WHERE account_id = ${c.id}`;
    E.invalidateProcessingEligibility();
    expect(await processMascotPregenerationFor(c.id)).toBeNull();
    const { coherenceAccountEligibility } = await import('@/services/coherence/eligibility');
    expect(await coherenceAccountEligibility(c.id)).toEqual({ eligible: false, reason: 'UNPAID' });
    const [d] = await sql<{ processed_at: Date | null; attempts: number }[]>`SELECT processed_at, attempts FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`;
    expect(d).toEqual({ processed_at: null, attempts: 0 });

    // Régularisé : la demande repart d'elle-même (une ligne, aucun doublon) ; le contrôle de cohérence reprend.
    await sql`UPDATE account_subscriptions SET status = 'active' WHERE account_id = ${c.id}`;
    E.invalidateProcessingEligibility();
    expect(await coherenceAccountEligibility(c.id)).toEqual({ eligible: true, reason: 'ELIGIBLE' });
    expect(await sql`SELECT 1 FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM home_mascot_pregen_requests WHERE account_id = ${c.id} AND processed_at IS NULL AND ${sql.unsafe(E.processingEligibleSql('home_mascot_pregen_requests.account_id'))}`).toHaveLength(1);
  });

  it('L82A-E06 — réactivation : reprise des travaux neutralisés sans doublon et contrôle de rattrapage (`onAccountReactivated`), une seule fois', async () => {
    const c = await essai(JOUR);
    await L.syncAccountEligibility(c.id, { source: 'e2e', now: new Date() });
    const a = (await travail(c.id, 20)).jobId!;
    const b = (await travail(c.id, 21, 600)).jobId!;
    // Fin d'essai : neutralisation par la tâche planifiée (transition détectée).
    await sql`UPDATE account_subscriptions SET trial_ends_at = now() - interval '1 minute' WHERE account_id = ${c.id}`;
    const fin = await L.runAccountEligibilitySync({ onlyAccountIds: [c.id] });
    expect(fin).toMatchObject({ examined: 1, becameIneligible: 1 });
    expect((await job(a)).status).toBe('CANCELLED');
    expect((await job(b)).status).toBe('CANCELLED');

    // Étape de rattrapage remplaçable (82B) : appelée une fois, après le réexamen.
    const ordre: string[] = [];
    const etapeDefaut = L.coherenceCatchupControl;
    L.registerAccountReactivationStep('catchup-control', async (ctx) => { ordre.push('catchup'); return etapeDefaut(ctx); });

    // Souscription : compte de nouveau éligible → reprise (tâche planifiée ou transition directe).
    await sql`UPDATE account_subscriptions SET status = 'active', plan_code = 'premium', first_billed_at = now() WHERE account_id = ${c.id}`;
    const reprise = await L.runAccountEligibilitySync({ onlyAccountIds: [c.id] });
    expect(reprise).toMatchObject({ examined: 1, reactivated: 1 });
    expect(ordre).toEqual(['catchup']);

    // Travaux pertinents remis en file UNE fois (un vivant par clé), anciens marqués réexaminés.
    const vivants = await sql<Array<{ id: number; target_id: string; trigger_code: string; payload: Record<string, unknown> }>>`
      SELECT id, target_id, trigger_code, payload FROM ai_job_queue
       WHERE account_id = ${c.id} AND treatment = 'T4' AND status IN ('PENDING', 'RUNNING') ORDER BY target_id`;
    expect(vivants.map((v) => v.target_id)).toEqual(['20', '21']);
    expect(vivants.every((v) => v.trigger_code === 'source_analyzed' && !('accountIneligible' in v.payload))).toBe(true);
    for (const id of [a, b]) {
      expect(((await job(id)).payload as Record<string, unknown>).accountIneligible).toMatchObject({ reactivationSource: 'eligibility_sync' });
    }
    // Contrôle de rattrapage demandé : campagne de cohérence EXHAUSTIVE sur ce seul compte (C-Q10), pas de T3 systématique (C-Q1).
    const camp = await sql<Array<{ id: number; status: string; trigger_code: string }>>`
      SELECT id, status, trigger_code FROM coherence_campaigns WHERE kind = 'CATCHUP' AND scope_account_ids = ARRAY[${c.id}]::int[]`;
    expect(camp).toHaveLength(1);
    expect(camp[0]).toMatchObject({ status: 'RUNNING', trigger_code: 'reactivation:eligibility_sync' });
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${c.id} AND treatment = 'T3' AND trigger_code = 'account_reactivated'`).toHaveLength(0);
    // Pré-génération de l'accueil redemandée.
    expect(await sql`SELECT 1 FROM home_mascot_pregen_requests WHERE account_id = ${c.id} AND reason = 'account_reactivated'`).toHaveLength(1);
    // Preuve technique de la reprise.
    const st = await etat(c.id);
    expect(st).toMatchObject({ eligible: true, reason: null, last_reactivation_source: 'eligibility_sync' });
    expect(st.last_catchup_requested_at).not.toBeNull();
    expect(st.last_catchup_result).toMatchObject({ 'reexamine-neutralized-jobs': { ok: true, detail: { examined: 2, requeued: 2 } }, 'catchup-control': { ok: true, detail: { coherenceCatchupCampaignId: Number(camp[0].id) } } });

    // Rejoué (autre instance, passage suivant, appel direct) : aucun doublon.
    expect(await L.runAccountEligibilitySync({ onlyAccountIds: [c.id] })).toMatchObject({ examined: 0 });
    expect((await L.syncAccountEligibility(c.id, { source: 'e2e', now: new Date() })).transition).toBe('none');
    await L.onAccountReactivated(c.id, { source: 'e2e-rejeu' });
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${c.id} AND treatment = 'T4' AND status IN ('PENDING', 'RUNNING')`).toHaveLength(2);
    expect(await sql`SELECT 1 FROM coherence_campaigns WHERE kind = 'CATCHUP' AND scope_account_ids = ARRAY[${c.id}]::int[]`).toHaveLength(1);
    // Le travail repris s'exécute normalement.
    const premier = vivants[0].id;
    await seul(premier);
    executes.length = 0;
    expect(await worker.runOne('T4')).toBe(true);
    expect(executes).toEqual([premier]);
    L.registerAccountReactivationStep('catchup-control', etapeDefaut);
  });

  it('L82A-E07 — opérations indispensables non bloquées : compte / facturation, consultation et export, réactivation BO', async () => {
    const { suspendAccount, reactivateAccount } = await import('@/services/admin/account-status.service');
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { emit } = await import('@/lib/notifications');
    const c = await essai(-JOUR); // essai échu : non éligible
    // Notification de COMPTE (fin d'essai) : émise malgré la non-éligibilité.
    await emit({ type: 'TRIAL_ENDED', accountId: c.id, entityType: 'account', entityId: c.id, payload: {}, dedupeKey: `l82a:trial:${c.id}` });
    const [n] = await sql<{ status: string; outcome_reason: string | null }[]>`
      SELECT status, outcome_reason FROM notification_outbox WHERE account_id = ${c.id} AND event_type = 'TRIAL_ENDED'`;
    expect(n).toBeDefined();
    expect(n.outcome_reason ?? '').not.toMatch(/account_ineligible/);
    // Consultation et export conservés (mode restreint, pas de blocage d'accès).
    expect(await getEntitlements(c.id)).toMatchObject({ canRead: true, canWrite: false });
    // Suspension / réactivation BO : toujours possibles sur un compte non éligible ;
    // réactivé mais toujours sans abonnement : aucun rattrapage déclenché.
    expect(await suspendAccount(c.id)).toMatchObject({ ok: true });
    expect(await reactivateAccount(c.id)).toMatchObject({ ok: true, isActive: true });
    expect(await etat(c.id)).toMatchObject({ eligible: false, reason: 'TRIAL_EXPIRED' });
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${c.id} AND trigger_code = 'account_reactivated'`).toHaveLength(0);
    // Le titulaire souscrit : la réactivation BO d'un compte suspendu EN RÈGLE déclenche la reprise.
    const d = await make.account({ plan: 'premium' });
    await suspendAccount(d.id);
    expect(await etat(d.id)).toMatchObject({ eligible: false, reason: 'ACCOUNT_SUSPENDED' });
    await reactivateAccount(d.id);
    expect(await etat(d.id)).toMatchObject({ eligible: true, last_reactivation_source: 'admin_reactivate' });
    expect(await sql`SELECT 1 FROM coherence_campaigns WHERE kind = 'CATCHUP' AND scope_account_ids = ARRAY[${d.id}]::int[] AND trigger_code = 'reactivation:admin_reactivate'`).toHaveLength(1);
  });
});
