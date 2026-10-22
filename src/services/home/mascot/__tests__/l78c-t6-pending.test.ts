/**
 * Lot 78C — ticket « [P1] T6 — Corriger les évaluations bloquées en PENDING
 * et fiabiliser leur exécution » + retour PO « mascotte au travail » et date
 * de l'accueil — logique pure et orchestration (base simulée). Les états
 * persistés sur PostgreSQL réel sont vérifiés par
 * `src/test/e2e/scenarios/l78c-t6-pending.e2e.ts` ; le rendu navigateur
 * (desktop / mobile, mouvement réduit, date) par
 * `src/components/home/__tests__/l78c-mascotte-travail-navigateur.test.ts`.
 *
 *  L78C-A  états réels : PENDING / RUNNING / RETRY_WAIT / FAILED / COMPLETED /
 *          UNAVAILABLE, interruption (bail expiré), attente anormale
 *  L78C-B  état affiché d'après l'état réel (jamais une attente fictive)
 *  L78C-C  préparation : demande durable, seules les évaluations prenables
 *          transmises, motif explicite des autres ; repli lot 77
 *  L78C-D  exécution : prise durable, clôture échéance par échéance, refus de
 *          prise, échec d'écriture de l'état
 *  L78C-E  pré-génération : jamais close sur une analyse incomplète, reportée
 *  L78C-F  actualisation ciblée et bornée de l'accueil
 *  L78C-G  reporting evaluate:display / evaluate:pregen et rapport T6
 *  L78C-H  supervision : causes distinguées
 *  L78C-M  mascotte « au travail » (pose, animation, mouvement réduit)
 *  L78C-D8 date et salutation : renouvelées à minuit et à 18:00
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
const M = await import('../mascot.service');
const B = await import('../bubble');
const H = await import('@/components/home/useMascotPresentation');
const G = await import('@/components/home/useGreetingClock');
const MM = await import('@/lib/verebona/mascot-motion');
const { buildCandidates } = await import('../signals');
const { selectSubjects, buildSecondaries } = await import('../selector');
const { buildPresentation } = await import('../presentation');

type Row = import('../signals').MascotAgendaRow;
type Raw = import('../signals').MascotRawData;
type RunRow = import('../t6-evaluation-runs').T6RunRow;
type Dec = import('../t6-contract').T6EvaluateOutput['decisions'][number];

const TODAY = '2026-10-21';
const NOW = new Date('2026-10-21T14:24:00Z');
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const min = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString();

const runRow = (o: Partial<RunRow> = {}): RunRow => ({
  agendaItemId: 1, accountId: 7, status: 'PENDING', fingerprint: 'v4:a', signature: 'e2:a', attempts: 0, runId: null, mode: null,
  requestedAt: min(-1), startedAt: null, finishedAt: null, leaseUntil: null, nextAttemptAt: null, lastErrorKind: null, lastError: null,
  lastOutcome: null, traceId: null, interruptedCount: 0, sameContextRuns: 0, ...o,
});
const eff = (o: Partial<RunRow> | null) => W.effectiveRunState(o ? runRow(o) : null, NOW, { alertMinutes: 30 });

const ligne = (id: number, date: string, o: Partial<Row> = {}): Row => ({
  id, title: `Échéance ${id}`, date, forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', ...o,
});
const raw = (agenda: Row[], o: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 1 },
  toProcess: [], toProcessTotal: 0, agenda, acknowledgments: [], toProcessAgendaIds: [], toProcessSettledAgendaIds: [], overdueAgenda: [],
  ...o,
});
const vide = (): import('../t6-interpellation.service').T6ItemEvidence => ({ description: null, endDate: null, originFieldKey: null, documents: [], facts: [] });
const loaders = { assessments: async () => new Map(), evidence: async (_a: number, ids: number[]) => new Map(ids.map((i) => [i, vide()])), dueReminders: async () => new Map<number, string>() };

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
    context: { schemaVersion: 't6-evaluation-input-v1' as const, today: TODAY, thresholdDays: 60, candidates: ids.map(candidat) },
    refs: new Map(ids.map((s, k) => [s, { subjectKey: `agenda:${k + 1}`, agendaItemId: k + 1, fingerprint: `v4:fp${k + 1}`, daysUntilDue: 18 }])),
    persist, evaluationSignature: 'e2:sig',
  };
};
const reponse = (decisions: unknown[]) => ({ data: { schemaVersion: 't6-evaluation-v1', decisions }, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 'trace-1' });

/** Magasin d'exécutions simulé (deux « instances » partagent la même base). */
function magasin(o: { refuse?: boolean; claimThrows?: boolean; finishThrows?: boolean } = {}) {
  const claims: unknown[] = [];
  const finishes: Array<{ results: readonly import('../t6-evaluation-runs').T6RunResult[] }> = [];
  const store: import('../t6-runner').T6RunStore = {
    ready: async () => true,
    claim: async (p) => {
      claims.push(p);
      if (o.claimThrows) throw new Error('base indisponible');
      if (o.refuse) return { ok: false, reason: 'running_elsewhere', waitingUntil: min(4), agendaItemId: 1 };
      return { ok: true, runId: p.runId, attempts: new Map(p.subjects.map((s) => [s.agendaItemId, 1])), interrupted: [] };
    },
    finish: async (p) => {
      finishes.push(p);
      if (o.finishThrows) throw new Error('écriture de l’état impossible');
      return p.results.map((r) => ({
        agendaItemId: r.agendaItemId, status: r.outcome === 'COMPLETED' ? 'COMPLETED' : r.outcome === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'RETRY_WAIT',
        attempts: 1, nextAttemptAt: r.outcome === 'COMPLETED' ? null : min(10), errorKind: r.errorKind ?? null,
      }));
    },
  };
  return { store, claims, finishes };
}
const evalDeps = (execute: (r: unknown) => unknown, runs?: import('../t6-runner').T6RunStore, report?: (o: unknown) => void) => ({
  available: async () => true, promptVersion: async () => 't6_master_v1@file|cfg:3', execute: execute as never, runs, report,
});

