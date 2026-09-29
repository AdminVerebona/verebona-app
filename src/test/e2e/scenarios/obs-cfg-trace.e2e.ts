/**
 * OBS-CFG / DP-05 — la trace d'un appel porte ce qui a été appliqué
 * (CDC 15 CFG-02, CFG-05, ARCH-03, DP-05 ; migration 0217), vérifié sur
 * une base réelle : colonnes `task`, `master_prompt_code`,
 * `master_prompt_version` et métadonnées (moteur, raisonnement, plafond,
 * déclencheur). Sortie modèle rejouée : aucun réseau.
 */
import { it, expect } from 'vitest';
import { z } from 'zod';
import { scenario } from '../scenario';

scenario('OBS-CFG', 'Trace de la configuration appliquée', ({ sql, make, useRecordings }) => {
  it('appel passerelle rejoué → ligne ai_usage_event complète', async () => {
    const compte = await make.account();
    const replay = await useRecordings([
      { operationCode: 'classify_document', task: 'ANALYZE_DOCUMENT', output: { ok: true }, inputTokens: 10, outputTokens: 2 },
    ]);
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const { runInJobContext } = await import('@/services/ai/queue/job-context');

    const res = await runInJobContext(
      { jobId: null, treatment: 'T1', configVersionId: null, triggerCode: 'source_uploaded' },
      () => AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'classify_document', accountId: compte.id,
        promptVariables: {}, outputSchema: z.object({ ok: z.boolean() }),
        task: 'ANALYZE_DOCUMENT', masterPromptCode: 't1_master', masterPromptVersion: '1',
      }),
    );
    expect(res.data).toEqual({ ok: true });
    expect(replay.calls).toHaveLength(1);
    expect(replay.pending()).toHaveLength(0);

    const [ligne] = await sql<{
      task: string | null; master_prompt_code: string | null; master_prompt_version: string | null;
      metadata: Record<string, unknown>; operation_code: string;
    }[]>`
      SELECT task, master_prompt_code, master_prompt_version, metadata, operation_code
        FROM ai_usage_event WHERE account_id = ${compte.id} ORDER BY id DESC LIMIT 1`;
    expect(ligne).toMatchObject({
      operation_code: 'classify_document', task: 'ANALYZE_DOCUMENT',
      master_prompt_code: 't1_master', master_prompt_version: '1',
    });
    expect(ligne.metadata).toMatchObject({ engine: 'new', trigger: 'source_uploaded', traceId: res.traceId });
    expect('reasoning' in ligne.metadata && 'maxOutputTokens' in ligne.metadata).toBe(true);
  });

  it('sans sortie enregistrée : échec immédiat, jamais d’appel réseau', async () => {
    const compte = await make.account();
    await useRecordings([]);
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    await expect(AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'classify_document', accountId: compte.id,
      promptVariables: {}, outputSchema: z.object({ ok: z.boolean() }),
    })).rejects.toThrow(/aucune sortie enregistrée/);
  });
});
