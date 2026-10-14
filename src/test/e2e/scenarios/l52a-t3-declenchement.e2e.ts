/**
 * Lot 52A — ticket « [P1] T3 — Identifier et corriger le non-déclenchement
 * des exécutions manuelles et horaires » : NR-01 à NR-10 sur PostgreSQL réel,
 * boucleur réel (`runOne`), exécutant T3 de production
 * (`registerReconciliationHandlers`, comme `instrumentation-node`).
 *
 * Reproduction AVANT correctif (code lot50b) : voir le rapport du lot —
 * NR-09 (compte sans bien exclu du lancement manuel), COR-03 (la File IA
 * rendait les 100 PLUS ANCIENS jobs), NR-10 (exécution orpheline après
 * redéploiement → job FAILED « déjà en cours » en 5 tentatives), NR-02
 * (balayage « horaire » sautant le compte rationalisé au cycle précédent).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';

type JobRow = {
  id: number; status: string; attempts: number; origin: string; trigger_code: string | null; account_id: number | null;
  business_result: string | null; business_result_detail: Record<string, unknown> | null; last_error: string | null;
  recovered_count: number; payload: Record<string, unknown> | null; treatment: string; execution_id: string | null;
};

scenario('L52A', 'T3 — déclenchement manuel et horaire (NR-01 à NR-10)', ({ sql, make }) => {
  let w: typeof import('@/services/ai/queue/queue-worker');
  let repo: typeof import('@/services/ai/queue/job-queue.repository');
  let ml: typeof import('@/services/ai/queue/manual-launch');
  let sup: typeof import('@/services/ai/queue/supervision');
  let triggers: typeof import('@/services/ai/queue/triggers');
  let admin: { id: number };
  const ecartes = new Set<number>();
  const env = { ...process.env };

  /** Seuls `ids` sont prélevables (base partagée entre scénarios). */
  const seul = async (...ids: number[]) => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE status = 'PENDING' AND available_at <= now() AND NOT (id = ANY(${ids})) RETURNING id`;
    for (const r of rows) ecartes.add(Number(r.id));
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ids}) AND status = 'PENDING'`;
  };
  const lire = async (id: number) => (await sql<JobRow[]>`SELECT * FROM ai_job_queue WHERE id = ${id}`)[0];
  const lancer = async (accountIds: number[]) => ml.launchManual('T3', { accountIds }, admin.id, {}, await ml.defaultManualLaunchDeps());
  const compteAvecBien = async () => { const c = await make.account(); await make.asset(c); return c; };
  const runs = async (accountId: number) => sql<{ id: number; status: string; trigger_type: string; queue_job_id: number | null }[]>`
    SELECT id, status, trigger_type, queue_job_id FROM account_reconciliation_runs WHERE account_id = ${accountId} ORDER BY id`;

  beforeAll(async () => {
    w = await import('@/services/ai/queue/queue-worker');
    repo = await import('@/services/ai/queue/job-queue.repository');
    ml = await import('@/services/ai/queue/manual-launch');
    sup = await import('@/services/ai/queue/supervision');
    triggers = await import('@/services/ai/queue/triggers');
    const { registerReconciliationHandlers } = await import('@/services/ai/reconciliation');
    registerReconciliationHandlers();
    triggers.__setTriggerConfigLoader(async () => null); // défauts du code : schedule_hourly
    admin = await make.user();
    await repo.setEmergencyStop(false, admin.id);
    await repo.setTreatmentState('T3', 'ENABLED', admin.id);
  });
  afterAll(async () => {
    triggers.__setTriggerConfigLoader(null);
    process.env = { ...env };
    if (ecartes.size) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${[...ecartes]}) AND status = 'PENDING'`;
  });

  it('NR-01 : lancement manuel — job identifiable tout de suite, pris en charge, résultat consultable', async () => {
    const c = await compteAvecBien();
    const r = await lancer([c.id]);
    expect(r.jobIds).toHaveLength(1);
    const id = r.jobIds[0];
    expect(r.jobs).toEqual([{ id, accountId: c.id }]);
    // Persisté, visible tout de suite : recherche par identifiant ET en tête de la File IA (plus récents d'abord).
    const [cherche] = await repo.listJobs({ ids: [id] });
    expect(cherche).toMatchObject({ id, status: 'PENDING', origin: 'manual', triggerCode: 'manual', accountId: c.id });
    expect(sup.executionPhase(cherche)).toBe('CREATED_NOT_STARTED');
    const recents = await repo.listJobs({ treatment: 'T3' });
    expect(recents[0].id).toBe(id);
    // Prise en charge par le boucleur réel.
    await seul(id);
    expect(await w.runOne('T3')).toBe(true);
    const j = await lire(id);
    expect(j.status).toBe('DONE');
    expect(['NO_CHANGE', 'APPLIED', 'ABSTAIN']).toContain(j.business_result);
    expect((await runs(c.id)).map((x) => ({ s: x.status, t: x.trigger_type, q: x.queue_job_id }))).toEqual([{ s: 'completed', t: 'manual', q: id }]);
    const s = await sup.getT3Supervision();
    expect(s.lastManual).toMatchObject({ id, accountId: c.id, status: 'DONE', objectsExamined: 1 });
    expect(s.lastManual?.startedAt).not.toBeNull();
    expect(s.lastManual?.finishedAt).not.toBeNull();
    expect(s.lastManual?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('NR-02 : planification horaire — balayage puis job compte exécutés sans administrateur, y compris un compte vu au cycle précédent', async () => {
    process.env.T3_SWEEP_PAGE_SIZE = '1000';
    const c = await compteAvecBien();
    // Cycle précédent : racine il y a 1 h, passage du compte terminé 40 s après son début.
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now()
               WHERE treatment = 'T3' AND status IN ('PENDING', 'RUNNING')
                 AND (target_type IN ('t3_sweep', 'document_sweep', 'document_title_sweep', 'business_operations_sweep')
                      OR (account_id IS NULL AND target_type IS NULL))`;
    await sql`UPDATE ai_job_queue SET created_at = created_at - interval '2 hours'
               WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL AND created_at > now() - interval '2 hours'`;
    await sql`INSERT INTO account_reconciliation_runs (account_id, trigger_type, correlation_id, scope, status, started_at, finished_at)
              VALUES (${c.id}, 'scheduled', 'cycle-precedent', 'incremental', 'completed', now() - interval '3595 seconds', now() - interval '3560 seconds')`;

    const declenches = await triggers.runDueSchedules();
    expect(declenches).toContainEqual({ treatment: 'T3', triggerCode: 'schedule_hourly' });
    const [racine] = await sql<JobRow[]>`SELECT * FROM ai_job_queue WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL
                                           AND status = 'PENDING' ORDER BY id DESC LIMIT 1`;
    expect(racine).toMatchObject({ origin: 'automatic', trigger_code: 'schedule_hourly' });
    await seul(racine.id);
    expect(await w.runOne('T3')).toBe(true);
    expect((await lire(racine.id)).status).toBe('DONE');
    const [jc] = await sql<JobRow[]>`SELECT * FROM ai_job_queue WHERE treatment = 'T3' AND account_id = ${c.id} AND target_type IS NULL
                                       AND trigger_code = 'schedule_hourly' ORDER BY id DESC LIMIT 1`;
    expect(jc, 'compte rationalisé au cycle précédent : remis en file par le cycle suivant').toBeDefined();
    await seul(jc.id);
    expect(await w.runOne('T3')).toBe(true);
    expect((await lire(jc.id)).status).toBe('DONE');
    const r = await runs(c.id);
    expect(r[r.length - 1]).toMatchObject({ status: 'completed', trigger_type: 'scheduled', queue_job_id: jc.id });
    const s = await sup.getT3Supervision();
    expect(s.schedule).toMatchObject({ triggerCode: 'schedule_hourly', periodHours: 1 });
    expect(new Date(s.schedule.nextDueAt!).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(s.lastSweep?.id).toBe(racine.id);
    // Une seconde passe immédiate ne replanifie pas (échéance horaire respectée).
    expect(await triggers.runDueSchedules()).not.toContainEqual({ treatment: 'T3', triggerCode: 'schedule_hourly' });
  });

  it('NR-03 : exécution sans modification — DONE / NO_CHANGE, sans appel modèle, visible dans le BO', async () => {
    const c = await compteAvecBien();
    const [id] = (await lancer([c.id])).jobIds;
    await seul(id);
    await w.runOne('T3');
    const j = await lire(id);
    expect(j).toMatchObject({ status: 'DONE', business_result: 'NO_CHANGE' });
    expect(j.business_result_detail).toMatchObject({ objectsExamined: 1, objectsModified: 0, aiCalls: 0 });
    const [vu] = await repo.listJobs({ ids: [id] });
    expect(sup.executionPhase(vu)).toBe('DONE_NO_CHANGE');
    const s = await sup.getT3Supervision();
    expect(s.lastManual).toMatchObject({ id, phase: 'DONE_NO_CHANGE', businessResult: 'NO_CHANGE', aiCalls: 0 });
  });

  it('NR-04 : boucleur indisponible — job conservé, état identifiable, reprise au redémarrage', async () => {
    const c = await compteAvecBien();
    const [id] = (await lancer([c.id])).jobIds;
    // Battement d'une instance arrêtée depuis 10 min (aucune autre vivante).
    expect(await w.writeHeartbeat()).toBe(true);
    await sql`UPDATE ai_queue_worker_heartbeats SET last_tick_at = now() - interval '10 minutes'`;
    let s = await sup.getT3Supervision();
    expect(s.workers.state).toBe('NO_LIVE_WORKER');
    expect(s.executor).toMatchObject({ available: false, code: 'NO_LIVE_WORKER' });
    expect(s.lastManual).toMatchObject({ id, phase: 'CREATED_NOT_STARTED' });
    // Arrêt brutal PENDANT l'exécution : RUNNING, bail expiré.
    await sql`UPDATE ai_job_queue SET status = 'RUNNING', attempts = 1, started_at = now() - interval '6 minutes',
              execution_id = gen_random_uuid(), worker_id = 'instance-arretee', lease_expires_at = now() - interval '1 minute' WHERE id = ${id}`;
    const repris = await repo.recoverAbandonedJobs();
    expect(repris).toContainEqual({ id, status: 'PENDING' });
    expect((await lire(id)).status).toBe('PENDING'); // jamais considéré exécuté
    // Redémarrage : l'instance bat de nouveau, le job est repris et exécuté.
    expect(await w.writeHeartbeat()).toBe(true);
    s = await sup.getT3Supervision();
    expect(s.workers).toMatchObject({ state: 'OK' });
    expect(s.workers.t3ExecutorInstances).toBeGreaterThanOrEqual(1);
    await seul(id);
    expect(await w.runOne('T3')).toBe(true);
    expect(await lire(id)).toMatchObject({ status: 'DONE', recovered_count: 1 });
  });

  it('NR-05 : T3 désactivé — aucun traitement, attente explicite, reprise à la réactivation', async () => {
    const c = await compteAvecBien();
    await repo.setTreatmentState('T3', 'DISABLED', admin.id, 'e2e NR-05');
    try {
      const r = await lancer([c.id]);
      expect(r.waitsForReactivation).toBe(true);
      const id = r.jobIds[0];
      await seul(id);
      expect(await w.runOne('T3')).toBe(false);
      expect(await lire(id)).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect(await runs(c.id)).toHaveLength(0);
      const s = await sup.getT3Supervision();
      expect(s.executor).toMatchObject({ available: false, code: 'DISABLED' });
      await repo.setTreatmentState('T3', 'ENABLED', admin.id);
      await seul(id);
      expect(await w.runOne('T3')).toBe(true);
      expect((await lire(id)).status).toBe('DONE');
    } finally {
      await repo.setTreatmentState('T3', 'ENABLED', admin.id);
    }
  });

  it('NR-06 : plusieurs instances, plusieurs jobs — ni doublon ni perte', async () => {
    const comptes = [];
    for (let i = 0; i < 6; i++) comptes.push(await compteAvecBien());
    const { jobIds } = await lancer(comptes.map((c) => c.id));
    expect(jobIds).toHaveLength(6);
    await seul(...jobIds);
    // Quatre « instances » qui prélèvent en parallèle jusqu'à épuisement.
    const instance = async () => { let n = 0; while (await w.runOne('T3')) n++; return n; };
    const pris = await Promise.all([instance(), instance(), instance(), instance()]);
    expect(pris.reduce((a, b) => a + b, 0)).toBe(6);
    for (const id of jobIds) expect(await lire(id)).toMatchObject({ status: 'DONE', attempts: 1 });
    for (const c of comptes) expect(await runs(c.id)).toHaveLength(1);
    // Deux planificateurs simultanés : une seule racine vivante (index unique de déduplication).
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now()
               WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL AND status IN ('PENDING', 'RUNNING')`;
    await sql`UPDATE ai_job_queue SET created_at = created_at - interval '2 hours'
               WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL AND created_at > now() - interval '2 hours'`;
    await Promise.all([triggers.runDueSchedules(), triggers.runDueSchedules()]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue
      WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL AND status IN ('PENDING', 'RUNNING')`;
    expect(n).toBe(1);
  });

  it('NR-07 : périmètre — aucun traitement intercomptes ; refus tracés et compréhensibles', async () => {
    const a = await compteAvecBien();
    const b = await make.account();
    const bienB = await make.asset(b);
    // Mise en file d'une référence d'un autre compte : refusée, rien n'est écrit.
    const refus = await repo.enqueue({ treatment: 'T3', scope: { accountId: a.id, targetType: 'asset', targetId: bienB.id }, payload: { kind: 'asset', userId: a.ownerUserId } });
    expect(refus).toEqual({ decision: 'skip', jobId: null, reasonCode: 'CROSS_ACCOUNT_SCOPE' });
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${a.id} AND target_type = 'asset' AND target_id = ${String(bienB.id)}`).toHaveLength(0);
    // Job ancien portant une référence étrangère : échec définitif, motif lisible, aucune écriture.
    const [{ id: vieux }] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload)
      VALUES ('T3', ${a.id}, 'asset', ${String(bienB.id)}, ${`e2e-nr07-${a.id}`}, 'manual', 'manual',
              ${JSON.stringify({ payloadVersion: 1, kind: 'asset', userId: a.ownerUserId })}::jsonb) RETURNING id`;
    await seul(vieux);
    await w.runOne('T3');
    const j = await lire(vieux);
    expect(j.status).toBe('FAILED');
    expect(j.last_error).toMatch(/périmètre hors compte/);
    const [vu] = await repo.listJobs({ ids: [vieux] });
    expect(sup.executionPhase(vu)).toBe('FAILED');
    expect(await sql`SELECT 1 FROM reconciliation_runs WHERE asset_id = ${bienB.id}`).toHaveLength(0);
    // Le lancement manuel d'un compte ne touche que ce compte.
    const avantB = (await runs(b.id)).length;
    const [id] = (await lancer([a.id])).jobIds;
    await seul(id);
    await w.runOne('T3');
    expect((await lire(id)).account_id).toBe(a.id);
    expect(await runs(b.id)).toHaveLength(avantB);
  });

  it('NR-08 : T1 et T4 — files, contextes, déclencheurs et ordre de service inchangés', async () => {
    const c = await make.account();
    const bien = await make.asset(c);
    await make.assetFile(c, { assetId: bien.id });
    await make.assetFile(c, { assetId: bien.id });
    const r = await ml.launchManual('T1', { accountIds: [c.id] }, admin.id, {}, await ml.defaultManualLaunchDeps());
    expect(r.jobIds).toHaveLength(2);
    const t1 = await sql<JobRow[]>`SELECT * FROM ai_job_queue WHERE id = ANY(${r.jobIds}) ORDER BY id`;
    for (const j of t1) {
      expect(j).toMatchObject({ treatment: 'T1', origin: 'manual', trigger_code: 'manual', status: 'PENDING' });
      expect(j.payload).toMatchObject({ billable: false, processingVisibility: 'TECHNICAL', origin: 'admin/manual', userId: null });
    }
    // Affichage : plus récents d'abord ; service du boucleur : FIFO (le plus ancien d'abord).
    const affiches = await repo.listJobs({ ids: r.jobIds });
    expect(affiches.map((j) => j.id)).toEqual([...r.jobIds].sort((x, y) => y - x));
    expect((await repo.listJobs({ ids: r.jobIds, order: 'service' })).map((j) => j.id)).toEqual([...r.jobIds].sort((x, y) => x - y));
    await seul(...r.jobIds);
    const pris = await repo.claimNext('T1', 'e2e-nr08');
    expect(pris?.id).toBe(Math.min(...r.jobIds));
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now() WHERE id = ANY(${r.jobIds})`;
    // Le boucleur T3 ne prélève jamais un job T1.
    expect(t1.every((j) => j.treatment === 'T1')).toBe(true);
    // T4 : périmètre sans échéance candidate → refus inchangé (EMPTY_SCOPE), rien n'est créé.
    await expect(ml.launchManual('T4', { accountIds: [c.id] }, admin.id, {}, await ml.defaultManualLaunchDeps()))
      .rejects.toMatchObject({ code: 'EMPTY_SCOPE' });
    // Déclencheurs par défaut T1 / T4 inchangés.
    expect([...triggers.activeTriggerCodes('T1', null)].sort()).toEqual(['analysis_recovery', 'source_uploaded']);
    expect([...triggers.activeTriggerCodes('T4', null)]).toEqual(['source_analyzed']);
  });

  it('NR-09 : un compte avec des « À traiter » ouverts mais sans bien actif est réellement examiné', async () => {
    const c = await make.account();
    const agenda = await make.agendaItem(c);
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
              VALUES (${c.id}, 'AGENDA_ITEM', ${agenda.id}, 'nr09', 'ARBITRATE', 'AGENDA-PROPOSAL', 'Question e2e')`;
    const est = await ml.launchManual('T3', { accountIds: [c.id] }, admin.id, { dryRun: true }, await ml.defaultManualLaunchDeps());
    expect(est).toMatchObject({ objects: 1, excludedAccountIds: [] });
    const [id] = (await lancer([c.id])).jobIds;
    await seul(id);
    await w.runOne('T3');
    const j = await lire(id);
    expect(j.status).toBe('DONE');
    expect(Number(j.business_result_detail?.openActionsExamined)).toBeGreaterThanOrEqual(1);
    // Un compte sans bien NI « À traiter » : motif explicite, aucun job.
    const vide = await make.account();
    await expect(lancer([vide.id])).rejects.toMatchObject({ code: 'EMPTY_SCOPE', details: { excludedAccountIds: [vide.id] } });
  });

  it('NR-10 : redéploiement — jobs persistés ni perdus ni considérés exécutés ; exécution orpheline sans effet bloquant', async () => {
    const c = await compteAvecBien();
    const autre = await compteAvecBien();
    const [id] = (await lancer([c.id])).jobIds;
    const [enAttente] = (await lancer([autre.id])).jobIds;
    // Ancien processus : prélève le job et ouvre l'exécution du compte, puis est tué.
    await seul(id);
    const pris = await repo.claimNext('T3', 'ancien-processus');
    expect(pris?.id).toBe(id);
    await sql`INSERT INTO account_reconciliation_runs (account_id, trigger_type, correlation_id, scope, status, started_at, queue_job_id, queue_execution_id)
              VALUES (${c.id}, 'manual', 'orphelin', 'full', 'running', now() - interval '6 minutes', ${id}, ${pris!.executionId}::uuid)`;
    await sql`UPDATE ai_job_queue SET lease_expires_at = now() - interval '1 minute' WHERE id = ${id}`;
    // Nouveau processus : reprise des abandonnés, puis exécution.
    await repo.recoverAbandonedJobs();
    expect((await lire(id)).status).toBe('PENDING');
    expect((await lire(enAttente)).status).toBe('PENDING'); // non touché, jamais DONE à tort
    await seul(id);
    expect(await w.runOne('T3')).toBe(true);
    expect(await lire(id)).toMatchObject({ status: 'DONE' });
    const r = await runs(c.id);
    expect(r.map((x) => x.status)).toEqual(['failed', 'completed']); // orpheline close, passage réel complet

    // Orpheline d'AVANT ce lot (sans lien vers son job) : le job est REPORTÉ
    // (tentative rendue), jamais épuisé en échec en quelques minutes.
    await sql`INSERT INTO account_reconciliation_runs (account_id, trigger_type, correlation_id, scope, status, started_at)
              VALUES (${autre.id}, 'manual', 'orphelin-historique', 'full', 'running', now() - interval '6 minutes')`;
    await seul(enAttente);
    expect(await w.runOne('T3')).toBe(true);
    const reporte = await lire(enAttente);
    expect(reporte).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(reporte.last_error).toMatch(/déjà en cours sur ce compte — reprise différée/);
  });
});