beforeEach(() => {
  unsafe.mockReset(); unsafe.mockResolvedValue([]); writeReport.mockClear();
  R.resetT6EvaluationState(); R.resetT6Breaker(); W.resetT6RunsProbe();
});

// ── L78C-A ───────────────────────────────────────────────────────────────────

describe('L78C-A — états réels des évaluations', () => {
  it('L78C-A1 — jamais demandée : PENDING prenable, sans ancienneté', () => {
    expect(eff(null)).toMatchObject({ state: 'PENDING', claimable: true, stale: false, interrupted: false });
  });
  it('L78C-A2 — RUNNING au bail vivant : non prenable, fin attendue ; bail expiré : interrompue, reprise', () => {
    expect(eff({ status: 'RUNNING', startedAt: min(-1), leaseUntil: min(4) })).toMatchObject({ state: 'RUNNING', claimable: false, waitingUntil: min(4) });
    const i = eff({ status: 'RUNNING', startedAt: min(-10), leaseUntil: min(-5) });
    expect(i).toMatchObject({ state: 'PENDING', claimable: true, interrupted: true, lastErrorKind: 'interrupted', stale: false });
    expect(eff({ status: 'RUNNING', startedAt: min(-100), leaseUntil: min(-95) }).stale).toBe(true);
  });
  it('L78C-A3 — RETRY_WAIT / UNAVAILABLE : attendues jusqu’à l’essai planifié, puis prenables ; essai dû non exécuté = anomalie', () => {
    expect(eff({ status: 'RETRY_WAIT', attempts: 1, nextAttemptAt: min(10) })).toMatchObject({ state: 'RETRY_WAIT', claimable: false, waitingUntil: min(10) });
    expect(eff({ status: 'RETRY_WAIT', attempts: 1, nextAttemptAt: min(-1) })).toMatchObject({ claimable: true, stale: false });
    expect(eff({ status: 'RETRY_WAIT', attempts: 1, nextAttemptAt: min(-60) })).toMatchObject({ claimable: true, stale: true });
    expect(eff({ status: 'UNAVAILABLE', nextAttemptAt: min(360) })).toMatchObject({ state: 'UNAVAILABLE', claimable: false });
  });
  it('L78C-A4 — FAILED : jamais prenable sans reprise explicite, toujours signalée', () => {
    const f = eff({ status: 'FAILED', attempts: 3, finishedAt: min(-1) });
    expect(f).toMatchObject({ state: 'FAILED', claimable: false, stale: true });
    expect(W.displayGroupOf(f)).toBe('UNAVAILABLE');
  });
  it('L78C-A5 — COMPLETED de nouveau réclamée : bornée (anti-boucle), libre hors fenêtre', () => {
    expect(eff({ status: 'COMPLETED', finishedAt: min(-5), sameContextRuns: 1 }).claimable).toBe(true);
    const b = eff({ status: 'COMPLETED', finishedAt: min(-5), sameContextRuns: W.T6_RUN_SAME_CONTEXT_MAX });
    expect(b).toMatchObject({ claimable: false, stale: false });
    expect(eff({ status: 'COMPLETED', finishedAt: min(-60), sameContextRuns: 3 }).stale).toBe(true);
    expect(eff({ status: 'COMPLETED', finishedAt: min(-21 * 60), sameContextRuns: 3 }).claimable).toBe(true);
  });
  it('L78C-A6 — PENDING au-delà du délai d’alerte : jamais présentée comme en cours', () => {
    const p = eff({ status: 'PENDING', requestedAt: min(-45) });
    expect(p).toMatchObject({ claimable: true, stale: true });
    expect(W.displayGroupOf(p)).toBe('UNAVAILABLE');
    expect(W.displayGroupOf(eff({ status: 'PENDING', requestedAt: min(-2) }))).toBe('PENDING');
  });
  it('L78C-A7 — réglages bornés et délais de reprise croissants', () => {
    expect(W.t6RunMaxAttempts({})).toBe(3);
    expect(W.t6RunMaxAttempts({ MASCOT_T6_EVAL_MAX_ATTEMPTS: '50' })).toBe(10);
    expect(W.t6RunMaxAttempts({ MASCOT_T6_EVAL_MAX_ATTEMPTS: '0' })).toBe(3);
    expect(W.t6PendingAlertMinutes({})).toBe(30);
    expect(W.t6PendingAlertMinutes({ MASCOT_T6_PENDING_ALERT_MINUTES: '2' })).toBe(30);
    expect(W.t6PendingAlertMinutes({ MASCOT_T6_PENDING_ALERT_MINUTES: '99999' })).toBe(1440);
    expect([1, 2, 3, 4, 9].map(W.t6RetryDelaySeconds)).toEqual([600, 1800, 7200, 21600, 21600]);
  });
  it('L78C-A8 — migration 0616 : six états, idempotente, rétablissable', () => {
    const sql = lire('src/db/migrations/0616_l78c_t6_evaluation_runs.sql');
    expect(sql).toContain("CHECK (status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'FAILED', 'COMPLETED', 'UNAVAILABLE'))");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS t6_evaluation_runs/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    // Aucune instruction destructive (le retour arrière n'est que documenté en commentaire).
    expect(sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/ON DELETE CASCADE/g, '')).not.toMatch(/DROP|DELETE|TRUNCATE/i);
  });
});

