/**
 * Lot 54A — ticket « [P1] T3 — Aucun job créé dans la File IA en lancement
 * manuel ni en planification » : TC1 à TC10 sur PostgreSQL réel, par la VRAIE
 * route HTTP (`POST /api/admin/ai/treatments/T3/launch`, garde admin réelle,
 * seule la lecture du cookie est simulée), la File IA (`GET …/queue/jobs`),
 * la supervision (`GET …/queue/supervision`) et la planification réelle
 * (`evaluateDueSchedules` / `runDueSchedules`).
 *
 * PHASE A seulement (demande → ligne `ai_job_queue`) : aucun job n'est
 * exécuté ici, sauf mention.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

type Ev = { decision: string; reason_code: string | null; job_id: number | null; persisted: boolean | null; origin: string; trigger_code: string | null; account_id: number | null };

scenario('L54A', 'T3 — création du job (phase A) : contrat HTTP strict, motifs, traces (TC1 à TC10)', ({ sql, make }) => {
  const session = { userId: 0, role: 'ADMIN', email: '' };
  let NextRequest: typeof import('next/server').NextRequest;
  let launch: typeof import('@/app/api/admin/ai/treatments/[treatment]/launch/route');
  let jobsRoute: typeof import('@/app/api/admin/ai/queue/jobs/route');
  let supRoute: typeof import('@/app/api/admin/ai/queue/supervision/route');
  let triggers: typeof import('@/services/ai/queue/triggers');
  let repo: typeof import('@/services/ai/queue/job-queue.repository');
  let admin: { id: number };
  const debut = new Date();

  /** Comptes lancés ici : leurs jobs manuels sont annulés en fin de fichier. */
  const comptesLances = new Set<number>();
  const post = async (body: unknown) => {
    for (const id of ((body as { accountIds?: unknown })?.accountIds as number[] | undefined) ?? []) if (Number.isInteger(id)) comptesLances.add(id);
    const res = await launch.POST(
      new NextRequest('http://app.test/api/admin/ai/treatments/T3/launch', { method: 'POST', body: JSON.stringify(body) }),
      { params: Promise.resolve({ treatment: 'T3' }) },
    );
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const ligne = async (id: number) => (await sql<Array<Record<string, unknown>>>`SELECT * FROM ai_job_queue WHERE id = ${id} AND treatment = 'T3'`);
  const traces = async (accountId: number) => sql<Ev[]>`SELECT * FROM ai_t3_enqueue_events WHERE account_id = ${accountId} ORDER BY id`;
  /** Racines T3 vivantes écartées, dernière racine reculée de 2 h : passage échu. */
  const rendreEchu = async () => {
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now()
               WHERE treatment = 'T3' AND status IN ('PENDING', 'RUNNING') AND account_id IS NULL AND target_type IS NULL`;
    await sql`UPDATE ai_job_queue SET created_at = created_at - interval '2 hours'
               WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL AND created_at > now() - interval '2 hours'`;
  };

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    ({ NextRequest } = await import('next/server'));
    launch = await import('@/app/api/admin/ai/treatments/[treatment]/launch/route');
    jobsRoute = await import('@/app/api/admin/ai/queue/jobs/route');
    supRoute = await import('@/app/api/admin/ai/queue/supervision/route');
    triggers = await import('@/services/ai/queue/triggers');
    repo = await import('@/services/ai/queue/job-queue.repository');
    triggers.__setTriggerConfigLoader(async () => null); // défauts du code : schedule_hourly
    const u = await make.user({ role: 'ADMIN' });
    admin = u;
    session.userId = u.id; session.email = u.email;
    await repo.setEmergencyStop(false, admin.id);
    await repo.setTreatmentState('T3', 'ENABLED', admin.id);
  });
  afterAll(async () => {
    triggers.__setTriggerConfigLoader(null);
    vi.restoreAllMocks();
    // Phase A seulement : les jobs créés ici ne sont JAMAIS exécutés — ils
    // ne doivent pas encombrer la file des scénarios suivants (base partagée :
    // une racine de balayage mettrait en file tous les comptes de la base).
    // Lot 54 (intégration) : seulement les jobs de CE fichier — racines de
    // balayage et lancements manuels T3 de ses comptes ; jamais ceux des
    // scénarios qui tournent en parallèle sur la même base.
    await annulerRacines();
    if (comptesLances.size > 0) {
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now()
                 WHERE status = 'PENDING' AND treatment = 'T3' AND origin = 'manual'
                   AND account_id = ANY(${[...comptesLances]}::int[])`;
    }
  });
  // Une racine de balayage restée PENDING serait prélevée par la vidange de
  // file d'un autre scénario et remettrait en file tous les comptes de la
  // base (l28, l31b) : annulée dès la fin de chaque test.
  const annulerRacines = () => sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now()
               WHERE status = 'PENDING' AND account_id IS NULL AND target_type IS NULL
                 AND created_at >= ${debut.toISOString()}::timestamptz`;
  afterEach(async () => { await annulerRacines(); });

  it('T3-JOB-TC01 : compte avec un bien → 202, jobIds = [X], ligne T3 manual PENDING réelle, trace create/persisted', async () => {
    const c = await make.account();
    await make.asset(c);
    const r = await post({ accountIds: [c.id] });
    expect(r.status).toBe(202);
    expect(r.body.jobIds).toHaveLength(1);
    const [row] = await ligne(r.body.jobIds[0]);
    expect(row).toMatchObject({ treatment: 'T3', origin: 'manual', trigger_code: 'manual', status: 'PENDING', account_id: c.id, target_type: null });
    expect(row.payload).toMatchObject({ kind: 'account', scope: 'full' });
    const [t] = await traces(c.id);
    expect(t).toMatchObject({ origin: 'manual', trigger_code: 'manual', decision: 'create', reason_code: null, job_id: r.body.jobIds[0], persisted: true });
  });

  it('T3-JOB-TC02 : compte sans bien avec un « À traiter » ouvert → job T3 créé', async () => {
    const c = await make.account();
    const agenda = await make.agendaItem(c);
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
              VALUES (${c.id}, 'AGENDA_ITEM', ${agenda.id}, 'tc02', 'ARBITRATE', 'AGENDA-PROPOSAL', 'Question e2e')`;
    const est = await post({ accountIds: [c.id], dryRun: true });
    expect(est).toMatchObject({ status: 200, body: { objects: 1, excludedAccountIds: [] } });
    const r = await post({ accountIds: [c.id] });
    expect(r.status).toBe(202);
    expect(await ligne(r.body.jobIds[0])).toHaveLength(1);
  });

  it('T3-JOB-TC03 : compte vide → 422 EMPTY_SCOPE, motif NO_ELIGIBLE_ACCOUNT tracé, aucun job', async () => {
    const c = await make.account();
    const avant = (await sql`SELECT id FROM ai_job_queue WHERE account_id = ${c.id}`).length;
    const r = await post({ accountIds: [c.id] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'EMPTY_SCOPE', details: { excludedAccountIds: [c.id], reasons: { NO_ELIGIBLE_ACCOUNT: 1 } } });
    expect(r.body.jobIds).toBeUndefined();
    expect((await sql`SELECT id FROM ai_job_queue WHERE account_id = ${c.id}`).length).toBe(avant);
    expect(await traces(c.id)).toEqual([expect.objectContaining({ decision: 'refused', reason_code: 'NO_ELIGIBLE_ACCOUNT', job_id: null })]);
  });

  it('T3-JOB-TC04 : deux lancements manuels consécutifs → deux jobs distincts (jamais absorbés), même avec un automatique vivant', async () => {
    const c = await make.account();
    await make.asset(c);
    const auto = await repo.enqueue({ treatment: 'T3', scope: { accountId: c.id }, payload: { kind: 'account', scope: 'incremental' } });
    expect(auto.decision).toBe('create');
    const a = await post({ accountIds: [c.id] });
    const b = await post({ accountIds: [c.id] });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.jobIds[0]).not.toBe(b.body.jobIds[0]);
    expect(new Set([auto.jobId, a.body.jobIds[0], b.body.jobIds[0]]).size).toBe(3);
    // La déduplication AUTOMATIQUE reste inchangée, et son motif est dit.
    const dup = await repo.enqueue({ treatment: 'T3', scope: { accountId: c.id }, payload: { kind: 'account', scope: 'incremental' } });
    expect(dup).toEqual({ decision: 'skip', jobId: auto.jobId, reasonCode: 'DUPLICATE_PENDING' });
    expect((await traces(c.id)).at(-1)).toMatchObject({ origin: 'automatic', decision: 'skip', reason_code: 'DUPLICATE_PENDING', job_id: auto.jobId });
  });

  it('T3-JOB-TC05 : contrôle de périmètre — job compte sans cible : autorisé ; référence étrangère : refus CROSS_ACCOUNT_SCOPE motivé (jamais un succès)', async () => {
    const { enqueueScopeAllowed } = await import('@/services/ai/queue/job-scope');
    const c = await make.account();
    await make.asset(c);
    expect(await enqueueScopeAllowed({ treatment: 'T3', scope: { accountId: c.id }, payload: { kind: 'account', scope: 'full', requestedByUserId: admin.id } })).toBe(true);
    const autre = await make.account();
    const bienAutre = await make.asset(autre);
    const r = await repo.enqueue({ treatment: 'T3', scope: { accountId: c.id, targetType: 'asset', targetId: bienAutre.id }, payload: { kind: 'asset' } });
    expect(r).toEqual({ decision: 'skip', jobId: null, reasonCode: 'CROSS_ACCOUNT_SCOPE' });
    expect((await traces(c.id)).at(-1)).toMatchObject({ decision: 'refused', reason_code: 'CROSS_ACCOUNT_SCOPE', job_id: null });
    // Lancement manuel dont TOUTES les demandes sont refusées : 422 NO_JOB_CREATED motivé.
    const { launchManual, defaultManualLaunchDeps, ManualLaunchRefused } = await import('@/services/ai/queue/manual-launch');
    const deps = await defaultManualLaunchDeps();
    const refus = await launchManual('T3', { accountIds: [c.id] }, admin.id, {}, {
      ...deps, enqueue: async () => ({ decision: 'skip', jobId: null, reasonCode: 'CROSS_ACCOUNT_SCOPE' }),
    }).catch((e) => e);
    expect(refus).toBeInstanceOf(ManualLaunchRefused);
    expect(refus).toMatchObject({ code: 'NO_JOB_CREATED', details: { reasons: { CROSS_ACCOUNT_SCOPE: 1 } } });
  });

  it('T3-JOB-TC06 : persistance — confirmPersisted([X]) = [X], ligne physique ; job perdu → refus PERSISTENCE_NOT_CONFIRMED ; relecture en panne → 5xx', async () => {
    const { launchManual, defaultManualLaunchDeps, ManualLaunchFailed } = await import('@/services/ai/queue/manual-launch');
    const deps = await defaultManualLaunchDeps();
    const c = await make.account();
    await make.asset(c);
    const r = await post({ accountIds: [c.id] });
    const x = r.body.jobIds[0];
    expect(await deps.confirmPersisted!([x])).toEqual([x]);
    expect(await ligne(x)).toHaveLength(1);
    // Identifiant annoncé mais absent : jamais un succès.
    const perdu = await launchManual('T3', { accountIds: [c.id] }, admin.id, {}, { ...deps, confirmPersisted: async () => [] }).catch((e) => e);
    expect(perdu).toMatchObject({ code: 'NO_JOB_CREATED', details: { reasons: { PERSISTENCE_NOT_CONFIRMED: 1 } } });
    expect((await traces(c.id)).at(-1)).toMatchObject({ decision: 'error', reason_code: 'PERSISTENCE_NOT_CONFIRMED', persisted: false });
    const panne = await launchManual('T3', { accountIds: [c.id] }, admin.id, {}, {
      ...deps, confirmPersisted: async () => { throw new Error('connexion perdue'); },
    }).catch((e) => e);
    expect(panne).toBeInstanceOf(ManualLaunchFailed);
    expect(panne).toMatchObject({ code: 'PERSISTENCE_NOT_CONFIRMED', details: { stage: 'confirmPersisted' } });
    // Écriture refusée par la base (ex. contrainte) : 5xx exploitable par la route.
    const ecriture = await launchManual('T3', { accountIds: [c.id] }, admin.id, {}, {
      ...deps, enqueue: async () => { throw Object.assign(new Error('new row violates check constraint "ai_job_queue_origin_check"'), { code: '23514' }); },
    }).catch((e) => e);
    expect(ecriture).toMatchObject({ code: 'INSERT_FAILED', details: { stage: 'enqueue', createdJobIds: [] } });
    expect(ecriture.message).toMatch(/ai_job_queue_origin_check/);
    expect((await traces(c.id)).at(-1)).toMatchObject({ decision: 'error', reason_code: 'INSERT_FAILED' });
  });

  it('T3-JOB-TC07 : planification horaire échue → racine T3 schedule_hourly (compte et cible nuls, origin automatic, payload.kind sweep), tracée', async () => {
    await rendreEchu();
    const issues = await triggers.evaluateDueSchedules();
    const t3 = issues.find((o) => o.treatment === 'T3')!;
    expect(t3).toMatchObject({ triggerCode: 'schedule_hourly', due: true, decision: 'create', reasonCode: null });
    const [racine] = await sql<Array<Record<string, any>>>`SELECT * FROM ai_job_queue WHERE id = ${t3.jobId}`;
    expect(racine).toMatchObject({ treatment: 'T3', account_id: null, target_type: null, origin: 'automatic', trigger_code: 'schedule_hourly', status: 'PENDING' });
    expect(racine.payload.kind).toBe('sweep');
    const [ev] = await sql<Ev[]>`SELECT * FROM ai_t3_enqueue_events WHERE job_id = ${t3.jobId} ORDER BY id DESC LIMIT 1`;
    expect(ev).toMatchObject({ origin: 'automatic', trigger_code: 'schedule_hourly', decision: 'create', persisted: true });
    // Échue mais absorbée par la racine vivante : plus JAMAIS annoncée « mise en file ».
    await sql`UPDATE ai_job_queue SET created_at = created_at - interval '2 hours' WHERE id = ${t3.jobId}`;
    const absorbee = (await triggers.evaluateDueSchedules()).find((o) => o.treatment === 'T3')!;
    expect(absorbee).toMatchObject({ due: true, decision: 'skip', reasonCode: 'DUPLICATE_PENDING', jobId: t3.jobId });
    expect(await triggers.runDueSchedules()).not.toContainEqual({ treatment: 'T3', triggerCode: 'schedule_hourly' });
  });

  it('T3-JOB-TC08 : planification non échue → aucun nouveau job, motif SCHEDULE_NOT_DUE', async () => {
    await rendreEchu();
    await triggers.runDueSchedules();
    const [{ n: avant }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T3'`;
    const t3 = (await triggers.evaluateDueSchedules()).find((o) => o.treatment === 'T3')!;
    expect(t3).toMatchObject({ due: false, decision: 'none', reasonCode: 'SCHEDULE_NOT_DUE', jobId: null });
    expect(new Date(t3.nextDueAt!).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    const [{ n: apres }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T3'`;
    expect(apres).toBe(avant);
  });

  it('T3-JOB-TC09 : déclencheur désactivé → aucun job, motif TRIGGER_DISABLED, signalé par la supervision', async () => {
    await rendreEchu();
    triggers.__setTriggerConfigLoader(async () => ({ triggers: [{ code: 'schedule_hourly', active: false }, { code: 'source_analyzed', active: true }] as never }));
    try {
      const [{ n: avant }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T3'`;
      const t3 = (await triggers.evaluateDueSchedules()).find((o) => o.treatment === 'T3')!;
      expect(t3).toMatchObject({ triggerCode: null, due: false, reasonCode: 'TRIGGER_DISABLED', jobId: null });
      const [{ n: apres }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T3'`;
      expect(apres).toBe(avant);
      const { diagnoseT3Creation } = await import('@/services/ai/queue/supervision');
      const f = diagnoseT3Creation({
        now: new Date(), emergencyStop: false, migrations: { heartbeats0338: true, enqueueTrace0370: true },
        workers: { state: 'OK', liveInstances: 1 }, scheduleTriggerCode: null, scheduleNextDueAt: null, scheduleEvaluation: null,
        lastManualRequest: null, liveCommits: ['abc1234'], servingCommit: 'abc1234',
      });
      expect(f.map((x) => x.code)).toContain('SCHEDULE_DISABLED');
    } finally {
      triggers.__setTriggerConfigLoader(async () => null);
    }
  });

  it('T3-JOB-TC10 : visibilité BO — le jobId rendu est trouvé par la File IA (recherche par n°, quels que soient les filtres) et la supervision montre la demande', async () => {
    const c = await make.account();
    await make.asset(c);
    const r = await post({ accountIds: [c.id] });
    const id = r.body.jobIds[0];
    const res = await jobsRoute.GET(new NextRequest(`http://app.test/api/admin/ai/queue/jobs?ids=${id}&status=FAILED&treatment=T1`));
    const body = await res.json() as { jobs: Array<Record<string, unknown>> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ id, treatment: 'T3', origin: 'manual', status: 'PENDING', phase: 'CREATED_NOT_STARTED' });
    // Liste par défaut : plus récents d'abord — le job est en tête des T3.
    const liste = await (await jobsRoute.GET(new NextRequest('http://app.test/api/admin/ai/queue/jobs?treatment=T3'))).json() as { jobs: Array<{ id: number }> };
    expect(liste.jobs[0].id).toBe(id);
    const sup = await (await supRoute.GET(new NextRequest('http://app.test/api/admin/ai/queue/supervision'))).json() as Record<string, any>;
    expect(sup.migrations).toEqual({ heartbeats0338: true, enqueueTrace0370: true });
    expect(sup.lastManual).toMatchObject({ id, accountId: c.id });
    expect(sup.requests[0]).toMatchObject({ origin: 'manual', accountId: c.id, decision: 'create', jobId: id, persisted: true });
    expect(Array.isArray(sup.creation)).toBe(true);
    expect(sup.build).toHaveProperty('commit');
  });

  it('T3-JOB — arrêt d’urgence : 409 explicite et tracé ; T1 inchangé (aucune trace T3)', async () => {
    const c = await make.account();
    await make.asset(c);
    await repo.setEmergencyStop(true, admin.id, 'e2e 54A');
    try {
      const r = await post({ accountIds: [c.id] });
      expect(r).toMatchObject({ status: 409, body: { error: 'EMERGENCY_STOP' } });
      expect(await sql`SELECT 1 FROM ai_t3_enqueue_events WHERE reason_code = 'EMERGENCY_STOP'`).not.toHaveLength(0);
    } finally {
      await repo.setEmergencyStop(false, admin.id);
    }
    const f = await make.assetFile(c);
    const t1 = await repo.enqueue({ treatment: 'T1', scope: { accountId: c.id, targetType: 'asset_file', targetId: f.id }, payload: { fileId: f.id } });
    expect(t1).toMatchObject({ decision: 'create', reasonCode: null });
    expect(await sql`SELECT 1 FROM ai_t3_enqueue_events WHERE job_id = ${t1.jobId}`).toHaveLength(0);
  });
});
