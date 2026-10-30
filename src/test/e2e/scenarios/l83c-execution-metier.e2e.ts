/**
 * Lot 83C — CDC Pilotage IA V2, phase P2 « exécution métier et issue finale »,
 * sur base PostgreSQL réelle (pipeline T1 de production, passerelle RÉELLE,
 * sorties du modèle rejouées : aucun réseau). Assertions limitées aux comptes,
 * travaux et traces créés par ce scénario.
 *
 *   L83C-E2E-MIG  migrations 0668 / 0669 idempotentes, colonnes et index présents
 *   L83C-E2E-01   R17 / SEM-03 : cinq documents → cinq exécutions, quatre
 *                 Réussies, une Incomplète (pages non vérifiées) ; chaque appel
 *                 porte SON exécution ; aucune sixième exécution
 *   L83C-E2E-02   R56 : analyse + réparation = deux appels, une exécution
 *                 (corrélation ai_usage_event ET ai_call_captures)
 *   L83C-E2E-03   R22 / R61 / SEM-05 : échec puis reprise par la file = MÊME
 *                 exécution (non finale pendant la reprise, puis Réussie ; appels
 *                 en échec conservés sans compter d'échec)
 *   L83C-E2E-04   R22 : nouvelle analyse = exécution DISTINCTE, filiation vers la
 *                 précédente
 *   L83C-E2E-05   T2 qualifié (R21) : succès, lacune objective, échec, annulation ;
 *                 appels T2 rattachés à la demande
 *   L83C-E2E-06   T6 qualifié (R42, R43) : FORMULATE (génération, échec +
 *                 secours, affichage expiré exclu) et EVALUATE (états propres) ;
 *                 appel FORMULATE rattaché à sa génération
 *   L83C-E2E-07   T3 / T4 et règle temporelle (R39, R40, R60) : terminé pendant
 *                 la période compté, terminé avant non ; balayage = technique
 *   L83C-E2E-08   droits : routes réservées aux administrateurs existants ;
 *                 Exécutions IA (détail d'appel) et File IA portent l'issue métier
 */
import { afterAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { scenario } from '../scenario';
import { sortieT1, useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { T1_TEST_OPERATION, t1TestVariables, t1Schema } from '@/services/ai/gateway/__tests__/t1-master-request';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
/** Fichier original servi par le « stockage » (aucune lecture S3 réelle) : PDF texte d'une page. */
const stockage = vi.hoisted(() => ({ lignes: [] as string[] }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    stockage.lignes.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 24, size: 12, font }));
    return doc.save();
  },
}));