// ── L78C-B ───────────────────────────────────────────────────────────────────

describe('L78C-B — état affiché d’après l’état réel', () => {
  const att = (id: number) => ({ agendaItemId: id, code: 'AI_ASSESSMENT_PENDING', thresholdApplied: false }) as never;
  it('L78C-B1 — en cours réel : PENDING ; échec, essai planifié, attente anormale : UNAVAILABLE', () => {
    expect(S.evaluationStateFromRuns([att(1)], new Map([[1, eff({ status: 'RUNNING', startedAt: min(-1), leaseUntil: min(4) })]]))).toBe('PENDING');
    expect(S.evaluationStateFromRuns([att(1)], new Map([[1, eff({ status: 'PENDING', requestedAt: min(-1) })]]))).toBe('PENDING');
    expect(S.evaluationStateFromRuns([att(1)], new Map([[1, eff({ status: 'RETRY_WAIT', nextAttemptAt: min(10) })]]))).toBe('UNAVAILABLE');
    expect(S.evaluationStateFromRuns([att(1)], new Map([[1, eff({ status: 'FAILED' })]]))).toBe('UNAVAILABLE');
    expect(S.evaluationStateFromRuns([att(1), att(2)], new Map([
      [1, eff({ status: 'PENDING', requestedAt: min(-1) })], [2, eff({ status: 'PENDING', requestedAt: min(-90) })],
    ]))).toBe('UNAVAILABLE');
    expect(S.evaluationStateFromRuns([{ agendaItemId: 1, code: 'EVALUATION_UNAVAILABLE', thresholdApplied: false } as never], new Map())).toBe('UNAVAILABLE');
    expect(S.evaluationStateFromRuns([{ agendaItemId: 1, code: 'AI_SHOW_NOW', thresholdApplied: false } as never], new Map())).toBe('OK');
  });
});

// ── L78C-C ───────────────────────────────────────────────────────────────────

