/**
 * Lot 31C — contrat versionné de la file T3 (sans base).
 *
 * Identifiants T3Q-xx : tests obligatoires du ticket « T3 — Durcir et
 * formaliser le contrat de la file durable » (§25) ; les scénarios sur base
 * réelle et worker réel sont dans `src/test/e2e/scenarios/l31c-t3-file-contrat.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueueT3ForAssets, enqueueT3ForEntities, enqueueT3ForAnalyzedAsset, enqueueT3ForEvent, enqueueT3Manual,
  runT3Job, reconciliationBusinessResult, type T3HandlerDeps,
} from '../t3-queue';
import {
  registerT3JobKind, resolveT3Job, buildT3Payload, T3_PAYLOAD_VERSION, listT3JobKinds,
} from '../t3-job-contract';
import { isPermanentJobError, type JobBusinessResult } from '../../queue/queue-policy';
import { DEFAULT_TRIGGERS, activeTriggerCodes } from '../../queue/triggers';
import { T3_DEFAULT_SCHEDULE_TRIGGER } from '../../config/catalogs';
import { NO_GUARD } from '../../queue/execution-control';
import type { QueuedJob } from '../../queue/job-queue.repository';
import type { ReconciliationDecision } from '../types';

const enqueue = vi.fn(async (_i: unknown) => ({ decision: 'create' as const, jobId: 99 }));
const actifs = (...codes: string[]) => ({ enqueue: enqueue as never, isTriggerActive: async (_t: 'T3', c: string) => codes.includes(c) });

beforeEach(() => { enqueue.mockClear(); enqueue.mockImplementation(async () => ({ decision: 'create', jobId: 99 })); });
afterEach(() => { delete process.env.T3_SWEEP_PAGE_SIZE; });

const job = (over: Partial<QueuedJob>): QueuedJob => ({
  id: 1, treatment: 'T3', accountId: 5, targetType: null, targetId: null, status: 'RUNNING', origin: 'automatic',
  triggerCode: null, attempts: 1, lastError: null, availableAt: new Date(), coalesceRequested: false, headPriority: false,
  createdAt: new Date('2026-10-07T08:00:00Z'), startedAt: new Date('2026-10-07T08:00:05Z'), finishedAt: null, payload: null,
  executionId: null, workerId: null, leaseExpiresAt: null, recoveredCount: 0, configVersionId: null, ...over,
});

const dec = (action: ReconciliationDecision['action']): ReconciliationDecision => ({
  fieldKey: 'k', currentValue: null, proposedValue: 1, action, reasonCode: 'R', confidence: 'certain', evidenceIds: [], deterministic: true,
});

const deps = (over: Partial<T3HandlerDeps> = {}): T3HandlerDeps => ({
  reconcileAsset: vi.fn(async () => ({ runId: 7, decisions: [dec('keep')] })),
  reconcileEntity: vi.fn(async () => ({ skipped: false, decisions: [], written: [], retracted: [] })),
  reconcileAccount: vi.fn(async () => ({
    runId: 3, status: 'completed', objectsExamined: 2, decisionsApplied: 0, conflictsCreated: 0, errors: 0,
  })) as never,
  listSweepAccounts: vi.fn(async () => []),
  enqueue: enqueue as never,
  ...over,
});

const assetJob = (payload: Record<string, unknown> | null, over: Partial<QueuedJob> = {}) =>
  job({ targetType: 'asset', targetId: '10', payload, ...over });

// ── Déclencheurs ────────────────────────────────────────────────────────────

describe('déclencheurs réels (§4-6)', () => {
  it('T3Q-01 : source_analyzed déclenche les traitements prévus (bien analysé, entités analysées)', async () => {
    expect(await enqueueT3ForAnalyzedAsset({ accountId: 5, assetId: 2, userId: 1, leadSourceId: 3 }, actifs('source_analyzed'))).toBe(99);
    expect(await enqueueT3ForEntities({ accountId: 5, userId: 1, targets: [{ type: 'ROOM', id: 4 }] }, actifs('source_analyzed'))).toEqual([99]);
    // Révision de date / revalidation : cause = (ré)analyse de la source.
    expect(await enqueueT3ForAssets({ accountId: 5, userId: 1, assetIds: [6], reason: 'T4', triggerCode: 'source_analyzed' }, actifs('source_analyzed'))).toEqual([99]);
    expect(enqueue.mock.calls.map((c) => (c[0] as { triggerCode: string }).triggerCode)).toEqual(['source_analyzed', 'source_analyzed', 'source_analyzed']);
  });

  it('T3Q-02 : document_linked fonctionne même si source_analyzed est désactivé', async () => {
    const isTriggerActive = vi.fn(async (_t: 'T3', c: string) => c === 'document_linked');
    const d = { enqueue: enqueue as never, isTriggerActive };
    expect(await enqueueT3ForAssets({ accountId: 5, userId: 3, assetIds: [10], sourceFileId: 55, reason: 'DOCUMENT_UNLINKED' }, d)).toEqual([99]);
    expect(await enqueueT3ForEntities({ accountId: 5, userId: 3, targets: [{ type: 'EQUIPMENT', id: 4 }], triggeredBy: 'document_linked', reason: 'DOCUMENT_DELETED' }, d)).toEqual([99]);
    // Contrôlé ET écrit : le déclencheur réel.
    expect(isTriggerActive.mock.calls.map((c) => c[1])).toEqual(['document_linked', 'document_linked']);
    expect(enqueue.mock.calls.map((c) => (c[0] as { triggerCode: string }).triggerCode)).toEqual(['document_linked', 'document_linked']);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ payload: { triggeredBy: 'document_linked', lifecycleReason: 'DOCUMENT_UNLINKED' } });
  });

  it('T3Q-03 : document_linked inactif empêche le travail (source_analyzed actif n’y change rien)', async () => {
    const d = actifs('source_analyzed', 'asset_updated');
    expect(await enqueueT3ForAssets({ accountId: 5, userId: 3, assetIds: [10, 11], reason: 'DOCUMENT_MOVED' }, d)).toEqual([]);
    expect(await enqueueT3ForEntities({ accountId: 5, userId: 3, targets: [{ type: 'ROOM', id: 9 }], triggeredBy: 'document_linked' }, d)).toEqual([]);
    expect(await enqueueT3ForEvent(5, { event: 'document_linked' }, d)).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('T3Q-04 : fallback T3 = schedule_hourly ; schedule_daily n’est plus un défaut T3 (reste au catalogue)', async () => {
    expect(T3_DEFAULT_SCHEDULE_TRIGGER).toBe('schedule_hourly');
    expect(DEFAULT_TRIGGERS.T3).toContain('schedule_hourly');
    expect(DEFAULT_TRIGGERS.T3).not.toContain('schedule_daily');
    expect(activeTriggerCodes('T3', []).has('schedule_hourly')).toBe(true);
    expect(activeTriggerCodes('T3', [{ kind: 'schedule', code: 'schedule_daily', active: true }]).has('schedule_daily')).toBe(true);

    // Balayage dont le déclencheur est absent / non planifié : repli horaire.
    for (const triggerCode of [null, 'coalesced']) {
      enqueue.mockClear();
      const d = deps({ listSweepAccounts: vi.fn(async () => [1]) });
      await runT3Job(job({ accountId: null, triggerCode, payload: null }), NO_GUARD, d);
      expect(d.listSweepAccounts).toHaveBeenCalledWith(expect.objectContaining({
        since: new Date(new Date('2026-10-07T08:00:05Z').getTime() - 3_600_000),
      }));
      expect(enqueue.mock.calls[0][0]).toMatchObject({ scope: { accountId: 1 }, triggerCode: 'schedule_hourly' });
    }
  });
});

// ── Contrat du payload ──────────────────────────────────────────────────────

describe('contrat versionné du payload (§3)', () => {
  it('T3Q-30 : payloadVersion 1, contexte de reprise uniquement (aucun snapshot métier)', async () => {
    const d = actifs('source_analyzed', 'document_linked', 'asset_updated');
    await enqueueT3ForAnalyzedAsset({ accountId: 5, assetId: 2, userId: 1, leadSourceId: 3 }, d);
    await enqueueT3ForAssets({ accountId: 5, userId: 1, assetIds: [2], sourceFileId: 3, reason: 'DOCUMENT_MOVED' }, d);
    await enqueueT3ForEntities({ accountId: 5, userId: 1, targets: [{ type: 'ROOM', id: 4 }] }, d);
    await enqueueT3ForEvent(5, { event: 'asset_updated', objectType: 'asset', objectId: 2 }, d);
    await enqueueT3Manual(5, 8, 'full', d);
    const AUTORISES = new Set(['payloadVersion', 'kind', 'requestedAt', 'userId', 'sourceFileId', 'triggeredBy',
      'lifecycleReason', 'scope', 'events', 'requestedByUserId', 'scheduled', 'sweepCycleId']);
    for (const [arg] of enqueue.mock.calls) {
      const p = (arg as { payload: Record<string, unknown> }).payload;
      expect(p.payloadVersion).toBe(T3_PAYLOAD_VERSION);
      expect(Object.keys(p).filter((k) => !AUTORISES.has(k))).toEqual([]);
    }
  });

  it('anciens payloads sans payloadVersion : toujours compatibles (sorte déduite de la forme)', async () => {
    const d = deps();
    await runT3Job(assetJob({ userId: 3, sourceFileId: 4 }), NO_GUARD, d);
    expect(d.reconcileAsset).toHaveBeenCalledWith(expect.objectContaining({ assetId: 10, userId: 3, sourceFileId: 4, triggeredBy: 'document_analyzed' }));
    await runT3Job(job({ targetType: 'room', targetId: '9', payload: { kind: 'entity' } }), NO_GUARD, d);
    expect(d.reconcileEntity).toHaveBeenCalledWith(expect.objectContaining({ target: { type: 'ROOM', id: 9 } }));
    await runT3Job(job({ triggerCode: 'asset_updated', payload: { events: [{ event: 'asset_updated', objectId: 2 }] } }), NO_GUARD, d);
    expect(d.reconcileAccount).toHaveBeenCalled();
    expect(resolveT3Job(job({ accountId: null, payload: { scheduled: true, triggerCode: 'schedule_daily' } }))).toMatchObject({ kind: 'sweep', payloadVersion: 0 });
  });
});

// ── Job invalide ────────────────────────────────────────────────────────────

describe('travail inexécutable → PermanentJobError (FAILED immédiat), jamais un retour normal (§9)', () => {
  const rejette = async (j: QueuedJob, motif: RegExp) => {
    const d = deps();
    const e = await runT3Job(j, NO_GUARD, d).then(() => null, (x: unknown) => x);
    expect(isPermanentJobError(e), `attendu PermanentJobError pour ${motif}`).toBe(true);
    expect((e as Error).message).toMatch(motif);
    // Aucun traitement métier n'a été tenté (donc aucun DONE possible).
    expect(d.reconcileAsset).not.toHaveBeenCalled();
    expect(d.reconcileEntity).not.toHaveBeenCalled();
    expect(d.reconcileAccount).not.toHaveBeenCalled();
  };

  it('T3Q-08 : targetId invalide', async () => {
    for (const targetId of ['abc', '0', '-3', '1.5', '']) {
      await rejette(assetJob(buildT3Payload('asset', { userId: 3 }), { targetId }), /identifiant de cible/);
    }
    await rejette(job({ targetType: 'equipment', targetId: 'x', payload: buildT3Payload('entity', {}) }), /identifiant de cible/);
  });

  it('T3Q-09 : payload incompatible (cible incompatible, structure incorrecte, information obligatoire absente)', async () => {
    await rejette(job({ targetType: 'equipment', targetId: '4', payload: buildT3Payload('asset', { userId: 3 }) }), /incompatible avec la sorte « asset »/);
    await rejette(job({ targetType: 'banane', targetId: '4', payload: { userId: 3 } }), /incompatible avec T3/);
    await rejette(job({ accountId: null, targetType: 'asset', targetId: '4', payload: { userId: 3 } }), /incompatible/);
    await rejette(assetJob(buildT3Payload('inconnue', {})), /sorte de travail « inconnue » inconnue/);
    await rejette(assetJob(buildT3Payload('asset', {})), /utilisateur à l'origine absent/);
    await rejette(assetJob(buildT3Payload('asset', { userId: 'trois' })), /userId invalide/);
    await rejette(job({ payload: buildT3Payload('account', { scope: 'tout' }) }), /scope invalide/);
    await rejette(job({ payload: buildT3Payload('account', { events: 'x' }) }), /events/);
    await rejette(job({ payload: [] as unknown as Record<string, unknown> }), /structurellement incorrect/);
    await rejette(job({ accountId: null, targetType: 't3_sweep', targetId: '1:1', payload: buildT3Payload('sweep', {}) }), /sans cycle/);
  });

  it('T3Q-10 : payloadVersion inconnue', async () => {
    for (const v of [2, 99, 'v1', 0, -1, 1.5]) {
      await rejette(assetJob({ ...buildT3Payload('asset', { userId: 3 }), payloadVersion: v }), /payloadVersion/);
    }
  });

  it('T3Q-11 : la sorte « entity » sans exécutant branché est aussi terminale', async () => {
    const d = deps({ reconcileEntity: undefined });
    const e = await runT3Job(job({ targetType: 'room', targetId: '9', payload: buildT3Payload('entity', {}) }), NO_GUARD, d).catch((x) => x);
    expect(isPermanentJobError(e)).toBe(true);
  });
});

// ── Résultats métier ────────────────────────────────────────────────────────

describe('résultats métier (§10-11) — tous techniquement DONE', () => {
  it('résultat d’une réconciliation (pur)', () => {
    expect(reconciliationBusinessResult([dec('apply'), dec('keep')]).result).toBe('APPLIED');
    expect(reconciliationBusinessResult([dec('create_conflict')]).result).toBe('ABSTAIN');
    expect(reconciliationBusinessResult([dec('keep'), dec('ignore')]).result).toBe('NO_CHANGE');
    expect(reconciliationBusinessResult([], 2).result).toBe('APPLIED');
  });

  it('T3Q-12 : NO_CHANGE (bien relu, rien à modifier)', async () => {
    const r = await runT3Job(assetJob(buildT3Payload('asset', { userId: 3, sourceFileId: 4 })), NO_GUARD, deps({ assetExists: async () => true }));
    expect(r).toMatchObject({ result: 'NO_CHANGE', detail: { assetId: 10, runId: 7 } });
  });

  it('T3Q-13 : ABSTAIN (contradiction non tranchée → arbitrage), compte comme bien', async () => {
    const d = deps({ reconcileAsset: vi.fn(async () => ({ decisions: [dec('create_conflict')] })) });
    expect((await runT3Job(assetJob(buildT3Payload('asset', { userId: 3 })), NO_GUARD, d)).result).toBe('ABSTAIN');
    const c = deps({ reconcileAccount: vi.fn(async () => ({ runId: 1, status: 'completed', decisionsApplied: 0, conflictsCreated: 2, errors: 0, objectsExamined: 3 })) as never });
    expect((await runT3Job(job({ origin: 'manual', payload: buildT3Payload('account', { scope: 'full' }) }), NO_GUARD, c)).result).toBe('ABSTAIN');
  });

  it('T3Q-14 : SUPERSEDED (relecture : une exécution plus récente a déjà couvert le travail)', async () => {
    const since = vi.fn(async () => true);
    const d = deps({ assetExists: async () => true, assetReconciledSince: since });
    const r = await runT3Job(assetJob(buildT3Payload('asset', { userId: 3, sourceFileId: null }, new Date('2026-10-07T08:30:00Z'))), NO_GUARD, d);
    expect(r.result).toBe('SUPERSEDED');
    expect(since).toHaveBeenCalledWith(5, 10, new Date('2026-10-07T08:30:00Z')); // la demande la plus récente
    expect(d.reconcileAsset).not.toHaveBeenCalled();
    // Avec une source : jamais SUPERSEDED (réconciliation de statut agenda propre à la source).
    const d2 = deps({ assetExists: async () => true, assetReconciledSince: since });
    expect((await runT3Job(assetJob(buildT3Payload('asset', { userId: 3, sourceFileId: 4 })), NO_GUARD, d2)).result).toBe('NO_CHANGE');

    // Compte : événement couvert seulement par une exécution `full` ; manuel jamais.
    const acc = vi.fn(async (_a: number, _s: Date, fullOnly: boolean) => !fullOnly);
    const d3 = deps({ accountReconciledSince: acc });
    const ev = job({ triggerCode: 'asset_updated', payload: buildT3Payload('account', { scope: 'incremental', events: [{ event: 'asset_updated', at: '2026-10-07T09:00:00Z' }] }) });
    expect((await runT3Job(ev, NO_GUARD, d3)).result).toBe('NO_CHANGE');
    expect(acc).toHaveBeenLastCalledWith(5, new Date('2026-10-07T09:00:00Z'), true);
    const sched = job({ triggerCode: 'schedule_hourly', payload: buildT3Payload('account', { scope: 'incremental', scheduled: true }) });
    expect((await runT3Job(sched, NO_GUARD, d3)).result).toBe('SUPERSEDED');
    const manuel = job({ origin: 'manual', triggerCode: 'manual', payload: buildT3Payload('account', { scope: 'full' }) });
    expect((await runT3Job(manuel, NO_GUARD, deps({ accountReconciledSince: async () => true }))).result).toBe('NO_CHANGE');
  });

  it('T3Q-15 : TARGET_GONE (bien supprimé, entité disparue ou archivée)', async () => {
    const d = deps({ assetExists: async () => false });
    expect(await runT3Job(assetJob(buildT3Payload('asset', { userId: 3 })), NO_GUARD, d)).toEqual({ result: 'TARGET_GONE', detail: { assetId: 10 } });
    expect(d.reconcileAsset).not.toHaveBeenCalled();
    const e = deps({ reconcileEntity: vi.fn(async () => ({ skipped: true })) });
    expect((await runT3Job(job({ targetType: 'equipment', targetId: '4', payload: buildT3Payload('entity', {}) }), NO_GUARD, e)).result).toBe('TARGET_GONE');
  });

  it('APPLIED (bien, entité, compte)', async () => {
    expect((await runT3Job(assetJob(buildT3Payload('asset', { userId: 3 })), NO_GUARD,
      deps({ reconcileAsset: vi.fn(async () => ({ decisions: [dec('update')] })) }))).result).toBe('APPLIED');
    expect((await runT3Job(job({ targetType: 'room', targetId: '9', payload: buildT3Payload('entity', {}) }), NO_GUARD,
      deps({ reconcileEntity: vi.fn(async () => ({ skipped: false, decisions: [], written: ['a'], retracted: [] })) }))).result).toBe('APPLIED');
    expect(await runT3Job(job({ origin: 'manual', payload: buildT3Payload('account', {}) }), NO_GUARD,
      deps({ reconcileAccount: vi.fn(async () => ({ runId: 1, status: 'partial', decisionsApplied: 4, conflictsCreated: 0, errors: 1, objectsExamined: 3 })) as never }))).toMatchObject({
      result: 'APPLIED', detail: { decisionsApplied: 4, errors: 1, status: 'partial' },
    });
  });

  it('exécution compte en échec sur tous les biens : échec TECHNIQUE (retry), pas un DONE', async () => {
    const d = deps({ reconcileAccount: vi.fn(async () => ({ runId: 1, status: 'failed', errors: 3 })) as never });
    await expect(runT3Job(job({ origin: 'manual', payload: buildT3Payload('account', {}) }), NO_GUARD, d)).rejects.toThrow(/en échec sur tous les biens/);
  });

  it('garde : vérifiée avant l’écriture métier (bien) ; interrompue, rien n’est réconcilié', async () => {
    const guard = { ...NO_GUARD, assertActive: vi.fn(async () => { throw Object.assign(new Error('révoquée'), { code: 'EXECUTION_CANCELLED' }); }) };
    const d = deps({ assetExists: async () => true });
    await expect(runT3Job(assetJob(buildT3Payload('asset', { userId: 3 })), guard, d)).rejects.toThrow(/révoquée/);
    expect(guard.assertActive).toHaveBeenCalledWith('réconciliation du bien');
    expect(d.reconcileAsset).not.toHaveBeenCalled();
  });
});

// ── Balayage paginé ─────────────────────────────────────────────────────────

describe('balayage horaire borné, paginé, reprenable (§18-20)', () => {
  /** Simulateur : comptes, file (clés uniques à vie pour les pages), pages exécutées en chaîne. */
  function simulateur(comptes: number[], opts: { size?: number; backlog?: number[] } = {}) {
    process.env.T3_SWEEP_PAGE_SIZE = String(opts.size ?? 3);
    const file: Array<{ scope: Record<string, unknown>; triggerCode: string; payload: Record<string, unknown>; delaySeconds?: number; onlyIfNeverQueued?: boolean }> = [];
    const cles = new Set<string>();
    const backlogs = [...(opts.backlog ?? [])];
    const listSweepAccounts = vi.fn(async (q: { afterAccountId: number; limit: number }) =>
      comptes.filter((a) => a > q.afterAccountId).sort((a, b) => a - b).slice(0, q.limit));
    const enq = vi.fn(async (i: never) => {
      const e = i as (typeof file)[number];
      const cle = JSON.stringify(e.scope);
      if (e.onlyIfNeverQueued && cles.has(cle)) return { decision: 'skip' as const, jobId: 1 };
      cles.add(cle);
      file.push(e);
      return { decision: 'create' as const, jobId: file.length };
    });
    const d = deps({ listSweepAccounts: listSweepAccounts as never, enqueue: enq as never, sweepBacklog: async () => backlogs.shift() ?? 0, liveSweepPages: async () => 0 });
    return { file, d, listSweepAccounts };
  }
  const pages = <T extends { scope: Record<string, unknown> }>(file: T[]): T[] => file.filter((e) => e.scope.targetType === 't3_sweep');
  const comptesEnFile = (file: Array<{ scope: Record<string, unknown> }>) => file.filter((e) => e.scope.accountId != null).map((e) => e.scope.accountId);

  /** Exécute la racine puis chaque page créée, comme le boucleur. */
  async function cycle(s: ReturnType<typeof simulateur>, rejouer: number[] = []) {
    const resultats: JobBusinessResult[] = [];
    resultats.push(await runT3Job(job({ id: 500, accountId: null, triggerCode: 'schedule_hourly', payload: buildT3Payload('sweep', { scheduled: true }) }), NO_GUARD, s.d));
    for (let i = 0; i < pages(s.file).length; i++) {
      const p = pages(s.file)[i];
      const j = job({ id: 600 + i, accountId: null, targetType: 't3_sweep', targetId: String(p.scope.targetId), triggerCode: p.triggerCode, payload: p.payload });
      resultats.push(await runT3Job(j, NO_GUARD, s.d));
      // Reprise après bail expiré : la même page est rejouée.
      if (rejouer.includes(i)) resultats.push(await runT3Job(j, NO_GUARD, s.d));
    }
    return resultats;
  }

  it('T3Q-25 : schedule_hourly déclenche le balayage (racine = page 0 du cycle)', async () => {
    const s = simulateur([1, 2]);
    const [r] = await cycle(s);
    expect(r).toMatchObject({ result: 'APPLIED', detail: { cycleId: '500', page: 0, enqueued: 2, last: true } });
    expect(s.file.every((e) => e.triggerCode === 'schedule_hourly')).toBe(true);
  });

  it('T3Q-26 : fan-out borné — jamais plus d’une page de travaux compte par passage', async () => {
    const s = simulateur(Array.from({ length: 10 }, (_, i) => i + 1), { size: 3 });
    await runT3Job(job({ id: 500, accountId: null, triggerCode: 'schedule_hourly', payload: null }), NO_GUARD, s.d);
    expect(comptesEnFile(s.file)).toEqual([1, 2, 3]);
    expect(pages(s.file)).toHaveLength(1);
    expect(pages(s.file)[0]).toMatchObject({
      scope: { targetType: 't3_sweep', targetId: '500:1' }, onlyIfNeverQueued: true, delaySeconds: 60,
      payload: { payloadVersion: 1, kind: 'sweep', cycleId: '500', afterAccountId: 3, page: 1 },
    });
  });

  it('T3Q-27 : continuation correcte (curseur stable par identifiant, fin de cycle sans page de trop)', async () => {
    const s = simulateur([2, 4, 6, 8, 10, 12, 14], { size: 3 });
    const res = await cycle(s);
    expect(pages(s.file).map((p) => [p.scope.targetId, p.payload.afterAccountId])).toEqual([['500:1', 6], ['500:2', 12]]);
    expect(s.listSweepAccounts.mock.calls.map((c) => c[0].afterAccountId)).toEqual([0, 6, 12]);
    expect(res.at(-1)).toMatchObject({ detail: { last: true, enqueued: 1 } });
  });

  it('T3Q-28 / T3Q-29 : aucun compte perdu, aucun compte mis en file deux fois dans le cycle (page rejouée comprise)', async () => {
    const tous = Array.from({ length: 11 }, (_, i) => 100 + i * 7);
    const s = simulateur(tous, { size: 4 });
    // La page 1 est rejouée (reprise après crash) : la continuation n'est pas recréée.
    await cycle(s, [0]);
    const enFile = comptesEnFile(s.file);
    expect([...new Set(enFile)].sort((a, b) => Number(a) - Number(b))).toEqual(tous);
    // Rejouer une page re-propose ses comptes ; la file les absorbe (dédup PENDING,
    // et période : exclus une fois réconciliés). Les PAGES, elles, ne sont jamais doublées.
    expect(pages(s.file).map((p) => p.scope.targetId)).toEqual(['500:1', '500:2']);
  });

  it('charge laissée par la page précédente : rien n’est mis en file, la page se reporte (curseur inchangé)', async () => {
    const s = simulateur([1, 2, 3, 4, 5], { size: 2, backlog: [0, 5] });
    await cycle(s);
    const p = pages(s.file);
    expect(p[0].payload.afterAccountId).toBe(2);
    // Page 1 : backlog 5 ≥ 2 → report, même curseur, délai long.
    expect(p[1]).toMatchObject({ payload: { afterAccountId: 2, page: 2 }, delaySeconds: 300 });
    expect([...new Set(comptesEnFile(s.file))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('un cycle déjà vivant : la nouvelle racine ne double pas le balayage (SUPERSEDED)', async () => {
    const d = deps({ liveSweepPages: async () => 1, listSweepAccounts: vi.fn(async () => [1]) });
    const r = await runT3Job(job({ accountId: null, triggerCode: 'schedule_hourly', payload: null }), NO_GUARD, d);
    expect(r.result).toBe('SUPERSEDED');
    expect(d.listSweepAccounts).not.toHaveBeenCalled();
  });
});

// ── Extensibilité ───────────────────────────────────────────────────────────

describe('nouvelle sorte de travail (ex. rattachement document → bien, lot 31B)', () => {
  it('enregistrée, validée par version, exécutée par le même aiguillage', async () => {
    const run = vi.fn(async () => ({ result: 'APPLIED' as const }));
    registerT3JobKind<{ fileId: number }>({
      kind: 'test_document_asset', targetTypes: ['test_asset_file'], account: 'required', versions: [1],
      parse: (raw, j) => ({ fileId: Number(j.targetId) + Number(raw.extra ?? 0) }),
      run,
    });
    expect(listT3JobKinds()).toContain('test_document_asset');
    const j = job({ targetType: 'test_asset_file', targetId: '12', payload: buildT3Payload('test_document_asset', { extra: 1 }) });
    expect(await runT3Job(j, NO_GUARD, deps())).toEqual({ result: 'APPLIED' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ payload: { fileId: 13 } }));
    // Sans version, une sorte non historique est refusée.
    const legacy = job({ targetType: 'test_asset_file', targetId: '12', payload: { kind: 'test_document_asset' } });
    expect(() => resolveT3Job(legacy)).toThrow(/payloadVersion 0 inconnue/);
  });
});
