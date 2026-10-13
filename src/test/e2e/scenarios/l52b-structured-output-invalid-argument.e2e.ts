/**
 * Lot 52B sur base réelle — ticket « IA Gateway : rattraper les
 * INVALID_ARGUMENT génériques sur structured output avant de changer de
 * modèle » (P1). Passerelle RÉELLE, fournisseur simulé par le rejeu
 * (`replay-gateway`, erreur fournisseur 400 et filtre `whenStructured`).
 *
 * Reproduction de l'incident de la trace c4b2a66e… : T1 ANALYZE_DOCUMENT,
 * contrat t1_analyze_document@v4, responseSchema transmis → HTTP 400
 * INVALID_ARGUMENT « Request contains an invalid argument. », 0 jeton.
 *
 *   · E2E-L52B-01 (AC3) : le retry diagnostique échoue aussi → aucune
 *     mémorisation, cascade normale (3 modèles × 2 appels, jamais 3),
 *     BO : « requête refusée », jamais « fournisseur indisponible » ;
 *   · E2E-L52B-02 (AC1, AC2, AC9) : retry diagnostique réussi → génération
 *     reçue, validation runtime v4, persistance normale, aucun fallback,
 *     refus mémorisé, BO : tentatives et compteurs distincts.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';

vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));

/** Corps d'erreur réel de l'API Gemini (SDK `@google/genai`), HTTP 400. */
const ERREUR_400 = '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';

type Attempt = { step: number; kind: string; responseSchemaSent: boolean; providerSchemaHash: string | null; responseMimeType: string | null; outcome: string; httpStatus: number | null; providerErrorCode: string | null };
type Meta = {
  traceId: string; providerMeta?: { structuredOutput?: string }; failure?: { family: string; subtype: string | null; stage: string };
  providerRequest?: { responseSchemaSent: boolean; providerSchemaHash: string | null; schemaNodes: number | null; responseMimeType: string | null; attachments: { count: number; items: Array<{ mimeType: string; transport: string }> } };
  providerAttempts?: Attempt[];
  runtimeContract?: { schemaVersion: string; schemaHash: string; contractId: string; contractVersion: number };
};