describe('L78C-C — préparation : demande durable, transmission des seules évaluations prenables', () => {
  const lignes = [ligne(1, '2026-11-02'), ligne(2, '2026-11-03'), ligne(3, '2026-11-04')];
  it('L78C-C1 — chaque échéance éligible est DEMANDÉE ; en cours ailleurs / essai planifié non transmises, avec motif', async () => {
    const request = vi.fn(async () => 3);
    const runs: import('../t6-interpellation.service').T6RunLoaders = {
      ready: async () => true, request,
      load: async () => new Map([
        [1, runRow({ agendaItemId: 1, status: 'RUNNING', startedAt: min(-1), leaseUntil: min(4) })],
        [2, runRow({ agendaItemId: 2, status: 'RETRY_WAIT', attempts: 1, nextAttemptAt: min(10) })],
      ]),
    };
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw(lignes) }, {
      aiCapable: async () => true, thresholdDays: async () => 60, loaders, runs, now: () => NOW,
      evaluationConfig: async () => ({ signature: 'e2:sig', masterVersion: 'v', legacySignature: null, legacyBaseline: null }),
    });
    expect(request).toHaveBeenCalledTimes(1);
    const sujets = (request.mock.calls[0] as unknown as [number, Array<{ agendaItemId: number; fingerprint: string; signature: string }>])[1];
    expect(sujets.map((x) => x.agendaItemId)).toEqual([1, 2, 3]);
    expect(sujets.every((x) => x.fingerprint.startsWith('v4:') && x.signature === 'e2:sig')).toBe(true);
    expect([...p.bundle!.refs.values()].map((x) => x.agendaItemId)).toEqual([3]);
    expect(p.bundle!.evaluationSignature).toBe('e2:sig');
    expect(p.evaluationProgress).toMatchObject({ eligible: 3, claimable: 1, inBundle: 1, waiting: 2, failed: 0, waitingUntil: min(4) });
    expect(p.runStates!.get(1)!.state).toBe('RUNNING');
    expect(p.evaluation).toBe('UNAVAILABLE'); // l'une attend un nouvel essai après échec
    // Rapport T6 : état réel par échéance.
    const e = S.t6ReportEntries(p.decisions, 60, p.runStates).find((x) => x.entityId === 2)!;
    expect((e.value as Record<string, unknown>).evaluationRun).toMatchObject({ state: 'RETRY_WAIT', attempts: 1, nextAttemptAt: min(10) });
  });
  it('L78C-C2 — table non déployée ou illisible : comportement du lot 77, jamais une source « en panne »', async () => {
    for (const runs of [
      { ready: async () => false, request: vi.fn(), load: vi.fn() },
      { ready: async () => true, request: async () => { throw new Error('panne'); }, load: vi.fn() },
    ] as never[]) {
      const p = await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw(lignes) }, { aiCapable: async () => true, thresholdDays: async () => 60, loaders, runs });
      expect(p.runStates).toBeNull();
      expect(p.degraded).toBe(false);
      expect(p.bundle!.refs.size).toBe(3);
      expect(p.evaluation).toBe('PENDING');
    }
  });
});

// ── L78C-D ───────────────────────────────────────────────────────────────────

