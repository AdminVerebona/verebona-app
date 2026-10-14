/**
 * Lot 47A — O9, BO diagnostic des Opérations (CDC Opérations V1 ch. 21, B23,
 * C21 `OperationDiagnosticsService`, C25, C26.1, C26.2, C27 ; F-191 à
 * F-200 ; décisions PO Q8, Q9) — base PostgreSQL réelle.
 *
 * Jeux de données construits en SQL (comptes dédiés) :
 *   · compte A « propre » : chaque indicateur C26.2 a une valeur attendue
 *     exacte (période fixe janvier 2026 pour les flux, état courant pour les
 *     stocks) et AUCUNE anomalie dure ;
 *   · compte C « défauts » : chaque anomalie dure présente une fois ;
 *   · compte B : cible des liens inter-comptes.
 * Toutes les assertions sont bornées au compte : la base E2E est partagée.
 */
import { expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

const diag = () => import('@/services/business-operations/diagnostics/service');
const model = () => import('@/services/business-operations/diagnostics/model');
const alerts = () => import('@/services/business-operations/diagnostics/alerts');

const JANVIER = { from: '2026-01-01', to: '2026-01-31', days: 31 };

scenario('L47A-O9', 'BO diagnostic des Opérations : liste, détail, 13 indicateurs, anomalies dures, lecture seule', ({ sql, make }) => {
  /** Opération insérée directement (diagnostic d'états construits). */
  async function op(acc: AccountRow, o: {
    type?: string | null; status?: string; createdAt?: string; invalidatedAt?: string | null; mergedInto?: number | null;
    parent?: number | null; label?: string; provider?: string;
  } = {}): Promise<number> {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, created_at, invalidated_at,
                                       invalidation_reason, merged_into_operation_id, parent_operation_id, realized_date)
      VALUES (${acc.id}, ${o.type === undefined ? 'INTERVENTION' : o.type}, ${o.status ?? 'REALIZED'}, ${o.label ?? 'E2E'}, ${o.provider ?? null},
              ${o.createdAt ?? new Date().toISOString()}::timestamptz, ${o.invalidatedAt ?? null}::timestamptz,
              ${o.invalidatedAt ? (o.mergedInto ? 'MERGED' : 'NO_ACTIVE_SOURCE') : null}, ${o.mergedInto ?? null}, ${o.parent ?? null}, '2026-01-10')
      RETURNING id`;
    return Number(r.id);
  }
  async function src(acc: AccountRow, opId: number, o: {
    kind?: string; key?: string | number; role?: string | null; authority?: string; active?: boolean; method?: string | null;
    reason?: string | null; version?: string | null; locator?: Record<string, unknown>;
  } = {}): Promise<number> {
    const active = o.active ?? true;
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_version, source_role,
                                              locator, authority, confidence, match_method, match_reason, active, superseded_at)
      VALUES (${acc.id}, ${opId}, ${o.kind ?? 'DOCUMENT'}, ${String(o.key ?? `k${opId}-${Math.random().toString(36).slice(2, 8)}`)}, ${o.version ?? null},
              ${o.role === undefined ? 'INVOICE' : o.role}, ${JSON.stringify(o.locator ?? {})}::jsonb, ${o.authority ?? 'DOCUMENT'}, 'certain',
              ${o.method ?? null}, ${o.reason ?? null}, ${active}, ${active ? null : new Date().toISOString()}::timestamptz)
      RETURNING id`;
    return Number(r.id);
  }
  async function comp(acc: AccountRow, opId: number, o: { kind?: string; amount?: number; sources?: number[]; active?: boolean } = {}): Promise<number> {
    const active = o.active ?? true;
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, active, superseded_at)
      VALUES (${acc.id}, ${opId}, ${o.kind ?? 'REALIZED_COST'}, ${o.amount ?? 10_000}, 'EUR', ${active}, ${active ? null : new Date().toISOString()}::timestamptz)
      RETURNING id`;
    for (const s of o.sources ?? []) {
      await sql`INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, is_primary) VALUES (${r.id}, ${s}, true)`;
    }
    return Number(r.id);
  }
  const link = (acc: AccountRow, opId: number, assetId: number, active = true) => sql`
    INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active)
    VALUES (${acc.id}, ${opId}, ${assetId}, 'PRIMARY', 'DOCUMENT', ${active})`;
  async function extraction(acc: AccountRow, fileId: number, at: string): Promise<number> {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, extracted_at) VALUES (${acc.id}, ${fileId}, ${at}::timestamptz) RETURNING id`;
    return Number(r.id);
  }
  async function cand(acc: AccountRow, fileId: number, extractionId: number, o: {
    key: string; confidence?: string; established?: boolean; typeHint?: string | null; outcome?: string | null; reason?: string | null;
    processedAt?: string | null; operationId?: number | null; detail?: Record<string, unknown> | null; createdAt?: string; status?: string;
  }): Promise<number> {
    const status = o.status ?? 'ACTIVE';
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO document_operation_candidates (account_id, file_id, extraction_id, candidate_key, established, confidence, type_hint, summary,
                                                 status, superseded_at, t3_pending, t3_outcome, t3_reason, t3_processed_at, t3_operation_id, t3_detail, created_at)
      VALUES (${acc.id}, ${fileId}, ${extractionId}, ${o.key}, ${o.established ?? true}, ${o.confidence ?? 'certain'}, ${o.typeHint ?? null},
              ${`Candidat ${o.key}`}, ${status}, ${status === 'ACTIVE' ? null : new Date().toISOString()}::timestamptz, false, ${o.outcome ?? null},
              ${o.reason ?? null}, ${o.processedAt ?? null}::timestamptz, ${o.operationId ?? null},
              ${o.detail ? JSON.stringify(o.detail) : null}::jsonb, ${o.createdAt ?? new Date().toISOString()}::timestamptz)
      RETURNING id`;
    return Number(r.id);
  }
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

  // ── Compte A : jeu de référence des indicateurs, sans anomalie ──────────
  let A: AccountRow & { owner: { id: number } };
  let B: AccountRow;
  let maison: AssetRow;
  const ids: Record<string, number> = {};

  async function compteA() {
    if (ids.ready) return;
    A = await make.account({ plan: 'premium' });
    B = await make.account({ plan: 'premium' });
    maison = await make.asset(A, { category: 'IMMOBILIER', name: 'Maison A' });
    const f1 = await make.assetFile(A, { assetId: maison.id });
    const f2 = await make.assetFile(A, { assetId: maison.id });
    const f3 = await make.assetFile(A, { assetId: maison.id });
    ids.f1 = f1.id; ids.f2 = f2.id;

    // Créations de janvier (indicateurs 1, 6, 7) et stock (4, 5, 8).
    ids.op1 = await op(A, { type: 'INTERVENTION', createdAt: '2026-01-10T09:00:00Z', label: 'Facture virement FR76 3000 6000 0112 3456 7890 189', provider: 'Chauffage Plus' });
    const s1 = await src(A, ids.op1, { key: f1.id, method: 'M1', reason: 'MATCH_M1', version: '2', locator: { candidateKey: 'c1', filename: 'secret.pdf' } });
    ids.s1old = await src(A, ids.op1, { key: f1.id, active: false, version: '1', locator: { candidateKey: 'c1-v1' } });   // F-193
    await comp(A, ids.op1, { amount: 120_000, sources: [s1] });
    await comp(A, ids.op1, { kind: 'INDEMNITY', amount: 20_000, sources: [s1] });
    await link(A, ids.op1, maison.id);
    await sql`INSERT INTO business_operation_references (account_id, operation_id, reference_kind, reference_value, normalized_value, source_id)
              VALUES (${A.id}, ${ids.op1}, 'INVOICE', 'FA-2026/001', 'FA2026001', ${s1})`;

    ids.op2 = await op(A, { createdAt: '2026-01-10T10:00:00Z', invalidatedAt: '2026-01-13T10:00:00Z', mergedInto: ids.op1 });
    await src(A, ids.op2, { kind: 'ASSET_DATA', key: maison.id, role: null, authority: 'STRUCTURED', active: false });
    ids.op3 = await op(A, { createdAt: '2026-01-12T10:00:00Z', invalidatedAt: '2026-01-25T10:00:00Z' });
    const s3 = await src(A, ids.op3, { active: false });
    await comp(A, ids.op3, { sources: [s3] });   // composante d'une Opération invalidée : pas une anomalie
    ids.op5 = await op(A, { createdAt: '2026-01-20T10:00:00Z', invalidatedAt: '2026-01-22T10:00:00Z' });
    await src(A, ids.op5, { active: false });
    ids.op4 = await op(A, { type: null, createdAt: '2025-12-20T10:00:00Z' });
    await src(A, ids.op4, {});
    ids.op6 = await op(A, { type: 'OTHER', createdAt: daysAgo(3) });
    await src(A, ids.op6, { key: f3.id });
    ids.op7 = await op(A, { type: 'CONTRACT', status: 'ENVISAGED', createdAt: daysAgo(0.1) });
    await src(A, ids.op7, { role: 'CONTRACT_DOCUMENT' });
    await sql`INSERT INTO business_operation_contract_details (operation_id, contract_reference, periodicity, effective_from)
              VALUES (${ids.op7}, 'POL-77', 'ANNUAL', '2026-01-01')`;
    ids.op8 = await op(A, { type: 'INTERVENTION', createdAt: daysAgo(10), parent: ids.op1 });
    await src(A, ids.op8, {});

    // Indicateurs 2, 3, 9 : documents analysés en janvier et candidats T1.
    const e1 = await extraction(A, f1.id, '2026-01-10T08:00:00Z');
    const e2 = await extraction(A, f2.id, '2026-01-11T08:00:00Z');
    const e3 = await extraction(A, f3.id, '2026-01-12T08:00:00Z');
    ids.c1 = await cand(A, f1.id, e1, { key: 'c1', outcome: 'CREATE_NEW', reason: 'NO_MATCH_ESTABLISHED', processedAt: '2026-01-10T09:00:00Z', operationId: ids.op1 });
    await cand(A, f1.id, e1, { key: 'c2', outcome: 'MATCH_AND_ENRICH', reason: 'MATCH_M1', processedAt: '2026-01-11T09:00:00Z', operationId: ids.op1 });
    await cand(A, f1.id, e1, { key: 'c3', outcome: 'MATCH_AND_ENRICH', reason: 'MATCH_M2', processedAt: '2026-01-12T09:00:00Z', operationId: ids.op1 });
    await cand(A, f1.id, e1, { key: 'c4', outcome: 'HOLD_UNRESOLVED', reason: 'CONTRADICTORY_REFERENCE', processedAt: '2026-01-13T09:00:00Z' });
    // F-191 : candidat probable ancien — jamais créé par l'âge, reste en attente.
    ids.c5 = await cand(A, f2.id, e2, { key: 'c5', confidence: 'probable', outcome: 'HOLD_UNRESOLVED', reason: 'PROBABLE_WITHOUT_MATCH',
      processedAt: '2026-01-14T09:00:00Z', createdAt: '2025-06-01T09:00:00Z' });
    // F-200 : rapprochement sémantique probable → arbitrage, jamais automatique.
    ids.c6 = await cand(A, f2.id, e2, { key: 'c6', confidence: 'probable', outcome: 'ARBITRATION_REQUIRED', reason: 'M3_AMBIGUOUS', processedAt: '2026-02-05T09:00:00Z',
      detail: { arbitration: { basis: 'M3', operationIds: [ids.op1] }, plausible: [ids.op1] } });
    // OTHER qualifié (candidat T1 « OTHER » certain, depuis supersédé) : pas un repli.
    await cand(A, f3.id, e3, { key: 'c-other', typeHint: 'OTHER', outcome: 'CREATE_NEW', reason: 'NO_MATCH_ESTABLISHED',
      processedAt: '2026-02-01T09:00:00Z', operationId: ids.op6, status: 'SUPERSEDED' });
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
              VALUES (${A.id}, 'DOCUMENT', ${f2.id}, 'operationMatch:c6', 'ARBITRATE', 'OPERATION-MATCH', 'Ce document concerne-t-il la même intervention ?')`;

    // F-192 : décision REJECTED durable ; historique ; Agenda projeté + suppression durable.
    await sql`INSERT INTO business_operation_match_decisions (account_id, source_kind, source_entity_key, candidate_operation_id, decision, origin, reason_code)
              VALUES (${A.id}, 'DOCUMENT', ${String(f2.id)}, ${ids.op1}, 'REJECTED', 'USER_ARBITRATION', 'USER_REJECTED')`;
    await sql`INSERT INTO business_operation_history (account_id, operation_id, event_type, reason_code, source_id, correlation_id, after_json)
              VALUES (${A.id}, ${ids.op1}, 'CREATED', 'T3_CREATE_NEW', ${s1}, 'corr-op1', '{"type_code":"INTERVENTION"}'::jsonb),
                     (${A.id}, ${ids.op1}, 'SOURCE_REMOVED', 'T1_REANALYZED', ${ids.s1old}, 'corr-op1b', null)`;
    await sql`INSERT INTO agenda_items (account_id, title, start_date, business_operation_id, projection_origin, projection_correlation_id)
              VALUES (${A.id}, 'Entretien chaudière', '2027-01-10', ${ids.op1}, 'OPERATION', 'corr-agenda')`;
    await sql`INSERT INTO business_operation_projection_suppressions (account_id, operation_id, projection_kind, projection_key, user_id)
              VALUES (${A.id}, ${ids.op1}, 'AGENDA', 'next-maintenance', ${A.ownerUserId})`;
    await sql`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, payload, finished_at, business_result)
              VALUES ('T3', ${A.id}, 'business_operations', ${String(A.id)}, ${`e2e-l47a-${A.id}`}, 'DONE',
                      ${JSON.stringify({ kind: 'business_operations', events: [{ trigger: 'source_analyzed', correlationId: 'corr-t3-last' }] })}::jsonb,
                      now(), 'APPLIED')`;

    // Indicateur 13 : traces T2 de janvier.
    const run = (mode: string | null) => sql`
      INSERT INTO verebona_request_runs (request_id, account_id, status, retrieval_methods_json, created_at)
      VALUES (${`l47a-${Math.random().toString(36).slice(2)}`}, ${A.id}, 'answered',
              ${JSON.stringify({ strategy: 'x', observability: mode ? { truthSource: 'canonique', economicMode: mode } : { truthSource: 'document' } })}::jsonb,
              '2026-01-15T10:00:00Z')`;
    await run('operation_only'); await run('operation_only'); await run('mixed'); await run('fallback_only'); await run(null);
    ids.ready = 1;
  }

  // ── Indicateurs (compte A) ────────────────────────────────────────────────

  it('C26-01…C26-13 les 13 indicateurs C26.2 sur un jeu construit (compte A, janvier 2026)', async () => {
    await compteA();
    const { OperationDiagnosticsService } = await diag();
    const r = await new OperationDiagnosticsService().indicators(JANVIER, A.id);
    const v = Object.fromEntries(r.indicators.map((i) => [i.key, i.value]));
    expect(r.indicators.length).toBe(13);

    // C26-01 créations par jour / source_kind (op1, op2, op3, op5 en janvier).
    expect(v.createdPerDayBySourceKind).toMatchObject({ total: 4, bySourceKind: { DOCUMENT: 3, ASSET_DATA: 1 }, maxDay: { day: '2026-01-10', total: 2 } });
    expect((v.createdPerDayBySourceKind.days as unknown[]).length).toBe(3);
    // C26-02 documents T1 analysés : f1 seul porte un candidat certain (1/3).
    expect(v.documentsWithCertainCandidate).toEqual({ analysed: 3, withCertain: 1, pct: 33.3 });
    // C26-03 candidats certains traités en janvier : 1 CREATE, 2 MATCH, 1 HOLD.
    expect(v.certainCandidatesOutcome).toMatchObject({ total: 4, create: 1, match: 2, createPct: 25, matchPct: 50 });
    // C26-04 / C26-05 actives : op1, op4 (null), op6 (OTHER), op7, op8.
    expect(v.typeNull).toMatchObject({ active: 5, count: 1, pct: 20 });
    expect(v.typeOther).toEqual({ active: 5, count: 1, pct: 20 });
    // C26-06 / C26-07 cohorte de janvier : op2 fusionnée en 3 j, op5 invalidée en 2 j (op3 : 13 j, hors fenêtre).
    expect(v.mergedWithin7Days).toEqual({ created: 4, count: 1, pct: 25 });
    expect(v.invalidatedWithin7Days).toEqual({ created: 4, count: 1, pct: 25 });
    // C26-08 sans cible par âge : op7 (<24 h), op6 (3 j), op8 (10 j), op4 (>30 j) — aucune invalidation par âge (F-080).
    expect(v.withoutTargetByAge).toEqual({ total: 4, h24: 1, d7: 1, d30: 1, older: 1 });
    // C26-09 ambiguïtés : 2 HOLD + 1 arbitrage, 1 carte À traiter ouverte.
    expect(v.ambiguousSources).toMatchObject({ total: 3, hold: 2, arbitration: 1, openCards: { 'OPERATION-MATCH': 1 }, openCardsTotal: 1 });
    // C26-10 / 11 / 12 anomalies dures : 0 sur le compte propre (aucun faux positif).
    expect(v.componentsWithoutActiveSource).toEqual({ count: 0 });
    expect(v.activeWithoutActiveSource).toEqual({ count: 0 });
    expect(v.crossAccountOrParentCycles).toEqual({ count: 0, crossAccount: 0, parentCycles: 0 });
    expect(r.hardAnomalyTotal).toBe(0);
    // C26-13 T2 économiques : 2 / 1 / 1 (la réponse non économique n'est pas comptée).
    expect(v.t2EconomicAnswers).toMatchObject({ total: 4, operationOnly: 2, mixed: 1, fallbackOnly: 1, operationOnlyPct: 50 });
  });

  it('C26-14 global : les mêmes calculs sans filtre compte incluent le compte A', async () => {
    await compteA();
    const { OperationDiagnosticsService } = await diag();
    const r = await new OperationDiagnosticsService().indicators(JANVIER, null);
    const v = Object.fromEntries(r.indicators.map((i) => [i.key, i.value]));
    expect(Number(v.createdPerDayBySourceKind.total)).toBeGreaterThanOrEqual(4);
    expect(Number(v.t2EconomicAnswers.total)).toBeGreaterThanOrEqual(4);
    expect(r.accountId).toBeNull();
  });

  // ── Anomalies dures (compte C) ───────────────────────────────────────────

  it('C26-20…C26-26 chaque anomalie dure est détectée, avec compte et Opération (compte C)', async () => {
    await compteA();
    const C = await make.account({ plan: 'premium' });
    const bienC = await make.asset(C, { category: 'IMMOBILIER' });
    const bienB = await make.asset(B, { category: 'IMMOBILIER' });
    const fichierB = await make.assetFile(B, { assetId: bienB.id });

    const sansSource = await op(C, {});                                         // A1
    const sansCompSrc = await op(C, {});
    const sA = await src(C, sansCompSrc, {});
    await link(C, sansCompSrc, bienC.id);
    await comp(C, sansCompSrc, {});                                             // A2 : aucune source
    const sInactive = await src(C, sansCompSrc, { active: false });
    await comp(C, sansCompSrc, { sources: [sInactive] });                       // A2 : source inactive seulement
    await comp(C, sansCompSrc, { sources: [sA] });                              // saine
    const croise = await op(C, {});
    await src(C, croise, {});
    // Relation intercomptes HISTORIQUE (refusée en base depuis le lot 54, garde 0373) : injectée hors gardes.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active)
               VALUES (${C.id}, ${croise}, ${bienB.id}, 'PRIMARY', 'DOCUMENT', true)`;
    });                                                                          // A3 : bien de B
    await src(C, croise, { key: fichierB.id });                                 // A3 : document de B
    await sql`INSERT INTO agenda_items (account_id, title, business_operation_id) VALUES (${B.id}, 'Agenda B', ${croise})`; // A3
    const x = await op(C, {});
    const y = await op(C, { parent: x });
    await src(C, x, {}); await src(C, y, {});
    await sql`UPDATE business_operations SET parent_operation_id = ${y} WHERE id = ${x}`;   // A4 : cycle
    const d1 = await op(C, {});
    const d2 = await op(C, { parent: d1 });
    const d3 = await op(C, { parent: d2 });
    const d4 = await op(C, { parent: d3 });                                     // A5 : 4 niveaux
    for (const d of [d1, d2, d3, d4]) await src(C, d, {});
    const autre = await op(C, { type: 'OTHER' });
    await src(C, autre, {});                                                     // A7 : OTHER sans qualification

    const { OperationDiagnosticsService } = await diag();
    const svc = new OperationDiagnosticsService();
    const anomalies = Object.fromEntries((await svc.hardAnomalies(C.id)).map((a) => [a.code, a]));
    expect(anomalies.ACTIVE_OPERATION_WITHOUT_SOURCE.count).toBe(1);
    expect(anomalies.ACTIVE_OPERATION_WITHOUT_SOURCE.samples[0]).toMatchObject({ accountId: C.id, operationId: sansSource });
    expect(anomalies.ACTIVE_COMPONENT_WITHOUT_SOURCE.count).toBe(2);
    expect(anomalies.CROSS_ACCOUNT_LINK.count).toBe(3);
    expect(anomalies.CROSS_ACCOUNT_LINK.samples.every((s) => s.accountId === C.id && s.operationId === croise)).toBe(true);
    expect(anomalies.PARENT_CYCLE.count).toBe(2);
    expect(anomalies.PARENT_CYCLE.samples.map((s) => s.operationId).sort()).toEqual([x, y].sort());
    expect(anomalies.PARENT_DEPTH_EXCEEDED.count).toBe(1);
    expect(anomalies.PARENT_DEPTH_EXCEEDED.samples[0]).toMatchObject({ operationId: d4, detail: '4 niveaux (maximum 3)' });
    expect(anomalies.OTHER_AS_FALLBACK.count).toBe(1);
    expect(anomalies.OTHER_AS_FALLBACK.samples[0].operationId).toBe(autre);
    expect(anomalies.NEGATIVE_COMPONENT.count).toBe(0);

    // Indicateurs C26.2 du compte C : anomalies dures portées par les indicateurs 10 à 12.
    const r = await svc.indicators(JANVIER, C.id);
    const v = Object.fromEntries(r.indicators.map((i) => [i.key, i.value]));
    expect(v.activeWithoutActiveSource).toEqual({ count: 1 });
    expect(v.componentsWithoutActiveSource).toEqual({ count: 2 });
    expect(v.crossAccountOrParentCycles).toEqual({ count: 5, crossAccount: 3, parentCycles: 2 });
    expect(r.hardAnomalyTotal).toBe(1 + 2 + 3 + 2 + 1 + 1);

    // Composante négative : impossible en base (CHECK) — détectée si la contrainte a sauté (transaction annulée).
    const RETOUR = new Error('rollback');
    await sql.begin(async (tx) => {
      await tx.unsafe('ALTER TABLE business_operation_financial_components DROP CONSTRAINT business_operation_financial_components_amount_chk');
      await tx`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency)
               VALUES (${C.id}, ${sansCompSrc}, 'REALIZED_COST', -500, 'EUR')`;
      const exec = async <T,>(fn: (q: (s: string, p?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>) =>
        fn(async (s, p = []) => (await tx.unsafe(s, p as never[])) as unknown as Record<string, unknown>[]);
      const neg = (await new OperationDiagnosticsService(exec).hardAnomalies(C.id)).find((a) => a.code === 'NEGATIVE_COMPONENT')!;
      expect(neg.count).toBe(1);
      expect(neg.samples[0].detail).toMatch(/-500 EUR/);
      throw RETOUR;
    }).catch((e) => { if (e !== RETOUR) throw e; });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'business_operation_financial_components_amount_chk'`;
    expect(n).toBe(1);

    // O9-E10 alerte d'exploitation : une anomalie de Supervision par code, résolue à 0 après correction + reconsolidation.
    const { runOperationsQualityCheck, operationsAnomalyFingerprint } = await alerts();
    const { reportAnomaly, autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    const { pgClient } = await import('@/db');
    const deps = {
      detect: () => svc.hardAnomalies(C.id),
      openFingerprints: async () => (await pgClient.unsafe(`SELECT fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE 'other:business-operations:%'`) as unknown as Array<{ fingerprint: string }>).map((z) => z.fingerprint),
      report: reportAnomaly,
      resolve: (f: string) => autoResolveAnomaly(f, { origin: 'operations_quality_check_cleared' }),
    };
    const premier = await runOperationsQualityCheck(deps);
    expect(premier.reported).toBe(6);
    const [ouverte] = await sql<{ domain: string; account_id: number; title: string; status: string }[]>`
      SELECT domain, account_id, title, status FROM admin_anomalies WHERE fingerprint = ${operationsAnomalyFingerprint('PARENT_CYCLE')} AND status = 'open'`;
    expect(ouverte).toMatchObject({ domain: 'other', account_id: C.id, status: 'open' });
    expect(ouverte.title).toMatch(/Cycle parent \/ enfant \(2\)/);
    // « Correction du code + reconsolidation » simulée : les données redeviennent saines.
    await sql`UPDATE business_operations SET parent_operation_id = NULL WHERE id IN (${x}, ${y})`;
    const second = await runOperationsQualityCheck(deps);
    expect(second.resolved).toBe(1);
    const [resolue] = await sql<{ status: string; resolution_source: string }[]>`
      SELECT status, resolution_source FROM admin_anomalies WHERE fingerprint = ${operationsAnomalyFingerprint('PARENT_CYCLE')} ORDER BY id DESC LIMIT 1`;
    expect(resolue).toEqual({ status: 'resolved', resolution_source: 'auto' });
    await sql`UPDATE admin_anomalies SET status = 'resolved', resolved_at = now(), resolution_source = 'auto' WHERE fingerprint LIKE 'other:business-operations:%' AND status = 'open'`;
  });

  // ── Liste, filtres, pagination ───────────────────────────────────────────

  it('O9-E01 liste : filtres compte / type / statut / état / sans bien / sans source / période, pagination stable', async () => {
    await compteA();
    const { OperationDiagnosticsService } = await diag();
    const { parseOperationListFilters } = await model();
    const svc = new OperationDiagnosticsService();
    const liste = (q: Record<string, string>) => svc.list(parseOperationListFilters(new URLSearchParams({ accountId: String(A.id), ...q })));

    const tout = await liste({});
    expect(tout.total).toBe(8);
    expect(tout.items.map((o) => o.id)).toEqual([ids.op7, ids.op6, ids.op8, ids.op5, ids.op3, ids.op2, ids.op1, ids.op4]);
    const p3 = await liste({ pageSize: '3', page: '3' });
    expect(p3).toMatchObject({ total: 8, totalPages: 3, page: 3 });
    expect(p3.items.map((o) => o.id)).toEqual([ids.op1, ids.op4]);
    expect((await liste({ type: 'NULL' })).items.map((o) => o.id)).toEqual([ids.op4]);
    expect((await liste({ type: 'CONTRACT' })).items.map((o) => o.id)).toEqual([ids.op7]);
    expect((await liste({ status: 'ENVISAGED' })).items.map((o) => o.id)).toEqual([ids.op7]);
    expect((await liste({ state: 'merged' })).items.map((o) => o.id)).toEqual([ids.op2]);
    expect((await liste({ state: 'invalidated' })).items.map((o) => o.id)).toEqual([ids.op5, ids.op3]);
    expect((await liste({ state: 'active' })).total).toBe(5);
    expect((await liste({ withoutAsset: '1' })).items.map((o) => o.id).sort()).toEqual([ids.op4, ids.op6, ids.op7, ids.op8].sort());
    expect((await liste({ withoutSource: '1' })).items.map((o) => o.id).sort()).toEqual([ids.op2, ids.op3, ids.op5].sort());
    expect((await liste({ from: '2026-01-01', to: '2026-01-31' })).items.map((o) => o.id)).toEqual([ids.op5, ids.op3, ids.op2, ids.op1]);

    const o1 = tout.items.find((o) => o.id === ids.op1)!;
    expect(o1).toMatchObject({
      accountId: A.id, typeCode: 'INTERVENTION', status: 'REALIZED', assets: [{ id: maison.id, name: 'Maison A' }],
      activeSourceCount: 1, sourceCount: 2, componentCount: 2, netCents: 100_000, principalDate: '2026-01-10',
    });
    expect(o1.label).not.toMatch(/0112 3456/); // C25 : IBAN masqué
    expect(tout.items.find((o) => o.id === ids.op2)).toMatchObject({ mergedIntoOperationId: ids.op1 });
    // Isolation : le filtre d'un autre compte ne renvoie rien de A.
    const autre = await svc.list(parseOperationListFilters(new URLSearchParams({ accountId: String(B.id) })));
    expect(autre.items.some((o) => o.accountId === A.id)).toBe(false);
  });

  it('O9-E02 / F-191 / F-200 candidats en attente : motif, filtres, Opérations proposées ; aucune création par l’âge', async () => {
    await compteA();
    const { OperationDiagnosticsService } = await diag();
    const { parseHoldFilters } = await model();
    const svc = new OperationDiagnosticsService();
    const holds = (q: Record<string, string>) => svc.holds(parseHoldFilters(new URLSearchParams({ accountId: String(A.id), ...q })));
    const tout = await holds({});
    expect(tout.total).toBe(3);
    expect(tout.reasons.map((r) => r.reason).sort()).toEqual(['CONTRADICTORY_REFERENCE', 'M3_AMBIGUOUS', 'PROBABLE_WITHOUT_MATCH']);
    const probable = await holds({ reason: 'PROBABLE_WITHOUT_MATCH' });
    expect(probable.items.map((c) => c.id)).toEqual([ids.c5]);
    expect(probable.items[0]).toMatchObject({ operationId: null, reasonLabel: expect.stringMatching(/pas de création/) });
    const arbitrage = await holds({ outcome: 'ARBITRATION_REQUIRED' });
    expect(arbitrage.items[0]).toMatchObject({ id: ids.c6, proposedOperationIds: [ids.op1], reason: 'M3_AMBIGUOUS' });
    expect((await holds({ pageSize: '2', page: '2' })).items.length).toBe(1);
  });

  // ── Détail ───────────────────────────────────────────────────────────────

  it('O9-E03 / C26.1 détail complet (F-192 REJECTED, F-193 source supersédée, F-185 fusion, Agenda, T3)', async () => {
    await compteA();
    const { OperationDiagnosticsService } = await diag();
    const svc = new OperationDiagnosticsService();
    const d = (await svc.detail(ids.op1))!;
    expect(d.operation).toMatchObject({ id: ids.op1, accountId: A.id, provider: 'Chauffage Plus', active: true, version: 1 });
    expect(d.assetLinks).toEqual([expect.objectContaining({ asset_id: maison.id, asset_name: 'Maison A', link_role: 'PRIMARY', active: true })]);
    expect(d.sources.length).toBe(2);
    const actif = d.sources.find((s) => s.active === true)!;
    expect(actif).toMatchObject({ source_kind: 'DOCUMENT', file_id: ids.f1, authority: 'DOCUMENT', match_method: 'M1', match_reason_label: 'référence métier identique' });
    expect(JSON.stringify(actif.locator)).not.toMatch(/secret\.pdf/);   // C25 : aucun nom de fichier
    expect(d.sources.find((s) => s.active === false)).toMatchObject({ source_version: '1' });   // F-193 : historique conservé
    expect(d.components.length).toBe(2);
    expect((d.components[0].sources as unknown[]).length).toBe(1);
    expect(d.references).toEqual([expect.objectContaining({ reference_kind: 'INVOICE', normalized_value: 'FA2026001' })]);
    expect(d.children.map((c) => Number(c.id))).toEqual([ids.op8]);
    expect(d.mergedFrom.map((c) => Number(c.id))).toEqual([ids.op2]);
    expect(d.history.map((h) => h.event_type)).toEqual(['SOURCE_REMOVED', 'CREATED']);
    expect(d.history.find((h) => h.event_type === 'CREATED')).toMatchObject({ correlation_id: 'corr-op1', reason_code_label: 'création par la consolidation T3' });
    expect(d.matchDecisions).toEqual([expect.objectContaining({ decision: 'REJECTED', origin: 'USER_ARBITRATION', active: true })]);   // F-192
    expect(d.agendaItems).toEqual([expect.objectContaining({ title: 'Entretien chaudière', projection_origin: 'OPERATION' })]);
    expect(d.projectionSuppressions).toEqual([expect.objectContaining({ projection_kind: 'AGENDA', projection_key: 'next-maintenance' })]);
    expect(d.candidates.map((c) => Number(c.id))).toEqual(expect.arrayContaining([ids.c1]));
    expect(d.candidates.find((c) => Number(c.id) === ids.c1)).toMatchObject({ t3_outcome: 'CREATE_NEW' });
    expect(d.lastT3Pass).toMatchObject({ status: 'DONE', businessResult: 'APPLIED', correlationId: 'corr-t3-last' });
    expect(d.procedure).toMatch(/ne modifie jamais/);

    // F-185 : Opération fusionnée — détail lisible, canonique indiquée.
    const fusionnee = (await svc.detail(ids.op2))!;
    expect(fusionnee.canonicalOperationId).toBe(ids.op1);
    expect(fusionnee.operation.active).toBe(false);
    // Détail par type : contrat.
    expect((await svc.detail(ids.op7))!.contractDetails).toMatchObject({ contract_reference: 'POL-77', periodicity: 'ANNUAL' });
    expect(await svc.detail(2_000_000_000)).toBeNull();
  });

  // ── Lecture seule, référentiel ───────────────────────────────────────────

  it('O9-E04 / INV-032 / Q9 aucune écriture possible : la session du diagnostic est READ ONLY (25006)', async () => {
    await compteA();
    const { readOnlyExecutor } = await diag();
    const err = await readOnlyExecutor((q) => q('UPDATE business_operations SET version = version + 1 WHERE id = $1', [ids.op1]))
      .then(() => null, (e: { code?: string }) => e.code);
    expect(err).toBe('25006');
    const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM business_operations WHERE id = ${ids.op1}`;
    expect(version).toBe(1);
  });

  it('O9-E05 / F-183 / C27 référentiel des types : utilisations réelles, dont actives', async () => {
    await compteA();
    const { loadReferentials } = await import('@/app/api/admin/referentials/referentials-data');
    const snap = await loadReferentials();
    const [{ total, actives }] = await sql<{ total: number; actives: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE invalidated_at IS NULL)::int AS actives FROM business_operations WHERE type_code = 'CONTRACT'`;
    const contrat = snap.operationTypes.find((r) => r.code === 'CONTRACT')!;
    expect(contrat.usage).toBe(total);
    expect(contrat.details).toMatch(new RegExp(`dont ${actives} active\\(s\\)$`));
  });
});
