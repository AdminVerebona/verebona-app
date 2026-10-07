/**
 * Lot 31C — contrat de la file durable T3, sur PostgreSQL réel et boucleur
 * réel (`runOne('T3')` avec l'exécutant T3 de production).
 *
 * Identifiants T3Q-xx : tests obligatoires du ticket « T3 — Durcir et
 * formaliser le contrat de la file durable » (§25). Les règles pures sont
 * couvertes sans base par `l31c-t3-contract.test.ts` et
 * `l31c-queue-contract.test.ts`.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Job = {
  id: number; status: string; attempts: number; head_priority: boolean; coalesce_requested: boolean; origin: string;
  trigger_code: string | null; payload: Record<string, unknown> | null; business_result: string | null;
  business_result_detail: Record<string, unknown> | null; last_error: string | null; execution_id: string | null;
  recovered_count: number; available_at: Date; target_type: string | null; target_id: string | null; account_id: number | null;
};

const trace = {
  traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'],
};
const fait = (assetId: number, value: string): ProjectedFact => ({
  canonicalKey: 'acquisitionDate', rawKey: 'Date d’achat', label: null, subject: null, attribute: null,
  rawValue: value, value, valueType: 'date', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: `Date d’achat : ${value}`, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
});

const attendre = async (cond: () => Promise<boolean> | boolean, ms = 10_000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition non atteinte');
};

scenario('L31C', 'Contrat de la file durable T3 (worker réel)', ({ sql, make }) => {
  let runOne: typeof import('@/services/ai/queue/queue-worker').runOne;
  let repo: typeof import('@/services/ai/queue/job-queue.repository');
  let t3: typeof import('@/services/ai/reconciliation/t3-queue');
  let contrat: typeof import('@/services/ai/reconciliation/t3-job-contract');
  let triggers: typeof import('@/services/ai/queue/triggers');
  let admin: { id: number };
  const ecartes = new Set<number>();
  const env = { ...process.env };

  // Sorte de travail de test : attend un signal, puis écrit (garde comprise).
  const portes = new Map<number, { ouvrir: () => void; ouverte: Promise<void>; demarre: boolean; ecrit: boolean }>();
  const porte = (cible: number) => {
    let ouvrir!: () => void;
    const ouverte = new Promise<void>((r) => { ouvrir = r; });
    const p = { ouvrir, ouverte, demarre: false, ecrit: false };
    portes.set(cible, p);
    return p;
  };

  beforeAll(async () => {
    ({ runOne } = await import('@/services/ai/queue/queue-worker'));
    repo = await import('@/services/ai/queue/job-queue.repository');
    t3 = await import('@/services/ai/reconciliation/t3-queue');
    contrat = await import('@/services/ai/reconciliation/t3-job-contract');
    triggers = await import('@/services/ai/queue/triggers');
    const { registerJobHandler } = await import('@/services/ai/queue/queue-worker');
    registerJobHandler('T3', t3.t3JobHandler);
    triggers.__setTriggerConfigLoader(async () => null); // défauts du code
    admin = await make.user();
    await repo.setEmergencyStop(false, admin.id);
    await repo.setTreatmentState('T3', 'ENABLED', admin.id);

    const { assertJobActive } = await import('@/services/ai/queue/execution-control');
    contrat.registerT3JobKind<{ cible: number }>({
      kind: 'e2e_attente', targetTypes: ['e2e_cible'], account: 'required', versions: [1],
      parse: (_raw, j) => ({ cible: contrat.parseTargetId(j) }),
      async run({ payload }) {
        const p = portes.get(payload.cible);
        if (!p) return { result: 'NO_CHANGE' };
        p.demarre = true;
        await p.ouverte;
        await assertJobActive('écriture e2e'); // garde avant écriture métier
        p.ecrit = true;
        return { result: 'APPLIED' };
      },
    });
  });
  afterAll(async () => {
    triggers.__setTriggerConfigLoader(null);
    process.env = { ...env };
    if (ecartes.size) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${[...ecartes]}) AND status = 'PENDING'`;
  });

  /** Seul `ids` est prélevable parmi les travaux T3 (base partagée entre scénarios). */
  const seul = async (...ids: number[]) => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T3' AND status = 'PENDING' AND available_at <= now() AND NOT (id = ANY(${ids}))
       RETURNING id`;
    for (const r of rows) ecartes.add(Number(r.id));
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ids}) AND status = 'PENDING'`;
  };
  const lire = async (id: number) => (await sql<Job[]>`SELECT * FROM ai_job_queue WHERE id = ${id}`)[0];
  const vivants = async (accountId: number, targetType: string | null, targetId: string | null) => sql<Job[]>`
    SELECT * FROM ai_job_queue WHERE treatment = 'T3' AND account_id = ${accountId}
       AND target_type IS NOT DISTINCT FROM ${targetType} AND target_id IS NOT DISTINCT FROM ${targetId}
       AND status IN ('PENDING', 'RUNNING') ORDER BY id`;
  const executer = async (id: number) => { await seul(id); expect(await runOne('T3')).toBe(true); return lire(id); };
  const jobCompte = async (accountId: number) => {
    const { jobId } = await repo.enqueue({
      treatment: 'T3', scope: { accountId }, origin: 'manual', triggerCode: 'manual',
      payload: contrat.buildT3Payload('account', { scope: 'full' }),
    });
    return jobId!;
  };
  const jobAttente = async (accountId: number, cible: number) => (await repo.enqueue({
    treatment: 'T3', scope: { accountId, targetType: 'e2e_cible', targetId: cible },
    triggerCode: 'manual', origin: 'manual', payload: contrat.buildT3Payload('e2e_attente', {}),
  })).jobId!;

  it('migration 0267 : colonnes du résultat métier présentes, rejouable sans effet', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0267_ai_job_queue_business_result.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'ai_job_queue'
         AND column_name IN ('business_result', 'business_result_detail') ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(['business_result', 'business_result_detail']);
    const [idx] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'ai_job_queue_dedupe_key_all_idx'`;
    expect(idx.n).toBe(1);
  });

  // ── Déclencheurs ──────────────────────────────────────────────────────────

  it('T3Q-01/02/03 : déclencheur réel écrit sur le job ; document_linked indépendant de source_analyzed', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const config = (actifs: string[]) => triggers.__setTriggerConfigLoader(async () => ({
      triggers: ['source_analyzed', 'document_linked', 'asset_updated', 'arbitration_resolved'].map((code) => ({ kind: 'event' as const, code, active: actifs.includes(code) })),
    }));
    try {
      // T3Q-01 : source_analyzed actif → travail d'analyse.
      config(['source_analyzed']);
      expect(await t3.enqueueT3ForAnalyzedAsset({ accountId: compte.id, assetId: bien.id, userId: compte.ownerUserId, leadSourceId: 1 })).not.toBeNull();
      const [a] = await vivants(compte.id, 'asset', String(bien.id));
      expect(a).toMatchObject({ trigger_code: 'source_analyzed', payload: expect.objectContaining({ payloadVersion: 1, kind: 'asset' }) });
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${a.id}`;

      // T3Q-02 : source_analyzed coupé, document_linked actif → le détachement réconcilie.
      config(['document_linked']);
      expect(await t3.enqueueT3ForAssets({ accountId: compte.id, userId: compte.ownerUserId, assetIds: [bien.id], sourceFileId: null, reason: 'DOCUMENT_UNLINKED' })).toHaveLength(1);
      const [b] = await vivants(compte.id, 'asset', String(bien.id));
      expect(b).toMatchObject({ trigger_code: 'document_linked', payload: expect.objectContaining({ payloadVersion: 1, triggeredBy: 'document_linked', lifecycleReason: 'DOCUMENT_UNLINKED' }) });
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${b.id}`;

      // T3Q-03 : document_linked coupé → aucun travail (même avec source_analyzed actif).
      config(['source_analyzed']);
      expect(await t3.enqueueT3ForAssets({ accountId: compte.id, userId: compte.ownerUserId, assetIds: [bien.id], reason: 'DOCUMENT_MOVED' })).toEqual([]);
      expect(await vivants(compte.id, 'asset', String(bien.id))).toHaveLength(0);
    } finally {
      triggers.__setTriggerConfigLoader(async () => null);
    }
  });

  // ── Déduplication / coalescence ──────────────────────────────────────────

  it('T3Q-05/06/07 : PENDING absorbé ; RUNNING → coalesceRequested ; dix événements → UN passage consolidé', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const cle = [compte.id, 'asset', String(bien.id)] as const;
    await t3.enqueueT3ForAnalyzedAsset({ accountId: compte.id, assetId: bien.id, userId: compte.ownerUserId, leadSourceId: 11 });
    await t3.enqueueT3ForAnalyzedAsset({ accountId: compte.id, assetId: bien.id, userId: compte.ownerUserId, leadSourceId: 12 });
    const pending = await vivants(...cle);
    expect(pending).toHaveLength(1); // T3Q-05
    expect(pending[0].payload).toMatchObject({ sourceFileId: 12 }); // replace : le plus récent l'emporte

    await seul(pending[0].id);
    const pris = await repo.claimNext('T3', 'e2e-31c', 60);
    expect(pris?.id).toBe(pending[0].id);
    for (let i = 0; i < 10; i++) {
      await t3.enqueueT3ForAnalyzedAsset({ accountId: compte.id, assetId: bien.id, userId: compte.ownerUserId, leadSourceId: 100 + i });
    }
    const pendant = await vivants(...cle);
    expect(pendant).toHaveLength(1); // T3Q-06 : jamais une seconde ligne
    expect(pendant[0]).toMatchObject({ status: 'RUNNING', coalesce_requested: true });

    expect(await repo.completeJob(pris!.id, pris!.executionId, { result: 'NO_CHANGE' })).toEqual({ requeued: true });
    const apres = await vivants(...cle);
    expect(apres).toHaveLength(1); // T3Q-07 : un seul passage supplémentaire
    expect(apres[0]).toMatchObject({ status: 'PENDING', trigger_code: 'coalesced', payload: expect.objectContaining({ sourceFileId: 109 }) });
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${apres[0].id}`;

    // Compte : événements fusionnés, bornés à MAX_MERGED_EVENTS.
    for (let i = 0; i < 60; i++) await t3.enqueueT3ForEvent(compte.id, { event: 'asset_updated', objectType: 'asset', objectId: i + 1 });
    const [ev] = await vivants(compte.id, null, null);
    expect((ev.payload!.events as unknown[]).length).toBe(repo.MAX_MERGED_EVENTS);
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${ev.id}`;
  });

  it('T3Q-31 : lancement manuel jamais absorbé par un travail automatique vivant (origin manual)', async () => {
    const compte = await make.account();
    await t3.enqueueT3ForEvent(compte.id, { event: 'asset_updated' });
    const m1 = await t3.enqueueT3Manual(compte.id, admin.id);
    const m2 = await t3.enqueueT3Manual(compte.id, admin.id);
    const rows = await vivants(compte.id, null, null);
    expect(rows.map((r) => r.origin).sort()).toEqual(['automatic', 'manual', 'manual']);
    expect(new Set([m1, m2]).size).toBe(2);
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ANY(${rows.map((r) => r.id)})`;
  });

  // ── Job invalide ─────────────────────────────────────────────────────────

  it('T3Q-08/09/10/11 : travail inexécutable → FAILED dès la première exécution, jamais DONE', async () => {
    const compte = await make.account();
    const inserer = async (targetType: string | null, targetId: string | null, payload: Record<string, unknown>) => {
      const [r] = await sql<{ id: number }[]>`
        INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, trigger_code, payload)
        VALUES ('T3', ${compte.id}, ${targetType}, ${targetId}, ${`e2e31c:${compte.id}:${targetType}:${targetId}:${Math.random()}`},
                'source_analyzed', ${JSON.stringify(payload)}::jsonb) RETURNING id`;
      return Number(r.id);
    };
    const cas = [
      ['T3Q-08 targetId invalide', await inserer('asset', 'abc', { payloadVersion: 1, kind: 'asset', userId: compte.ownerUserId })],
      ['T3Q-09 cible incompatible', await inserer('equipment', '4', { payloadVersion: 1, kind: 'asset', userId: compte.ownerUserId })],
      ['T3Q-09 contexte incorrect', await inserer('asset', '4', { payloadVersion: 1, kind: 'asset' })],
      ['T3Q-10 payloadVersion inconnue', await inserer('asset', '4', { payloadVersion: 99, kind: 'asset', userId: compte.ownerUserId })],
    ] as const;
    for (const [nom, id] of cas) {
      const j = await executer(id);
      expect(j, nom).toMatchObject({ status: 'FAILED', attempts: 1, business_result: null });
      expect(j.last_error, nom).toMatch(/inexécutable/);
      expect(j.execution_id, nom).not.toBeNull(); // dernière exécution traçable
    }
    // T3Q-11 : aucun de ces cas ne finit DONE.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE id = ANY(${cas.map((c) => c[1])}) AND status = 'DONE'`;
    expect(n).toBe(0);
  });

  // ── Résultats métier ─────────────────────────────────────────────────────

  it('T3Q-12/13/15 + APPLIED : résultats métier persistés sur des jobs DONE (moteur réel)', async () => {
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const facade = await import('@/services/asset-details-write.service');
    const compte = await make.account();
    const entree = (fileId: number) => ({ sourceType: 'file' as const, sourceIds: [fileId], accountId: compte.id, userId: compte.ownerUserId, mimeTypes: [], displayNames: [] });
    const analyse = async (assetId: number, valeur: string, run: number) => {
      const doc = await make.assetFile(compte, { assetId });
      await persistProjectedFacts({ input: entree(doc.id), leadSourceId: doc.id, trace, analysisRunId: run, documentType: 'FACTURE', facts: [fait(assetId, valeur)] });
      return doc.id;
    };
    const job = async (assetId: number, sourceFileId: number) => {
      await t3.enqueueT3ForAnalyzedAsset({ accountId: compte.id, assetId, userId: compte.ownerUserId, leadSourceId: sourceFileId });
      return (await vivants(compte.id, 'asset', String(assetId)))[0].id;
    };

    // APPLIED : la preuve remplit le champ vide.
    const bien = await make.asset(compte);
    const d1 = await analyse(bien.id, '2024-01-02', 31001);
    const j1 = await executer(await job(bien.id, d1));
    expect(j1).toMatchObject({ status: 'DONE', business_result: 'APPLIED', business_result_detail: expect.objectContaining({ assetId: bien.id }) });
    const [kc] = await sql<{ kc: string }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${bien.id}`;
    expect(JSON.parse(kc.kc).acquisitionDate).toBe('2024-01-02');

    // T3Q-12 NO_CHANGE : relu, rien à modifier.
    const j2 = await executer(await job(bien.id, d1));
    expect(j2).toMatchObject({ status: 'DONE', business_result: 'NO_CHANGE' });

    // T3Q-13 ABSTAIN : la valeur USER contredite → arbitrage, rien d'écrit.
    await facade.updateAssetDetails({ assetId: bien.id, accountId: compte.id, section: 'common', fields: { acquisitionDate: '2023-06-15' }, actorUserId: compte.ownerUserId });
    const d3 = await analyse(bien.id, '2022-02-02', 31003);
    const j3 = await executer(await job(bien.id, d3));
    expect(j3).toMatchObject({ status: 'DONE', business_result: 'ABSTAIN' });

    // T3Q-15 TARGET_GONE : bien supprimé entre la mise en file et l'exécution.
    const parti = await make.asset(compte);
    const id4 = await job(parti.id, d1);
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${parti.id}`;
    const j4 = await executer(id4);
    expect(j4).toMatchObject({ status: 'DONE', business_result: 'TARGET_GONE' });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM reconciliation_runs WHERE asset_id = ${parti.id}`;
    expect(n).toBe(0); // aucune écriture pour une cible disparue
  });

  it('T3Q-14 : SUPERSEDED — une réconciliation complète plus récente que la demande a déjà couvert le bien', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const [id] = await t3.enqueueT3ForAssets({ accountId: compte.id, userId: compte.ownerUserId, assetIds: [bien.id], sourceFileId: null, reason: 'DOCUMENT_DELETED' });
    await sql`UPDATE ai_job_queue SET created_at = now() - interval '1 minute', payload = payload || jsonb_build_object('requestedAt', (now() - interval '1 minute')::text) WHERE id = ${id}`;
    await sql`INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, status, started_at, finished_at)
              VALUES (${compte.id}, ${bien.id}, 'scheduled', 'completed', now(), now())`;
    const j = await executer(id);
    expect(j).toMatchObject({ status: 'DONE', business_result: 'SUPERSEDED' });
  });

  // ── Tentatives ───────────────────────────────────────────────────────────

  it('T3Q-16/17/18 : échecs 1 à 4 → PENDING (backoff) ; 5e exécution → FAILED ; exactement cinq exécutions', async () => {
    const compte = await make.account();
    await make.asset(compte);
    // Exécution compte déjà en cours hors file : chaque exécution échoue (erreur technique).
    await sql`INSERT INTO account_reconciliation_runs (account_id, trigger_type, correlation_id, scope, status, started_at)
              VALUES (${compte.id}, 'manual', 'e2e-31c', 'full', 'running', now())`;
    const id = await jobCompte(compte.id);
    let executions = 0;
    for (let n = 1; n <= 10; n++) {
      await seul(id);
      if (!(await runOne('T3'))) break;
      executions++;
      const j = await lire(id);
      if (n < 5) {
        expect(j, `exécution ${n}`).toMatchObject({ status: 'PENDING', attempts: n });
        expect(new Date(j.available_at).getTime()).toBeGreaterThan(Date.now()); // backoff
        expect(j.last_error).toMatch(/déjà en cours/);
      } else {
        expect(j, 'exécution 5').toMatchObject({ status: 'FAILED', attempts: 5 });
      }
    }
    expect(executions).toBe(5);
    await sql`UPDATE account_reconciliation_runs SET status = 'failed', finished_at = now() WHERE account_id = ${compte.id} AND status = 'running'`;
  });

  // ── Interruption ─────────────────────────────────────────────────────────

  for (const mode of ['désactivation', 'arrêt d’urgence'] as const) {
    it(`T3Q-19/20/21 (${mode}) : RUNNING → PENDING en tête, tentative non consommée, l’ancienne exécution n’écrit plus`, async () => {
      const compte = await make.account();
      const cible = 31_000 + (mode === 'désactivation' ? 1 : 2);
      const p = porte(cible);
      const id = await jobAttente(compte.id, cible);
      await seul(id);
      const execution = runOne('T3');
      await attendre(() => p.demarre);
      expect(await lire(id)).toMatchObject({ status: 'RUNNING', attempts: 1 });

      if (mode === 'désactivation') await repo.setTreatmentState('T3', 'DISABLED', admin.id, 'e2e 31C');
      else await repo.setEmergencyStop(true, admin.id, 'e2e 31C');
      p.ouvrir();
      expect(await execution).toBe(true);

      const j = await lire(id);
      expect(j).toMatchObject({ status: 'PENDING', head_priority: true, attempts: 0, execution_id: null, business_result: null }); // T3Q-19/20
      expect(p.ecrit).toBe(false); // T3Q-21 : garde avant écriture
      // Coupé : rien ne démarre.
      expect(await runOne('T3')).toBe(false);

      if (mode === 'désactivation') await repo.setTreatmentState('T3', 'ENABLED', admin.id);
      else await repo.setEmergencyStop(false, admin.id);
      portes.delete(cible); // reprise : passage direct
      const fini = await executer(id);
      expect(fini).toMatchObject({ status: 'DONE', attempts: 1, business_result: 'NO_CHANGE' });
    });
  }

  // ── Crash / bail expiré ─────────────────────────────────────────────────

  it('T3Q-22/23/24 : bail expiré → reprise en tête ; ancienne exécution dépossédée ; jamais deux exécutions simultanées', async () => {
    const compte = await make.account();
    const plusAncien = await jobAttente(compte.id, 31_010);
    await sql`UPDATE ai_job_queue SET created_at = now() - interval '1 hour' WHERE id = ${plusAncien}`;
    const id = await jobAttente(compte.id, 31_011);
    await seul(id);

    // Deux instances prélèvent ensemble : une seule obtient le job (T3Q-24).
    const [a, b] = await Promise.all([repo.claimNext('T3', 'instance-a', 60), repo.claimNext('T3', 'instance-b', 60)]);
    const pris = [a, b].filter((x) => x !== null);
    expect(pris).toHaveLength(1);
    const ancien = pris[0]!;
    expect(ancien.id).toBe(id);
    // Bail vivant : jamais repris.
    expect((await repo.recoverAbandonedJobs()).map((r) => r.id)).not.toContain(id);

    // Processus arrêté : le bail expire (T3Q-22).
    await sql`UPDATE ai_job_queue SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`;
    expect(await repo.recoverAbandonedJobs()).toEqual(expect.arrayContaining([{ id, status: 'PENDING' }]));
    expect(await lire(id)).toMatchObject({ status: 'PENDING', head_priority: true, recovered_count: 1, attempts: 1, execution_id: null });
    // L'ancienne exécution ne peut plus écrire ni clore.
    expect(await repo.isExecutionActive(id, ancien.executionId!)).toBe(false);
    expect(await repo.completeJob(id, ancien.executionId)).toEqual({ requeued: false, stale: true });

    // T3Q-23 : remis en tête, devant un travail plus ancien.
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${plusAncien}`;
    const suivant = await repo.claimNext('T3', 'instance-c', 60);
    expect(suivant?.id).toBe(id);
    expect(suivant?.attempts).toBe(2); // la tentative interrompue par le crash compte
    expect(await repo.completeJob(id, suivant!.executionId)).toEqual({ requeued: false });
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE id = ${plusAncien}`;
  });

  // ── Version de configuration ────────────────────────────────────────────

  it('T3Q-32 : configVersionId figée au démarrage', async () => {
    const compte = await make.account();
    const [v1] = await sql<{ id: number }[]>`INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'e2e 31C v1') RETURNING id`;
    const id = await jobAttente(compte.id, 31_020);
    await seul(id);
    const pris = await repo.claimNext('T3', 'e2e', 60, v1.id);
    expect(pris?.configVersionId).toBe(v1.id);
    await sql`INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'e2e 31C v2')`;
    expect((await lire(id)) as unknown as { config_version_id: number }).toMatchObject({ config_version_id: v1.id });
    await repo.completeJob(id, pris!.executionId);
  });

  // ── Observabilité ───────────────────────────────────────────────────────

  it('T3Q-33 : observabilité — tout le contrat est lisible depuis la liste de la file (BO)', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    await t3.enqueueT3ForAssets({ accountId: compte.id, userId: compte.ownerUserId, assetIds: [bien.id], sourceFileId: null, reason: 'DOCUMENT_DELETED' });
    const [{ id }] = await vivants(compte.id, 'asset', String(bien.id));
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${bien.id}`;
    await executer(id);
    const [j] = await repo.listJobs({ treatment: 'T3', accountId: compte.id, businessResult: 'TARGET_GONE' });
    expect(j).toMatchObject({
      id, accountId: compte.id, targetType: 'asset', targetId: String(bien.id), origin: 'automatic', triggerCode: 'document_linked',
      status: 'DONE', attempts: 1, recoveredCount: 0, businessResult: 'TARGET_GONE',
      payload: expect.objectContaining({ kind: 'asset', payloadVersion: 1 }),
    });
    for (const k of ['createdAt', 'availableAt', 'startedAt', 'finishedAt'] as const) expect(j[k], k).toBeInstanceOf(Date);
    expect(j.workerId).toEqual(expect.any(String));
    expect(j.executionId).toEqual(expect.any(String));
    expect(j).toHaveProperty('configVersionId');
    expect(j).toHaveProperty('lastError');
  });

  // ── Balayage ────────────────────────────────────────────────────────────

  it('T3Q-25/26/27/28/29 : schedule_hourly déclenche un balayage paginé, borné, sans compte perdu ni doublé', async () => {
    process.env.T3_SWEEP_PAGE_SIZE = '2';
    process.env.T3_SWEEP_PAGE_DELAY_SECONDS = '0';
    const miens: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await make.account();
      await make.asset(c);
      miens.push(c.id);
    }
    // Planification : défaut T3 = horaire, échue.
    await sql`UPDATE ai_job_queue SET created_at = created_at - interval '2 hours'
               WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL`;
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE treatment = 'T3' AND target_type = 't3_sweep' AND status IN ('PENDING', 'RUNNING')`;
    // Charge planifiée laissée par d'autres scénarios : elle reporterait les pages.
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED'
               WHERE treatment = 'T3' AND status = 'PENDING' AND account_id IS NOT NULL AND target_type IS NULL
                 AND trigger_code LIKE 'schedule%'`;
    const fired = await triggers.runDueSchedules();
    expect(fired).toEqual(expect.arrayContaining([{ treatment: 'T3', triggerCode: 'schedule_hourly' }])); // T3Q-25
    const [racine] = await sql<Job[]>`
      SELECT * FROM ai_job_queue WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL AND status = 'PENDING'
       ORDER BY id DESC LIMIT 1`;
    expect(racine).toMatchObject({ trigger_code: 'schedule_hourly', payload: expect.objectContaining({ payloadVersion: 1, kind: 'sweep' }) });

    const cycle = String(racine.id);
    const misEnFile: number[] = [];
    const parPage: number[] = [];
    const recolter = async () => {
      // Travaux compte de ce cycle : relevés puis écartés (on n'exécute que les pages).
      const rows = await sql<{ id: number; account_id: number }[]>`
        UPDATE ai_job_queue SET status = 'CANCELLED'
         WHERE treatment = 'T3' AND status = 'PENDING' AND target_type IS NULL AND account_id IS NOT NULL
           AND payload->>'sweepCycleId' = ${cycle}
        RETURNING id, account_id`;
      misEnFile.push(...rows.map((r) => Number(r.account_id)));
      parPage.push(rows.length);
    };
    let page: number | null = racine.id;
    for (let tour = 0; page != null && tour < 5000; tour++) {
      const j = await executer(page);
      expect(j.status).toBe('DONE');
      await recolter();
      const [suite] = await sql<{ id: number }[]>`
        SELECT id FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 't3_sweep'
           AND payload->>'cycleId' = ${cycle} AND status = 'PENDING' ORDER BY id LIMIT 1`;
      page = suite ? Number(suite.id) : null;
    }
    expect(page).toBeNull();
    expect(Math.max(...parPage)).toBeLessThanOrEqual(2); // T3Q-26 : fan-out borné
    const pages = await sql<Job[]>`SELECT * FROM ai_job_queue WHERE target_type = 't3_sweep' AND payload->>'cycleId' = ${cycle} ORDER BY id`;
    // T3Q-27 : curseurs strictement croissants, rangs consécutifs, dernière page marquée.
    const curseurs = pages.map((p) => Number(p.payload!.afterAccountId));
    expect(curseurs).toEqual([...curseurs].sort((x, y) => x - y));
    expect(new Set(curseurs).size).toBe(curseurs.length);
    expect(pages.map((p) => Number(p.payload!.page))).toEqual(pages.map((_, i) => i + 1));
    const derniere = pages.length ? pages[pages.length - 1] : racine;
    expect((await lire(derniere.id)).business_result_detail).toMatchObject({ last: true });
    // T3Q-28 / T3Q-29 : chacun de mes comptes exactement une fois dans le cycle.
    for (const c of miens) expect(misEnFile.filter((x) => x === c), `compte ${c}`).toHaveLength(1);
    expect(new Set(misEnFile).size).toBe(misEnFile.length);
  });
});