scenario('L52B', 'Structured output : 400 INVALID_ARGUMENT générique rattrapé sur le même modèle', ({ sql, make, useRecordings }) => {
  useTargetState();

  const analyser = async (compte: { id: number; ownerUserId: number }, fileId: number, linkedAssetId: number | null) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${fileId}.pdf`}, analysis_state = NULL WHERE id = ${fileId}`;
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    return analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, linkedAssetId, billable: false, origin: 'e2e/l52b' });
  };
  const appelsT1 = async (accountId: number) => sql<{ id: number; model: string; model_rank: string; status: string; error_code: string | null; input_tokens: number; metadata: Meta }[]>`
    SELECT id, model, model_rank, status, error_code, input_tokens, metadata FROM ai_usage_event
     WHERE account_id = ${accountId} AND operation_code = 't1_analyze_document' ORDER BY id`;

  it('E2E-L52B-01 (AC3) — retry diagnostique également en 400 : pas de mémorisation, cascade normale, BO « requête refusée »', async () => {
    const { clearSchemaRejections, schemaRejectedRecently } = await import('@/services/ai/gateway/output-resolution/provider-schema');
    clearSchemaRejections();
    const compte = await make.account();
    const f = await make.assetFile(compte);
    const replay = await useRecordings([{
      operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', repeat: true, output: null, error: { message: ERREUR_400, status: 400 },
    }]);
    // Échec TRANSITOIRE, comme avant le lot 52B (politique T1 inchangée) : remis en file durable.
    expect(await analyser(compte, f.id, null)).toMatchObject({ analysedCount: 0, failedSourceIds: [f.id], definitiveFailedSourceIds: [] });
    // Écarté des autres scénarios.
    await sql`UPDATE ai_job_queue SET available_at = now() + interval '30 days'
               WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(f.id)} AND status = 'PENDING'`;

    // 3 modèles × (avec schéma, puis sans) — jamais un troisième appel au même modèle.
    const analyses = replay.calls.filter((c) => (c.callKind ?? 'analysis') === 'analysis' && c.operationCode === 't1_analyze_document');
    const parModele = new Map<string, boolean[]>();
    for (const c of analyses) parModele.set(c.model, [...(parModele.get(c.model) ?? []), c.responseSchema !== undefined]);
    expect(parModele.size).toBe(3);
    for (const v of parModele.values()) expect(v).toEqual([true, false]);

    const rows = await appelsT1(compte.id);
    expect(rows.map((r) => r.model_rank)).toEqual(['primary', 'fallback_1', 'fallback_2']);
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'error', error_code: 'PROVIDER_REQUEST_REJECTED', input_tokens: 0 });
      expect(r.metadata.failure).toMatchObject({ family: 'INPUT_ERROR', subtype: null, stage: 'provider_request' });
      expect(r.metadata.providerMeta?.structuredOutput).toBe('requested_schema');
      expect(r.metadata.providerAttempts?.map((a) => [a.kind, a.responseSchemaSent, a.outcome, a.httpStatus])).toEqual([
        ['initial', true, 'FAILED', 400], ['diagnostic_retry', false, 'FAILED', 400],
      ]);
      expect(schemaRejectedRecently(r.model, r.metadata.runtimeContract!.schemaHash)).toBe(false);
    }

    // BO › Exécutions IA : nature « requête refusée », compteurs distincts.
    const { getExecutionDetail, getErrorBreakdown } = await import('@/services/ai/telemetry/execution-log.repository');
    const detail = await getExecutionDetail(Number(rows[2].id));
    expect(detail?.diagnosis.calls.map((c) => [c.label, c.status, c.cause, c.failureCategory, c.errorCode])).toEqual([
      ['principal', 'FAILED', 'INPUT_ERROR', 'REQUEST_REJECTED', 'PROVIDER_REQUEST_REJECTED'],
      ['fallback 1', 'FAILED', 'INPUT_ERROR', 'REQUEST_REJECTED', 'PROVIDER_REQUEST_REJECTED'],
      ['fallback 2', 'FAILED', 'INPUT_ERROR', 'REQUEST_REJECTED', 'PROVIDER_REQUEST_REJECTED'],
    ]);
    expect(detail?.diagnosis.counters).toEqual({ jobAttempts: null, modelCalls: 3, modelFallbacks: 2, structuredOutputRetries: 3, repairCalls: 0 });
    expect(detail?.diagnosis.finalDiagnosis.join(' ')).toMatch(/essai diagnostique sans responseSchema également en échec \(HTTP 400\) — le schéma n’est pas mis en cause/);
    const breakdown = await getErrorBreakdown(1);
    expect(breakdown.some((b) => b.treatment === 'T1' && b.errorCode === 'PROVIDER_REQUEST_REJECTED' && b.failureSubtype === 'INPUT_ERROR')).toBe(true);
  });

  it('E2E-L52B-02 (AC1, AC2, AC9) — retry diagnostique réussi : génération reçue, validation v4, persistance normale, STOP cascade', async () => {
    const { clearSchemaRejections, schemaRejectedRecently } = await import('@/services/ai/gateway/output-resolution/provider-schema');
    const rc = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    clearSchemaRejections();
    const compte = await make.account();
    const bien = await make.asset(compte);
    const f = await make.assetFile(compte, { assetId: bien.id });
    const sortie = sortieT1({
      title: 'Facture entretien chaudière', date: '2026-04-24', documentTypeCode: 'MAINTENANCE_INVOICE',
      assets: [{ id: bien.id, label: 'Maison' }],
      facts: [{ canonicalKey: 'lastRevision', value: '2026-04-24', valueType: 'date', excerpt: 'Entretien réalisé le 24/04/2026', assetId: bien.id }],
    });
    const replay = await useRecordings([
      { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', whenStructured: true, output: null, error: { message: ERREUR_400, status: 400 } },
      { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', whenStructured: false, output: sortie, inputTokens: 13_927, outputTokens: 1790, meta: { finishReason: 'STOP' } },
    ]);
    const r = await analyser(compte, f.id, bien.id);
    expect(r?.analysedCount).toBe(1);
    await drainQueues();

    // Persistance normale.
    const [etat] = await sql<{ analysis_state: string }[]>`SELECT analysis_state FROM asset_files WHERE id = ${f.id}`;
    expect(etat.analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    const faits = await sql<{ fact_key: string }[]>`SELECT fact_key FROM document_facts WHERE file_id = ${f.id}`;
    expect(faits.map((x) => x.fact_key)).toContain('lastRevision');

    // Même modèle, avec puis sans responseSchema ; JSON natif conservé ; schéma DÉRIVÉ du même contrat dans le prompt.
    const analyses = replay.calls.filter((c) => (c.callKind ?? 'analysis') === 'analysis' && c.operationCode === 't1_analyze_document');
    expect(analyses).toHaveLength(2);
    expect(analyses[0].model).toBe(analyses[1].model);
    expect(analyses[0].responseSchema).toBeDefined();
    expect(analyses[1].responseSchema).toBeUndefined();
    expect(analyses[1].jsonResponse).toBe(true);
    expect(replay.pending()).toEqual([]);

    const rows = await appelsT1(compte.id);
    expect(rows).toHaveLength(1); // aucun fallback modèle
    const [row] = rows;
    expect(row).toMatchObject({ status: 'success', model_rank: 'primary', model: analyses[0].model });
    const m = row.metadata;
    expect(m.runtimeContract).toMatchObject({ contractId: 'T1_ANALYZE_DOCUMENT', schemaVersion: 't1_analyze_document@v4' });
    const { T1AnalyzeDocumentTolerantOutput } = await import('@/services/ai/source-analysis/master/tolerant-output');
    const contrat = rc.resolveRuntimeContract({ schemaName: 'T1AnalyzeDocumentOutput', operationCode: 't1_analyze_document', callerSchema: T1AnalyzeDocumentTolerantOutput }).contract;
    expect(m.runtimeContract!.schemaHash).toBe(contrat.schemaHash);
    expect(analyses[1].prompt).toContain(rc.contractJsonSchemaText(contrat));
    expect(analyses[1].prompt).toContain(`${contrat.contractId} v${contrat.contractVersion} · schéma ${contrat.schemaVersion} · empreinte ${contrat.schemaHash}`);
    expect(m.providerMeta?.structuredOutput).toBe('schema_rejected_retried_without');
    expect(m.providerRequest).toMatchObject({ responseSchemaSent: true, responseMimeType: 'application/json', attachments: { count: 1, items: [{ mimeType: 'application/pdf', transport: 'files_api' }] } });
    expect(m.providerRequest!.providerSchemaHash).toMatch(/^[0-9a-f]{12}$/);
    expect(m.providerAttempts?.map((a) => [a.step, a.kind, a.responseSchemaSent, a.outcome, a.httpStatus, a.providerErrorCode])).toEqual([
      [1, 'initial', true, 'FAILED', 400, 'INVALID_ARGUMENT'],
      [2, 'diagnostic_retry', false, 'SUCCESS', null, null],
    ]);
    expect(m.providerAttempts![0].providerSchemaHash).toBe(m.providerRequest!.providerSchemaHash);
    // Mémorisé : modèle + schemaHash (TTL existant).
    expect(schemaRejectedRecently(row.model, contrat.schemaHash)).toBe(true);
    // Aucun contenu documentaire ni schéma dans la trace.
    expect(JSON.stringify({ a: m.providerAttempts, r: m.providerRequest })).not.toMatch(/chaudière|"properties"|CONTRAT RUNTIME/);

    // BO › Exécutions IA : tentatives internes, compteurs distincts, diagnostic final.
    const { getExecutionDetail } = await import('@/services/ai/telemetry/execution-log.repository');
    const detail = await getExecutionDetail(Number(row.id));
    expect(detail?.diagnosis.calls.map((c) => [c.label, c.status, c.providerAttempts?.length])).toEqual([['principal', 'SUCCEEDED', 2]]);
    expect(detail?.diagnosis.counters).toEqual({ jobAttempts: null, modelCalls: 1, modelFallbacks: 0, structuredOutputRetries: 1, repairCalls: 0 });
    expect(detail?.diagnosis.finalDiagnosis[0]).toBe('Réussite T1.');
    expect(detail?.diagnosis.finalDiagnosis.join(' ')).toMatch(/HTTP 400 INVALID_ARGUMENT avec structured output \(schéma fournisseur [0-9a-f]{12}\) ; essai diagnostique du même modèle sans responseSchema réussi/);
  });
});
