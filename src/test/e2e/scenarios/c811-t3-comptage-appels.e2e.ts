/**
 * Carte #811 (écart P1-A du #596) — comptage des appels IA sur PostgreSQL réel,
 * passerelle réelle, fournisseur simulé (aucun appel réseau).
 *
 * Chaque cas exécute une ou plusieurs demandes dans une mesure
 * (`measureAiActivity`) puis CONCILIE le relevé avec les deux sources
 * indépendantes : les requêtes reçues par le fournisseur simulé
 * (`replay.calls`) et les lignes `ai_usage_event` de la base (par `traceId`).
 *
 *   C811-A01  rejet avant contact (aucun rang sollicitable, tarif non vérifié) : 0 requête, coût nul certain
 *   C811-A02  un appel réussi : 1 demande, 1 tentative, 1 requête, 1 événement, coût chiffré
 *   C811-A03  réponse du cache : 0 requête, 0 événement, coût non reporté
 *   C811-A04  demande simultanée partagée : 2 demandes, 1 requête
 *   C811-A05  repli à plusieurs tentatives : requêtes par modèle et par rang
 *   C811-A06  passe de réparation : tentative d'analyse et réparation distinguées
 *   C811-A07  délai dépassé sur tous les rangs : requêtes émises, coût INCONNU (jamais zéro)
 *   C811-A08  erreur réseau : même règle
 *   C811-A09  passage du compte (sous-phases, mémoire, passage sans appel) : journal, phases, file, rapport
 *             — mêmes nombres que les événements sources ; ancienne sémantique conservée et étiquetée
 *   C811-A10  historique : un passage antérieur n'est ni recalculé ni requalifié
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import type { RecordedOutput } from '../replay-gateway';
import type { AiActivitySnapshot } from '@/services/ai/measure/ai-activity';
import type { AiProvider, ProviderCallInput, ProviderCallOutput } from '@/services/ai/gateway/providers/provider.port';

const OP = 't3_value_conflict';
const sortie = { task: 'VALUE_CONFLICT', decision: 'abstain', chosenEvidenceId: null, confidence: 'conflictual', reason: 'Abstention (jeu de recette).' };
const reussite = (over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: OP, task: 'VALUE_CONFLICT', output: sortie, inputTokens: 1200, outputTokens: 40, ...over });
const variables = (n: string) => ({
  FIELD: 'constructionYear', CURRENT_STATE: { value: null, origin: 'USER', protected: false }, EVIDENCES: [{ evidenceId: 1, value: 1948, cas: n }],
  SUBJECT_CONTEXT: null, CANDIDATES: null, RELATION_TYPE: null,
});

scenario('C811-A', 'T3 — comptage des appels : la mesure se concilie avec le fournisseur et les événements d’usage', ({ sql, make, useRecordings }) => {
  const avant = process.env.AI_IDEMPOTENCY_DISABLED;
  let mesurer: typeof import('@/services/ai/measure/ai-activity').measureAiActivity;
  let executer: (accountId: number, cas: string, over?: Record<string, unknown>) => Promise<{ traceId: string; fromCache: boolean; costMicros: number }>;
  beforeAll(async () => {
    process.env.AI_IDEMPOTENCY_DISABLED = 'false';
    ({ measureAiActivity: mesurer } = await import('@/services/ai/measure/ai-activity'));
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const { T3ValueConflictOutput } = await import('@/services/ai/reconciliation/master/t3-contract');
    executer = async (accountId, cas, over = {}) => AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION', operationCode: OP, accountId, promptVariables: variables(cas),
      outputSchema: T3ValueConflictOutput, idempotencyKey: `c811:a${accountId}:${cas}`, ...over,
    }) as Promise<{ traceId: string; fromCache: boolean; costMicros: number }>;
  });
  afterAll(() => { process.env.AI_IDEMPOTENCY_DISABLED = avant; });

  /** Événements d'usage de la base pour les traces du relevé (source autoritative). */
  const sources = async (a: AiActivitySnapshot) => {
    if (a.traceIds.length === 0) return { events: 0, requests: 0, cost: 0, withoutSend: 0 };
    const [r] = await sql<Array<{ events: number; requests: number; cost: string; without_send: number }>>`
      SELECT count(*)::int AS events,
             coalesce(sum((metadata->>'networkRequests')::int), 0)::int AS requests,
             coalesce(sum(cost_micros), 0)::bigint AS cost,
             count(*) FILTER (WHERE (metadata->>'networkRequests')::int = 0)::int AS without_send
        FROM ai_usage_event WHERE metadata->>'traceId' = ANY(${a.traceIds})`;
    return { events: r.events, requests: r.requests, cost: Number(r.cost), withoutSend: r.without_send };
  };
  /** Rapprochement complet : relevé = fournisseur simulé = événements d'usage. */
  const concilier = async (a: AiActivitySnapshot, fournisseur: number) => {
    const s = await sources(a);
    expect(a.total.networkRequests, 'requêtes émises = requêtes reçues par le fournisseur').toBe(fournisseur);
    expect(s.requests, 'requêtes émises = somme des événements d’usage').toBe(a.total.networkRequests);
    expect(s.events, 'événements d’usage').toBe(a.total.usageEvents);
    expect(s.withoutSend, 'événements sans envoi').toBe(a.total.usageEventsWithoutSend);
    expect(s.cost, 'coût chiffré = coût des événements').toBe(a.total.costObservedMicros + a.total.costEstimatedMicros);
    // Aucune dimension ne compte deux fois : chaque axe redonne le total.
    for (const axe of [a.byTreatment, a.byOperation, a.byPhase]) {
      expect(Object.values(axe).reduce((n, c) => n + c.networkRequests, 0)).toBe(a.total.networkRequests);
      expect(Object.values(axe).reduce((n, c) => n + c.logicalRequests, 0)).toBe(a.total.logicalRequests);
    }
    expect(a.byModelRank.reduce((n, m) => n + m.networkRequests, 0)).toBe(a.total.networkRequests);
    return s;
  };

  it('C811-A01 : rejet avant contact — aucune requête, coût nul certain, jamais « inconnu »', async () => {
    const c = await make.account();
    const r = await useRecordings([reussite({ repeat: true })]);
    // (a) aucun rang sollicitable (budget de tentatives nul) : la demande échoue sans événement d'usage.
    const m1 = await mesurer(async () => { await expect(executer(c.id, 'a01-budget', { maxModelAttempts: 0 })).rejects.toThrow(); });
    expect(m1.activity.total).toMatchObject({ logicalRequests: 1, requestsWithoutContact: 1, networkRequests: 0, usageEvents: 0, costUnknownEvents: 0 });
    await concilier(m1.activity, 0);
    // (b) tarif non vérifié : chaque rang est tracé « non sollicité » (événement d'usage SANS envoi).
    const prix = await import('@/services/ai/gateway/pricing/pricing.repository');
    prix.__setVerifiedTestPricesForTests(false);
    let m2: Awaited<ReturnType<typeof mesurer>>;
    try {
      m2 = await mesurer(async () => { await expect(executer(c.id, 'a01-tarif')).rejects.toThrow(); });
    } finally { prix.__setVerifiedTestPricesForTests(true); }
    expect(m2.activity.total).toMatchObject({ logicalRequests: 1, requestsWithoutContact: 1, networkRequests: 0, providerAttempts: 0, costUnknownEvents: 0, costObservedMicros: 0 });
    expect(m2.activity.total.usageEvents).toBeGreaterThan(0);
    expect(m2.activity.total.usageEventsWithoutSend).toBe(m2.activity.total.usageEvents);
    await concilier(m2.activity, 0);
    expect(r.calls).toHaveLength(0);
  });

  it('C811-A02 / A03 : un appel réussi, puis la même demande servie par le cache (ni requête, ni événement, ni coût reporté)', async () => {
    const c = await make.account();
    const r = await useRecordings([reussite()]);
    // Tarif confirmé (non nul) pour le modèle principal : le coût de l'appel est OBSERVÉ et chiffré.
    const prix = await import('@/services/ai/gateway/pricing/pricing.repository');
    prix.primePricingCache([{
      provider: 'gemini', model: 'gemini-3.1-flash-lite', inputMicros: 250_000, outputMicros: 1_500_000, currency: 'USD',
      source: 'billing_api', sourceReference: 'test:c811', verified: true, fetchedAt: new Date(),
    }]);
    let m1: { result: { traceId: string; fromCache: boolean; costMicros: number }; activity: AiActivitySnapshot };
    try { m1 = await mesurer(() => executer(c.id, 'a02')); } finally { prix.clearPricingCache(); }
    expect(m1.result.fromCache).toBe(false);
    expect(m1.activity.total).toMatchObject({
      logicalRequests: 1, requestsWithoutContact: 0, cacheResponses: 0, sharedResponses: 0, usageEvents: 1, usageEventsWithoutSend: 0,
      providerAttempts: 1, repairAttempts: 0, networkRequests: 1, inputTokens: 1200, outputTokens: 40, costUnknownEvents: 0,
    });
    expect(m1.activity.byTreatment).toHaveProperty('T3');
    expect(m1.activity.byOperation[OP].networkRequests).toBe(1);
    expect(m1.activity.byModelRank).toMatchObject([{ rank: 'primary', attempts: 1, networkRequests: 1, succeeded: 1, failed: 0 }]);
    const s1 = await concilier(m1.activity, 1);
    expect(s1.cost).toBeGreaterThan(0);
    expect(s1.cost).toBe(m1.result.costMicros);
    expect(m1.activity.total).toMatchObject({ costObservedMicros: s1.cost, costEstimatedMicros: 0 });

    const m2 = await mesurer(() => executer(c.id, 'a02'));
    expect(m2.result.fromCache).toBe(true);
    // La réponse du cache porte encore le coût de l'appel d'origine : la mesure ne le reporte pas.
    expect(m2.result.costMicros).toBe(m1.result.costMicros);
    expect(m2.activity.total).toMatchObject({
      logicalRequests: 1, cacheResponses: 1, networkRequests: 0, providerAttempts: 0, usageEvents: 0,
      costObservedMicros: 0, costEstimatedMicros: 0, costUnknownEvents: 0, inputTokens: 0,
    });
    expect(r.calls).toHaveLength(1);
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM ai_usage_event WHERE account_id = ${c.id} AND operation_code = ${OP}`;
    expect(n).toBe(1);
  });

  it('C811-A04 : deux demandes identiques simultanées → une seule requête, la seconde est « partagée »', async () => {
    const c = await make.account();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    const appels: ProviderCallInput[] = [];
    const lent: AiProvider = {
      name: 'replay', isConfigured: () => true,
      call: async (i: ProviderCallInput): Promise<ProviderCallOutput> => {
        appels.push(i);
        await new Promise((res) => setTimeout(res, 400));
        return { rawText: JSON.stringify(sortie), inputTokens: 900, outputTokens: 30 };
      },
    };
    setAiProvider(lent);
    try {
      const m = await mesurer(() => Promise.all([executer(c.id, 'a04'), executer(c.id, 'a04')]));
      expect(appels).toHaveLength(1);
      expect(m.result.filter((x) => x.fromCache)).toHaveLength(1);
      expect(m.activity.total).toMatchObject({ logicalRequests: 2, sharedResponses: 1, cacheResponses: 0, networkRequests: 1, providerAttempts: 1, usageEvents: 1 });
      await concilier(m.activity, 1);
    } finally { await useRecordings([]); }
  });

  it('C811-A05 : repli — deux tentatives, deux requêtes, attribuées par modèle et par rang', async () => {
    const c = await make.account();
    const r = await useRecordings([
      reussite({ output: '', error: { message: '503 Service Unavailable', status: 503 } }),
      reussite(),
    ]);
    const m = await mesurer(() => executer(c.id, 'a05'));
    expect(r.calls).toHaveLength(2);
    expect(m.activity.total).toMatchObject({ logicalRequests: 1, providerAttempts: 2, repairAttempts: 0, networkRequests: 2, usageEvents: 2, costUnknownEvents: 0 });
    expect(m.activity.byModelRank.map((x) => [x.rank, x.attempts, x.networkRequests, x.succeeded, x.failed])).toEqual([
      ['primary', 1, 1, 0, 1], ['fallback_1', 1, 1, 1, 0],
    ]);
    await concilier(m.activity, 2);
    // Ce que l'ancienne règle annonçait : UN appel (la réponse dit seulement « repli utilisé »).
    const rangs = await sql<Array<{ model_rank: string; status: string; n: number }>>`
      SELECT model_rank, status, (metadata->>'networkRequests')::int AS n FROM ai_usage_event WHERE metadata->>'traceId' = ${m.result.traceId} ORDER BY id`;
    expect(rangs.map((x) => [x.model_rank, x.status, x.n])).toEqual([['primary', 'error', 1], ['fallback_1', 'success', 1]]);
  });

  it('C811-A06 : réparation — une tentative d’analyse et une passe de réparation, deux requêtes, sans double compte', async () => {
    const c = await make.account();
    const r = await useRecordings([
      reussite({ output: { ...sortie, confidence: 'peut-être' } }),
      reussite({ callKind: 'repair', inputTokens: 300, outputTokens: 20 }),
    ]);
    const m = await mesurer(() => executer(c.id, 'a06'));
    expect(r.calls).toHaveLength(2);
    expect(m.activity.total).toMatchObject({ logicalRequests: 1, providerAttempts: 1, repairAttempts: 1, networkRequests: 2, usageEvents: 2, inputTokens: 1500, outputTokens: 60 });
    await concilier(m.activity, 2);
  });

  it('C811-A07 / A08 : délai dépassé, erreur réseau — requêtes comptées, coût INCONNU (jamais présenté comme nul)', async () => {
    const c = await make.account();
    const delai = await useRecordings([reussite({ output: '', error: { message: 'délai dépassé', code: 'TIMEOUT', recoverable: true }, repeat: true })]);
    const m1 = await mesurer(async () => { await expect(executer(c.id, 'a07')).rejects.toThrow(); });
    expect(delai.calls.length).toBeGreaterThan(0);
    expect(m1.activity.total).toMatchObject({ logicalRequests: 1, requestsWithoutContact: 0, costObservedMicros: 0, costEstimatedMicros: 0 });
    expect(m1.activity.total.costUnknownEvents).toBe(m1.activity.total.providerAttempts);
    expect(m1.activity.total.providerAttempts).toBeGreaterThan(0);
    await concilier(m1.activity, delai.calls.length);

    const reseau = await useRecordings([reussite({ output: '', error: { message: 'fetch failed : ECONNRESET', code: 'ECONNRESET' }, repeat: true })]);
    const m2 = await mesurer(async () => { await expect(executer(c.id, 'a08')).rejects.toThrow(); });
    expect(reseau.calls.length).toBeGreaterThan(0);
    expect(m2.activity.total.requestsWithoutContact).toBe(0);
    expect(m2.activity.total.costUnknownEvents).toBe(m2.activity.total.providerAttempts);
    await concilier(m2.activity, reseau.calls.length);
  });

  // ── Passage du compte : sous-phases, mémoire, passage sans appel ─────────────────────────────────────────────
  const trace = { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'] };
  const annee = (assetId: number, value: number): ProjectedFact => ({
    canonicalKey: 'constructionYear', rawKey: 'Année de construction', label: null, subject: null, attribute: null,
    rawValue: String(value), value, valueType: 'number', canonicalUnit: null,
    target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
    provenance: 'TEXT_EXTRACTION', confidence: 'probable', evidence: { excerpt: `Construit vers ${value}`, page: 1 },
    semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
  });

  it('C811-A09 : passage du compte — journal, phases, file et rapport annoncent la mesure ; repli compté ; passage suivant sans appel', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    const f = await make.assetFile(c as never, { assetId: bien.id });
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [f.id], accountId: c.id, userId: c.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: f.id, trace, analysisRunId: 98111, documentType: 'DIAGNOSTIC', facts: [annee(bien.id, 1948)],
    });
    // Premier arbitrage : le modèle principal échoue (503), le repli répond → UNE demande, DEUX requêtes.
    const r = await useRecordings([
      reussite({ output: '', error: { message: '503 Service Unavailable', status: 503 } }),
      reussite({ repeat: true }),
    ]);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const { reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine');
    const { runT3Job } = await import('@/services/ai/reconciliation/t3-queue');
    const job = (id: number) => ({ id, accountId: c.id, targetType: null, targetId: null, treatment: 'T3', origin: 'manual', triggerCode: 'manual', payload: { payloadVersion: 1, kind: 'account', scope: 'full' }, createdAt: new Date(0), startedAt: new Date(), executionId: null });
    const deps = { reconcileAsset, reconcileAccount, enqueue: (async () => ({ jobId: null })) as never, listSweepAccounts: async () => [] };
    const garde = { assertActive: async () => {} } as never;

    const t3 = () => r.calls.filter((x) => x.operationCode === OP).length;
    const res1 = await runT3Job(job(981101) as never, garde, deps);
    expect(t3()).toBe(2);
    const d1 = res1.detail as Record<string, unknown>;
    const fournisseur1 = r.calls.length;
    // File IA : `aiCalls` = requêtes réellement émises (2), pas la demande déclarée (1).
    expect(d1).toMatchObject({ aiCountersSemantics: 'MEASURED_V1', aiCalls: fournisseur1, withoutAiCall: false });
    expect(Number(d1.aiDeclaredRequests)).toBeLessThan(Number(d1.aiCalls));
    expect(Number(d1.aiLogicalRequests)).toBeGreaterThanOrEqual(1);
    expect(d1.aiActivity).toMatchObject({ semantics: 'ai-activity-v1', total: { networkRequests: fournisseur1 } });

    const [j1] = await sql<Array<{
      provider_calls: number; ai_counters_semantics: string; ai_requests_declared: number; ai_logical_requests: number; provider_attempts: number;
      provider_calls_other_treatments: number; ai_activity: AiActivitySnapshot; phases_json: Record<string, { counts?: Record<string, number> }>; ai_calls: number;
    }>>`SELECT provider_calls, ai_counters_semantics, ai_requests_declared, ai_logical_requests, provider_attempts,
               provider_calls_other_treatments, ai_activity, phases_json, ai_calls
          FROM account_reconciliation_runs WHERE id = ${Number(d1.runId)}`;
    expect(j1).toMatchObject({ provider_calls: fournisseur1, ai_counters_semantics: 'MEASURED_V1', provider_attempts: fournisseur1 });
    // T3 et autres traitements distingués : la somme redonne le total.
    const t3Mesure = j1.ai_activity.byTreatment.T3?.networkRequests ?? 0;
    expect(t3Mesure).toBe(2);
    expect(j1.provider_calls_other_treatments).toBe(j1.provider_calls - t3Mesure);
    // Le journal du passage se concilie avec les événements d'usage sources.
    const s = await sources(j1.ai_activity);
    expect(s.requests).toBe(j1.provider_calls);
    expect(s.events).toBe(j1.ai_activity.total.usageEvents);
    // Phases : la revue des biens porte les deux requêtes ; `aiCalls` d'une phase reste sa demande déclarée.
    expect(j1.phases_json.ASSETS.counts).toMatchObject({ providerNetworkRequests: 2, aiLogicalRequests: 1, providerAttempts: 2 });
    expect(Object.values(j1.ai_activity.byPhase).reduce((n, x) => n + x.networkRequests, 0)).toBe(j1.provider_calls);
    // Run local et rapport d'exécution : même vérité.
    const [local] = await sql<Array<{ id: number; provider_calls: number; ai_counters_semantics: string; ai_requests_declared: number }>>`
      SELECT id, provider_calls, ai_counters_semantics, ai_requests_declared FROM reconciliation_runs WHERE account_id = ${c.id} AND asset_id = ${bien.id} ORDER BY id LIMIT 1`;
    expect(local).toMatchObject({ provider_calls: 2, ai_counters_semantics: 'MEASURED_V1', ai_requests_declared: 1 });
    const [rapport] = await sql<Array<{ counters: Record<string, number>; sources: { aiUsage: Record<string, unknown> } }>>`
      SELECT counters, sources FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T3' AND reconciliation_run_id = ${local.id}`;
    expect(rapport.counters).toMatchObject({ aiProviderCalls: 2, aiLogicalRequests: 1, aiProviderAttempts: 2, aiDeclaredRequests: 1, aiUsageEvents: 2 });
    expect(rapport.sources.aiUsage).toMatchObject({ providerCalls: 2, semantics: 'MEASURED_V1', declaredRequests: 1, withoutAiCall: false });

    // Passage suivant, contexte identique : décision de la mémoire, aucune demande, aucune requête.
    const avant2 = r.calls.length;
    const res2 = await runT3Job(job(981102) as never, garde, deps);
    expect(r.calls.length).toBe(avant2);
    const d2 = res2.detail as Record<string, unknown>;
    expect(d2).toMatchObject({ aiCountersSemantics: 'MEASURED_V1', aiCalls: 0, withoutAiCall: true, aiLogicalRequests: 0 });
    expect(Number(d2.aiDecisionsReused)).toBeGreaterThanOrEqual(1);
    const [j2] = await sql<Array<{ provider_calls: number; ai_counters_semantics: string; decisions_reused: number; ai_activity: AiActivitySnapshot }>>`
      SELECT provider_calls, ai_counters_semantics, decisions_reused, ai_activity FROM account_reconciliation_runs WHERE id = ${Number(d2.runId)}`;
    expect(j2).toMatchObject({ provider_calls: 0, ai_counters_semantics: 'MEASURED_V1' });
    expect(j2.decisions_reused).toBeGreaterThanOrEqual(1);
    expect(j2.ai_activity.total).toMatchObject({ decisionsReused: 1, networkRequests: 0, usageEvents: 0 });
  });

  it('C811-A10 : historique — un passage antérieur garde ses valeurs et reste « ancienne sémantique »', async () => {
    const c = await make.account();
    const [ancien] = await sql<Array<{ id: number }>>`
      INSERT INTO account_reconciliation_runs (account_id, trigger_type, correlation_id, scope, status, started_at, finished_at, ai_calls, provider_calls, ai_cache_hits, decisions_reused)
      VALUES (${c.id}, 'scheduled', gen_random_uuid(), 'incremental', 'completed', now() - interval '3 days', now() - interval '3 days', 4, 7, 1, 2) RETURNING id`;
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    await useRecordings([]);
    const p = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
    expect(p).toMatchObject({ aiCountersSemantics: 'MEASURED_V1', providerCalls: 0 });
    const lignes = await sql<Array<{ id: number; provider_calls: number | null; ai_counters_semantics: string | null; ai_activity: unknown; ai_requests_declared: number | null }>>`
      SELECT id, provider_calls, ai_counters_semantics, ai_activity, ai_requests_declared FROM account_reconciliation_runs WHERE account_id = ${c.id} ORDER BY id`;
    expect(lignes.find((l) => Number(l.id) === Number(ancien.id))).toMatchObject({ provider_calls: 7, ai_counters_semantics: null, ai_activity: null, ai_requests_declared: null });
    expect(lignes.find((l) => Number(l.id) === p.runId)).toMatchObject({ provider_calls: 0, ai_counters_semantics: 'MEASURED_V1' });
  });
});