scenario('L83C', 'Exécution métier et issue finale (Pilotage IA V2 P2)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  const debut = new Date(Date.now() - 60_000);
  const repo = () => import('@/services/ai/business-execution/repository');
  const projeter = async (accountId: number) => (await repo()).projectBusinessExecutions(
    { from: debut, to: new Date(Date.now() + 60_000), accountId, nature: null },
  );

  // Travaux T1 d'autres scénarios : jamais exécutés par ce fichier.
  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
    // Aucun travail de ce scénario ne survit au fichier (les scénarios suivants vident les files).
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now()
               WHERE status IN ('PENDING', 'RUNNING') AND account_id IN (SELECT id FROM accounts WHERE created_at >= ${debut.toISOString()}::timestamptz)`;
  });

  const fichier = async (compte: Parameters<typeof make.assetFile>[0], titre: string) => {
    const f = await make.assetFile(compte);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`${titre}.pdf`}, retained_title = ${titre},
                upload_status = 'COMPLETED', analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const succes = (title: string) => {
    stockage.lignes = [title, '2026-03-14'];
    return {
      operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT',
      output: sortieT1({ title, date: '2026-03-14', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS', assets: [], facts: [] }),
    };
  };
  /** Qualité de couverture posée par le contrôle déterministe (après l'analyse : couverture courante). */
  const couverture = async (fileId: number, quality: string, anomalies: string[] = []) => {
    const n = await sql`UPDATE document_extraction_coverage SET quality_state = ${quality}, anomalies = ${anomalies}, next_retry_at = NULL, updated_at = clock_timestamp()
                         WHERE file_id = ${fileId} RETURNING file_id`;
    if (n.length === 0) {
      await sql`INSERT INTO document_extraction_coverage (file_id, account_id, quality_state, anomalies, updated_at)
                SELECT id, account_id, ${quality}, ${anomalies}, clock_timestamp() FROM asset_files WHERE id = ${fileId}`;
    }
  };
  /** Diagnostic (lot 101-bis) : phases et étapes des rapports T1 du compte, pour un échec lisible en CI. */
  const rapportsT1 = async (accountId: number) => JSON.stringify(await sql`
    SELECT id, status, file_id, sources->'phases' AS phases,
           (SELECT jsonb_agg(s) FROM jsonb_array_elements(steps) s WHERE s->>'status' <> 'OK') AS steps_ko
      FROM ai_execution_reports WHERE treatment = 'T1' AND account_id = ${accountId} ORDER BY id`);
  const appels = (executionId: string) => sql<{ id: number; status: string; metadata: Record<string, unknown> }[]>`
    SELECT id, status, metadata FROM ai_usage_event WHERE business_execution_id = ${executionId} ORDER BY id`;

  it('L83C-E2E-MIG — migrations 0668 et 0669 idempotentes (deux passes), colonnes et index présents', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      const fichiers = (await import('node:fs/promises')).readdir(join(process.cwd(), 'src/db/migrations'));
      for (const f of (await fichiers).filter((x) => /^066[89]_l83c_/.test(x)).sort()) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${f} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const cols = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.columns
      WHERE column_name = 'business_execution_id' AND table_name IN ('ai_usage_event', 'ai_call_captures') ORDER BY table_name`;
    expect(cols.map((c) => c.table_name)).toEqual(['ai_call_captures', 'ai_usage_event']);
    const idx = await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE indexname IN (
      'ai_usage_event_business_execution_idx', 'ai_call_captures_business_execution_idx', 'ai_job_queue_activity_idx', 'ai_job_queue_business_execution_idx',
      'ai_execution_reports_treatment_created_idx', 'ai_execution_reports_business_execution_idx', 'verebona_messages_assistant_request_idx',
      'home_mascot_generations_traced_idx', 'document_extraction_coverage_updated_idx')`;
    expect(idx).toHaveLength(9);
    // Aucune table nouvelle (projection calculée) : rien à classer au catalogue de recette.
    expect(await sql`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'ai_business_execution%'`).toHaveLength(0);
  });

  it('L83C-E2E-01 — R17 : cinq documents → cinq exécutions, quatre Réussies et une Incomplète ; chaque appel porte son exécution', async () => {
    await ecarterLesAutresJobsT1();
    const c = await make.account();
    const docs = [];
    for (const t of ['Facture 1', 'Facture 2', 'Facture 3', 'Facture 4', 'Contrat 5']) docs.push(await fichier(c, t));
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    for (const d of docs) {
      await rejouer([succes(`Document ${d.id}`)]);
      const r = await analyzeFileSources([d.id], c.id, { userId: c.ownerUserId, origin: 'documents/analyze', billable: false });
      expect(r?.failedSourceIds ?? []).toEqual([]);
    }
    for (const d of docs.slice(0, 4)) await couverture(d.id, 'COMPLETE');
    await couverture(docs[4].id, 'VERIFICATION_INCOMPLETE', ['PAGE_UNVERIFIED', 'COVERAGE_UNVERIFIED']);

    const p = await projeter(c.id);
    const t1 = p.rows.filter((x) => x.treatment === 'T1');
    expect(t1).toHaveLength(5);
    expect(new Set(t1.map((x) => x.objectId))).toEqual(new Set(docs.map((d) => String(d.id))));
    expect(t1.filter((x) => x.outcome === 'SUCCEEDED'), JSON.stringify(t1.map((x) => [x.outcome, x.cause, x.native])) + ' — rapports : ' + await rapportsT1(c.id)).toHaveLength(4);
    const inc = t1.filter((x) => x.outcome === 'INCOMPLETE');
    expect(inc.map((x) => x.objectId)).toEqual([String(docs[4].id)]);
    expect(inc[0].cause).toContain('T1_VERIFICATION_INCOMPLETE');
    expect(inc[0].native).toMatchObject({ source: 'ai_execution_reports', result: 'VERIFICATION_INCOMPLETE' });
    expect(t1.every((x) => x.nature === 'BUSINESS' && x.origin === 'USER' && x.id.startsWith('T1:'))).toBe(true);
    // SEM-01 : les appels du document portent l'identifiant de SON exécution (et seulement elle).
    for (const x of t1) {
      const ev = await appels(x.id);
      expect(ev.length).toBeGreaterThanOrEqual(1);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_usage_event WHERE business_execution_id = ${x.id} AND account_id <> ${c.id}`;
      expect(n).toBe(0);
    }
    // Rapports T1 rattachés (sources.businessExecutionId) ; récapitulatif : une fois chacune.
    const [{ n: rapports }] = await sql<{ n: number }[]>`SELECT count(DISTINCT sources->>'businessExecutionId')::int AS n FROM ai_execution_reports WHERE treatment = 'T1' AND account_id = ${c.id}`;
    expect(rapports).toBe(5);
    const s = (await repo()).summarize(p.rows, ['T1'])[0];
    expect(s).toMatchObject({ succeeded: 4, incomplete: 1, failed: 0, notFinal: 0 });
  });

  it('L83C-E2E-02 — R56 : analyse puis réparation = deux appels, une seule exécution (événements d’usage et captures)', async () => {
    const c = await make.account();
    await rejouer([
      { operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: { task: 'GROUP_UPLOAD', ok: 'peut-être' } },
      { operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', callKind: 'repair', output: { task: 'GROUP_UPLOAD', ok: true } },
    ]);
    const { runInBusinessExecution } = await import('@/services/ai/business-execution/context');
    const { newT1ExecutionId } = await import('@/services/ai/business-execution/identity');
    const id = newT1ExecutionId();
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const res = await runInBusinessExecution(id, () => AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: c.id,
      promptVariables: t1TestVariables('facture'), outputSchema: t1Schema({ ok: z.boolean() }), idempotencyKey: `l83c-${c.id}-${Math.random()}`,
    }));
    expect(res.data).toMatchObject({ ok: true });
    const ev = await appels(id);
    expect(ev.map((e) => e.metadata.callKind ?? 'analysis')).toEqual(['analysis', 'repair']);
    const caps = await sql<{ business_execution_id: string; call_kind: string }[]>`
      SELECT business_execution_id, call_kind FROM ai_call_captures WHERE trace_id = ${res.traceId} ORDER BY call_index NULLS LAST, id`;
    expect(caps.map((x) => [x.call_kind, x.business_execution_id])).toEqual([['analysis', id], ['repair', id]]);
    const calls = (await (await repo()).callsOfExecutions([{ id, traceIds: [] }])).get(id)!;
    expect(calls).toMatchObject({ calls: 2, repairCalls: 1 });
  });

  let premiere: { fileId: number; accountId: number; userId: number; executionId: string } | null = null;

  it('L83C-E2E-03 — R22 / R61 / SEM-05 : échec puis reprise par la file = MÊME exécution, non finale pendant la reprise, puis Réussie', async () => {
    await ecarterLesAutresJobsT1();
    const c = await make.account();
    const f = await fichier(c, 'Facture chaudière');
    const { registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    registerSourceAnalysisHandler();
    // 1er essai hors file : aucune sortie enregistrée → la chaîne de modèles échoue.
    await rejouer([]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([f.id], c.id, { userId: c.ownerUserId, origin: 'documents/analyze', billable: false });
    expect(r?.failedSourceIds).toEqual([f.id]);
    let x = (await projeter(c.id)).rows.filter((e) => e.treatment === 'T1');
    expect(x).toHaveLength(1);
    const id = x[0].id;
    // Travail de reprise en attente : l'échec n'est PAS compté (non finale).
    expect(x[0]).toMatchObject({ outcome: 'NOT_FINAL' });
    const [job] = await sql<{ id: number; payload: Record<string, unknown> }[]>`
      SELECT id, payload FROM ai_job_queue WHERE treatment = 'T1' AND dedupe_key = ${`T1:a${c.id}:asset_file:${f.id}`} ORDER BY id DESC LIMIT 1`;
    expect(job.payload.businessExecution).toEqual({ id, role: 'resume' });

    // Reprise par la file : succès.
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${job.id}`;
    await rejouer([succes('Facture chaudière')]);
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    expect(await runOne('T1')).toBe(true);
    await couverture(f.id, 'COMPLETE');
    x = (await projeter(c.id)).rows.filter((e) => e.treatment === 'T1');
    expect(x).toHaveLength(1);
    expect(x[0], JSON.stringify([x[0].cause, x[0].native]) + ' — rapports : ' + await rapportsT1(c.id)).toMatchObject({ id, outcome: 'SUCCEEDED', origin: 'USER' });
    expect(x[0].jobIds).toEqual([Number(job.id)]);
    expect(x[0].reportIds).toHaveLength(2);
    expect(x[0].resumptions).toBeGreaterThanOrEqual(1);
    // Tous les appels (en échec puis réussis) portent la même exécution ; une seule issue : Réussie.
    const ev = await appels(id);
    expect(ev.some((e) => e.status !== 'success')).toBe(true);
    expect(ev.some((e) => e.status === 'success')).toBe(true);
    const calls = (await (await repo()).callsOfExecutions(x)).get(id)!;
    expect(calls.failedCalls).toBeGreaterThan(0);
    expect((await repo()).summarize(x, ['T1'])[0]).toMatchObject({ succeeded: 1, failed: 0 });
    premiere = { fileId: f.id, accountId: c.id, userId: c.ownerUserId, executionId: id };
  });

  it('L83C-E2E-04 — R22 : nouvelle analyse du même document = nouvelle exécution, filiation vers la précédente', async () => {
    expect(premiere).not.toBeNull();
    const p = premiere!;
    await rejouer([succes('Facture chaudière — réanalyse')]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    await analyzeFileSources([p.fileId], p.accountId, { userId: p.userId, origin: 'documents/analyze', billable: false });
    await couverture(p.fileId, 'COMPLETE');
    const t1 = (await projeter(p.accountId)).rows.filter((e) => e.treatment === 'T1');
    expect(t1).toHaveLength(2);
    const nouvelle = t1.find((e) => e.id !== p.executionId)!;
    expect(nouvelle.objectId).toBe(String(p.fileId));
    const detail = await (await repo()).getBusinessExecution(nouvelle.id);
    expect(detail).toMatchObject({ id: nouvelle.id, outcome: 'SUCCEEDED', previousExecutionId: p.executionId });
    // L'exécution précédente n'est plus jugée sur la couverture COURANTE (celle de la
    // nouvelle analyse) mais sur l'instantané de SON rapport — jamais une issue empruntée.
    const avant = await (await repo()).getBusinessExecution(p.executionId);
    const [snap] = await sql<{ value: string }[]>`SELECT e.value #>> '{}' AS value FROM ai_execution_report_entries e
      WHERE e.report_id = ${avant!.reportIds.at(-1)!} AND e.section = 'COVERAGE' LIMIT 1`;
    expect(avant!.native.result).toBe(snap.value);
    expect(['SUCCEEDED', 'INCOMPLETE']).toContain(avant!.outcome);
  });

  it('L83C-E2E-05 — T2 : statuts propres au métier (R21) ; appels rattachés à la demande', async () => {
    const c = await make.account();
    const demande = async (status: string, finalState: string | null, support: string | null, errorCode: string | null = null) => {
      const requestId = crypto.randomUUID();
      await sql`INSERT INTO verebona_request_runs (request_id, account_id, user_id, status, machine_final_state, mode, error_code, latency_ms)
                VALUES (${requestId}, ${c.id}, ${c.ownerUserId}, ${status}, ${finalState}, 'ai', ${errorCode}, 1200)`;
      if (support) {
        const [conv] = await sql<{ id: number }[]>`INSERT INTO verebona_conversations (account_id, user_id, status, expires_at)
          VALUES (${c.id}, ${c.ownerUserId}, 'active', now() + interval '90 days') RETURNING id`;
        await sql`INSERT INTO verebona_messages (conversation_id, account_id, role, status, content, support_level, request_id, expires_at)
                  VALUES (${conv.id}, ${c.id}, 'assistant', 'ready', 'réponse', ${support}, ${requestId}, now() + interval '90 days')`;
      }
      return `T2:${requestId}`;
    };
    const ok = await demande('ok', 'READY', 'supported');
    const abst = await demande('ok', 'READY', 'insufficient');
    const lacune = await demande('ok', 'READY', 'partial');
    const ko = await demande('error', 'ERROR_FINAL', null, 'ASSISTANT_UNAVAILABLE');
    const annule = await demande('cancelled', 'CANCELLED', null);
    const parId = new Map((await projeter(c.id)).rows.filter((x) => x.treatment === 'T2').map((x) => [x.id, x]));
    expect(parId.get(ok)?.outcome).toBe('SUCCEEDED');
    expect(parId.get(abst)?.outcome).toBe('SUCCEEDED');
    expect(parId.get(lacune)).toMatchObject({ outcome: 'INCOMPLETE', cause: expect.stringContaining('T2_CLAIMS_DISCARDED') });
    expect(parId.get(ko)).toMatchObject({ outcome: 'FAILED', native: { source: 'verebona_request_runs', status: 'error' } });
    expect(parId.get(annule)?.outcome).toBe('VOID');

    // Appel du modèle pendant la demande : rattaché à `T2:<request_id>`.
    await rejouer([{ operationCode: 't2_answer', task: 'ANSWER', output: { mode: 'ANSWER', ok: true } }]);
    const { runInBusinessExecution } = await import('@/services/ai/business-execution/context');
    const { t2MasterVariables } = await import('@/services/ai/assistant/master/t2-answer');
    const { asTestContract } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    await runInBusinessExecution(ok, () => AiGateway.execute({
      useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 't2_answer', accountId: c.id, userId: c.ownerUserId,
      promptVariables: t2MasterVariables('ANSWER', { QUESTION: 'Montant ?' }),
      outputSchema: asTestContract(z.object({ mode: z.literal('ANSWER'), ok: z.boolean() })),
      idempotencyKey: `l83c-t2-${Math.random()}`, maxModelAttempts: 1,
    }));
    expect(await appels(ok)).toHaveLength(1);
  });

  it('L83C-E2E-06 — T6 : FORMULATE et EVALUATE qualifiés séparément (R42, R43) ; appel FORMULATE rattaché à sa génération', async () => {
    const c = await make.account();
    // FORMULATE réel par la passerelle : l'exécution EST l'exécution de la passerelle.
    const { T6FormulateOutput, T6_OUTPUT_SCHEMA_VERSION_V2 } = await import('@/services/home/mascot/t6-contract');
    await rejouer([{ operationCode: 't6_formulate', output: { schemaVersion: T6_OUTPUT_SCHEMA_VERSION_V2, messages: [] } }]);
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const res = await AiGateway.execute({
      useCaseCode: 'HOME_MASCOT', operationCode: 't6_formulate', accountId: c.id,
      promptVariables: { INPUT_JSON: '{}', SUGGESTION_CONTEXT: null, INTERPELLATION_CONTEXT: null }, outputSchema: T6FormulateOutput, idempotencyKey: `l83c-t6-${c.id}`,
    });
    expect(await appels(`T6F:${res.traceId}`)).toHaveLength(1);
    const gen = (status: string, traceId: string | null, error: string | null = null) => sql`
      INSERT INTO home_mascot_generations (account_id, context_hash, mode, status, trace_id, error) VALUES (${c.id}, 'h', 'display', ${status}, ${traceId}, ${error})`;
    await gen('generated', res.traceId);
    const echec = crypto.randomUUID();
    await gen('validation_failed', echec, 'sujet inventé');
    await gen('error', null, 'délai de 800 ms dépassé'); // affichage expiré : pas une exécution (génération journalisée plus tard)
    await gen('fallback', null);
    const ev = async (status: string, extra: Record<string, unknown> = {}) => {
      const a = await make.agendaItem(c);
      const fin = status === 'COMPLETED' || status === 'FAILED' ? new Date().toISOString() : null;
      const essai = status === 'RETRY_WAIT' ? new Date(Date.now() + 600_000).toISOString() : null;
      await sql`INSERT INTO t6_evaluation_runs (agenda_item_id, account_id, status, attempts, mode, last_error_kind, finished_at, next_attempt_at)
                VALUES (${a.id}, ${c.id}, ${status}, ${Number(extra.attempts ?? 1)}, 'pregen', ${(extra.kind as string) ?? null},
                        ${fin}::timestamptz, ${essai}::timestamptz)`;
      return a.id;
    };
    const evOk = await ev('COMPLETED');
    const evKo = await ev('FAILED', { attempts: 3, kind: 'invalid_output' });
    const evAttente = await ev('RETRY_WAIT', { kind: 'model_unavailable' });
    const t6 = (await projeter(c.id)).rows.filter((x) => x.treatment === 'T6');
    const f = t6.filter((x) => x.mode === 'FORMULATE');
    expect(f.map((x) => [x.id, x.outcome]).sort()).toEqual([[`T6F:${echec}`, 'FAILED'], [`T6F:${res.traceId}`, 'SUCCEEDED']].sort());
    expect(f.find((x) => x.outcome === 'FAILED')!.cause).toContain('texte de secours affiché');
    const e = new Map(t6.filter((x) => x.mode === 'EVALUATE').map((x) => [Number(x.objectId), x]));
    expect(e.get(evOk)?.outcome).toBe('SUCCEEDED');
    expect(e.get(evKo)).toMatchObject({ outcome: 'FAILED', cause: expect.stringMatching(/^T6_EVALUATE_INVALID_OUTPUT/) });
    expect(e.get(evAttente)).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED' });
    expect(await (await repo()).getBusinessExecution(e.get(evOk)!.id)).toMatchObject({ outcome: 'SUCCEEDED' });
  });

  it('L83C-E2E-07 — T3 / T4 et règle temporelle : terminé pendant la période compté, avant non ; balayage technique ; T4 partiel = Incomplète', async () => {
    const c = await make.account();
    const job = async (treatment: string, over: { status: string; result?: string | null; created: string; finished: string | null; lastError?: string | null; target?: string | null; account?: number | null }) => {
      const [r] = await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts,
          business_result, last_error, created_at, started_at, finished_at, payload)
        VALUES (${treatment}, ${over.account === undefined ? c.id : over.account}, ${over.target ?? 'asset'}, ${String(Math.floor(Math.random() * 1e9))},
                ${`l83c:${Math.random()}`}, ${over.status}, 'automatic', 'source_analyzed', 1, ${over.result ?? null}, ${over.lastError ?? null},
                now() - ${over.created}::interval, now() - ${over.created}::interval, ${over.finished === null ? null : sql`now() - ${over.finished}::interval`}, '{}'::jsonb)
        RETURNING id`;
      return `${treatment}:${r.id}`;
    };
    const t3Pendant = await job('T3', { status: 'DONE', result: 'NO_CHANGE', created: '9 days', finished: '2 days' });
    const t3Avant = await job('T3', { status: 'DONE', result: 'APPLIED', created: '9 days', finished: '8 days' });
    const t3Abst = await job('T3', { status: 'DONE', result: 'ABSTAIN', created: '1 hour', finished: '50 minutes' });
    const t3Remplace = await job('T3', { status: 'DONE', result: 'SUPERSEDED', created: '1 hour', finished: '50 minutes' });
    const t4Partiel = await job('T4', { status: 'FAILED', created: '3 hours', finished: '1 hour', lastError: 'T4_PERSIST_PARTIAL : 1 écriture(s) Agenda en échec' });
    const { projectBusinessExecutions, summarize } = await repo();
    const { periodFromQuery } = await import('@/services/ai/business-execution/period');
    const per = periodFromQuery({});
    const p = await projectBusinessExecutions({ from: per.from, to: per.to, accountId: c.id, treatments: ['T3', 'T4'] });
    const ids = new Map(p.rows.map((x) => [x.id, x]));
    expect(ids.has(t3Pendant)).toBe(true);
    expect(ids.has(t3Avant)).toBe(false);
    expect(ids.get(t3Abst)?.outcome).toBe('SUCCEEDED');
    expect(ids.get(t3Remplace)?.outcome).toBe('VOID');
    expect(ids.get(t4Partiel)).toMatchObject({ outcome: 'INCOMPLETE', native: { status: 'FAILED' } });
    // SEM-04 : une page de balayage planifié (sans compte) est technique, jamais une exécution métier.
    const balayage = await job('T3', { status: 'DONE', result: 'NO_CHANGE', created: '1 hour', finished: '50 minutes', target: 't3_sweep', account: null });
    const tout = await projectBusinessExecutions({ from: per.from, to: per.to, treatments: ['T3'] });
    expect(tout.rows.find((x) => x.id === balayage)?.nature).toBe('TECHNICAL');
    const s = summarize(p.rows, ['T3', 'T4']);
    expect(s[0]).toMatchObject({ succeeded: 2, void: 1 });
    expect(s[1]).toMatchObject({ incomplete: 1, failed: 0 });
  });

  it('L83C-E2E-08 — droits administrateur existants ; File IA et détail d’appel portent l’issue métier', async () => {
    const session = { userId: 0, role: 'USER', email: '' };
    const { SessionService } = await import('@/lib/session-service');
    const espion = vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    try {
      const { NextRequest } = await import('next/server');
      const req = (url: string) => new NextRequest(`http://app.test${url}`, { headers: { origin: 'http://app.test', host: 'app.test' } });
      const liste = (await import('@/app/api/admin/ai/business-executions/route')).GET;
      const detail = (await import('@/app/api/admin/ai/business-executions/[id]/route')).GET;
      const jobs = (await import('@/app/api/admin/ai/queue/jobs/route')).GET;
      const appel = (await import('@/app/api/admin/ai/executions/[id]/route')).GET;
      const p = premiere!;
      const user = await make.user();
      session.userId = user.id; session.role = 'USER'; session.email = user.email;
      expect([401, 403]).toContain((await liste(req(`/api/admin/ai/business-executions?accountId=${p.accountId}`))).status);
      expect([401, 403]).toContain((await detail(req('/x'), { params: Promise.resolve({ id: encodeURIComponent(p.executionId) }) })).status);

      const admin = await make.user({ role: 'ADMIN' });
      session.userId = admin.id; session.role = 'ADMIN'; session.email = admin.email;
      const r = await liste(req(`/api/admin/ai/business-executions?accountId=${p.accountId}&treatment=T1&nature=all`));
      expect(r.status).toBe(200);
      const body = await r.json() as { summary: Array<Record<string, unknown>>; rows: Array<{ id: string; label: string; calls: { calls: number } | null }>; period: { rule: string }; readAt: string };
      expect(body.summary).toHaveLength(1);
      expect(body.summary[0]).toMatchObject({ treatment: 'T1', failed: 0, notFinal: 0 });
      const s0 = body.summary[0] as Record<string, number>;
      expect(s0.succeeded + s0.incomplete + s0.void + s0.undetermined, JSON.stringify(s0)).toBe(2);
      expect(s0.succeeded).toBeGreaterThanOrEqual(1);
      expect(body.rows.map((x) => x.id)).toContain(p.executionId);
      expect(body.rows.find((x) => x.id === p.executionId)).toMatchObject({ calls: expect.objectContaining({ calls: expect.any(Number) }) });
      expect(body.period.rule).toContain('Europe/Paris');
      expect((await detail(req('/x'), { params: Promise.resolve({ id: 'pas-un-id' }) })).status).toBe(400);
      const d = await detail(req('/x'), { params: Promise.resolve({ id: encodeURIComponent(p.executionId) }) });
      expect((await d.json() as { execution: { id: string; outcome: string; previousExecutionId: string | null } }).execution).toMatchObject({ id: p.executionId });

      // File IA : le travail de reprise porte l'issue de SON exécution métier.
      const [j] = await sql<{ id: number }[]>`SELECT id FROM ai_job_queue WHERE dedupe_key = ${`T1:a${p.accountId}:asset_file:${p.fileId}`} ORDER BY id LIMIT 1`;
      const jr = await (await jobs(req(`/api/admin/ai/queue/jobs?ids=${j.id}`))).json() as { jobs: Array<{ id: number; businessExecution: { id: string; outcome: string } | null }> };
      expect(jr.jobs[0].businessExecution).toMatchObject({ id: p.executionId });
      expect(jr.jobs[0].businessExecution!.outcome).not.toBe('FAILED');

      // Détail d'un appel EN ÉCHEC : l'issue métier n'est pas un échec (SEM-05 : repli / reprise réussis).
      const [ko] = await sql<{ id: number }[]>`SELECT id FROM ai_usage_event WHERE business_execution_id = ${p.executionId} AND status <> 'success' ORDER BY id LIMIT 1`;
      const dc = await (await appel(req('/x'), { params: Promise.resolve({ id: String(ko.id) }) })).json() as { businessExecutions: Array<{ id: string; outcome: string }> | null };
      expect(dc.businessExecutions).toEqual([expect.objectContaining({ id: p.executionId })]);
      expect(dc.businessExecutions![0].outcome).not.toBe('FAILED');
    } finally {
      espion.mockRestore();
    }
  });
});
