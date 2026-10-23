/**
 * Lot 81B — ticket « [P1] T6 — Corriger les écarts résiduels du lot 78C » —
 * logique pure et orchestration (base simulée). Les états persistés sur
 * PostgreSQL réel (plafond, indisponibilité, tentatives épuisées, bail et
 * concurrence à deux connexions, supervision paginée, tâche inactive,
 * rapports) sont vérifiés par `src/test/e2e/scenarios/l81b-t6-residuels-78c.e2e.ts`.
 *
 *  L81B-U-A  plafond de formulation : processClaim exécute le cycle EVALUATE
 *  L81B-U-B  T6 indisponible à l'exécution : état explicite, rapport tracé
 *  L81B-U-C  épuisement de la demande : SQL du balayage (borné, explicite)
 *  L81B-U-D  bail : renouvellement, perte de propriété, décision non écrite
 *  L81B-U-E  supervision : diagnostic (épuisement, tâche inactive), empreintes
 *  L81B-U-F  tâche de supervision distincte, couverte par le chien de garde
 *  L81B-U-G  statut des rapports : validation + persistance + clôture
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
type Tx = { unsafe: (s: string, p?: unknown[]) => Promise<unknown[]> };
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p), begin: (f: (tx: Tx) => Promise<unknown>) => f({ unsafe: (s, p) => unsafe(s, p) }) } }));
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: null, configVersionId: 3, masterPromptVersionId: null, primaryModel: 'm' }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));
const writeReport = vi.fn(async (..._a: unknown[]) => 1);
vi.mock('@/services/ai/execution-report/repository', () => ({
  executionReportsReady: async () => true,
  writeExecutionReport: (...a: unknown[]) => writeReport(...a),
}));

const W = await import('../t6-evaluation-runs');
const S = await import('../t6-interpellation.service');
const R = await import('../t6-runner');
const Q = await import('../pregen-queue');

type Dec = import('../t6-contract').T6EvaluateOutput['decisions'][number];
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const agir = (subjectId = 'C1'): Dec => ({
  subjectId, decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON',
  reason: 'Une démarche est à engager avant la date limite.', expectedAction: 'Prendre rendez-vous', actionDeadline: null,
  suggestedReviewAt: null, priorityHint: 'MEDIUM', evidenceRefs: [`${subjectId}.dueDate`], uncertainties: [],
});
const candidat = (subjectId: string): import('../t6-contract').T6EvaluationCandidate => ({
  subjectId, title: 'Entretien chaudière', description: null, assetName: 'Maison', assetCategory: 'LOGEMENT',
  dueDate: '2026-11-08', dateLabel: '8 novembre 2026', daysUntilDue: 18, dateNature: 'confirmée', dateRole: 'DEADLINE',
  overdue: false, requiresQualification: false, recurring: false, documents: [], recentlyShownDays: 0,
  evidence: [{ ref: `${subjectId}.title`, kind: 'TITLE' }, { ref: `${subjectId}.dueDate`, kind: 'DUE_DATE' }],
});
const lot = (n: number, persist: import('../t6-interpellation').T6InterpellationBundle['persist']) => {
  const ids = Array.from({ length: n }, (_, k) => `C${k + 1}`);
  return {
    context: { schemaVersion: 't6-evaluation-input-v1' as const, today: '2026-10-21', thresholdDays: 60, candidates: ids.map(candidat) },
    refs: new Map(ids.map((s, k) => [s, { subjectKey: `agenda:${k + 1}`, agendaItemId: k + 1, fingerprint: `v4:fp${k + 1}`, daysUntilDue: 18 }])),
    persist, evaluationSignature: 'e2:sig',
  };
};
const reponse = (decisions: unknown[], latence = 0) => new Promise((r) => setTimeout(() => r({
  data: { schemaVersion: 't6-evaluation-v1', decisions }, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 'trace-1',
}), latence));

function magasin(o: { finishThrows?: boolean; renewLoses?: boolean; finishPartial?: boolean } = {}) {
  const renouvellements: unknown[] = [];
  const indisponibles: unknown[] = [];
  const store: import('../t6-runner').T6RunStore = {
    ready: async () => true,
    claim: async (p) => ({ ok: true, runId: p.runId, attempts: new Map(p.subjects.map((s) => [s.agendaItemId, 1])), interrupted: [] }),
    finish: async (p) => {
      if (o.finishThrows) throw new Error('clôture refusée');
      return p.results.slice(0, o.finishPartial ? 0 : undefined).map((r) => ({
        agendaItemId: r.agendaItemId, status: r.outcome === 'COMPLETED' ? 'COMPLETED' : 'RETRY_WAIT', attempts: 1, nextAttemptAt: null, errorKind: r.errorKind ?? null,
      }));
    },
    renew: async (p) => { renouvellements.push(p); return o.renewLoses ? [] : [...p.ids]; },
    markUnavailable: async (_a, s) => { indisponibles.push(s); return s.map((x) => x.agendaItemId); },
    leaseMs: 1_000, renewEveryMs: 60,
  };
  return { store, renouvellements, indisponibles };
}
const evalDeps = (execute: (r: unknown) => unknown, runs?: import('../t6-runner').T6RunStore, report?: (o: unknown) => void, available = true) => ({
  available: async () => available, promptVersion: async () => 't6_master_v1@file|cfg:3', execute: execute as never, runs, report,
});

beforeEach(() => {
  unsafe.mockReset(); unsafe.mockResolvedValue([]); writeReport.mockClear();
  R.resetT6EvaluationState(); R.resetT6Breaker(); W.resetT6RunsProbe(); Q.resetPregenColumnsProbe();
});

describe('L81B-U-A — plafond de formulation distinct du cycle EVALUATE', () => {
  it('L81B-U-A1 — le plafond ne clôt plus la demande avant les évaluations (source)', () => {
    const src = lire('src/services/home/mascot/pregen-queue.ts');
    const corps = src.slice(src.indexOf('async function processClaim'), src.indexOf('export async function processMascotPregenerationFor'));
    // Plus de clôture « capped » avant la présentation (et donc avant l'évaluation).
    expect(corps.indexOf("close(c, 'capped'")).toBe(-1);
    expect(corps).toMatch(/formulate: !plafond/);
    expect(corps.indexOf('pregenEvaluationDecision')).toBeLessThan(corps.indexOf("plafond ? 'capped'"));
  });
});

describe('L81B-U-B — T6 indisponible : état explicite et trace', () => {
  it('L81B-U-B1 — devenu indisponible avant l’exécution : évaluations marquées UNAVAILABLE, rapport, aucun appel', async () => {
    const m = magasin();
    const execute = vi.fn();
    const report = vi.fn();
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(2, async () => 1), mode: 'pregen' }, evalDeps(execute, m.store, report, false));
    expect(execute).not.toHaveBeenCalled();
    expect(m.indisponibles).toHaveLength(1);
    expect(o).toMatchObject({ status: 'disabled', run: { claimed: false, refusal: { reason: 't6_unavailable' }, unavailable: [1, 2] } });
    expect(report).toHaveBeenCalledTimes(1);
    expect(S.t6EvaluationReportStatus(S.t6EvaluationTraceOf(o))).toBe('FAILED');
  });
  it('L81B-U-B2 — SQL : jamais une exécution vivante, une décision ou un échec définitif du même contexte ; tentatives conservées', async () => {
    await W.markT6RunsUnavailable(7, [{ agendaItemId: 1, fingerprint: 'v4:a', signature: 'e2:a' }]);
    const sql = String(unsafe.mock.calls[0][0]);
    expect(sql).toMatch(/WHERE NOT \(t6_evaluation_runs\.status = 'RUNNING' AND t6_evaluation_runs\.lease_until > now\(\)\)/);
    expect(sql).toMatch(/t6_evaluation_runs\.status IN \('PENDING', 'RETRY_WAIT', 'RUNNING'\)/);
    expect(sql).toMatch(/attempts = CASE WHEN [\s\S]* THEN t6_evaluation_runs\.attempts ELSE 0 END/);
    expect(unsafe.mock.calls[0][1]).toEqual([7, [1], ['v4:a'], ['e2:a'], W.T6_RUN_UNAVAILABLE_RECHECK_S, 't6_unavailable', expect.any(String)]);
    // Rétablissement : la demande libère d'abord les indisponibilités (tentatives conservées).
    unsafe.mockClear();
    await W.requestT6Runs(7, [{ agendaItemId: 1, fingerprint: 'v4:a', signature: 'e2:a' }]);
    expect(String(unsafe.mock.calls[0][0])).toMatch(/status = 'UNAVAILABLE' AND last_error_kind = 't6_unavailable'/);
    expect(String(unsafe.mock.calls[0][0])).toMatch(/WHEN attempts > 0 THEN 'RETRY_WAIT' ELSE 'PENDING'/);
  });
});

describe('L81B-U-C — épuisement des tentatives de la demande', () => {
  it('L81B-U-C1 — balayage : état explicite, reprise bornée, évaluations PENDING marquées', async () => {
    unsafe.mockImplementation(async (s: string) => {
      if (/information_schema\.columns/.test(s)) return [{ n: 2 }];
      if (/to_regclass\('t6_evaluation_runs'\)/.test(s)) return [{ ok: true }];
      if (/UPDATE home_mascot_pregen_requests r SET/.test(s)) return [{ account_id: 9, exhausted_count: 1, requested_at: '2026-10-21T16:00:00Z', final: false }];
      if (/UPDATE t6_evaluation_runs SET\s+status = 'UNAVAILABLE', last_error_kind = 'pregen_exhausted'/.test(s)) return [{ agenda_item_id: 4 }];
      return [];
    });
    const r = await Q.sweepExhaustedPregenRequests();
    expect(r).toEqual([{ accountId: 9, exhaustedCount: 1, final: false, retryAt: '2026-10-21T16:00:00.000Z', runsMarked: 1 }]);
    const balayage = unsafe.mock.calls.find((c) => /UPDATE home_mascot_pregen_requests r SET/.test(String(c[0])))!;
    expect(String(balayage[0])).toMatch(/last_status = 'attempts_exhausted'/);
    expect(String(balayage[0])).toMatch(/attempts >= 3/);
    expect(String(balayage[0])).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(balayage[1]).toEqual([200, Q.PREGEN_EXHAUSTED_REARM_MS, Q.PREGEN_EXHAUSTED_MAX_REARMS, null]);
    const marque = unsafe.mock.calls.find((c) => /pregen_exhausted/.test(String(c[0])) && /UPDATE t6_evaluation_runs/.test(String(c[0])))!;
    expect(String(marque[0])).toMatch(/status = 'PENDING' OR \(status = 'RUNNING' AND lease_until <= now\(\)\)/);
    expect(marque[1]).toEqual([9, '2026-10-21T16:00:00.000Z']);
  });
  it('L81B-U-C2 — colonnes 0629 absentes (fenêtre de déploiement) : aucun balayage, demande enregistrée comme au lot 78C', async () => {
    expect(await Q.sweepExhaustedPregenRequests()).toEqual([]);
    await Q.requestMascotPregeneration(7, 'x');
    const ins = unsafe.mock.calls.find((c) => /INSERT INTO home_mascot_pregen_requests/.test(String(c[0])))!;
    expect(String(ins[0])).not.toMatch(/exhausted_count/);
  });
});

describe('L81B-U-D — bail renouvelé, propriété vérifiée à l’écriture', () => {
  it('L81B-U-D1 — exécution longue : bail renouvelé, décision écrite sous contrôle de propriété', async () => {
    const m = magasin();
    const metas: unknown[] = [];
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async (_l, meta) => { metas.push(meta); return { persisted: 1, persistedSubjectIds: ['C1'] }; }), mode: 'pregen' },
      evalDeps(() => reponse([agir('C1')], 300), m.store));
    expect(o.status).toBe('generated');
    expect(m.renouvellements.length).toBeGreaterThanOrEqual(2);
    expect(metas[0]).toMatchObject({ run: { runId: o.run!.runId, leaseMs: 1_000 } });
    expect(o.run).toMatchObject({ ownershipLost: [], notClosed: [], closeError: null });
    expect(S.t6EvaluationReportStatus(S.t6EvaluationTraceOf(o))).toBe('SUCCESS');
  });
  it('L81B-U-D2 — propriété perdue : décision NON écrite (ownership_lost), clôture sans effet, jamais SUCCESS', async () => {
    const m = magasin({ renewLoses: true, finishPartial: true });
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async () => ({ persisted: 0, persistedSubjectIds: [], lostSubjectIds: ['C1'] })), mode: 'pregen' },
      evalDeps(() => reponse([agir('C1')], 200), m.store));
    expect(o.status).toBe('persist_failed');
    expect(o.notPersisted).toEqual([{ subjectId: 'C1', reason: 'ownership_lost' }]);
    expect(o.run).toMatchObject({ ownershipLost: [1], notClosed: [1] });
    expect(R.t6RunResultsOf(o, lot(1, async () => 1).refs)).toEqual([expect.objectContaining({ agendaItemId: 1, outcome: 'RETRY', errorKind: 'ownership_lost' })]);
    expect(S.t6EvaluationReportStatus(S.t6EvaluationTraceOf(o))).toBe('FAILED');
  });
  it('L81B-U-D3 — SQL : contrôle sous le verrou du compte, lignes détenues verrouillées et bail prolongé', async () => {
    const sqls: string[] = [];
    unsafe.mockImplementation(async (s: string) => { sqls.push(s); return /RETURNING agenda_item_id/.test(s) ? [{ agenda_item_id: 1 }] : []; });
    const tq = async (s: string, p: unknown[]) => (await unsafe(s, p)) as Array<Record<string, unknown>>;
    expect([...await W.lockOwnedT6Runs(tq, { accountId: 7, runId: 'r', ids: [1, 2] })]).toEqual([1]);
    expect(sqls[0]).toMatch(/pg_advisory_xact_lock/);
    expect(sqls[1]).toMatch(/run_id = \$2 AND status = 'RUNNING'/);
    expect(sqls[1]).toMatch(/ORDER BY agenda_item_id FOR UPDATE/);
    // Persistance : seules les décisions détenues sont écrites, dans la même transaction.
    expect(lire('src/services/home/mascot/t6-interpellation.service.ts')).toMatch(/if \(detenues && !detenues\.has\(c\.agendaItemId\)\) \{ perdues\.push\(d\.subjectId\); continue; \}/);
  });
});

describe('L81B-U-E — supervision', () => {
  const a = (o: Partial<import('../t6-evaluation-runs').T6SupervisionAccount>) => ({ accountId: 7, failed: 0, stalePending: 0, staleRunning: 0, overdueRetry: 0, oldestSince: null, kinds: {}, ...o });
  it('L81B-U-E1 — épuisement de la pré-génération et tâche inactive distingués', () => {
    expect(W.t6BlockedDiagnosis(a({ pregenExhausted: true, incomplete: 2, kinds: { pregen_exhausted: 2 } }), true)).toMatchObject({
      causes: ['pregen_exhausted'], summary: 'pré-génération aux tentatives épuisées (2 évaluation(s) incomplète(s))',
    });
    expect(W.t6BlockedDiagnosis(a({ pregenExhausted: true }), false).causes).toEqual(['pregen_exhausted', 'scheduler_inactive']);
  });
  it('L81B-U-E2 — empreinte d’anomalie → compte ; l’anomalie globale n’est jamais prise pour un compte', () => {
    expect(W.accountOfT6Anomaly(W.t6EvaluationAnomalyFingerprint(1234))).toBe(1234);
    expect(W.accountOfT6Anomaly(W.T6_PREGEN_SCHEDULER_ANOMALY)).toBeNull();
    expect(W.T6_PREGEN_SCHEDULER_ANOMALY.startsWith(W.T6_EVALUATION_ANOMALY_PREFIX)).toBe(false);
  });
  it('L81B-U-E4 — anomalie « tâche inactive » : lien BO vers les tâches planifiées', async () => {
    const { diagnosticLinkFor } = await import('@/services/admin/anomaly.service');
    expect(diagnosticLinkFor('ai', { kind: 't6_pregen_scheduler' })).toEqual({ href: '/admin/exploitation?tab=taches', label: 'Ouvrir les tâches planifiées' });
  });
  it('L81B-U-E3 — SQL : filtre du compte et pagination DANS la requête, causes comptées sur les seules bloquées', async () => {
    await W.blockedT6Accounts(30, { limit: 50, afterAccountId: 200, onlyAccountId: 9 });
    const [s, p] = unsafe.mock.calls[0];
    expect(String(s)).toMatch(/\(\$3::int IS NULL OR account_id = \$3::int\) AND account_id > \$4::int/);
    expect(String(s)).toMatch(/WHERE bloquee OR epuisee GROUP BY account_id, kind/);
    expect(String(s)).toMatch(/ORDER BY y\.account_id\s+LIMIT \$2/);
    expect(p).toEqual([30, 50, 9, 200]);
  });
});

describe('L81B-U-F — supervision indépendante de la tâche surveillée', () => {
  it('L81B-U-F1 — mascot-pregeneration ne porte plus la supervision ; tâche distincte et critique', async () => {
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    expect(findTask('mascot-pregeneration')!.run.toString()).not.toMatch(/superviseT6Evaluations/);
    expect(findTask('mascot-t6-supervision')).toMatchObject({ schedule: { kind: 'interval', everyMs: 5 * 60_000 }, critical: { staleAfterMs: 30 * 60_000 } });
  });
  it('L81B-U-F2 — le chien de garde existant détecte l’arrêt de la tâche de supervision', async () => {
    const { checkStaleCriticalTasks } = await import('@/services/scheduling/scheduled-task-runner');
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const report = vi.fn(async () => undefined);
    const vieux = new Date('2026-10-21T10:00:00Z');
    const stale = await checkStaleCriticalTasks({
      store: { list: async () => [{ code: 'mascot-t6-supervision', lastSuccessAt: vieux, createdAt: vieux }] } as never,
      tasks: SCHEDULED_TASKS.filter((t) => t.code === 'mascot-t6-supervision'), env: {},
      alerts: { report, resolve: async () => undefined, isOpen: async () => false }, owner: 'w',
      now: () => new Date('2026-10-21T11:00:00Z'), watchdogLock: async () => null, startedAt: new Date(0),
    });
    expect(stale).toEqual(['mascot-t6-supervision']);
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('L81B-U-F3 — état de la tâche lu dans le planificateur : arrêtée par variable = inactive ; illisible = inconnu', async () => {
    unsafe.mockImplementation(async () => [{ admin_disabled: false, recent: true, last_finished_at: null, last_success_at: null }]);
    expect((await W.pregenSchedulerState(10, {})).state).toBe('active');
    expect((await W.pregenSchedulerState(10, { SCHEDULED_TASK_MASCOT_PREGENERATION: 'off' })).state).toBe('inactive');
    unsafe.mockImplementation(async () => [{ admin_disabled: true, recent: true }]);
    expect((await W.pregenSchedulerState(10, {})).state).toBe('inactive');
    unsafe.mockImplementation(async () => []);
    expect((await W.pregenSchedulerState(10, {})).state).toBe('inactive'); // jamais exécutée
    unsafe.mockImplementation(async () => { throw new Error('base'); });
    expect((await W.pregenSchedulerState(10, {})).state).toBe('unknown');
    expect(await W.pregenSchedulerActive()).toBe(true); // jamais d'accusation sans preuve
  });
});

describe('L81B-U-G — statut des rapports sur le cycle complet', () => {
  it('L81B-U-G1 — persistance réussie mais clôture technique en échec : PARTIAL, étape run_state en échec', async () => {
    const m = magasin({ finishThrows: true });
    const b = lot(1, async () => ({ persisted: 1, persistedSubjectIds: ['C1'] }));
    const o = await R.evaluateWithT6({ accountId: 7, bundle: b, mode: 'pregen' }, evalDeps(() => reponse([agir('C1')]), m.store));
    expect(o.status).toBe('generated');
    expect(o.run).toMatchObject({ finished: null, closeError: 'clôture refusée' });
    const t = S.t6EvaluationTraceOf(o);
    expect(S.t6RunClosed(t)).toBe(false);
    expect(S.t6EvaluationReportStatus(t)).toBe('PARTIAL');
    await S.writeT6EvaluationReport({ accountId: 7, mode: 'pregen', bundle: b, trace: t, pregenState: async () => null });
    const [rapport] = writeReport.mock.calls.at(-1) as [Record<string, unknown>];
    expect(rapport).toMatchObject({ status: 'PARTIAL', counters: { persisted: 1, runNotClosed: 1 } });
    expect((rapport.steps as Array<{ step: string; status: string; error: string }>).find((s) => s.step === 'run_state'))
      .toMatchObject({ status: 'FAILED', error: expect.stringContaining('clôture refusée') });
  });
  it('L81B-U-G2 — refus de prise : NO_CHANGE (motif) ; prise impossible : FAILED ; succès complet : SUCCESS', () => {
    const base = { promptVersion: 'v', inputContract: 'i', outputContract: 'o', traceId: null, error: null, accepted: [], rejected: [], persisted: 0 };
    expect(S.t6EvaluationReportStatus({ ...base, status: 'skipped', run: { runId: null, claimed: false, refusal: { reason: 'running_elsewhere', waitingUntil: null, agendaItemId: 1 } } })).toBe('NO_CHANGE');
    expect(S.t6EvaluationReportStatus({ ...base, status: 'skipped', run: { runId: null, claimed: false, refusal: { reason: 'claim_failed', waitingUntil: null, agendaItemId: 0 } } })).toBe('FAILED');
    const ok = { ...base, status: 'generated', accepted: [{ subjectId: 'C1', decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'X', priorityHint: null, evidenceRefs: [] }], persisted: 1, persistedSubjectIds: ['C1'] };
    expect(S.t6EvaluationReportStatus({ ...ok, run: { runId: 'r', claimed: true, finished: [{ agendaItemId: 1, status: 'COMPLETED', attempts: 1, nextAttemptAt: null, errorKind: null }], notClosed: [] } })).toBe('SUCCESS');
    expect(S.t6EvaluationReportStatus({ ...ok, run: { runId: 'r', claimed: true, finished: [], notClosed: [1] } })).toBe('PARTIAL');
  });
});
