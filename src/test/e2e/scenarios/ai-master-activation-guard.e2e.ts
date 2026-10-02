/**
 * Garde d'activation des prompts maîtres sur base réelle — CDC 15 §30 (règle
 * de recette), §32, D-17, HC-06 ; migration 0224.
 *
 * Chaîne exercée : version de configuration en base (T1 en `master`) →
 * activation refusée sans corpus, puis avec un corpus rouge → corpus rejoué
 * (`runMasterCorpus`, fixtures synthétiques D-08) enregistré en base →
 * activation acceptée → un texte master MODIFIÉ (autre empreinte) est de
 * nouveau refusé tant que son propre corpus n'est pas vert.
 */
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('AI-MASTER-GATE', 'Garde d’activation des masters (corpus §30)', ({ sql, make }) => {
  let numero = 9000 + Math.floor(Math.random() * 500);

  /** Brouillon avec T1 en master, passé « Validée » (le cycle de test est couvert ailleurs). */
  async function versionT1Master(userId: number, masterPrompt: string | null) {
    const repo = await import('@/services/ai/config/config-version.repository');
    const draft = await repo.createDraft(userId, `e2e garde ${numero}`, 'local');
    const t1 = draft.entries.find((e) => e.treatment === 'T1')!;
    await repo.saveEntry(draft.id, { ...t1, promptArchitecture: 'master', masterPrompt }, userId);
    numero += 1;
    await sql`UPDATE ai_config_versions SET status = 'VALIDATED', visible_number = ${numero}, validated_at = now()
               WHERE id = ${draft.id}`;
    return draft.id;
  }

  /**
   * Lot 16b : T5 et T6 (L16b-1), T2 et T4 (L16b-2) sont TOUJOURS en master
   * (fichier du dépôt) — leur corpus vert est donc exigé à chaque
   * activation, comme celui de T1 ici.
   */
  async function corpusVertMastersSeuls(versionId: number) {
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { recordCorpusRun } = await import('@/services/ai/governance/master-corpus/repository');
    for (const run of await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T2', 'T4', 'T5', 'T6'] })) {
      expect(run.status, run.masterPromptCode).toBe('PASSED');
      await recordCorpusRun(run, { configVersionId: versionId, source: 'ci', environment: 'local', gitSha: 'e2e' });
    }
  }

  const refus = async (versionId: number, userId: number) => {
    const { activate } = await import('@/services/ai/config/config-version.service');
    try {
      await activate(versionId, userId);
      return null;
    } catch (e) {
      return e as { code?: string; message: string; details?: { entries?: Array<{ treatment: string; status: string }> } };
    }
  };

  it('sans corpus puis corpus rouge : refus motivé ; corpus vert enregistré : activation', async () => {
    const user = await make.user();
    const versionId = await versionT1Master(user.id, null);

    const r1 = await refus(versionId, user.id);
    expect(r1?.code).toBe('MASTER_CORPUS_NOT_GREEN');
    // Lot 16b : T2, T4, T5 et T6, master seul, sont contrôlés comme T1.
    expect(r1?.details?.entries?.map((e) => e.treatment)).toEqual(expect.arrayContaining(['T1', 'T2', 'T4', 'T5', 'T6']));
    await corpusVertMastersSeuls(versionId);
    const r1b = await refus(versionId, user.id);
    expect(r1b?.details?.entries?.filter((e) => e.status !== 'GREEN')).toEqual([expect.objectContaining({ treatment: 'T1', status: 'NO_RUN' })]);

    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { recordCorpusRun } = await import('@/services/ai/governance/master-corpus/repository');
    const [t1] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T1'] });
    expect(t1.status).toBe('PASSED');

    // Un corpus ROUGE sur la même empreinte ne suffit pas.
    await recordCorpusRun({ ...t1, status: 'FAILED', branchesPassed: ['GROUP_UPLOAD'] },
      { configVersionId: versionId, source: 'ci', environment: 'local', gitSha: null });
    expect((await refus(versionId, user.id))?.details?.entries?.find((e) => e.treatment === 'T1')?.status).toBe('RUN_FAILED');

    await recordCorpusRun(t1, { configVersionId: versionId, source: 'ci', environment: 'local', gitSha: 'e2e' });
    expect(await refus(versionId, user.id)).toBeNull();
    const [v] = await sql<{ status: string }[]>`SELECT status FROM ai_config_versions WHERE id = ${versionId}`;
    expect(v.status).toBe('ACTIVE');

    const [run] = await sql<{ text_sha256: string; branches_passed: string[]; source: string; text_source: string }[]>`
      SELECT text_sha256, branches_passed, source, text_source FROM ai_master_corpus_runs
       WHERE config_version_id = ${versionId} AND status = 'PASSED' ORDER BY id DESC LIMIT 1`;
    expect(run).toMatchObject({ text_sha256: t1.textSha256, source: 'ci', text_source: 'file' });
    expect([...run.branches_passed].sort()).toEqual(['ANALYZE_DOCUMENT', 'GROUP_UPLOAD']);
  });

  it('texte master modifié dans la version : autre empreinte, refus tant que son corpus n’est pas vert', async () => {
    const user = await make.user();
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const texte = `${readMasterFileFromRepo('t1_master_v1')}\n\nRÈGLE AJOUTÉE (e2e) — Le titre commence par le type de document.`;
    const versionId = await versionT1Master(user.id, texte);
    await corpusVertMastersSeuls(versionId);

    const r = await refus(versionId, user.id);
    expect(r?.code).toBe('MASTER_CORPUS_NOT_GREEN');
    expect(r?.message).toMatch(/texte de la version/);

    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { recordCorpusRun } = await import('@/services/ai/governance/master-corpus/repository');
    const [t1] = await runMasterCorpus({
      readMasterFile: readMasterFileFromRepo, treatments: ['T1'], texts: { t1_master_v1: { text: texte, source: 'config' } },
    });
    expect(t1).toMatchObject({ status: 'PASSED', textSource: 'config' });
    // Rejeu vert, et même un rejeu `local` : insuffisant pour un texte de version.
    await recordCorpusRun(t1, { configVersionId: versionId, source: 'local', environment: 'local', gitSha: null });
    expect((await refus(versionId, user.id))?.details?.entries?.find((e) => e.treatment === 'T1')?.status).toBe('NO_RUN');
    await recordCorpusRun(t1, { configVersionId: versionId, source: 'preprod', environment: 'local', gitSha: null });
    expect((await refus(versionId, user.id))?.details?.entries?.find((e) => e.treatment === 'T1')?.status).toBe('LIVE_RUN_MISSING');
    // Passage RÉEL en préprod (D-17) : la sortie du modèle est simulée ici par
    // les sorties enregistrées ; l'enregistrement est celui de `ai:corpus --live`.
    const { buildLiveRunner } = await import('@/services/ai/governance/master-corpus/live');
    const { loadMasterCorpusCases } = await import('@/services/ai/governance/master-corpus/cases');
    const cas = loadMasterCorpusCases(readMasterFileFromRepo);
    const live = await buildLiveRunner(cas, { accountId: 1, userId: user.id });
    const [reel] = await runMasterCorpus({
      readMasterFile: readMasterFileFromRepo, treatments: ['T1'], cases: cas,
      texts: { t1_master_v1: { text: texte, source: 'config' } },
      live: { variablesFor: live.variablesFor, call: async (c) => c.output },
    });
    expect(reel.status).toBe('PASSED');
    await recordCorpusRun(reel, { configVersionId: versionId, source: 'preprod', environment: 'local', gitSha: null, runMode: 'live' });
    expect(await refus(versionId, user.id)).toBeNull();
    const [trace] = await sql<{ run_mode: string }[]>`
      SELECT run_mode FROM ai_master_corpus_runs WHERE config_version_id = ${versionId} ORDER BY id DESC LIMIT 1`;
    expect(trace.run_mode).toBe('live');
  });

  it('restauration d’urgence sans corpus : justification exigée, puis tracée dans l’audit', async () => {
    const user = await make.user();
    const versionId = await versionT1Master(user.id, null);
    // Déjà active par le passé (restauration possible), corpus absent pour ce test : empreinte inconnue.
    await sql`UPDATE ai_config_versions SET activated_at = now() - interval '1 day' WHERE id = ${versionId}`;
    await sql`DELETE FROM ai_master_corpus_runs WHERE master_prompt_code = 't1_master_v1'`;
    const { rollback } = await import('@/services/ai/config/config-version.service');
    await expect(rollback(versionId, user.id)).rejects.toMatchObject({ code: 'ROLLBACK_JUSTIFICATION_REQUIRED' });
    const r = await rollback(versionId, user.id, { justification: 'Incident E2E : restauration de la version stable' });
    expect(r.corpusOverride).toBe(true);
    const [a] = await sql<{ action_type: string; reason: string; admin_user_id: number }[]>`
      SELECT action_type, reason, admin_user_id FROM ai_admin_audit_log
       WHERE action_type = 'ai_config_rollback_corpus_override' ORDER BY id DESC LIMIT 1`;
    expect(a).toMatchObject({ reason: 'Incident E2E : restauration de la version stable', admin_user_id: user.id });
  });

  it('master cassé (branche supprimée) : corpus rouge, jamais activable', async () => {
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const casse = readMasterFileFromRepo('t1_master_v1').replace(/BRANCHE TASK = GROUP_UPLOAD/g, 'SECTION SUPPRIMÉE');
    const [t1] = await runMasterCorpus({
      readMasterFile: readMasterFileFromRepo, treatments: ['T1'], texts: { t1_master_v1: { text: casse, source: 'config' } },
    });
    expect(t1.status).toBe('FAILED');
    expect(t1.branchesPassed).not.toContain('GROUP_UPLOAD');
  });
});