describe('L78C-D — exécution : prise durable et clôture échéance par échéance', () => {
  it('L78C-D1 — décision valide enregistrée : COMPLETED ; trace de l’exécution', async () => {
    const m = magasin();
    const execute = vi.fn(async () => reponse([agir('C1')]));
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async () => ({ persisted: 1, persistedSubjectIds: ['C1'] })), mode: 'pregen' }, evalDeps(execute, m.store));
    expect(o.status).toBe('generated');
    expect(m.claims[0]).toMatchObject({ accountId: 7, mode: 'pregen', subjects: [{ agendaItemId: 1, fingerprint: 'v4:fp1', signature: 'e2:sig' }] });
    expect(m.finishes[0].results).toEqual([{ agendaItemId: 1, outcome: 'COMPLETED', detail: 'SHOW_NOW/ACTION_REQUIRED_SOON' }]);
    expect(o.run).toMatchObject({ claimed: true, attempts: { 1: 1 }, finished: [{ agendaItemId: 1, status: 'COMPLETED' }] });
  });
  it('L78C-D2 — prise refusée (exécution vivante sur une autre instance) : aucun appel IA', async () => {
    const m = magasin({ refuse: true });
    const execute = vi.fn();
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async () => 1), mode: 'display' }, evalDeps(execute, m.store));
    expect(execute).not.toHaveBeenCalled();
    expect(o).toMatchObject({ status: 'skipped', run: { claimed: false, refusal: { reason: 'running_elsewhere' } } });
  });
  it('L78C-D3 — prise impossible (base) : aucune exécution non tracée', async () => {
    const execute = vi.fn();
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async () => 1), mode: 'pregen' }, evalDeps(execute, magasin({ claimThrows: true }).store));
    expect(execute).not.toHaveBeenCalled();
    expect(o.status).toBe('skipped');
  });
  it('L78C-D4 — après un échec, la reprise est décidée par l’état DURABLE (pas par la mémoire de l’instance)', async () => {
    const m = magasin();
    const execute = vi.fn(async () => { throw new Error('fournisseur indisponible'); });
    const b = lot(1, async () => 1);
    const o = await R.evaluateWithT6({ accountId: 7, bundle: b, mode: 'pregen' }, evalDeps(execute, m.store));
    expect(o.status).toBe('error');
    expect(m.finishes[0].results).toEqual([{ agendaItemId: 1, outcome: 'RETRY', errorKind: 'model_unavailable', error: 'fournisseur indisponible', detail: 'modèle indisponible' }]);
    // Même entrée : la base dit si l'essai est dû (ici le magasin l'accepte) — plus de refus « mémoire ».
    await R.evaluateWithT6({ accountId: 7, bundle: b, mode: 'pregen' }, evalDeps(execute, m.store));
    expect(m.claims).toHaveLength(2);
    // Sans magasin durable (table non déployée) : repli du lot 77 (échec récent en mémoire).
    R.resetT6EvaluationState();
    await R.evaluateWithT6({ accountId: 8, bundle: b, mode: 'pregen' }, evalDeps(execute));
    expect((await R.evaluateWithT6({ accountId: 8, bundle: b, mode: 'pregen' }, evalDeps(execute))).status).toBe('skipped');
  });
  it('L78C-D5 — état de clôture non écrit : signalé (reprise à l’expiration du bail)', async () => {
    const report = vi.fn();
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async () => 1), mode: 'pregen' }, evalDeps(async () => reponse([agir('C1')]), magasin({ finishThrows: true }).store, report));
    expect(o.error).toContain('état d’exécution non enregistré');
    expect(o.run).toMatchObject({ claimed: true, finished: null });
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('L78C-D6 — issue par échéance : rejetée, non enregistrée, sortie invalide, plafond, absente', () => {
    const refs = lot(4, async () => 1).refs;
    const base = { promptVersion: 'v', persisted: 1, accepted: [agir('C1'), agir('C2')] as never, rejected: [{ subjectId: 'C3', reason: 'show_now_without_action' }] as never };
    const r = R.t6RunResultsOf({ ...base, status: 'partially_persisted', persistedSubjectIds: ['C1'], notPersisted: [{ subjectId: 'C2', reason: 'write_failed' }] }, refs);
    expect(r.map((x) => [x.agendaItemId, x.outcome, x.errorKind ?? null])).toEqual([
      [1, 'COMPLETED', null], [2, 'RETRY', 'write_failed'], [3, 'RETRY', 'rejected'], [4, 'RETRY', 'invalid_output'],
    ]);
    expect(R.t6RunResultsOf({ status: 'validation_failed', promptVersion: 'v', accepted: [], rejected: [], persisted: 0, error: 'schema' }, refs).every((x) => x.errorKind === 'invalid_output')).toBe(true);
    expect(R.t6RunResultsOf({ status: 'error', promptVersion: 'v', accepted: [], rejected: [], persisted: 0, error: 'plafond' }, refs, true)
      .every((x) => x.outcome === 'UNAVAILABLE' && x.errorKind === 'cost_cap')).toBe(true);
    // Jamais « traité » sans décision enregistrée : écriture totalement en échec.
    expect(R.t6RunResultsOf({ ...base, status: 'persist_failed', persisted: 0, persistedSubjectIds: [], notPersisted: [{ subjectId: 'C1', reason: 'write_failed' }, { subjectId: 'C2', reason: 'write_failed' }] }, refs)
      .filter((x) => x.outcome === 'COMPLETED')).toEqual([]);
  });
  it('L78C-D7 — SQL : prise sous verrou consultatif du compte, clôture conditionnée par l’exécution', async () => {
    const sqls: string[] = [];
    unsafe.mockImplementation(async (s: string) => {
      sqls.push(s);
      if (/SELECT now\(\)/.test(s)) return [{ now: NOW.toISOString() }];
      if (/FOR UPDATE/.test(s)) return [{ agenda_item_id: 1, account_id: 7, status: 'PENDING', attempts: 0, requested_at: min(-1), interrupted_count: 0, same_context_runs: 0 }];
      if (/^\s*UPDATE t6_evaluation_runs SET\s+interrupted_count/.test(s)) return [{ agenda_item_id: 1, attempts: 1, last_error_kind: null }];
      return [];
    });
    const c = await W.claimT6Runs({ accountId: 7, runId: 'r1', mode: 'pregen', subjects: [{ agendaItemId: 1, fingerprint: 'v4:a', signature: null }] });
    expect(c).toMatchObject({ ok: true, runId: 'r1' });
    expect(sqls[0]).toMatch(/pg_advisory_xact_lock\(\$1::int, \$2::int\)/);
    await W.finishT6Runs({ accountId: 7, runId: 'r1', results: [{ agendaItemId: 1, outcome: 'RETRY', errorKind: 'model_unavailable' }] });
    expect(sqls.at(-1)).toMatch(/r\.run_id = \$2 AND r\.status = 'RUNNING'/);
    expect(sqls.at(-1)).toMatch(/WHEN r\.attempts >= \$4::int THEN 'FAILED' ELSE 'RETRY_WAIT'/);
  });
});

// ── L78C-E ───────────────────────────────────────────────────────────────────

