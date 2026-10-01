/**
 * Observabilité de l'assistant sur base réelle — CDC Assistant §32.2, §32.5,
 * §25.7 ; CDC Centre d'aide PUB-01 (lot 19).
 *
 * §32.2 : tables alimentées dans une PÉRIODE PASSÉE ISOLÉE (2002), comme
 * AI-OBS-18. §32.5 : la lecture porte sur les N derniers jours — compteurs
 * mesurés AVANT et APRÈS insertion (fichiers E2E exécutés en série).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

scenario('AI-OBS-T2', 'Observabilité assistant : §32.2, §32.5, PUB-01', ({ sql, make }) => {
  const NOW = new Date('2002-06-15T12:00:00Z');
  const IN = '2002-06-15T06:00:00Z';

  beforeAll(async () => {
    const { setObservabilityQueryRunner, clearObservabilityCache } = await import('@/services/ai/telemetry/observability.repository');
    setObservabilityQueryRunner(null);
    clearObservabilityCache();
  });

  it('§32.2 : timeouts, erreurs par service, jetons, coût par offre, sources, cloisonnement, versions', async () => {
    const premium = await make.account();
    const standard = await make.account();
    await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${premium.id}`;
    await sql`UPDATE accounts SET plan_type = 'STANDARD' WHERE id = ${standard.id}`;

    const run = (over: { status?: string; error?: string | null; candidates?: number; sources?: number; trace?: Record<string, unknown> }) => sql`
      INSERT INTO verebona_request_runs (request_id, account_id, intent, mode, machine_final_state, source_count, candidate_count,
                                         status, error_code, retrieval_methods_json, created_at)
      VALUES (${crypto.randomUUID()}, ${premium.id}, 'ACCOUNT_FACT_ASSET', 'ai', 'READY', ${over.sources ?? 0}, ${over.candidates ?? 0},
              ${over.status ?? 'ok'}, ${over.error ?? null}, ${JSON.stringify(over.trace ?? { strategy: 'llm.generate_answer' })}::jsonb, ${IN})`;
    await run({ candidates: 6, sources: 2 });
    await run({ candidates: 4, sources: 1, trace: { strategy: 'llm.generate_answer', securityEvents: [{ code: 'MODEL_UNKNOWN_SOURCE_REJECTED' }] } });
    await run({ status: 'error', error: 'REQUEST_TIMEOUT' });
    await run({ status: 'error', error: 'ASSISTANT_UNAVAILABLE' });

    const usage = async (accountId: number, op: string, status: string, tin: number, tout: number, cost: number, model: string, master: string | null) => {
      const [u] = await sql<{ id: number }[]>`
        INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, is_billable, is_fallback,
                                    input_tokens, output_tokens, cost_micros, duration_ms, status, metadata, use_case_code, created_at)
        VALUES (${accountId}, ${op}, ${op}, 'fake', ${model}, true, false, ${tin}, ${tout}, ${cost}, 1, ${status},
                ${JSON.stringify({ promptVersion: 'assistant-v3' })}::jsonb, 'INTELLIGENT_ASSISTANT', ${IN}) RETURNING id`;
      if (master) await sql`UPDATE ai_usage_event SET master_prompt_version = ${master} WHERE id = ${u.id}`;
    };
    await usage(premium.id, 'assistant_generate', 'success', 1000, 100, 400, 'gemini-a', '3');
    await usage(premium.id, 'assistant_generate', 'error', 500, 0, 0, 'gemini-a', '3');
    await usage(standard.id, 'assistant_classify', 'success', 200, 20, 100, 'gemini-b', null);

    const { getObservability, clearObservabilityCache } = await import('@/services/ai/telemetry/observability.repository');
    clearObservabilityCache();
    const r = await getObservability({ domain: 'T2', days: 1 }, NOW);
    expect(r.notes.filter((n) => /indisponible/.test(n))).toEqual([]);
    const v = (k: string) => r.metrics.find((m) => m.key === k)?.value;
    const rows = (k: string) => r.tables.find((t) => t.key === k)?.rows ?? [];

    expect([v('timeouts'), v('timeout_rate')]).toEqual([1, 25]);
    expect(v('service_errors')).toBe(3);
    expect(rows('t2_service_errors')).toContainEqual({ service: 'modèle · assistant_generate', calls: 2, errors: 1, rate: '50 %' });
    expect([v('tokens_in'), v('tokens_out')]).toEqual([1700, 120]);
    expect([v('accounts_using'), v('avg_cost_per_account')]).toEqual([2, 250]);
    expect(rows('t2_cost_by_plan')).toEqual(expect.arrayContaining([
      { plan: 'PREMIUM', accounts: 1, calls: 2, cost: '0.0004 $', median: '< 5 comptes', max: '< 5 comptes' },
      { plan: 'STANDARD', accounts: 1, calls: 1, cost: '0.0001 $', median: '< 5 comptes', max: '< 5 comptes' },
    ]));
    expect([v('sources_retrieved'), v('sources_shown')]).toEqual([10, 3]);
    expect(v('scope_incidents')).toBe(1);
    expect([v('model_versions'), v('prompt_versions')]).toEqual([2, 2]);
    expect(rows('t2_versions')).toContainEqual({ model: 'gemini-a', prompt: 'assistant-v3', master: '3', count: 2 });
    expect(rows('t2_business_events').length).toBeGreaterThan(10);
  });

  it('§32.5 : demandes non résolues comptées par motif (sans texte)', async () => {
    const { listUnansweredByMotive } = await import('@/services/verebona-assistant/core/unanswered-help.repository');
    const compte = async () => Object.fromEntries((await listUnansweredByMotive({ days: 7 })).byMotive.map((m) => [m.motive, m.count]));
    const avant = await compte();
    const account = await make.account();
    const run = (intent: string, over: { status?: string; error?: string | null; state?: string; strategy?: string; sources?: number }) => sql`
      INSERT INTO verebona_request_runs (request_id, account_id, intent, mode, machine_final_state, source_count, status, error_code,
                                         retrieval_methods_json)
      VALUES (${crypto.randomUUID()}, ${account.id}, ${intent}, 'ai', ${over.state ?? 'READY'}, ${over.sources ?? 0},
              ${over.status ?? 'ok'}, ${over.error ?? null}, ${JSON.stringify({ strategy: over.strategy ?? 'fallback.sources' })}::jsonb)`;
    await run('ACCOUNT_FACT_ASSET', {});
    await run('ACCOUNT_FACT_ASSET', {});
    await run('ACCOUNT_FACT_ASSET', { state: 'CLARIFYING', strategy: 'clarification.asset' });
    await run('PRODUCT_HELP_HOW_TO', {});
    await run('UNSUPPORTED_ACTION', { strategy: 'template.unsupported' });
    await run('ACCOUNT_FACT_ASSET', { status: 'error', error: 'ASSISTANT_UNAVAILABLE' });
    await run('OUT_OF_SCOPE', { strategy: 'none' });
    await run('ACCOUNT_FACT_ASSET', { sources: 2, strategy: 'retrieval.document' });
    await run('ACCOUNT_FACT_ASSET', { status: 'error', error: 'RATE_LIMITED' });
    const apres = await compte();
    const delta = Object.fromEntries(Object.keys(apres).map((k) => [k, apres[k] - (avant[k] ?? 0)]));
    expect(delta).toEqual({
      aucune_donnee: 2, ambiguite: 1, absence_article_aide: 1, action_non_supportee: 1, incident_technique: 1, hors_perimetre: 1,
    });
  });

  it('PUB-01 : dernier corpus valide enregistré en base, relu après refus du corpus publié', async () => {
    const svc = await import('@/services/verebona-assistant/core/help-corpus.service');
    const corpus = {
      schema: 'verebona-help-t2-v1' as const, version: 'e2e-v1', environment: 'local',
      articles: [{
        id: 'AID-E2E', title: 'Ajouter un document', path: '/aide/ajouter-un-document', category: 'documents',
        categoryName: 'Documents', summary: 's', offers: ['standard'], offersLabel: 'Toutes', offersNote: null,
        synonyms: [], sections: [{ anchor: 'a', heading: 'h', text: 't' }],
      }],
    };
    await svc.dbHelpCorpusStore.write('local', corpus);
    expect((await svc.dbHelpCorpusStore.read('local'))?.corpus).toMatchObject({ version: 'e2e-v1' });
    // Clé réservée : sans expiration, et épargnée par la purge des expirés.
    await sql`INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at)
              VALUES ('e2e-expiree', '{}'::jsonb, now() - interval '1 day') ON CONFLICT DO NOTHING`;
    const { purgeExpiredIdempotency } = await import('@/services/ai/idempotency/idempotency.service');
    expect(await purgeExpiredIdempotency()).toBeGreaterThanOrEqual(1);
    const [cle] = await sql<{ inf: boolean }[]>`
      SELECT expires_at = 'infinity'::timestamptz AS inf FROM ai_operation_idempotency WHERE key_hash = 'help-corpus:last-valid:local'`;
    expect(cle?.inf).toBe(true);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_operation_idempotency WHERE key_hash = 'e2e-expiree'`;
    expect(n).toBe(0);

    svc.resetHelpCorpusCacheForTests();
    svc.setHelpCorpusStoreForTests(svc.dbHelpCorpusStore);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'cassé' }), { status: 200 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await svc.loadHelpCorpus())?.version).toBe('e2e-v1');
      expect(svc.helpCorpusHealth()).toMatchObject({ status: 'warning', source: 'last_valid_db', alert: { code: 'HELP_CORPUS_INVALID' } });
    } finally {
      vi.unstubAllGlobals();
      svc.setHelpCorpusStoreForTests(null);
      svc.resetHelpCorpusCacheForTests();
    }
  });

  afterAll(() => vi.restoreAllMocks());
});
