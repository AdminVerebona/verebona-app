/**
 * Observabilité §18 sur base réelle — CDC 15 §18, lot 17 ; migration 0226.
 *
 * Les tables sont alimentées DANS UNE PÉRIODE PASSÉE ISOLÉE (mars 2001) :
 * les autres scénarios écrivent « maintenant », et les indicateurs lisent
 * tous les comptes de la période. Une ligne hors période vérifie la borne.
 * Chaque compteur attendu est vérifié contre les requêtes réelles.
 */
import { beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('AI-OBS-18', 'Observabilité §18 : compteurs par domaine sur base réelle', ({ sql, make }) => {
  const NOW = new Date('2001-03-15T12:00:00Z');
  const IN = '2001-03-15T06:00:00Z';
  const OUT = '2001-03-10T06:00:00Z';
  let versionId = 0;

  // Chemin RÉEL (relecture lot 17) : connexion réservée, transaction READ
  // ONLY, statement_timeout local — aucun runner injecté.
  beforeAll(async () => {
    const { setObservabilityQueryRunner } = await import('@/services/ai/telemetry/observability.repository');
    setObservabilityQueryRunner(null);
  });

  const obs = async (domain: 'T1' | 'T2' | 'T3' | 'T4' | 'CONFIG' | 'EXPORTS', configVersionId: number | null = null) => {
    const { getObservability, clearObservabilityCache } = await import('@/services/ai/telemetry/observability.repository');
    clearObservabilityCache();
    const r = await getObservability({ domain, days: 1, configVersionId }, NOW);
    expect(r.notes.filter((n) => /indisponible/.test(n))).toEqual([]);
    const v = (k: string) => r.metrics.find((m) => m.key === k)?.value;
    const rows = (k: string) => r.tables.find((t) => t.key === k)?.rows ?? [];
    return { r, v, rows };
  };

  it('alimente les tables (période isolée)', async () => {
    const account = await make.account();
    const asset = await make.asset(account);
    const file = await make.assetFile(account, { assetId: asset.id });

    // ── Configuration : une version et ses appels ──────────────────────────
    const [ver] = await sql<{ id: number }[]>`
      INSERT INTO ai_config_versions (environment, status, visible_number, label, validated_at, activated_at)
      VALUES ('local', 'ARCHIVED', 8801, 'e2e obs', ${IN}, ${'2001-03-15T00:00:00Z'}) RETURNING id`;
    versionId = ver.id;
    const usage = (useCase: string, meta: Record<string, unknown>, at: string, over: { version?: number | null; fallback?: boolean; cost?: number } = {}) => sql`
      INSERT INTO ai_usage_event (account_id, operation_type, provider, model, is_billable, is_fallback, input_tokens,
                                  output_tokens, cost_micros, duration_ms, status, metadata, use_case_code,
                                  config_version_id, model_rank, created_at)
      VALUES (${account.id}, 'op', 'fake', 'm-e2e', true, ${over.fallback ?? false}, 1, 1, ${over.cost ?? 100}, 1, 'success',
              ${JSON.stringify(meta)}::jsonb, ${useCase}, ${over.version === undefined ? versionId : over.version},
              ${over.fallback ? 'fallback_1' : 'primary'}, ${at})`;
    await usage('SOURCE_ANALYSIS', { engine: 'new', reasoning: 'low', maxOutputTokens: 4000, trigger: 'DOCUMENT_UPLOADED' }, IN);
    await usage('SOURCE_ANALYSIS', { engine: 'legacy' }, IN, { fallback: true, cost: 50 });
    await usage('INTELLIGENT_ASSISTANT', { engine: 'new' }, IN, { version: null });
    await usage('SOURCE_ANALYSIS', { engine: 'new' }, OUT);

    // ── T1 : analyse (avertissements, candidats) et faits ──────────────────
    const raw = JSON.stringify({
      warnings: [{ code: 'UNIT_MISMATCH', message: 'x' }, { code: 'UNVERIFIED_IDENTIFIER', message: 'x' },
        { code: 'MASTER_FALLBACK_STEPS', message: 'x' }],
      agendaCandidates: [{ title: 'a' }, { title: 'b' }],
    }).replace('"MASTER_FALLBACK_STEPS","message":"x"}', '"MASTER_FALLBACK_STEPS","message":"x"},{"code":"CODE_INCONNU","message":"x"}');
    // Un résultat ILLISIBLE dans la période : il ne doit pas rendre
    // l'échantillon indisponible (relecture lot 17).
    for (const [at, texte] of [[IN, raw], [OUT, raw], [IN, '{"warnings": [ tronqué']]) {
      await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model,
                                                   status, account_id, raw_response_json, created_at, started_at)
                VALUES (${file.id}, 'h', 'v', 'fake', 'm', 'completed', ${account.id}, ${texte}, ${at}, ${at})`;
    }
    const fact = (over: { canonical?: string | null; origin?: string; table?: boolean; target?: string | null; at?: string }) => sql`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, confidence, excerpt, location,
                                  evidence_origin, canonical_key, target_type, created_at)
      VALUES (${account.id}, ${file.id}, 1, ${`k_${Math.random()}`}, 'high',
              ${over.origin === 'VISUAL_ANALYSIS' ? null : 'extrait'},
              ${JSON.stringify(over.table ? { table: { id: 1 } } : {})}::jsonb, ${over.origin ?? 'TEXT_EXTRACTION'},
              ${over.canonical ?? null}, ${over.target ?? null}, ${over.at ?? IN})`;
    await fact({ canonical: 'vehicle.mileage' });
    await fact({ canonical: 'vehicle.power', table: true, target: 'equipment' });
    await fact({ canonical: null, origin: 'VISUAL_ANALYSIS' });
    await fact({ canonical: null, at: OUT });

    // ── T3 : preuves, écritures canoniques, conflits, décisions ────────────
    const evidence = (lifecycle: string, at: string) => sql`
      INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence,
                                  evidence_excerpt, fingerprint, lifecycle_status, extracted_at)
      VALUES (${account.id}, ${asset.id}, 'mileage', '1'::jsonb, 'asset_file', ${file.id}, 'high', 'extrait',
              ${`fp_${Math.random()}`}, ${lifecycle}, ${at})`;
    await evidence('ACTIVE', IN);
    await evidence('SUPERSEDED', IN);
    await evidence('WITHDRAWN', IN);
    await evidence('ACTIVE', OUT);
    const write = (outcome: string, origin: string, dryRun = false) => sql`
      INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, origin, outcome, dry_run, divergence, created_at)
      VALUES (${account.id}, ${asset.id}, 'vehicle.mileage', ${origin}, ${outcome}, ${dryRun},
              ${dryRun ? JSON.stringify({ x: 1 }) : null}::jsonb, ${IN})`;
    await write('written', 'DOCUMENT_EXTRACTION');
    await write('written', 'RECONCILIATION');
    await write('written', 'USER');
    await write('protected', 'DOCUMENT_EXTRACTION');
    await write('written', 'DOCUMENT_EXTRACTION', true);
    const action = (kind: string, rule: string, resolved: boolean) => sql`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question,
                                      resolved_at, resolution_reason, created_at)
      VALUES (${account.id}, 'ASSET', ${asset.id}, ${kind === 'ARBITRATE' ? 'mileage' : 'purchase_date'}, ${kind}, ${rule}, 'Question ?',
              ${resolved ? IN : null}, ${resolved ? 'USER_ARBITRATED' : null}, ${IN})`;
    await action('ARBITRATE', 'CONFLICT', false);
    await action('ARBITRATE', 'CONFLICT', true);
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, status, started_at)
      VALUES (${account.id}, ${asset.id}, 'document_analyzed', 'completed', ${IN}) RETURNING id`;
    for (const [code, act] of [['NO_REMAINING_EVIDENCE', 'update'], ['STALE_AUTO_VALUE_REPLACED', 'update'], ['NEW_EVIDENCE', 'apply']]) {
      await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence)
                VALUES (${run.id}, ${account.id}, ${asset.id}, 'mileage', ${act}, ${code}, 'certain')`;
    }

    // ── T4 : événements, sources, retraits, cartes ─────────────────────────
    const item = async (over: { nature: string | null; category: string | null; source: boolean }) => {
      const i = await make.agendaItem(account);
      await sql`UPDATE agenda_items SET is_automatic = true, event_nature = ${over.nature}, home_category = ${over.category},
                       created_at = ${IN} WHERE id = ${i.id}`;
      if (over.source) {
        await sql`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type, created_at)
                  VALUES (${i.id}, ${file.id}, 'created', ${IN})`;
      }
      return i;
    };
    const i1 = await item({ nature: 'DEADLINE', category: 'action', source: true });
    await item({ nature: 'HISTORICAL', category: 'information', source: true });
    await item({ nature: 'DEADLINE', category: null, source: false });
    await sql`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type, created_at)
              VALUES (${i1.id}, ${file.id}, 'resolved_existing', ${IN})`;
    await sql`INSERT INTO agenda_item_removals (account_id, agenda_item_id, source_file_id, reason, item_snapshot, removed_at)
              VALUES (${account.id}, 999999, ${file.id}, 'SOURCE_DELETED', '{}'::jsonb, ${IN})`;
    await action('COMPLETE', 'AGENDA-PROPOSAL', false);

    // ── T2 : demandes tracées ───────────────────────────────────────────────
    const request = (state: string, sources: number, trace: Record<string, unknown>) => sql`
      INSERT INTO verebona_request_runs (request_id, account_id, intent, mode, machine_final_state, source_count, status,
                                         retrieval_methods_json, created_at)
      VALUES (${crypto.randomUUID()}, ${account.id}, 'ASK_DATA', 'data', ${state}, ${sources}, 'ok', ${JSON.stringify(trace)}::jsonb, ${IN})`;
    await request('ANSWERED', 1, {
      strategy: 'structured.asset_field', answeredBy: 'structured',
      observability: { truthSource: 'canonique', sourceTypes: { asset_field: 1 }, target: { type: 'asset', origin: 'page' } },
    });
    await request('ANSWERED', 2, {
      strategy: 'llm.generate_answer', answeredBy: 'llm', aiEvents: ['CLAIM_UNSUPPORTED:FIELD_NOT_IN_SOURCES:1', 'REPAIR:x'],
      revalidations: [{ factId: 1 }],
    });
    await request('CLARIFYING', 0, { strategy: 'clarification.asset', answeredBy: 'template' });
    await request('ANSWERED', 0, { strategy: 'fallback.sources', answeredBy: 'fallback' });

    // ── Exports ─────────────────────────────────────────────────────────────
    const gen = async (status: string, dataSource: Record<string, unknown> | null, errorCode: string | null = null) => {
      const [g] = await sql<{ id: number }[]>`
        INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status, snapshot_json, error_code, created_at)
        VALUES (${asset.id}, ${account.id}, ${account.ownerUserId}, 'DOSSIER_COMPLET', ${status},
                ${dataSource ? JSON.stringify({ dataSource }) : null}::jsonb, ${errorCode}, ${IN}) RETURNING id`;
      return g.id;
    };
    const g1 = await gen('ready', { mode: 'shadow', source: 'legacy', shadowDiff: { fields: 2, documentsOnlyLegacy: 1, documentsOnlyCanonical: 0, events: 1, addedUnconfirmed: 1 } });
    await gen('ready', { mode: 'enabled', source: 'canonical', unconfirmedDocuments: [11, 12] });
    await gen('failed', null, 'RENDER_TIMEOUT');
    for (const reason of ['missing', 'corrupted', 'occupant_data', 'section_disabled']) {
      await sql`INSERT INTO export_generation_items (generation_id, source_type, status, reason)
                VALUES (${g1}, 'document', 'excluded', ${reason})`;
    }
  });

  it('T1 : faits, génériques, erreurs de cible, provenance, repli master', async () => {
    const { r, v, rows } = await obs('T1');
    expect(v('analyses')).toBe(2);
    expect(r.notes.join(' ')).toMatch(/1 résultat\(s\) d’analyse illisible/);
    expect(v('facts_extracted')).toBe(3);
    expect(v('facts_canonical')).toBe(2);
    expect(v('facts_generic')).toBe(1);
    expect(v('facts_unresolved_target')).toBe(1);
    expect(v('target_errors')).toBe(2);
    expect(v('warning_unit_mismatch')).toBe(1);
    expect([v('provenance_text'), v('provenance_visual'), v('provenance_table')]).toEqual([1, 1, 1]);
    expect(v('master_fallback_steps')).toBe(1);
    expect([v('ai_calls'), v('ai_cost'), v('ai_fallbacks')]).toEqual([2, 150, 1]);
    expect(rows('t1_warnings').map((x) => x.code).sort())
      .toEqual(['AUTRE', 'MASTER_FALLBACK_STEPS', 'UNIT_MISMATCH', 'UNVERIFIED_IDENTIFIER']);
  });

  it('T3 : preuves, champs mis à jour, USER bloqués, conflits, rétractations', async () => {
    const { v } = await obs('T3');
    expect([v('evidence_active'), v('evidence_superseded'), v('evidence_withdrawn')]).toEqual([1, 1, 1]);
    expect(v('fields_updated')).toBe(2);
    expect(v('user_overwrites_blocked')).toBe(1);
    expect(v('shadow_divergences')).toBe(1);
    expect([v('conflicts_opened'), v('conflicts_open')]).toEqual([2, 1]);
    expect([v('retractions'), v('retraction_no_evidence'), v('retraction_stale_replaced')]).toEqual([2, 1, 1]);
  });

  it('T4 : candidats, créés / mis à jour / retirés, natures, orphelins, classement, cartes', async () => {
    const { v } = await obs('T4');
    expect(v('candidates')).toBe(2);
    expect([v('events_created'), v('events_updated'), v('events_removed')]).toEqual([3, 1, 1]);
    expect([v('events_historical'), v('events_deadline')]).toEqual([1, 2]);
    expect(v('orphans')).toBe(1);
    expect([v('class_action'), v('class_information'), v('class_unknown')]).toEqual([1, 1, 1]);
    expect([v('proposal_cards'), v('proposal_cards_open')]).toEqual([1, 1]);
  });

  it('T2 : source de vérité, sans résultat, clarifications, revalidations, claims, cibles, sources', async () => {
    const { v, rows } = await obs('T2');
    expect(v('requests')).toBe(4);
    expect(v('no_result')).toBe(1);
    expect(v('clarifications')).toBe(1);
    expect(v('revalidations')).toBe(1);
    expect(v('claims_rejected')).toBe(1);
    expect(rows('t2_claims')).toEqual([{ code: 'FIELD_NOT_IN_SOURCES', count: 1 }]);
    expect(Object.fromEntries(rows('t2_truth').map((x) => [x.code, x.count])))
      .toEqual({ Canonique: 1, 'Modèle (sans source)': 1, Clarification: 1, 'Sans résultat': 1 });
    expect(rows('t2_targets')).toEqual([{ type: 'asset', origin: 'page', count: 1 }]);
    expect(rows('t2_source_types')).toEqual([{ code: 'asset_field', count: 1 }]);
    expect(v('avg_sources')).toBe(0.75);
    expect(v('ai_calls')).toBe(1);
  });

  it('Configuration IA : version, moteur, repli, raisonnement, max tokens, déclencheur', async () => {
    const { v, rows } = await obs('CONFIG');
    expect(v('calls')).toBe(3);
    expect(v('with_version')).toBe(67);
    expect([v('engine_new'), v('engine_legacy'), v('fallbacks')]).toEqual([2, 1, 1]);
    expect([v('reasoning_untraced'), v('max_tokens_untraced'), v('trigger_traced')]).toEqual([2, 2, 1]);
    expect(rows('config_detail').find((x) => x.trigger === 'DOCUMENT_UPLOADED')).toMatchObject({ version: `#${versionId}`, count: 1 });
  });

  it('filtre de version : exact sur les appels, période d’effet pour le métier', async () => {
    const cfg = await obs('CONFIG', versionId);
    expect(cfg.v('calls')).toBe(2);
    const t1 = await obs('T1', versionId);
    expect(t1.r.version).toMatchObject({ id: versionId, scope: 'exact+period' });
    expect(t1.v('ai_calls')).toBe(2);
    // Période d'effet : premier au dernier appel (+5 min) — les faits écrits à 06:00 en font partie.
    expect(t1.v('facts_extracted')).toBe(3);
  });

  it('Exports : pièces absentes, écarts shadow, périmètre, rattachements non confirmés', async () => {
    const { v, rows } = await obs('EXPORTS');
    expect(v('generations')).toBe(3);
    expect(v('generations_failed')).toBe(1);
    expect([v('source_canonical'), v('source_legacy'), v('shadow_runs')]).toEqual([1, 1, 1]);
    expect([v('shadow_divergent'), v('shadow_diff_fields'), v('shadow_diff_documents'), v('shadow_diff_events')]).toEqual([1, 2, 1, 1]);
    expect(v('linked_missing')).toBe(2);
    expect(v('scope_exclusions')).toBe(1);
    expect(v('unconfirmed_dropped')).toBe(3);
    expect(rows('export_errors')).toEqual([{ code: 'RENDER_TIMEOUT', count: 1 }]);
  });

  it('index 0226 présents et valides', async () => {
    const idx = await sql<{ indexrelid: string; indisvalid: boolean }[]>`
      SELECT c.relname AS indexrelid, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname LIKE '%\\_obs\\_idx'`;
    expect(idx.map((x) => x.indexrelid).sort()).toEqual([
      'agenda_item_sources_created_at_obs_idx', 'agenda_items_created_at_obs_idx', 'canonical_field_writes_created_at_obs_idx',
      'document_analysis_runs_created_at_obs_idx', 'document_facts_created_at_obs_idx', 'export_generation_created_at_obs_idx',
      'field_evidence_extracted_at_obs_idx', 'to_process_actions_created_at_obs_idx', 'verebona_request_runs_created_at_obs_idx',
    ]);
    expect(idx.every((x) => x.indisvalid)).toBe(true);
  });

  it('délai : la requête est ANNULÉE côté base (pg_stat_activity vide), la connexion rendue', async () => {
    const { observabilityQueryForTests } = await import('@/services/ai/telemetry/observability.repository');
    const t0 = Date.now();
    await expect(observabilityQueryForTests('SELECT pg_sleep(9.123)')).rejects.toThrow(/annulée par la base/);
    expect(Date.now() - t0).toBeLessThan(6_000);
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE state = 'active' AND query LIKE '%pg_sleep(9.123)%' AND pid <> pg_backend_pid()`;
    expect(n).toBe(0);
    // Session suivante : connexion saine, transaction en lecture seule.
    const [ro] = await observabilityQueryForTests(`SELECT current_setting('transaction_read_only') AS ro`);
    expect(ro.ro).toBe('on');
  });

  it('les requêtes de période peuvent utiliser les index 0226', async () => {
    const plans: Record<string, string> = {};
    for (const [table, col] of [['document_facts', 'created_at'], ['verebona_request_runs', 'created_at'],
      ['agenda_items', 'created_at'], ['field_evidence', 'extracted_at'], ['export_generation', 'created_at']]) {
      await sql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL enable_seqscan = off');
        const rows = await tx.unsafe(`EXPLAIN SELECT count(*) FROM ${table} WHERE ${col} >= $1 AND ${col} < $2`, [IN, NOW.toISOString()]);
        plans[table] = rows.map((r) => String(Object.values(r)[0])).join('\n');
      });
      expect(plans[table]).toContain(`${table}_${col}_obs_idx`);
    }
  });
});