describe('L78C-E — pré-génération : jamais close sur une analyse incomplète', () => {
  const prog = (o: Partial<import('../t6-interpellation.service').T6EvaluationProgress>) => ({
    eligible: 1, claimable: 0, inBundle: 0, waiting: 0, failed: 0, unavailable: 0, stale: 0, waitingUntil: null, counters: {}, ...o,
  });
  it('L78C-E1 — rien à évaluer : issue habituelle', () => {
    expect(Q.pregenEvaluationDecision(null, NOW)).toBeNull();
    expect(Q.pregenEvaluationDecision(prog({ eligible: 0 }), NOW)).toBeNull();
  });
  it('L78C-E2 — en cours ailleurs ou essai planifié : reportée jusqu’à l’instant attendu (borné), tentative non consommée', () => {
    expect(Q.pregenEvaluationDecision(prog({ waiting: 1, waitingUntil: min(10) }), NOW)).toEqual({ outcome: 'evaluation_waiting', deferMs: 605_000, consumeAttempt: false });
    expect(Q.pregenEvaluationDecision(prog({ waiting: 1, waitingUntil: min(0) }), NOW)).toMatchObject({ deferMs: Q.PREGEN_EVALUATION_DEFER_MIN_MS });
    expect(Q.pregenEvaluationDecision(prog({ waiting: 1, waitingUntil: min(24 * 60) }), NOW)).toMatchObject({ deferMs: Q.PREGEN_EVALUATION_DEFER_MAX_MS });
  });
  it('L78C-E3 — prenables non traitées (sans progrès) : nouvel essai court qui consomme une tentative (aucune boucle)', () => {
    expect(Q.pregenEvaluationDecision(prog({ claimable: 2 }), NOW)).toEqual({ outcome: 'evaluation_waiting', deferMs: 120_000, consumeAttempt: true });
  });
  it('L78C-E4 — restantes en échec définitif : close avec un motif explicite', () => {
    expect(Q.pregenEvaluationDecision(prog({ failed: 1 }), NOW)).toEqual({ outcome: 'evaluation_failed' });
  });
});

// ── L78C-F ───────────────────────────────────────────────────────────────────

describe('L78C-F — actualisation ciblée et bornée de l’accueil', () => {
  const prog = (o: Record<string, unknown>) => ({ eligible: 1, claimable: 0, inBundle: 0, waiting: 0, failed: 0, unavailable: 0, stale: 0, waitingUntil: null, counters: {}, ...o });
  it('L78C-F1 — suggestion serveur : examen en cours, essai planifié proche, documents en analyse ; rien sinon', () => {
    expect(M.mascotRefreshHintMs({ evaluation: 'PENDING', progress: null, analysing: false, now: NOW })).toBe(30_000);
    expect(M.mascotRefreshHintMs({ evaluation: 'PENDING', progress: prog({ waitingUntil: min(2) }), analysing: false, now: NOW })).toBe(125_000);
    expect(M.mascotRefreshHintMs({ evaluation: 'PENDING', progress: prog({ waitingUntil: new Date(NOW.getTime() + 1_000).toISOString() }), analysing: false, now: NOW })).toBe(15_000);
    expect(M.mascotRefreshHintMs({ evaluation: 'UNAVAILABLE', progress: prog({ waiting: 1, waitingUntil: min(5) }), analysing: false, now: NOW })).toBe(360_000);
    expect(M.mascotRefreshHintMs({ evaluation: 'UNAVAILABLE', progress: prog({ waiting: 1, waitingUntil: min(120) }), analysing: false, now: NOW })).toBeNull();
    expect(M.mascotRefreshHintMs({ evaluation: 'UNAVAILABLE', progress: prog({ failed: 1 }), analysing: false, now: NOW })).toBeNull();
    expect(M.mascotRefreshHintMs({ evaluation: 'OK', progress: null, analysing: true, now: NOW })).toBe(60_000);
    expect(M.mascotRefreshHintMs({ evaluation: 'OK', progress: null, analysing: false, now: NOW })).toBeNull();
  });
  it('L78C-F2 — côté client : relectures espacées, au plus 8 de suite, jamais au-delà de 10 min', () => {
    expect(H.nextTargetedRefreshMs(undefined, 0)).toBeNull();
    expect([0, 1, 2, 3, 6].map((n) => H.nextTargetedRefreshMs(30_000, n))).toEqual([30_000, 30_000, 30_000, 60_000, 90_000]);
    expect(H.nextTargetedRefreshMs(1_000, 0)).toBe(H.MASCOT_TARGETED_REFRESH_MIN_MS);
    expect(H.nextTargetedRefreshMs(9 * 60_000, 7)).toBe(H.MASCOT_REFRESH_MS);
    expect(H.nextTargetedRefreshMs(30_000, H.MASCOT_TARGETED_REFRESH_MAX)).toBeNull();
  });
  it('L78C-F3 — la suggestion n’entre pas dans l’empreinte : message stable à contexte inchangé', () => {
    const p = buildPresentation({ subjects: [], secondaries: [], degraded: false, messages: null, today: TODAY, evaluation: 'PENDING' });
    expect(B.keepDisplayedPresentation(p, { ...p, refreshAfterMs: 30_000 })).toBe(true);
    const src = lire('src/components/home/useMascotPresentation.ts');
    expect(src).toContain('nextTargetedRefreshMs(data.refreshAfterMs, c.done)');
    expect(src).toMatch(/visibilityState === 'hidden'\) \{ c\.enAttente = true; return; \}/);
  });
});

