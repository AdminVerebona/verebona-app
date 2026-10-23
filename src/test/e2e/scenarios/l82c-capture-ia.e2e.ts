/**
 * Lot 82C — CDC Pilotage IA V2, phase P1 « capture complète à la source et
 * conservation », sur base PostgreSQL réelle (passerelle RÉELLE, sorties du
 * modèle rejouées : aucun réseau). Assertions limitées aux comptes, traces et
 * lignes créés par ce scénario.
 *
 *   L82C-E2E-MIG   migrations 0649, 0650, 0651 idempotentes (deux passes)
 *   L82C-E2E-01    réussite + échec + repli : une capture par tentative, rattachée
 *                  à son événement d'usage, prompt réellement transmis, réponse
 *                  brute masquée, durée PROPRE par tentative
 *   L82C-E2E-02    réparation ciblée : capture de l'analyse (sortie d'origine
 *                  erronée) et de la réparation
 *   L82C-E2E-03    T2 : échange capturé et rattaché à sa conversation ; effacement
 *                  de l'historique par l'utilisateur → échanges supprimés ; purge
 *                  automatique à 90 jours → échanges conservés
 *   L82C-E2E-04    droits : refus hors AI_MODEL_OUTPUT_ADMIN_IDS (journalisé, aucun
 *                  contenu), accès autorisé journalisé (périmètre, nombre)
 *   L82C-E2E-05    échec de capture : traitement métier non bloqué, capture reprise
 *                  sans rappeler le modèle ; appel sans capture signalé à la
 *                  Supervision
 *   L82C-E2E-06    suppression de compte : contenu capturé purgé
 *   L82C-E2E-07    plus aucune suppression à 88 jours : archivage = copie, lignes,
 *                  diagnostics, rapports, captures et traces T2 conservés
 *   L82C-E2E-08    historique antérieur : « non conservé historiquement »
 *   L82C-E2E-VOL   mesure du volume stocké par appel (T1 réaliste)
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { T1_TEST_OPERATION, t1TestVariables, t1Schema } from '@/services/ai/gateway/__tests__/t1-master-request';

const IBAN = 'FR76 3000 6000 0112 3456 7890 189';

scenario('L82C', 'Capture complète à la source des échanges IA et conservation', ({ sql, make, useRecordings }) => {
  let adminIdsAvant: string | undefined;
  beforeAll(() => { adminIdsAvant = process.env.AI_MODEL_OUTPUT_ADMIN_IDS; delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS; });
  afterAll(async () => {
    if (adminIdsAvant === undefined) delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS; else process.env.AI_MODEL_OUTPUT_ADMIN_IDS = adminIdsAvant;
    const { setCaptureWriterForTests, resetCaptureQueueForTests } = await import('@/services/ai/telemetry/call-capture');
    setCaptureWriterForTests(null);
    resetCaptureQueueForTests();
  });

  const gateway = async () => (await import('@/services/ai/gateway/ai-gateway')).AiGateway;
  const appelT1 = async (accountId: number, over: Record<string, unknown> = {}) => (await gateway()).execute({
    useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId,
    promptVariables: t1TestVariables(`facture ${IBAN}`), outputSchema: t1Schema({ ok: z.boolean() }),
    idempotencyKey: `l82c-${accountId}-${Math.random()}`,
    attachments: [{ url: `https://bucket.example/docs/${accountId}.pdf?X-Amz-Signature=JETON`, mimeType: 'application/pdf', displayName: 'facture.pdf' }],
    ...over,
  });
  type Cap = {
    id: number; usage_event_id: number | null; call_index: number | null; call_kind: string; origin: string; capture_status: string;
    prompt_status: string; prompt_text: string | null; response_status: string; response_raw: string | null; attempt_duration_ms: number | null;
    execution_elapsed_ms: number | null; attachments: Array<Record<string, unknown>>; request_params: Record<string, unknown>; account_id: number | null;
    subject_ref: string | null; capture_attempts: number; parsed_output: Record<string, unknown> | null; masking: Record<string, unknown>;
  };
  const capturesDe = (traceId: string) => sql<Cap[]>`SELECT * FROM ai_call_captures WHERE trace_id = ${traceId} ORDER BY call_index NULLS LAST, id`;

  it('L82C-E2E-MIG — migrations 0649, 0650, 0651 idempotentes (deux passes)', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const f of ['0649_l82c_capture_appels_ia.sql', '0650_l82c_archives_ia_sans_suppression.sql', '0651_l82c_retrait_purge_diagnostics_ia.sql']) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${f} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const [etat] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_call_capture_state`;
    expect(etat.n).toBe(1);
    const idx = await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE indexname IN ('ai_call_captures_usage_idx', 'ai_call_captures_trace_idx', 'ai_call_captures_account_idx', 'ai_call_captures_user_idx', 'ai_usage_event_trace_idx')`;
    expect(idx).toHaveLength(5);
    const [t] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM scheduled_task_state WHERE code = 'ai-call-diagnostics-purge'`;
    expect(t.n).toBe(0);
  });

  it('L82C-E2E-01 — réussite, échec et repli : une capture par tentative, contenu réellement transmis, durée propre', async () => {
    const compte = await make.account();
    const replay = await useRecordings([
      { operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: '', error: { message: '503 Service Unavailable', status: 503 } },
      { operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: { task: 'GROUP_UPLOAD', ok: true, note: `IBAN ${IBAN}` }, inputTokens: 1200, outputTokens: 40 },
    ]);
    const res = await appelT1(compte.id);
    expect(res.data).toMatchObject({ task: 'GROUP_UPLOAD', ok: true });
    expect(replay.calls).toHaveLength(2);
    const caps = await capturesDe(res.traceId);
    const events = await sql<{ id: number; status: string; duration_ms: number; metadata: Record<string, unknown> }[]>`
      SELECT id, status, duration_ms, metadata FROM ai_usage_event WHERE metadata->>'traceId' = ${res.traceId} ORDER BY id`;
    expect(events.map((e) => e.status)).toEqual(['error', 'success']);
    expect(caps.map((c) => [Number(c.usage_event_id), c.call_kind, c.origin, c.prompt_status, c.response_status])).toEqual([
      [Number(events[0].id), 'analysis', 'gateway', 'MASKED', 'NO_RESPONSE'],
      [Number(events[1].id), 'analysis', 'gateway', 'MASKED', 'MASKED'],
    ]);
    // Prompt réellement transmis à chaque tentative (repli informé compris), jamais reconstitué.
    expect(caps[0].prompt_text).toBe(replay.calls[0].prompt);
    expect(caps[1].prompt_text).toBe(replay.calls[1].prompt);
    expect(caps[1].prompt_text).not.toContain('3000 6000');
    // Réponse brute masquée, sortie parsée et acceptée.
    expect(caps[1].response_raw).toContain('[IBAN_MASQUE]');
    expect(caps[1].parsed_output).toMatchObject({ accepted: { task: 'GROUP_UPLOAD', ok: true } });
    // Pièce jointe par référence, sans le jeton signé.
    expect(caps[1].attachments).toEqual([expect.objectContaining({ storage: `https://bucket.example/docs/${compte.id}.pdf`, mimeType: 'application/pdf' })]);
    expect(JSON.stringify(caps)).not.toContain('JETON');
    // Paramètres envoyés : rang et plafond hérité du principal par le repli.
    expect(caps[1].request_params).toMatchObject({ rank: 'fallback_1' });
    // Durée PROPRE par tentative (= événement d'usage), temps total à part.
    for (let i = 0; i < 2; i++) {
      expect(Number(caps[i].attempt_duration_ms)).toBe(Number(events[i].duration_ms));
      expect(events[i].metadata).toMatchObject({ durations: { semantics: 'attempt' } });
    }
    expect(Number(caps[1].execution_elapsed_ms)).toBeGreaterThanOrEqual(Number(events[0].duration_ms) + Number(events[1].duration_ms));
  });

  it('L82C-E2E-02 — réparation ciblée : analyse (sortie d’origine erronée) et réparation capturées', async () => {
    const compte = await make.account();
    await useRecordings([
      { operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: { task: 'GROUP_UPLOAD', ok: 'peut-être' } },
      { operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', callKind: 'repair', output: { task: 'GROUP_UPLOAD', ok: true } },
    ]);
    const res = await appelT1(compte.id);
    expect(res.data).toMatchObject({ ok: true });
    const caps = await capturesDe(res.traceId);
    expect(caps.map((c) => c.call_kind)).toEqual(['analysis', 'repair']);
    expect(caps[0].response_raw).toContain('peut-être');
    expect(caps[1]).toMatchObject({ response_status: 'CAPTURED', attachments: [] });
  });

  it('L82C-E2E-03 — T2 : échange capturé ; effacement par l’utilisateur → supprimé ; purge automatique 90 j → conservé', async () => {
    const compte = await make.account();
    const conv = async () => (await sql<{ id: number }[]>`
      INSERT INTO verebona_conversations (account_id, user_id, status, expires_at)
      VALUES (${compte.id}, ${compte.ownerUserId}, 'archived', now() + interval '90 days') RETURNING id`)[0].id;
    const [c1, c2] = [await conv(), await conv()];
    await useRecordings([{ operationCode: 't2_answer', task: 'ANSWER', repeat: true, output: { mode: 'ANSWER', ok: true } }]);
    const { t2MasterVariables } = await import('@/services/ai/assistant/master/t2-answer');
    const { asTestContract } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    const appelT2 = async (conversationId: number) => (await gateway()).execute({
      useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 't2_answer', accountId: compte.id, userId: compte.ownerUserId,
      promptVariables: t2MasterVariables('ANSWER', { QUESTION: `Question secrète ${conversationId}` }),
      outputSchema: asTestContract(z.object({ mode: z.literal('ANSWER'), ok: z.boolean() })),
      idempotencyKey: `assistant:c${conversationId}:${Math.random()}`, maxModelAttempts: 1,
    });
    const r1 = await appelT2(c1);
    const r2 = await appelT2(c2);
    const [cap1] = await capturesDe(r1.traceId);
    expect(cap1).toMatchObject({ subject_ref: `t2-conversation:${c1}`, response_status: 'CAPTURED', response_raw: '{"mode":"ANSWER","ok":true}' });
    expect(cap1.prompt_text).toContain(`Question secrète ${c1}`);
    // Journal inchangé (§29.6) : empreinte seulement dans ai_usage_event.
    const [ev] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_usage_event WHERE metadata->>'traceId' = ${r1.traceId} AND metadata::text LIKE '%Question secrète%'`;
    expect(ev.n).toBe(0);

    // Purge automatique (conversation expirée) : échanges capturés CONSERVÉS (décision PO 01).
    await sql`UPDATE verebona_conversations SET expires_at = now() - interval '1 day' WHERE id = ${c2}`;
    const { purgeAssistantData } = await import('@/services/ai/assistant/retention/purge-assistant-logs.job');
    await purgeAssistantData();
    expect(await sql`SELECT 1 FROM verebona_conversations WHERE id = ${c2}`).toHaveLength(0);
    expect(await capturesDe(r2.traceId)).toHaveLength(1);

    // Effacement manuel par l'utilisateur (droit de suppression maintenu) : échanges supprimés.
    const { clearUserHistory } = await import('@/services/verebona-assistant/core/conversation.service');
    await clearUserHistory(compte.id, compte.ownerUserId, c1);
    expect(await capturesDe(r1.traceId)).toHaveLength(0);
  });

  it('L82C-E2E-04 — droits : refus hors liste (journalisé, aucun contenu) ; accès autorisé journalisé', async () => {
    const compte = await make.account();
    await useRecordings([{ operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: { task: 'GROUP_UPLOAD', ok: true } }]);
    const res = await appelT1(compte.id);
    const [ev] = await sql<{ id: number }[]>`SELECT id FROM ai_usage_event WHERE metadata->>'traceId' = ${res.traceId}`;
    const autorise = await make.user();
    const refuse = await make.user();
    const { readModelOutputsForAdmin } = await import('@/services/ai/telemetry/model-output-access');
    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = String(autorise.id);
    try {
      const non = await readModelOutputsForAdmin({ adminUserId: refuse.id, callId: Number(ev.id), purpose: 'detail', includeCaptures: true });
      expect(non).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(JSON.stringify(non)).not.toContain('GROUP_UPLOAD');
      const oui = await readModelOutputsForAdmin({ adminUserId: autorise.id, callId: Number(ev.id), purpose: 'export', includeCaptures: true });
      expect(oui.ok && oui.captures?.[0]).toMatchObject({ captureStatus: 'CAPTURED', promptStatus: 'MASKED', usageEventId: Number(ev.id) });
      expect(oui.ok && oui.captures?.[0].prompt).toBeTruthy();
    } finally {
      delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS;
    }
    const journal = await sql<{ admin_user_id: number; action_type: string; result: string; details: string | null }[]>`
      SELECT admin_user_id, action_type, result, details FROM admin_audit_log
       WHERE admin_user_id IN (${refuse.id}, ${autorise.id}) ORDER BY id`;
    expect(journal.map((j) => [Number(j.admin_user_id), j.action_type, j.result])).toEqual([
      [refuse.id, 'AI_MODEL_OUTPUT_READ', 'DENIED'], [autorise.id, 'AI_MODEL_OUTPUT_READ', 'SUCCESS'],
    ]);
    const details = typeof journal[1].details === 'string' ? JSON.parse(journal[1].details) : journal[1].details;
    expect(details).toMatchObject({ purpose: 'export', traceId: res.traceId, captures: 1 });
  });

  it('L82C-E2E-05 — échec de capture : métier non bloqué, capture reprise sans nouvel appel ; défaut signalé à la Supervision', async () => {
    const compte = await make.account();
    const replay = await useRecordings([{ operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: { task: 'GROUP_UPLOAD', ok: true } }]);
    const m = await import('@/services/ai/telemetry/call-capture');
    m.resetCaptureQueueForTests();
    let panne = true;
    m.setCaptureWriterForTests(async (row) => {
      if (panne) throw Object.assign(new Error('terminating connection'), { code: '57P01' });
      await m.writeCaptureRow(row);
    });
    const res = await appelT1(compte.id);
    expect(res.data).toMatchObject({ ok: true });
    expect(await capturesDe(res.traceId)).toHaveLength(0);
    expect(m.captureHealth().pending).toBeGreaterThanOrEqual(1);
    // Appel sans capture : visible (détail BO « en cours d'écriture », Supervision au-delà de 15 min).
    const [ev] = await sql<{ id: number }[]>`SELECT id FROM ai_usage_event WHERE metadata->>'traceId' = ${res.traceId}`;
    const vue = await m.readTraceCaptures(res.traceId);
    expect(vue[0]).toMatchObject({ usageEventId: Number(ev.id), captureStatus: 'PENDING' });
    const plusTard = await m.readTraceCaptures(res.traceId, new Date(Date.now() + 20 * 60_000));
    expect(plusTard[0]).toMatchObject({ captureStatus: 'NOT_CAPTURED', promptStatus: 'NOT_CAPTURED' });
    await sql`UPDATE ai_usage_event SET created_at = now() - interval '30 minutes' WHERE id = ${ev.id}`;
    // Base E2E créée à l'instant : mise en service de la capture ramenée avant l'appel « vieilli ».
    await sql`UPDATE ai_call_capture_state SET started_at = LEAST(started_at, now() - interval '2 hours') WHERE id = 1`;
    const gap = await m.captureGap(7);
    expect(gap?.missing).toBeGreaterThanOrEqual(1);
    const { collectAiConditions, aiCaptureGapFingerprint } = await import('@/services/admin/supervision-sweep.service');
    expect((await collectAiConditions()).map((c) => c.fingerprint)).toContain(aiCaptureGapFingerprint());
    // Reprise : écrite sans rappeler le modèle.
    panne = false;
    expect(await m.flushCaptureRetries({ force: true })).toBeGreaterThanOrEqual(1);
    const [cap] = await capturesDe(res.traceId);
    expect({ ...cap, usage_event_id: Number(cap.usage_event_id) }).toMatchObject({ capture_status: 'CAPTURED', capture_attempts: 2, usage_event_id: Number(ev.id) });
    expect(replay.calls).toHaveLength(1);
    m.setCaptureWriterForTests(null);
  });

  it('L82C-E2E-06 — suppression de compte : le contenu capturé est purgé', async () => {
    const compte = await make.account();
    await useRecordings([{ operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: { task: 'GROUP_UPLOAD', ok: true } }]);
    const res = await appelT1(compte.id, { userId: compte.ownerUserId });
    expect(await capturesDe(res.traceId)).toHaveLength(1);
    const { scheduleDeletion, executeScheduledDeletion } = await import('@/services/account/scheduled-deletion.service');
    const s = await scheduleDeletion({ accountId: compte.id, userId: compte.ownerUserId, reason: 'ADMIN', delayDays: 0 });
    expect((await executeScheduledDeletion(s.id)).status).toBe('executed');
    expect(await capturesDe(res.traceId)).toHaveLength(0);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_call_captures WHERE account_id = ${compte.id} OR user_id = ${compte.ownerUserId}`;
    expect(n).toBe(0);
  });

  it('L82C-E2E-07 — plus aucune suppression à 88 jours : archivage = copie ; traces, diagnostics, rapports, captures et traces T2 conservés', async () => {
    const compte = await make.account();
    const trace = `l82c-vieux-${compte.id}`;
    const [ev] = await sql<{ id: number }[]>`
      INSERT INTO ai_usage_event (account_id, operation_type, use_case_code, operation_code, provider, model, status, duration_ms, metadata, created_at)
      VALUES (${compte.id}, 't1_group_upload', 'SOURCE_ANALYSIS', 't1_group_upload', 'gemini', 'm', 'success', 10, ${JSON.stringify({ traceId: trace })}::jsonb, now() - interval '120 days')
      RETURNING id`;
    await sql`INSERT INTO ai_call_diagnostics (created_at, trace_id, usage_event_id, account_id, operation_code, outcome, raw_output)
              VALUES (now() - interval '120 days', ${trace}, ${ev.id}, ${compte.id}, 't1_group_upload', 'FAILED', 'sortie')`;
    await sql`INSERT INTO ai_call_captures (created_at, captured_at, trace_id, usage_event_id, call_kind, origin, account_id, operation_code,
                capture_status, prompt_status, prompt_text, response_status, response_raw)
              VALUES (now() - interval '120 days', now() - interval '120 days', ${trace}, ${ev.id}, 'analysis', 'gateway', ${compte.id},
                't1_group_upload', 'CAPTURED', 'CAPTURED', 'prompt', 'CAPTURED', 'réponse')`;
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO verebona_request_runs (request_id, account_id, created_at) VALUES (${trace}, ${compte.id}, now() - interval '120 days') RETURNING id`;
    const { archiveAiLogs } = await import('@/services/ai/telemetry/log-archive.job');
    const deposes: string[] = [];
    await archiveAiLogs({ store: { put: async (k) => { deposes.push(k); } }, maxDays: 400 });
    // Archive déposée et enregistrée (copie), ligne CONSERVÉE, aucun agrégat (pas de double comptage).
    const [arch] = await sql<{ source_rows_kept: boolean }[]>`
      SELECT source_rows_kept FROM ai_log_archives WHERE source_table = 'ai_usage_event' AND min_id <= ${ev.id} AND max_id >= ${ev.id}`;
    expect(arch?.source_rows_kept).toBe(true);
    expect(await sql`SELECT 1 FROM ai_usage_event WHERE id = ${ev.id}`).toHaveLength(1);
    const [{ n: rollup }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_usage_daily_rollup WHERE account_id = ${compte.id}`;
    expect(rollup).toBe(0);
    // Second passage : la même ligne n'est pas archivée deux fois.
    await archiveAiLogs({ store: { put: async () => undefined }, maxDays: 400 });
    const [{ n: copies }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ai_log_archives WHERE source_table = 'ai_usage_event' AND min_id <= ${ev.id} AND max_id >= ${ev.id}`;
    expect(copies).toBe(1);
    // Purge de l'assistant : traces T2 conservées.
    const { purgeAssistantData } = await import('@/services/ai/assistant/retention/purge-assistant-logs.job');
    await purgeAssistantData();
    expect(await sql`SELECT 1 FROM verebona_request_runs WHERE id = ${run.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM ai_call_diagnostics WHERE trace_id = ${trace}`).toHaveLength(1);
    expect(await capturesDe(trace)).toHaveLength(1);
    // La tâche de purge des diagnostics et rapports n'existe plus.
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    expect(SCHEDULED_TASKS.map((t) => t.code)).not.toContain('ai-call-diagnostics-purge');
  });

  it('L82C-E2E-08 — appel antérieur à la capture : « non conservé historiquement », jamais reconstitué', async () => {
    const compte = await make.account();
    const trace = `l82c-histo-${compte.id}`;
    await sql`INSERT INTO ai_usage_event (account_id, operation_type, use_case_code, operation_code, provider, model, status, metadata, created_at)
              VALUES (${compte.id}, 't1_group_upload', 'SOURCE_ANALYSIS', 't1_group_upload', 'gemini', 'm', 'success', ${JSON.stringify({ traceId: trace })}::jsonb,
                      (SELECT started_at FROM ai_call_capture_state WHERE id = 1) - interval '1 day')`;
    const { readTraceCaptures } = await import('@/services/ai/telemetry/call-capture');
    const [v] = await readTraceCaptures(trace);
    expect(v).toMatchObject({ captureStatus: 'NOT_RETAINED_HISTORICALLY', promptStatus: 'NOT_RETAINED_HISTORICALLY', responseStatus: 'NOT_RETAINED_HISTORICALLY', prompt: null, response: null });
  });

  it('L82C-E2E-VOL — volume stocké par appel T1 réaliste (mesure pour le PO / DPO)', async () => {
    const compte = await make.account();
    // Sortie T1 réaliste : ~30 faits documentaires (≈ 25 Ko de JSON).
    const faits = Array.from({ length: 30 }, (_, i) => ({ key: `fait_${i}`, value: `Valeur documentaire ${i} — ${'texte '.repeat(60)}`, page: 1 + (i % 4), confidence: 'certain' }));
    await useRecordings([{ operationCode: T1_TEST_OPERATION, task: 'GROUP_UPLOAD', output: { task: 'GROUP_UPLOAD', ok: true, faits }, inputTokens: 14_000, outputTokens: 6_000 }]);
    const res = await appelT1(compte.id, { promptVariables: t1TestVariables(`facture ${'ligne de facture détaillée '.repeat(400)}`) });
    const [m] = await sql<{ disque: number; brut: number; prompt: number; reponse: number }[]>`
      SELECT pg_column_size(c.*)::int AS disque, (coalesce(prompt_chars, 0) + coalesce(response_chars, 0))::int AS brut,
             coalesce(prompt_chars, 0)::int AS prompt, coalesce(response_chars, 0)::int AS reponse
        FROM ai_call_captures c WHERE trace_id = ${res.traceId}`;
    console.info(`[L82C-E2E-VOL] prompt ${m.prompt} car., réponse ${m.reponse} car., brut ${m.brut} car. → ${m.disque} octets stockés (TOAST, compression sans perte)`);
    expect(m.disque).toBeGreaterThan(0);
    expect(m.disque).toBeLessThan(m.brut * 2);
  });
});
