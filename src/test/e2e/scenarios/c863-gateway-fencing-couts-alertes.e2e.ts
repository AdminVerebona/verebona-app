/**
 * Carte #863 sur base réelle — « IA T1 / Gateway : sécuriser les écarts
 * fonctionnels résiduels du #838 (qualification, preuves, coûts, alertes) ».
 * PostgreSQL RÉEL (migrations 1980 et 2000 appliquées), transport fournisseur
 * MOCKÉ (FakeProvider) : AUCUN appel Gemini. Ces scénarios n'établissent PAS
 * l'acceptation réelle d'un schéma par le fournisseur, ni ses coûts réels.
 *
 *   · C863-E2E-MIG  migration 2000 additive et idempotente (deux passes) ;
 *   · C863-E2E-A1   fencing EN BASE : A expiré / B refuse / A accepte
 *                   tardivement (et l'inverse), génération périmée, résultat
 *                   écrit avant la libération, observations conservées ;
 *   · C863-E2E-A2   cache périmé : B refuse pendant que la base de A est en
 *                   panne — au-delà de la tolérance, A n'envoie plus le schéma ;
 *                   40 décisions concurrentes → une lecture ; base restaurée ;
 *   · C863-E2E-A3   report d'une requalification incertaine opposable, relu
 *                   après redémarrage, UN essai parmi 10 à l'échéance ;
 *   · C863-E2E-B1   littéral récupéré / absence non justifiée / référence
 *                   d'unité PERSISTÉE (reprise) écrits et relus, couverture ;
 *   · C863-E2E-C    requêtes réelles et coûts complets sur traces RÉELLES :
 *                   400 + JSON, réparation 400 + JSON, historique sans détail,
 *                   non-envoi ; vues analyse / réparation / total et détail ;
 *   · C863-E2E-D1   5 230 alertes : panne avant effet, arrêt après effet avant
 *                   validation, panne de résolution / de création / de lecture
 *                   et reprise, deux workers, bail perdu pendant une page (l'ancien
 *                   n'écrit plus), ajouts pendant le parcours, phases, compteurs
 *                   cumulés du cycle = base, invalidation, UNKNOWN conservé.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { z } from 'zod';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } from '@/services/ai/gateway/__tests__/t1-master-request';

type Attempt = { kind: string; outcome: string; dispatch?: string; costStatus?: string; attemptId?: string; parentAttemptId?: string | null };
type Meta = { callKind?: string; traceId?: string; parentCallIndex?: number; providerAttempts?: Attempt[]; costEvidence?: Record<string, unknown> };

scenario('C863', 'Passerelle T1 : fencing de qualification, cache périmé, report, littéral, coûts complets, reprise durable des alertes', ({ sql, make }) => {
  useTargetState();

  const C = () => import('@/services/ai/gateway/schema-compat');
  const S = () => import('@/services/ai/gateway/schema-compat/store');
  const A = () => import('@/services/ai/gateway/schema-compat/alerts');
  const M = () => import('@/services/ai/gateway/schema-compat/static-matrix');
  const CODE = 'ai_schema_incompatibility';
  const REFUS = { reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' as const, httpStatus: 400, providerCode: 'INVALID_ARGUMENT', appVersion: 'sha-e2e-863' };
  const cle = (model: string) => ({
    provider: 'gemini', model, operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7,
    schemaHash: 'cccccccccccc', providerSchemaHash: 'dddddddddddd', adapterVersion: 'ps-e2e-863', generationProfileHash: '-',
  });
  const purger = async () => {
    await sql`DELETE FROM ai_schema_compatibility`;
    await sql`DELETE FROM ai_schema_compat_observations`;
    await sql`DELETE FROM ai_alerts WHERE code = ${CODE}`;
    await sql`DELETE FROM ai_schema_compat_reeval_checkpoints`;
  };
  let fournisseurAvant: unknown = null;
  const installerFake = async () => {
    const P = await import('@/services/ai/gateway/providers');
    if (fournisseurAvant === null) fournisseurAvant = P.getAiProvider();
    const f = new P.FakeProvider();
    P.setAiProvider(f);
    return f;
  };

  afterAll(async () => {
    const compat = await C();
    compat.__setSchemaCompatStoreForTests(null);
    compat.__enableSchemaCompatDbForTests(false);
    if (fournisseurAvant) (await import('@/services/ai/gateway/providers')).setAiProvider(fournisseurAvant as never);
    await purger().catch(() => undefined);
  });

  it('C863-E2E-MIG — migration 2000 additive, idempotente (deux passes), colonnes et table présentes', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      const texte = await readFile(join(process.cwd(), 'src/db/migrations/2000_c863_gateway_fencing_observations_cycle.sql'), 'utf-8');
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const cols = await sql<{ c: string }[]>`
      SELECT table_name || '.' || column_name AS c FROM information_schema.columns
       WHERE (table_name = 'ai_schema_compatibility' AND column_name = 'state_generation')
          OR (table_name = 'ai_schema_compat_reeval_checkpoints' AND column_name IN ('cycle_counters', 'last_status', 'last_error'))
       ORDER BY 1`;
    expect(cols.map((r) => r.c)).toEqual([
      'ai_schema_compat_reeval_checkpoints.cycle_counters', 'ai_schema_compat_reeval_checkpoints.last_error',
      'ai_schema_compat_reeval_checkpoints.last_status', 'ai_schema_compatibility.state_generation',
    ]);
    expect(await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_schema_compat_observations'`).toHaveLength(1);
  });

  it('C863-E2E-A1 — fencing EN BASE : ancien détenteur sans effet (dans les deux sens), génération périmée, observations conservées', async () => {
    await purger();
    const store = await S();
    const { coupleKeyId, SCHEMA_COMPAT_POLICY: P } = await C();
    const t0 = Date.UTC(2026, 10, 25, 8, 0, 0);
    // (1) A tient le bail, expire ; B reprend et REFUSE ; A ACCEPTE tardivement.
    const k = cle('modele-863-a');
    const id = coupleKeyId(k);
    const a = await store.claimQualification(k, 'FIRST', t0);
    expect(a.status).toBe('claimed');
    const tB = t0 + P.qualificationLeaseMs + 1;
    const b = await store.claimQualification(k, 'FIRST', tB);
    expect(b.status).toBe('claimed');
    const refusB = await store.recordRejection(k, REFUS, tB + 5, { token: (b as { token: string }).token, qualificationKind: 'FIRST' });
    expect(refusB).toMatchObject({ applied: true, transition: true });
    // Résultat écrit AVANT la libération du bail ; l'ancien détenteur ne libère pas le bail du nouveau.
    expect(await store.releaseQualification(id, (a as { token: string }).token, tB + 6, false)).toBe(false);
    expect(await store.releaseQualification(id, (b as { token: string }).token, tB + 7, false)).toBe(true);
    const tardif = await store.recordAcceptance(k, 'sha', tB + 8, 'v1', { token: (a as { token: string }).token, qualificationKind: 'FIRST' });
    expect(tardif).toMatchObject({ applied: false, cause: 'LEASE_TOKEN_MISMATCH' });
    expect(await store.getCouple(id)).toMatchObject({ state: 'REJECTED_CONFIRMED', acceptedCount: 0 });
    // (2) Inverse : B ACCEPTE, A REFUSE tardivement.
    const k2 = cle('modele-863-a-inverse');
    const a2 = await store.claimQualification(k2, 'FIRST', t0);
    const b2 = await store.claimQualification(k2, 'FIRST', tB);
    expect((await store.recordAcceptance(k2, 'sha', tB + 5, 'v1', { token: (b2 as { token: string }).token }))!.applied).not.toBe(false);
    const refusTardif = await store.recordRejection(k2, REFUS, tB + 6, { token: (a2 as { token: string }).token });
    expect(refusTardif).toMatchObject({ applied: false });
    expect(await store.getCouple(coupleKeyId(k2))).toMatchObject({ state: 'QUALIFIED', rejectionCount: 0 });
    // (3) Bail détenu mais ÉCHU au moment de l'issue : non opposable.
    const k3 = cle('modele-863-a-echu');
    const a3 = await store.claimQualification(k3, 'FIRST', t0);
    const echu = await store.recordAcceptance(k3, 'sha', t0 + P.qualificationLeaseMs + 10, 'v1', { token: (a3 as { token: string }).token });
    expect(echu).toMatchObject({ applied: false, cause: 'LEASE_EXPIRED' });
    // (4) Appel ORDINAIRE (sans bail) : génération observée à la décision ; une transition intermédiaire l'invalide.
    const avant = (await store.getCouple(coupleKeyId(k2)))!;
    expect(avant.generation).toBeGreaterThan(0);
    await store.recordRejection(k2, REFUS, tB + 100, { generation: avant.generation });
    const apres = (await store.getCouple(coupleKeyId(k2)))!;
    expect(apres).toMatchObject({ state: 'REJECTED_CONFIRMED', generation: avant.generation! + 1 });
    await store.recordAcceptance(k2, 'sha', tB + 200, 'v1');
    const perime = await store.recordRejection(k2, REFUS, tB + 300, { generation: avant.generation });
    expect(perime).toMatchObject({ applied: false, cause: 'STALE_GENERATION' });
    expect(await store.getCouple(coupleKeyId(k2))).toMatchObject({ state: 'QUALIFIED' });
    // Observations HISTORIQUES conservées, même non opposables.
    const obs = await sql<{ key_id: string; outcome: string; opposable: boolean; fence_cause: string | null }[]>`
      SELECT key_id, outcome, opposable, fence_cause FROM ai_schema_compat_observations ORDER BY id`;
    expect(obs.filter((o) => !o.opposable).map((o) => o.fence_cause)).toEqual(['LEASE_TOKEN_MISMATCH', 'LEASE_TOKEN_MISMATCH', 'LEASE_EXPIRED', 'STALE_GENERATION']);
    expect(obs.filter((o) => o.opposable).length).toBeGreaterThanOrEqual(3);
    // Aucune alerte levée par un constat non opposable.
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE}`)[0].n).toBe(0);
  });

  it('C863-E2E-A1-02 — passerelle : B refuse, A accepte tardivement — état, cache, alertes et envois de B tiennent', async () => {
    await purger();
    const compat = await C();
    compat.__enableSchemaCompatDbForTests(true);
    const { coupleKeyId, SCHEMA_COMPAT_POLICY: P } = compat;
    const k = cle('modele-863-pass');
    const t0 = Date.now() - 2 * P.qualificationLeaseMs;
    const dA = await compat.decideSchemaUse(k, t0);
    expect(dA.why).toBe('first_qualification');
    compat.__resetSchemaCompatProcessForTests();
    const tB = t0 + P.qualificationLeaseMs + 1;
    const dB = await compat.decideSchemaUse(k, tB);
    expect(dB.why).toBe('first_qualification');
    compat.reportSchemaOutcome(dB, { kind: 'REJECTED', reason: 'EXPLICIT_SCHEMA_REJECTION' }, { httpStatus: 400 }, tB + 5);
    await compat.__flushSchemaCompatWritesForTests();
    compat.reportSchemaOutcome(dA, { kind: 'ACCEPTED', servedModelVersion: 'v9' }, {}, tB + 10);
    await compat.__flushSchemaCompatWritesForTests();
    expect(await (await S()).getCouple(coupleKeyId(k))).toMatchObject({ state: 'REJECTED_CONFIRMED', acceptedCount: 0 });
    // Alerte de B levée UNE fois ; aucune résolution par le constat tardif de A.
    const alertes = await sql<{ resolved_at: Date | null }[]>`SELECT resolved_at FROM ai_alerts WHERE code = ${CODE}`;
    expect(alertes).toHaveLength(1);
    expect(alertes[0].resolved_at).toBeNull();
    expect(await compat.decideSchemaUse(k, tB + 20)).toMatchObject({ send: false, why: 'recent_rejection' });
    compat.__enableSchemaCompatDbForTests(false);
  });

  it('C863-E2E-A2 — cache périmé : B refuse pendant la panne de A ; au-delà de la tolérance, A n’envoie plus le schéma ; 40 décisions → 1 lecture', async () => {
    await purger();
    const compat = await C();
    const store = await S();
    const t0 = Date.now() - 60_000;
    const k = cle('modele-863-perime');
    await store.recordAcceptance(k, 'sha', t0, 'v1');
    compat.__enableSchemaCompatDbForTests(true);
    expect(await compat.decideSchemaUse(k, t0 + 1)).toMatchObject({ send: true, why: 'qualified' });
    // B refuse EN BASE ; la mémoire partagée de A devient illisible (panne).
    await store.recordRejection(k, REFUS, t0 + 2);
    const lectures = { load: 0 };
    compat.__setSchemaCompatStoreForTests({
      loadKnownCouples: async () => { lectures.load++; throw Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' }); },
      getCouple: async () => { throw new Error('connection terminated unexpectedly'); },
    }, { keepProcessMemory: true });
    const tard = t0 + 1 + compat.SHARED_TTL_MS + compat.QUALIFIED_STALE_TOLERANCE_MS + 1;
    expect(await compat.decideSchemaUse(k, tard)).toMatchObject({ send: false, why: 'memory_unavailable', degraded: { cause: 'stale_cache' } });
    // 40 décisions concurrentes pendant la panne : AUCUNE tempête (une lecture au plus par période).
    lectures.load = 0;
    const ds = await Promise.all(Array.from({ length: 40 }, (_, i) => compat.decideSchemaUse(cle(`modele-863-x-${i}`), tard + 1)));
    expect(ds.every((d) => !d.send)).toBe(true);
    expect(lectures.load).toBeLessThanOrEqual(1);
    // Rien d'écrit pendant la panne (aucun faux QUALIFIED) ; base restaurée : le refus de B est lu.
    compat.__setSchemaCompatStoreForTests(null, { keepProcessMemory: true });
    expect(await compat.decideSchemaUse(k, tard + 3 * compat.SHARED_TTL_MS)).toMatchObject({ send: false, why: 'recent_rejection' });
    expect(await store.getCouple(compat.coupleKeyId(k))).toMatchObject({ state: 'REJECTED_CONFIRMED' });
    compat.__enableSchemaCompatDbForTests(false);
  });

  it('C863-E2E-A3 — report d’une requalification incertaine OPPOSABLE, relu après redémarrage ; UN essai parmi 10 à l’échéance', async () => {
    await purger();
    const compat = await C();
    const store = await S();
    const { SCHEMA_COMPAT_POLICY: P } = compat;
    const k = cle('modele-863-alias');
    const t0 = Date.now() - P.uncertainQualificationTtlMs - 5 * P.inconclusiveRetestMs;
    await store.recordAcceptance(k, 'sha', t0, null);
    compat.__enableSchemaCompatDbForTests(true);
    const echu = t0 + P.uncertainQualificationTtlMs + 1;
    const d = await compat.decideSchemaUse(k, echu);
    expect(d).toMatchObject({ send: true, why: 'requalification_due' });
    compat.reportSchemaOutcome(d, { kind: 'INCONCLUSIVE' }, {}, echu + 1);
    await compat.__flushSchemaCompatWritesForTests();
    expect(await compat.decideSchemaUse(k, echu + 2)).toMatchObject({ send: false, why: 'requalification_deferred' });
    compat.__resetSchemaCompatProcessForTests();
    expect(await compat.decideSchemaUse(k, echu + P.inconclusiveRetestMs - 10)).toMatchObject({ send: false, why: 'requalification_deferred' });
    compat.__resetSchemaCompatProcessForTests();
    const ds = await Promise.all(Array.from({ length: 10 }, () => compat.decideSchemaUse(k, echu + 1 + P.inconclusiveRetestMs)));
    expect(ds.filter((x) => x.send)).toHaveLength(1);
    compat.__enableSchemaCompatDbForTests(false);
  });

  it('C863-E2E-B1 — littéral récupéré, absence non justifiée, référence d’unité PERSISTÉE (reprise) : écrits, relus, couverture non déclarée complète', async () => {
    const compte = await make.account();
    const f = await make.assetFile(compte);
    const [ex] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, provider, model, prompt_version, fact_count)
      VALUES (${compte.id}, ${f.id}, 'fake', 'm', 't1_analyze_document@v7', 4) RETURNING id`;
    const long = 'ballon thermodynamique 270 litres, '.repeat(70).trim();
    await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, content_text, coverage_status)
      VALUES (${compte.id}, ${f.id}, ${ex.id}, 'page:1:block:1', 'TEXT_BLOCK', 1, 0, ${'Désignation : ' + long}, 'COVERED')`;
    const { insertFactRows } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { readRawValueAbsence, literalCoverageOf } = await import('@/services/ai/source-analysis/master/raw-value-absence');
    const { pgClient } = await import('@/db');
    const fait = (over: Record<string, unknown>) => ({
      factKey: 'acquisitionPrice', subject: null, attribute: null, label: null, valueText: '1234.5', valueNumber: 1234.5, valueUnit: 'EUR',
      valueJson: 1234.5, normalizedValue: '1234.5', periodStart: null, periodEnd: null, confidence: 'certain' as const, excerpt: 'Total TTC : 1 234,50 €',
      location: { page: 1 }, evidenceOrigin: 'TEXT_EXTRACTION' as const, visualEvidence: null,
      canonicalKey: 'acquisitionPrice', rawKey: 'Total TTC', valueType: 'money_eur', canonicalUnit: 'EUR', projectionOrigin: 'MODEL_CANONICAL', rawValue: null, ...over,
    });
    await pgClient.begin(async (tx) => {
      await insertFactRows(tx as never, { accountId: compte.id, fileId: f.id, sourceType: 'asset_file', provider: 'fake', model: 'm', promptVersion: 'v' }, Number(ex.id), [
        fait({}),
        fait({ factKey: 'hors_sujet', excerpt: 'Total TTC : voir page 2' }),
        fait({ factKey: 'designation', canonicalKey: null, valueText: long, valueNumber: null, normalizedValue: long, valueType: 'text', excerpt: long.slice(0, 60).trim(), sourceUnitIds: ['page:1:block:1'] }),
        fait({ factKey: 'zero', valueNumber: 0, valueText: '0', normalizedValue: '0', excerpt: 'Solde : 0,00 €' }),
      ] as never, { canonical: true, provenance: true });
    });
    const lus = await sql<{ fact_key: string; raw_value: string | null; raw_value_absence: string | null; source_unit_ids: string[] | null; location: Record<string, unknown> }[]>`
      SELECT fact_key, raw_value, raw_value_absence, source_unit_ids, location FROM document_facts WHERE extraction_id = ${ex.id} ORDER BY id`;
    expect(lus.map((r) => [r.fact_key, r.raw_value, r.raw_value_absence])).toEqual([
      ['acquisitionPrice', '1 234,50 €', null],
      ['hors_sujet', null, 'UNJUSTIFIED'],
      ['designation', null, 'SOURCE_UNIT_REFERENCE'],
      ['zero', '0,00 €', null],
    ]);
    expect(lus[0].location).toMatchObject({ rawValueSource: 'EXCERPT' });
    expect(lus[2].source_unit_ids).toEqual(['page:1:block:1']);
    const lecture = lus.map((r) => ({ rawValue: r.raw_value, rawValueAbsence: r.raw_value_absence }));
    expect(lecture.map((r) => readRawValueAbsence(r))).toEqual([null, 'UNJUSTIFIED', 'SOURCE_UNIT_REFERENCE', null]);
    expect(literalCoverageOf(lecture)).toMatchObject({ status: 'INCOMPLETE', literal: 2, justified: 1, unjustified: 1 });
  });

  it('C863-E2E-C — requêtes réelles et coûts complets sur traces RÉELLES ; vues analyse / réparation / total ; détail parent / enfant', async () => {
    const fake = await installerFake();
    const envoyees = { n: 0 };
    fake.onAny((input) => {
      envoyees.n++;
      if (input.callKind === 'repair') {
        if (input.responseSchema) throw Object.assign(new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { name: 'ClientError', status: 400 });
        return { rawText: t1Out({ ok: true }), inputTokens: 5, outputTokens: 5 };
      }
      return { rawText: t1Out({ ok: 'peut-être' }), inputTokens: 10, outputTokens: 5 };
    });
    const compte = await make.account();
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const res = await AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: compte.id,
      promptVariables: t1TestVariables('coûts c863'), outputSchema: t1Schema({ ok: z.boolean() }), idempotencyKey: `c863-c-${Math.random()}`,
    });
    expect(res.data).toMatchObject({ ok: true });
    // Analyse (1) + réparation 400 + JSON (2) = 3 requêtes, égales aux envois du transport.
    expect(res.providerRequests).toBe(3);
    expect(envoyees.n).toBe(3);
    const evts = await sql<{ id: number; metadata: Meta }[]>`SELECT id, metadata FROM ai_usage_event WHERE account_id = ${compte.id} ORDER BY id`;
    const rep = evts.find((e) => e.metadata.callKind === 'repair')!.metadata;
    expect(rep.providerAttempts!.map((a) => [a.kind, a.dispatch])).toEqual([['initial', 'SENT'], ['diagnostic_retry', 'SENT']]);
    // Historique SANS détail de tentatives et tentative NON envoyée (synthétiques, même filtre).
    const traceId = evts[0].metadata.traceId!;
    await sql`INSERT INTO ai_usage_event (account_id, use_case_code, operation_code, operation_type, provider, model, is_billable, is_fallback, input_tokens, output_tokens, cost_micros, duration_ms, status, metadata)
      VALUES (${compte.id}, 'SOURCE_ANALYSIS', ${T1_TEST_OPERATION}, ${T1_TEST_OPERATION}, 'fake', 'm-histo', false, false, 10, 5, NULL, 10, 'success',
              ${JSON.stringify({ traceId: 'histo-863', providerRequest: { responseSchemaSent: true } })}::jsonb)`;
    await sql`INSERT INTO ai_usage_event (account_id, use_case_code, operation_code, operation_type, provider, model, is_billable, is_fallback, input_tokens, output_tokens, cost_micros, duration_ms, status, metadata)
      VALUES (${compte.id}, 'SOURCE_ANALYSIS', ${T1_TEST_OPERATION}, ${T1_TEST_OPERATION}, 'fake', 'm-garde', false, false, 0, 0, 0, 0, 'error',
              ${JSON.stringify({ traceId: 'garde-863', providerRequest: { responseSchemaSent: true }, providerAttempts: [{ step: 1, kind: 'initial', outcome: 'FAILED', dispatch: 'NOT_SENT_GUARD', costStatus: 'NOT_SENT', costMicros: null }] })}::jsonb)`;
    const { getSchemaCostViews, getSchemaCostDetails, getSchemaUsageReport } = await import('@/services/ai/gateway/schema-compat/supervision');
    const [{ fin }] = await sql<{ fin: Date }[]>`SELECT now() + interval '1 minute' AS fin`;
    const v = await getSchemaCostViews({ days: 1, operationCode: T1_TEST_OPERATION }, new Date(fin));
    expect(v.unavailable).toBeNull();
    const { analysis, repair, total } = v.views!;
    expect(repair).toMatchObject({ providerRequests: 2, attemptsCostUnknown: 1 });
    // Le non-envoi n'est pas une requête ; l'historique sans détail n'est jamais compté « 1 ».
    expect(analysis.attemptsNotSent).toBeGreaterThanOrEqual(1);
    expect(analysis.callsWithoutDetail).toBeGreaterThanOrEqual(1);
    expect(total.calls).toBe(analysis.calls + repair.calls);
    expect(total.providerRequests).toBe(analysis.providerRequests + repair.providerRequests);
    expect(total.observedCostMicros).toBe(analysis.observedCostMicros + repair.observedCostMicros);
    expect(['PARTIAL', 'UNKNOWN']).toContain(total.costStatus);
    const u = await getSchemaUsageReport({ days: 1, operationCode: T1_TEST_OPERATION }, new Date(fin));
    expect(u.totals.callsWithoutRequestDetail).toBeGreaterThanOrEqual(1);
    // Détail parent / enfant (paginé ; les vues n'en dépendent pas).
    const d = await getSchemaCostDetails({ days: 1, operationCode: T1_TEST_OPERATION, pageSize: 100 }, new Date(fin));
    const exec = d.executions.find((x) => x.traceId === traceId)!;
    expect(exec.calls.map((c) => [c.callKind, c.parentCallIndex])).toEqual([['analysis', null], ['repair', 0]]);
    expect(exec.calls[1].attempts[0].parentAttemptId).toBe(exec.calls[0].attempts[0].attemptId);
  });

  it('C863-E2E-D1 — 5 230 alertes : pannes et reprises, deux workers, bail perdu en page, phases, compteurs cumulés = base', async () => {
    await purger();
    const store = await S();
    const alerts = await A();
    const cur = (await M()).staticSchemaRowOf('t1_analyze_document')!;
    const base = {
      provider: 'gemini', operationCode: cur.operationCode, contractId: cur.contractId, contractVersion: cur.contractVersion,
      schemaHash: cur.schemaHash, providerSchemaHash: cur.providerSchemaHash, adapterVersion: cur.adapterVersion,
    };
    const t0 = Date.UTC(2026, 10, 25, 14, 0, 0);
    const TOTAL = 5_230;
    const couples = Array.from({ length: TOTAL }, (_, i) => ({ ...base, model: `modele-863-d1-${String(i).padStart(5, '0')}` }));
    for (let i = 0; i < couples.length; i += 200) {
      const lot = couples.slice(i, i + 200);
      const etats = await Promise.all(lot.map((k, j) => store.recordRejection(k, REFUS, t0 + (i + j) * 10)));
      await Promise.all(etats.map((r) => alerts.raiseSchemaIncompatibilityAlert(r!.state)));
    }
    // Couples refusés SANS alerte (levée perdue) : la phase COUPLES doit les lever.
    const sansAlerte = Array.from({ length: 7 }, (_, i) => ({ ...base, model: `modele-863-d1-sans-alerte-${i}` }));
    for (const k of sansAlerte) await store.recordRejection(k, REFUS, t0 + 1);
    // Couples dont le motif est PROUVÉ disparu (accepté de nouveau).
    const acceptes = couples.filter((_, i) => i % 50 === 0);
    for (const k of acceptes) await store.recordAcceptance(k, 'sha', t0 + 10_000_000, 'v1');
    const chaine = async () => [...couples, ...sansAlerte].map((c) => c.model);
    const ck = { cyclePeriodMs: 0 };
    const ouvertes = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND resolved_at IS NULL`)[0].n;
    const resolues = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND resolved_at IS NOT NULL`)[0].n;
    const point = async () => (await sql<{ phase: string; alert_cursor: string; lease_token: string | null; last_status: string | null; last_error: string | null; cycle_counters: Record<string, number> | null; last_report: Record<string, unknown> | null }[]>`
      SELECT phase, alert_cursor, lease_token, last_status, last_error, cycle_counters, last_report FROM ai_schema_compat_reeval_checkpoints WHERE scope = 'schema_compat_alerts'`)[0];
    expect(await ouvertes()).toBe(TOTAL);

    // (1) Panne AVANT l'effet (lecture faite) sur la 1re page, persistante : reprise bornée puis INTERRUPTED au point sûr.
    const p1 = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, readChain: chaine, faults: { beforeEffects: () => { throw new Error('panne avant effet'); } } });
    expect(p1.checkpoint).toMatchObject({ status: 'INTERRUPTED', cycleCompleted: false });
    expect(p1).toMatchObject({ examined: 0, failures: 3, retries: 2, done: false });
    let pt = await point();
    expect(pt).toMatchObject({ phase: 'ALERTS', alert_cursor: '0', lease_token: null, last_status: 'INTERRUPTED' });
    expect(pt.last_error).toMatch(/panne avant effet/);
    expect(await resolues()).toBe(0);

    // (2) Arrêt BRUTAL après les effets et le curseur, AVANT la validation (page 2) : rien de cette page n'est durable.
    const { ReevaluationCrashSimulated } = alerts;
    let pages = 0;
    await expect(alerts.reevaluateSchemaCompatAlerts({
      checkpoint: ck, readChain: chaine,
      faults: { beforeCommit: () => { pages++; if (pages === 2) throw new ReevaluationCrashSimulated(); } },
    })).rejects.toThrow(/arrêt brutal/);
    pt = await point();
    const curseurPage1 = Number(pt.alert_cursor);
    expect(curseurPage1).toBeGreaterThan(0);
    expect(pt.lease_token).not.toBeNull();
    const resoluesPage1 = await resolues();
    expect(pt.cycle_counters).toMatchObject({ examined: 100, pages: 1 });

    // (3) Bail du processus mort expiré. Worker A perd son bail PENDANT sa première page (B reprend et termine) :
    // A, ancien détenteur, n'écrit PLUS rien (sa transaction s'arrête au verrou du bail).
    await sql`UPDATE ai_schema_compat_reeval_checkpoints SET lease_expires_at = now() - interval '1 second'`;
    let b: Awaited<ReturnType<typeof alerts.reevaluateSchemaCompatAlerts>> | null = null;
    let declenche = false;
    // (4) Pannes TRANSITOIRES pendant le cycle de B : une résolution, une lecture, une création — reprises sans doublon.
    let panneResolution = 1; let panneLecture = 1; let panneCreation = 1;
    const a = await alerts.reevaluateSchemaCompatAlerts({
      checkpoint: ck, readChain: chaine,
      faults: {
        beforeEffects: async () => {
          if (declenche) return;
          declenche = true;
          await sql`UPDATE ai_schema_compat_reeval_checkpoints SET lease_expires_at = now() - interval '1 second'`;
          // Nouvelles alertes PENDANT le parcours (identifiants au-delà du curseur) : prises dans ce cycle.
          const nouveaux = Array.from({ length: 12 }, (_, i) => ({ ...base, model: `modele-863-d1-nouveau-${i}` }));
          for (const k of nouveaux) await alerts.raiseSchemaIncompatibilityAlert((await store.recordRejection(k, REFUS, t0 + 20_000_000))!.state);
          b = await alerts.reevaluateSchemaCompatAlerts({
            checkpoint: ck, readChain: async () => [...(await chaine()), ...nouveaux.map((n) => n.model)],
            faults: {
              inEffect: (p) => { if (p.kind === 'RESOLVE' && panneResolution-- > 0) throw new Error('panne de résolution'); if (p.kind === 'RAISE' && panneCreation-- > 0) throw new Error('panne de création'); },
              readCouple: () => { if (panneLecture-- > 0) throw new Error('panne de lecture du couple'); },
            },
          });
        },
      },
    });
    expect(a.checkpoint).toMatchObject({ status: 'LEASE_LOST', cycleCompleted: false });
    expect(a.examined).toBe(0);
    expect(a.resolved.SCHEMA_ACCEPTED_AGAIN).toBe(0);
    const B = b as unknown as Awaited<ReturnType<typeof alerts.reevaluateSchemaCompatAlerts>>;
    expect(B.checkpoint).toMatchObject({ status: 'RAN', resumed: true, cycleCompleted: true, startedFrom: { phase: 'ALERTS', alertCursor: curseurPage1 } });
    expect(B.failures).toBe(3);
    expect(B.retries).toBe(3);

    // (5) Bilan CUMULÉ du cycle entier (tous passages) = base : aucune alerte comptée deux fois, aucune perdue.
    pt = await point();
    expect(pt).toMatchObject({ phase: 'DONE', alert_cursor: '0', lease_token: null, last_status: 'DONE' });
    const bilan = pt.last_report as { examined: number; resolved: Record<string, number>; raised: number; keptRoutingUnknown: number; couplesScanned: number; failures: number; retries: number };
    const totalResolues = await resolues();
    expect(totalResolues).toBe(acceptes.length);
    expect(resoluesPage1 + B.resolved.SCHEMA_ACCEPTED_AGAIN).toBe(acceptes.length);
    expect(bilan.resolved.SCHEMA_ACCEPTED_AGAIN).toBe(acceptes.length);
    expect(bilan.examined).toBe(TOTAL + 12);
    expect(bilan.raised).toBe(sansAlerte.length);
    expect(bilan.failures).toBe(3 + 3);
    expect(bilan.couplesScanned).toBe((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_schema_compatibility WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK')`)[0].n);
    expect(await ouvertes()).toBe(TOTAL + 12 + sansAlerte.length - acceptes.length);
    // Refus historiques intacts, aucune écriture sur les anomalies de couverture T1 (#775).
    expect(B.coverageCoordination.unchanged).toBe(true);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_schema_compatibility WHERE last_http_status = 400`)[0].n).toBe(TOTAL + 12 + sansAlerte.length);

    // (6) Second passage (nouveau cycle) : rien à résoudre, rien à lever — idempotent.
    const p6 = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, readChain: chaine });
    expect(p6).toMatchObject({ raised: 0, done: true });
    expect(p6.resolved.SCHEMA_ACCEPTED_AGAIN).toBe(0);
    expect(p6.alreadySatisfied).toBe(0);

    // (6b) Routage ILLISIBLE (UNKNOWN) : aucune clôture, aucune levée — tout est conservé, compté à part.
    const avantInconnu = await ouvertes();
    const p6b = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, readChain: async () => { throw new Error('configuration illisible'); } });
    expect(p6b.resolved).toEqual({ SCHEMA_ACCEPTED_AGAIN: 0, SCHEMA_SUPERSEDED: 0, SCHEMA_MODEL_WITHDRAWN: 0 });
    expect(p6b.keptRoutingUnknown).toBe(avantInconnu);
    expect(await ouvertes()).toBe(avantInconnu);

    // (7) Invalidation contrôlée (périmètre / algorithme) : recommence au début, compteurs du cycle remis à zéro.
    await sql`UPDATE ai_schema_compat_reeval_checkpoints SET scope_fingerprint = 'ancien-perimetre', phase = 'ALERTS', alert_cursor = 12345`;
    const inval = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, maxAlerts: 100, readChain: chaine });
    expect(inval.checkpoint).toMatchObject({ status: 'RAN', invalidated: true, startedFrom: { alertCursor: 0 } });
    expect(inval.cycleTotals).toMatchObject({ examined: 100 });
  }, 300_000);
});