// ── L78C-G ───────────────────────────────────────────────────────────────────

describe('L78C-G — reporting evaluate:display / evaluate:pregen', () => {
  it('L78C-G1 — par échéance : empreinte, statut réel, tentative, prochain essai ; compteurs et étape « run_state »', async () => {
    const m = magasin();
    const b = lot(2, async () => ({ persisted: 1, persistedSubjectIds: ['C1'] }));
    const o = await R.evaluateWithT6({ accountId: 7, bundle: b, mode: 'display' }, evalDeps(async () => reponse([agir('C1'), { ...agir('C2'), expectedAction: null }]), m.store));
    const t = S.t6EvaluationTraceOf(o);
    const entries = S.t6EvaluationEntries(t, b.refs);
    expect(entries[0].value).toMatchObject({ persisted: true, contextFingerprint: 'v4:fp1', run: { status: 'COMPLETED', attempt: 1, nextAttemptAt: null } });
    expect(entries[1].value).toMatchObject({ rejected: 'show_now_without_action', run: { status: 'RETRY_WAIT', attempt: 1, nextAttemptAt: min(10), errorKind: 'rejected' } });
    await S.writeT6EvaluationReport({ accountId: 7, mode: 'display', bundle: b, trace: t, pregenState: async () => ({ exists: true, lastStatus: 'evaluation_waiting' }) });
    const [rapport] = writeReport.mock.calls.at(-1) as [Record<string, unknown>];
    expect(rapport).toMatchObject({
      triggerCode: 'evaluate:display', status: 'PARTIAL',
      counters: { runCompleted: 1, runRetryWait: 1, runFailed: 0, runUnavailable: 0 },
      sources: { pregen: { lastStatus: 'evaluation_waiting' }, runId: expect.any(String) },
    });
    expect((rapport.steps as Array<{ step: string; status: string }>).find((s) => s.step === 'run_state')).toMatchObject({ status: 'OK' });
  });
});

// ── L78C-H ───────────────────────────────────────────────────────────────────

describe('L78C-H — supervision : causes distinguées', () => {
  const a = (o: Partial<import('../t6-evaluation-runs').T6SupervisionAccount>) => ({ accountId: 7, failed: 0, stalePending: 0, staleRunning: 0, overdueRetry: 0, oldestSince: null, kinds: {}, ...o });
  it('L78C-H1 — modèle indisponible, sortie invalide, écriture, interruption, tâche inactive, non prise', () => {
    expect(W.t6BlockedDiagnosis(a({ failed: 1, kinds: { model_unavailable: 1 } }), true).causes).toEqual(['model_unavailable']);
    expect(W.t6BlockedDiagnosis(a({ failed: 2, kinds: { invalid_output: 1, write_failed: 1 } }), true).causes).toEqual(['invalid_output', 'write_failed']);
    expect(W.t6BlockedDiagnosis(a({ staleRunning: 1 }), true).causes).toEqual(['interrupted']);
    expect(W.t6BlockedDiagnosis(a({ stalePending: 1 }), false).causes).toEqual(['scheduler_inactive']);
    expect(W.t6BlockedDiagnosis(a({ stalePending: 1, kinds: { none: 1 } }), true)).toMatchObject({ causes: ['not_picked_up'], summary: '1 demandée(s) non prise(s) en charge' });
  });
  it('L78C-H2 — anomalie par compte (domaine IA), reprise explicite et lien vers les rapports T6 au BO', async () => {
    const svc = lire('src/services/admin/anomaly.service.ts');
    expect(svc).toContain("detail?.kind === 't6_evaluation'");
    expect(lire('src/app/api/admin/anomalies/[id]/t6-retry/route.ts')).toContain('resetT6RunsForRetry(anomaly.accountId)');
    expect(lire('src/app/admin/supervision/[id]/page.tsx')).toContain('Relancer les évaluations T6');
    const { diagnosticLinkFor } = await import('@/services/admin/anomaly.service');
    expect(diagnosticLinkFor('ai', { kind: 't6_evaluation', accountId: 7 })).toEqual({ href: '/admin/ai-executions?tab=reports&treatment=T6&accountId=7', label: 'Ouvrir les rapports T6 du compte' });
    expect(lire('src/services/scheduling/scheduled-tasks.catalog.ts')).toContain("claimEvaluatorRun('t6-evaluation-supervision', 300)");
  });
});

