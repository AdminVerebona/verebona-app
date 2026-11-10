/**
 * Lot 113AF (Trello #730) sur PostgreSQL 16 réel — « Fiabiliser la
 * comptabilisation des coûts fournisseur, métier et techniques (T1–T6) ».
 * Fournisseur SIMULÉ (rejeu, aucun réseau) DERRIÈRE la passerelle réelle.
 *
 *  L113AF-E01 (migration)     1610 additive et rejouable
 *  L113AF-E02 (crit. 1, 3, 4) passerelle : t3_link_ambiguity (billable:false) → métier imputable écrit à la source ;
 *                             cache d'idempotence = 0 appel payant ; observation et compte technique jamais imputés
 *  L113AF-E03 (crit. 1-3, 5, 6) rapport BO sur un jeu de traces représentatif AVANT reclassement : fournisseur =
 *                             métier + technique + non déterminable, reclassé, inconnu par segment, ventilations
 *  L113AF-E04 (crit. 1, 3)    budgets globaux et T1–T6 sur la dépense métier complète (sondes, corpus, observation exclus),
 *                             alertes seulement
 *  L113AF-E05 (crit. 7)       plafond par compte : cumul métier (T3/T4 compris), exemptions techniques, 80 %, 100 %,
 *                             plafond 0 désactivé, abstention T3 sans appel, date de reprise T1 (1er, Paris)
 *  L113AF-E06 (crit. 5, 6, 8, 9) rattrapage BO : simuler (rien écrit) / appliquer (idempotent) / restaurer ;
 *                             coûts persistés et régularisation utilisés, jamais recalculés ; réconciliation traces ↔
 *                             agrégats ↔ rapport ; chevauchement détecté ; quotas et is_billable intacts
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

const WINDOW = { since: new Date('2024-05-01T00:00:00Z'), until: new Date('2024-05-31T23:59:59Z') };

scenario('L113AF', 'Coûts IA : origine métier / technique, rapport, budgets, plafonds, rattrapage', ({ sql, make, useRecordings }) => {
  let A = 0; let B = 0; let C = 0; let T = 0;
  const ev: Record<string, number> = {};

  beforeAll(async () => {
    A = (await make.account()).id;
    B = (await make.account()).id;
    C = (await make.account()).id;
    const [deja] = await sql<{ id: number }[]>`SELECT id FROM accounts WHERE technical_kind = 'AI_QUALIFICATION_CORPUS' LIMIT 1`;
    T = deja ? Number(deja.id) : (await make.account()).id;
    if (!deja) await sql`UPDATE accounts SET technical_kind = 'AI_QUALIFICATION_CORPUS' WHERE id = ${T}`;
    // Tarifs connus des modèles de la famille documentaire (coût calculé > 0).
    for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-pro']) {
      await sql`INSERT INTO ai_model_pricing (provider, model, input_micros, output_micros, currency, source, verified, effective_from)
                VALUES ('gemini', ${model}, 0.1, 0.4, 'USD', 'public_catalog', TRUE, NOW() - interval '1 minute')`;
    }
    const P = await import('@/services/ai/gateway/pricing/pricing.repository');
    await P.loadPricingCache();
    (await import('@/services/ai/cost/cost-classification.store')).__resetCostClassificationStoreForTests();
  });
  afterAll(async () => {
    (await import('@/services/ai/gateway/account-cost-cap')).setCostCapStoreForTests(null);
  });

  const usage = (row: {
    account: number | null; op: string; uc: string | null; billable: boolean; cost: number | null; at: string;
    meta?: Record<string, unknown>; tokens?: [number, number]; status?: string; model?: string;
  }) => sql<{ id: number }[]>`
    INSERT INTO ai_usage_event (account_id, operation_type, operation_code, use_case_code, provider, model, is_billable,
                                input_tokens, output_tokens, cost_micros, status, metadata, created_at)
    VALUES (${row.account}, ${row.op}, ${row.op}, ${row.uc}, 'gemini', ${row.model ?? 'gemini-3.1-flash-lite'}, ${row.billable},
            ${row.tokens?.[0] ?? 1000}, ${row.tokens?.[1] ?? 100}, ${row.cost}, ${row.status ?? 'success'},
            ${JSON.stringify({ shadow: false, ...(row.meta ?? {}), pricing: { inputMicros: 0.1, outputMicros: 0.4 } })}::jsonb, ${row.at})
    RETURNING id`.then((r) => Number(r[0].id));

  it('L113AF-E01 — migration 1610 : additive, rejouable', async () => {
    const texte = await readFile(join(process.cwd(), 'src/db/migrations', '1610_l113af_classification_couts_ia.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = {
        unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown>,
        reserve: async () => {
          const r = await sql.reserve();
          return { unsafe: (q: string, p?: never[]) => r.unsafe(q, p as never) as unknown as Promise<unknown>, release: () => r.release() };
        },
      };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const [n] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_name IN ('ai_usage_event', 'ai_usage_daily_rollup') AND column_name IN ('cost_origin', 'cost_imputable', 'cost_class')`;
    expect(n.n).toBe(6);
  });

  it('L113AF-E02 — passerelle (modèle simulé, compteur) : étape hors quota = métier écrit à la source ; cache = 0 appel payant', async () => {
    const replay = await useRecordings([
      { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, inputTokens: 2_000, outputTokens: 120, repeat: true },
    ]);
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const { T3LinkAmbiguityOutput } = await import('@/services/ai/reconciliation/master/t3-contract');
    const appel = (accountId: number, over: Record<string, unknown> = {}) => AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION', operationCode: 't3_link_ambiguity', accountId,
      promptVariables: { FIELD: null, CURRENT_STATE: null, EVIDENCES: null, SUBJECT_CONTEXT: 'Chaudière', CANDIDATES: [{ candidateId: 1, description: 'facture' }], RELATION_TYPE: 'EQUIPMENT_DOCUMENT' },
      outputSchema: T3LinkAmbiguityOutput, idempotencyKey: `l113af-${accountId}-${String(over.k ?? 'a')}`, ...over,
    });
    // Le harnais coupe l'idempotence (setup.ts) : rétablie ici pour vérifier que le cache n'engendre aucun appel payant.
    const idemAvant = process.env.AI_IDEMPOTENCY_DISABLED;
    process.env.AI_IDEMPOTENCY_DISABLED = 'false';
    const avant = replay.calls.length;
    const r = await appel(A);
    expect(r.fromCache).toBe(false);
    expect(replay.calls.length - avant).toBe(1);
    const [ligne] = await sql<Array<{ is_billable: boolean; cost_micros: number | null; cost_origin: string; cost_imputable: boolean; cost_class: Record<string, unknown> }>>`
      SELECT is_billable, cost_micros, cost_origin, cost_imputable, cost_class FROM ai_usage_event WHERE metadata->>'traceId' = ${r.traceId}`;
    expect(ligne).toMatchObject({ is_billable: false, cost_origin: 'ACCOUNT_SERVICE', cost_imputable: true });
    expect(Number(ligne.cost_micros)).toBeGreaterThan(0);
    expect(ligne.cost_class).toMatchObject({ rule: 'couts-ia-v1', reason: 'REGISTRY_OPERATION', source: 'source', legacyBillable: false });

    // Même demande : servie par le cache d'idempotence — aucun appel fournisseur, aucune nouvelle dépense.
    const lignesAvant = (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_usage_event WHERE account_id = ${A}`)[0].n;
    const bis = await appel(A);
    expect(bis.fromCache).toBe(true);
    expect(replay.calls.length - avant).toBe(1);
    expect((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_usage_event WHERE account_id = ${A}`)[0].n).toBe(lignesAvant);
    process.env.AI_IDEMPOTENCY_DISABLED = idemAvant;

    // Observation et compte technique (contexte serveur vérifié) : coût fournisseur présent, jamais imputé.
    const ombre = await appel(B, { shadow: true, k: 'shadow' });
    const { runWithTechnicalAccount } = await import('@/services/ai/qualification/technical-context');
    const tech = await runWithTechnicalAccount({ ok: true, accountId: T }, 'e2e l113af', () => appel(T, { k: 'tech' }));
    const classes = await sql<Array<{ t: string; cost_origin: string; cost_imputable: boolean; cost_micros: number }>>`
      SELECT metadata->>'traceId' AS t, cost_origin, cost_imputable, cost_micros FROM ai_usage_event
       WHERE metadata->>'traceId' IN (${ombre.traceId}, ${tech.traceId})`;
    expect(classes.find((c) => c.t === ombre.traceId)).toMatchObject({ cost_origin: 'SHADOW', cost_imputable: false });
    expect(classes.find((c) => c.t === tech.traceId)).toMatchObject({ cost_origin: 'TECHNICAL', cost_imputable: false });
    for (const c of classes) expect(Number(c.cost_micros)).toBeGreaterThan(0);
  });

  it('L113AF-E03 — rapport BO sur un jeu représentatif (avant reclassement) : segments, reclassé, inconnu, ventilations', async () => {
    const at = '2024-05-02T10:00:00Z';
    ev.groupUpload = await usage({ account: A, op: 't1_group_upload', uc: 'SOURCE_ANALYSIS', billable: false, cost: 300, at });
    ev.analyze = await usage({ account: A, op: 't1_analyze_document', uc: 'SOURCE_ANALYSIS', billable: true, cost: 2_000, at });
    ev.understand = await usage({ account: A, op: 't2_understand', uc: 'INTELLIGENT_ASSISTANT', billable: false, cost: 100, at });
    ev.period = await usage({ account: B, op: 't3_period_relation', uc: 'DATA_RECONCILIATION', billable: false, cost: 50, at });
    ev.t4 = await usage({ account: B, op: 't4_classify_event', uc: 'AGENDA_INTELLIGENCE', billable: false, cost: 40, at });
    ev.t6 = await usage({ account: B, op: 't6_formulate', uc: 'HOME_MASCOT', billable: false, cost: 10, at });
    ev.unknown = await usage({ account: B, op: 't3_link_ambiguity', uc: 'DATA_RECONCILIATION', billable: false, cost: null, at, model: 'gemini-l113af-sans-tarif' });
    ev.probe = await usage({ account: null, op: 'circuit_breaker_probe', uc: 'SOURCE_ANALYSIS', billable: false, cost: 70, at });
    ev.providerTest = await usage({ account: A, op: 'provider_test', uc: 'AI_GOVERNANCE', billable: false, cost: 5, at });
    ev.shadow = await usage({ account: A, op: 't1_analyze_document', uc: 'SOURCE_ANALYSIS', billable: false, cost: 500, at, meta: { shadow: true } });
    ev.corpus = await usage({ account: T, op: 't1_analyze_document', uc: 'SOURCE_ANALYSIS', billable: true, cost: 800, at });
    ev.qualif = await usage({ account: A, op: 't2_answer', uc: 'INTELLIGENT_ASSISTANT', billable: true, cost: 60, at, meta: { trigger: 'qualification' } });
    ev.retired = await usage({ account: A, op: 'resolve_ambiguity', uc: 'DATA_RECONCILIATION', billable: false, cost: 25, at });
    ev.refus = await usage({ account: A, op: 't3_value_conflict', uc: 'DATA_RECONCILIATION', billable: false, cost: 0, at, tokens: [0, 0], status: 'error' });
    await sql`INSERT INTO ai_usage_daily_rollup (day, use_case_code, account_id, model, is_billable, calls, failed_calls, unpriced_calls, input_tokens, output_tokens, cost_micros)
              VALUES ('2024-05-03', 'SOURCE_ANALYSIS', ${A}, 'gemini-3.1-flash-lite', TRUE, 4, 0, 0, 4000, 400, 1000),
                     ('2024-05-03', 'DATA_RECONCILIATION', ${A}, 'gemini-3.1-flash-lite', FALSE, 3, 0, 0, 3000, 300, 60),
                     ('2024-05-03', 'AI_GOVERNANCE', NULL, 'gemini-3.1-flash-lite', FALSE, 2, 0, 0, 200, 20, 7),
                     ('2024-05-03', 'SOURCE_ANALYSIS', NULL, 'gemini-3.1-flash-lite', FALSE, 1, 0, 0, 100, 10, 3)`;

    const { getCostReport } = await import('@/services/ai/telemetry/cost-report.repository');
    const r = await getCostReport(WINDOW);
    const t = r.totals;
    // Métier = T1 regroupement + analyse + T2 compréhension + T3 + T4 + T6 (+ agrégat facturé) — billable:false compris.
    expect(t.functionalMicros).toBe(300 + 2_000 + 100 + 50 + 40 + 10 + 1_000);
    // Technique = sonde + test fournisseur + observation + corpus + qualification + agrégats techniques.
    expect(t.technicalMicros).toBe(70 + 5 + 500 + 800 + 60 + 7 + 3);
    expect(t.shadowMicros).toBe(500);
    expect(t.undeterminedMicros).toBe(25 + 60);
    expect(t.providerMicros).toBe(t.functionalMicros + t.technicalMicros + (t.undeterminedMicros ?? 0));
    expect(t.reclassifiedBusinessMicros).toBe(300 + 100 + 50 + 40 + 10);
    // Coût inconnu : jamais zéro, compté à part dans le segment métier ; total partiel.
    expect(t.unpricedBusinessCalls).toBe(1);
    expect(t.completeness).toBe('partial');
    expect(t.classification).toBe('classified');
    expect(t.provisionalRows).toBe(14 + 4 + 3 + 2 + 1);
    // Ventilations : par compte (pas de coût technique imputé au compte du corpus en métier), par étape, par origine.
    const compte = (id: number) => r.byAccount.find((x) => x.key === String(id));
    expect(compte(A)).toMatchObject({ functionalMicros: 300 + 2_000 + 100 + 1_000 });
    expect(compte(B)).toMatchObject({ functionalMicros: 100 });
    expect(compte(T)).toMatchObject({ functionalMicros: 0, technicalMicros: 800 });
    expect(r.byOperation?.find((x) => x.key === 't3_period_relation')).toMatchObject({ functionalMicros: 50, technicalMicros: 0 });
    expect(r.byOperation?.find((x) => x.key === '__rollup__')).toMatchObject({ calls: 10 });
    expect(r.byOrigin?.find((x) => x.key === 'UNDETERMINED:NOT_CLASSIFIABLE')).toMatchObject({ undeterminedMicros: 85 });
    expect(r.byOrigin?.find((x) => x.key === 'TECHNICAL:TECHNICAL_ACCOUNT')).toMatchObject({ technicalMicros: 800 });
    expect(r.byDay?.map((d) => d.key)).toEqual(['2024-05-03', '2024-05-02']);
    // Somme des ventilations = total (aucune perte, aucun double comptage).
    const somme = (rows: Array<{ functionalMicros: number; technicalMicros: number; undeterminedMicros?: number }>) =>
      rows.reduce((n, x) => n + x.functionalMicros + x.technicalMicros + (x.undeterminedMicros ?? 0), 0);
    expect(somme(r.byTreatment)).toBe(t.providerMicros);
    expect(somme(r.byOrigin ?? [])).toBe(t.providerMicros);
    expect(somme(r.byDay ?? [])).toBe(t.providerMicros);
  });

  it('L113AF-E04 — budgets sur la dépense métier complète : alertes seulement, sondes / corpus / observation exclus', async () => {
    await sql`DELETE FROM ai_usage_event WHERE created_at >= date_trunc('month', NOW())`;
    const now = new Date().toISOString();
    await usage({ account: A, op: 't3_link_ambiguity', uc: 'DATA_RECONCILIATION', billable: false, cost: 400, at: now });
    await usage({ account: A, op: 't1_analyze_document', uc: 'SOURCE_ANALYSIS', billable: true, cost: 600, at: now });
    await usage({ account: null, op: 'circuit_breaker_probe', uc: 'DATA_RECONCILIATION', billable: false, cost: 5_000, at: now });
    await usage({ account: A, op: 't1_analyze_document', uc: 'SOURCE_ANALYSIS', billable: false, cost: 3_000, at: now, meta: { shadow: true } });
    await usage({ account: T, op: 't1_analyze_document', uc: 'SOURCE_ANALYSIS', billable: true, cost: 7_000, at: now });
    const E = await import('@/services/ai/alerts/cost-evaluator');
    const admin = await make.user({ role: 'ADMIN' });
    await E.saveCostSettings({ budgets: [{ scope: 'global', monthlyBudgetMicros: 999 }, { scope: 'T3', monthlyBudgetMicros: 399 }, { scope: 'T1', monthlyBudgetMicros: 600 }] }, admin.id);
    const alertes: Array<Record<string, unknown>> = [];
    const verdicts = await E.evaluateBudgetAlerts(new Date(), async (a) => { alertes.push(a as never); return true; });
    expect(verdicts.find((v) => v.scope === 'global')).toMatchObject({ spentMicros: 1_000, exceeded: true });
    expect(verdicts.find((v) => v.scope === 'T3')).toMatchObject({ spentMicros: 400, exceeded: true });
    expect(verdicts.find((v) => v.scope === 'T1')).toMatchObject({ spentMicros: 600, exceeded: false });
    expect(alertes.map((a) => a.dedupeKey).sort()).toEqual([expect.stringMatching(/^budget:T3:/), expect.stringMatching(/^budget:global:/)].sort());
    for (const a of alertes) expect(String(a.message)).toMatch(/Aucun traitement n'est interrompu/);
    await E.saveCostSettings({ budgets: [{ scope: 'global', monthlyBudgetMicros: null }, { scope: 'T3', monthlyBudgetMicros: null }, { scope: 'T1', monthlyBudgetMicros: null }] }, admin.id);
  });

  it('L113AF-E05 — plafond du compte fondé sur la dépense métier : exemptions, 80 %, 100 %, 0 désactivé, abstention T3, reprise T1', async () => {
    const Cap = await import('@/services/ai/gateway/account-cost-cap');
    Cap.setCostCapStoreForTests(Cap.dbCostCapStore);
    Cap.resetCostCapCache();
    await sql`INSERT INTO ai_account_cost_caps (account_id, monthly_cap_micros, reason) VALUES (${C}, 1000, 'e2e l113af')`;
    const now = new Date().toISOString();
    // T3 hors quota : comptait 0 avec l'ancien booléen ; technique sur le même compte : jamais compté.
    await usage({ account: C, op: 't3_link_ambiguity', uc: 'DATA_RECONCILIATION', billable: false, cost: 850, at: now });
    await usage({ account: C, op: 'provider_test', uc: 'AI_GOVERNANCE', billable: false, cost: 50_000, at: now });
    await usage({ account: C, op: 't1_analyze_document', uc: 'SOURCE_ANALYSIS', billable: false, cost: 50_000, at: now, meta: { shadow: true } });
    const s80 = await Cap.getAccountCostCapStatus(C);
    expect(s80).toMatchObject({ capMicros: 1000, spentMicros: 850, level: 'threshold' });
    await Cap.assertAccountCostCap({ accountId: C, useCaseCode: 'DATA_RECONCILIATION', operationCode: 't3_link_ambiguity' });
    const [seuil] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_alerts WHERE code = 'account_cost_cap_threshold' AND account_id = ${C}`;
    expect(seuil.n).toBe(1);
    // T4 hors quota fait franchir 100 % : refus avant tout appel.
    await usage({ account: C, op: 't4_classify_event', uc: 'AGENDA_INTELLIGENCE', billable: false, cost: 200, at: now });
    await expect(Cap.assertAccountCostCap({ accountId: C, useCaseCode: 'AGENDA_INTELLIGENCE', operationCode: 't4_classify_event' }))
      .rejects.toMatchObject({ code: 'COST_CAP_REACHED' });
    // Exemptions vérifiées inchangées : usage technique et campagne exemptée ne sont pas plafonnés.
    await expect(Cap.assertAccountCostCap({ accountId: C, useCaseCode: 'AI_GOVERNANCE', operationCode: 'provider_test' })).resolves.toBeUndefined();
    await expect(Cap.assertAccountCostCap({ accountId: C, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 't1_analyze_document', exempt: true })).resolves.toBeUndefined();
    // Report T1 : date de reprise = 1er du mois suivant à minuit (Europe/Paris).
    const report = await Cap.costCapReachedFor(C);
    expect(report).toMatchObject({ capMicros: 1000, spentMicros: 1050 });
    expect(report!.resumeAt.toISOString()).toBe(Cap.costCapPeriod().end.toISOString());
    // Abstention T3 : la branche de départage s'abstient SANS appel fournisseur.
    const replay = await useRecordings([{ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true }]);
    const avant = replay.calls.length;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reconcileLinksMaster } = await import('@/services/ai/reconciliation/master/link-ambiguity');
    const res = await reconcileLinksMaster({ accountId: C, variables: { SUBJECT_CONTEXT: 'Chaudière', DOCUMENTS_LIST: '[id:1] facture' } });
    expect(replay.calls.length).toBe(avant);
    expect(res.documents).toEqual([]);
    // Plafond 0 = désactivé (aucune lecture du cumul, aucun refus).
    await sql`UPDATE ai_account_cost_caps SET monthly_cap_micros = 0 WHERE account_id = ${C}`;
    Cap.resetCostCapCache();
    expect(await Cap.getAccountCostCapStatus(C)).toMatchObject({ capMicros: null, level: 'none', spentMicros: null });
    await expect(Cap.assertAccountCostCap({ accountId: C, useCaseCode: 'DATA_RECONCILIATION', operationCode: 't3_link_ambiguity' })).resolves.toBeUndefined();
    Cap.setCostCapStoreForTests(null);
  });

  it('L113AF-E06 — rattrapage BO : simuler / appliquer / relancer / restaurer ; réconciliation ; coûts persistés ; quotas intacts', async () => {
    // Régularisation active (#670 / #713) sur l'appel au coût inconnu : utilisée telle quelle, jamais recalculée.
    const [run] = await sql<{ id: number }[]>`INSERT INTO ai_cost_regularization_runs (mode, status, since, until, method_version)
      VALUES ('apply', 'completed', '2024-05-01', '2024-05-31', 'e2e') RETURNING id`;
    await sql`INSERT INTO ai_cost_corrections (target_kind, target_id, run_id, call_at, initial_cost_micros, corrected_cost_micros, cause, method, method_version, price_ref)
              VALUES ('event', ${ev.unknown}, ${run.id}, '2024-05-02T10:00:00Z', NULL, 77, 'NO_PRICE', 'valid_at_call', 'e2e', '{}'::jsonb)`;
    const quotasAvant = await sql`SELECT * FROM ai_usage_account_counter ORDER BY id`;
    const billableAvant = await sql<{ id: number; is_billable: boolean; cost_micros: number | null }[]>`SELECT id, is_billable, cost_micros FROM ai_usage_event ORDER BY id`;
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const hooks = { log: () => undefined, progress: () => undefined };
    const lancer = (action: 'simulate' | 'apply' | 'restore', runId: string | null = null) =>
      executeBackfill(sql, { script: 'ai-cost-classification', action, step: null, runId, accountId: null, reason: action === 'simulate' ? null : 'recette 113AF' }, hooks);
    const nonClasses = async () => (await sql<{ n: number }[]>`
      SELECT ((SELECT COUNT(*) FROM ai_usage_event WHERE cost_origin IS NULL) + (SELECT COUNT(*) FROM ai_usage_daily_rollup WHERE cost_origin IS NULL))::int AS n`)[0].n;
    const { getCostReport } = await import('@/services/ai/telemetry/cost-report.repository');
    const rapportAvant = await getCostReport(WINDOW);
    expect(rapportAvant.totals.functionalMicros).toBe(3_500 + 77);

    // Simuler : rien n'est écrit ; avant / après réconciliés.
    const enAttente = await nonClasses();
    expect(enAttente).toBeGreaterThanOrEqual(18);
    const sim = (await lancer('simulate')).result as import('@/services/ai/cost/cost-classification-backfill').CostClassificationReport;
    expect(await nonClasses()).toBe(enAttente);
    expect(sim.before!.pending.events + sim.before!.pending.rollups).toBe(enAttente);
    expect(sim.reconciliation).toMatchObject({ totalsMatch: true, overlap: { calls: 0 }, costReport: { matches: true } });
    expect(sim.after!.reclassifiedToBusiness.micros).toBeGreaterThanOrEqual(300 + 100 + 50 + 40 + 10 + 77);
    expect(sim.after!.movedToTechnical.micros).toBeGreaterThanOrEqual(800 + 60);
    expect(sim.nonClassifiable).toMatchObject({ rows: 2, micros: 85 });
    expect(sim.nonClassifiable.samples.join('\n')).toMatch(/resolve_ambiguity/);
    const synth = summarizeBackfill('ai-cost-classification', 'simulate', null, { result: sim });
    expect(synth.counters.find((c) => c.label === 'Réconciliation : total avant = total après')?.value).toBe('oui');

    // Appliquer : fige le classement (coûts persistés), idempotent.
    const app = (await lancer('apply')).result as import('@/services/ai/cost/cost-classification-backfill').CostClassificationReport;
    expect(app.written.events + app.written.rollups).toBe(enAttente);
    expect(app.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await nonClasses()).toBe(0);
    const [g] = await sql<{ cost_origin: string; cost_imputable: boolean; cost_class: Record<string, unknown> }[]>`
      SELECT cost_origin, cost_imputable, cost_class FROM ai_usage_event WHERE id = ${ev.groupUpload}`;
    expect(g).toMatchObject({ cost_origin: 'ACCOUNT_SERVICE', cost_imputable: true, cost_class: { source: 'backfill', reason: 'REGISTRY_OPERATION', runId: app.runId, legacyBillable: false } });
    const [rt] = await sql<{ cost_origin: string }[]>`SELECT cost_origin FROM ai_usage_event WHERE id = ${ev.retired}`;
    expect(rt.cost_origin).toBe('UNDETERMINED');
    const rapportApres = await getCostReport(WINDOW);
    for (const k of ['functionalMicros', 'technicalMicros', 'undeterminedMicros', 'providerMicros', 'calls', 'unpricedCalls'] as const) {
      expect(rapportApres.totals[k], k).toBe(rapportAvant.totals[k]);
    }
    expect(rapportApres.totals.provisionalRows).toBe(0);
    const relance = (await lancer('apply')).result as import('@/services/ai/cost/cost-classification-backfill').CostClassificationReport;
    expect(relance.written).toMatchObject({ events: 0, rollups: 0 });

    // Aucun coût réécrit, `is_billable` et quotas intacts, aucune trace ajoutée (aucun appel IA).
    expect(await sql<{ id: number; is_billable: boolean; cost_micros: number | null }[]>`SELECT id, is_billable, cost_micros FROM ai_usage_event ORDER BY id`).toEqual(billableAvant);
    expect(await sql`SELECT * FROM ai_usage_account_counter ORDER BY id`).toEqual(quotasAvant);

    // Restaurer : seules les lignes de cette exécution ; les écritures à la source restent.
    const sourceAvant = (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_usage_event WHERE cost_class->>'source' = 'source'`)[0].n;
    const rest = (await lancer('restore', app.runId)).result as { events: number; rollups: number };
    expect(rest.events + rest.rollups).toBe(enAttente);
    expect(await nonClasses()).toBe(enAttente);
    expect((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_usage_event WHERE cost_class->>'source' = 'source'`)[0].n).toBe(sourceAvant);
    expect((await getCostReport(WINDOW)).totals.functionalMicros).toBe(rapportAvant.totals.functionalMicros);

    // Double comptage traces ↔ agrégats : un appel encore en base ET couvert par une archive SUPPRIMÉE du même jour d'agrégat.
    await sql`INSERT INTO ai_log_archives (source_table, period_day, part, s3_key, row_count, min_id, max_id, bytes, sha256, environment)
              VALUES ('ai_usage_event', '2024-05-03', 9, 'e2e/l113af', 1, ${ev.probe}, ${ev.probe}, 1, 'x', 'local')`;
    await sql`UPDATE ai_usage_event SET created_at = '2024-05-03T08:00:00Z' WHERE id = ${ev.probe}`;
    const dbl = (await lancer('simulate')).result as import('@/services/ai/cost/cost-classification-backfill').CostClassificationReport;
    expect(dbl.reconciliation?.overlap).toMatchObject({ calls: 1, micros: 70, days: ['2024-05-03'] });
    const s2 = summarizeBackfill('ai-cost-classification', 'simulate', null, { result: dbl });
    expect(s2.conflicts.count).toBe(1);
    await sql`DELETE FROM ai_log_archives WHERE s3_key = 'e2e/l113af'`;
  });
});