// ── L78C-M ───────────────────────────────────────────────────────────────────

describe('L78C-M — mascotte « au travail » pendant l’analyse des documents', () => {
  const analyse = (n: number, o: Partial<Raw> = {}) => {
    const r = raw([], { processing: { uploads: [], analyses: Array.from({ length: n }, (_, k) => ({ id: k + 1, title: `doc-${k + 1}.pdf`, at: `2026-10-21T14:0${k}:00Z` })), exports: [] }, ...o });
    const c = buildCandidates(r);
    const s = selectSubjects(c.candidates);
    return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, todo: { total: 1, items: [] } });
  };
  it('L78C-M1 — même source que la ligne « N documents sont en cours d’analyse » : pose « au travail »', () => {
    const p = analyse(8);
    expect(B.documentsInAnalysis(p)).toBe(true);
    expect(B.composeSpeech({ presentation: p, empty: false }).text).toMatch(/8 documents sont en cours d’analyse/);
    expect(B.homePose(p, false)).toBe('document-analysis-pdf');
    expect(B.homePoseLabel('document-analysis-pdf')).toBe('Verebona analyse vos documents');
  });
  it('L78C-M2 — analyse terminée : pose habituelle ; présentation non actualisée : neutre ; attention prioritaire', () => {
    const fini = analyse(0);
    expect(B.documentsInAnalysis(fini)).toBe(false);
    expect(B.homePose(fini, false)).toBe('neutral');
    expect(B.homePose(analyse(2), false, true)).toBe('neutral');
    const p = analyse(2);
    const avecAction = { ...p, todo: { total: 1, items: [{ todoId: 1, todoType: 'X', actionKind: 'COMPLETE', label: 'Prix', priority: 'DO_FIRST' } as never] } };
    expect(B.homePose(avecAction, false)).toBe('reminder-bell');
  });
  it('L78C-M3 — animation lente ajoutée à l’arrivée ; mouvement réduit : pose statique distincte de la pose neutre', () => {
    expect(MM.workingAnimation('vb-pose-a 0.55s x both', true, false)).toBe(`vb-pose-a 0.55s x both, ${MM.WORKING_ANIMATION}`);
    expect(MM.workingAnimation('none', true, true)).toBe('none');
    expect(MM.workingAnimation('vb-pose-a', false, false)).toBe('vb-pose-a');
    expect(MM.mascotSrc('document-analysis-pdf')).not.toBe(MM.mascotSrc('neutral'));
    const css = lire('src/app/globals.css');
    expect(css).toMatch(/@keyframes vb-mascotte-travail/);
    // Aucune exemption « mouvement réduit » (contrairement aux indicateurs de chargement du lot 75O).
    expect(css).not.toMatch(/vb-mascotte-travail[^}]*infinite !important/);
    const comp = lire('src/components/home/MascotSpeaks.tsx');
    expect(comp).toContain('working={travail}');
    expect(comp).toMatch(/role="status" aria-live="polite"/);
  });
  it('L78C-M4 — aucune révision du contrat de présentation : la pose est calculée par le client', async () => {
    expect((await import('../types')).MASCOT_PRESENTATION_REVISION).toBe('l75e-1');
  });
});

// ── L78C-D8 ──────────────────────────────────────────────────────────────────

describe('L78C-D8 — date et salutation de l’accueil', () => {
  it('L78C-D8-1 — clé : jour local et avant / après 18:00', () => {
    expect(G.greetingClockKey(new Date(2026, 9, 20, 23, 59))).toBe('2026-10-20|soir');
    expect(G.greetingClockKey(new Date(2026, 9, 21, 0, 0))).toBe('2026-10-21|jour');
    expect(G.greetingClockKey(new Date(2026, 9, 21, 18, 0))).toBe('2026-10-21|soir');
  });
  it('L78C-D8-2 — prochain changement : 18:00 puis minuit (heure locale)', () => {
    expect(G.msUntilNextGreetingChange(new Date(2026, 9, 21, 17, 59, 30))).toBe(30_000);
    expect(G.msUntilNextGreetingChange(new Date(2026, 9, 21, 18, 0, 0))).toBe(6 * 3600_000);
    expect(G.msUntilNextGreetingChange(new Date(2026, 9, 20, 23, 59, 59, 900))).toBe(1_000);
  });
  it('L78C-D8-3 — l’accueil ne calcule plus la date au seul rendu', () => {
    const comp = lire('src/components/home/MascotSpeaks.tsx');
    expect(comp).not.toContain('const now = new Date();');
    expect(comp).toContain('useGreetingNow()');
  });
});
