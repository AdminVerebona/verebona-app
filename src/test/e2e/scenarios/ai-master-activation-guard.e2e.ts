/**
 * Versions de configuration IA SANS garde du corpus, sur base réelle —
 * ticket BO-IA-PROMPTS-01 (remplace le scénario « garde d'activation » du
 * lot 16, CDC 15 §30).
 *
 * Chaîne exercée : version de configuration en base (T1 à T6 en `master`)
 * → activation acceptée SANS aucun corpus enregistré, puis avec un corpus
 * ROUGE enregistré sur l'empreinte exacte → texte master modifié dans la
 * version (autre empreinte, jamais testée) : activation acceptée →
 * restauration sans justification. Le corpus reste un diagnostic : un master
 * cassé est toujours détecté par `runMasterCorpus`.
 */
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('AI-MASTER-NO-GATE', 'Versions de configuration activables sans corpus (BO-IA-PROMPTS-01)', ({ sql, make }) => {
  let numero = 9000 + Math.floor(Math.random() * 500);

  /** Brouillon avec T1 en master, passé « Validée » (le cycle de test est couvert ailleurs). */
  async function versionT1Master(userId: number, masterPrompt: string | null) {
    const repo = await import('@/services/ai/config/config-version.repository');
    const draft = await repo.createDraft(userId, `e2e sans garde ${numero}`, 'local');
    const t1 = draft.entries.find((e) => e.treatment === 'T1')!;
    await repo.saveEntry(draft.id, { ...t1, promptArchitecture: 'master', masterPrompt }, userId);
    numero += 1;
    await sql`UPDATE ai_config_versions SET status = 'VALIDATED', visible_number = ${numero}, validated_at = now()
               WHERE id = ${draft.id}`;
    return draft.id;
  }

  it('AC04 — aucun corpus enregistré : la version est activée', async () => {
    const user = await make.user();
    await sql`DELETE FROM ai_master_corpus_runs`;
    const versionId = await versionT1Master(user.id, null);
    const { activate } = await import('@/services/ai/config/config-version.service');
    await expect(activate(versionId, user.id)).resolves.toMatchObject({ interrupts: false });
    const [v] = await sql<{ status: string }[]>`SELECT status FROM ai_config_versions WHERE id = ${versionId}`;
    expect(v.status).toBe('ACTIVE');
  });

  it('AC05 / AC06 — corpus ROUGE enregistré sur T1 et rien sur T2–T6 : activation acceptée', async () => {
    const user = await make.user();
    const versionId = await versionT1Master(user.id, null);
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { recordCorpusRun } = await import('@/services/ai/governance/master-corpus/repository');
    const [t1] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T1'] });
    await recordCorpusRun({ ...t1, status: 'FAILED', branchesPassed: ['GROUP_UPLOAD'] },
      { configVersionId: versionId, source: 'ci', environment: 'local', gitSha: null });
    const { activate } = await import('@/services/ai/config/config-version.service');
    await expect(activate(versionId, user.id)).resolves.toBeTruthy();
    const [v] = await sql<{ status: string }[]>`SELECT status FROM ai_config_versions WHERE id = ${versionId}`;
    expect(v.status).toBe('ACTIVE');
  });

  it('AC03 — texte master modifié dans la version (jamais testé, aucun passage réel) : activation acceptée', async () => {
    const user = await make.user();
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const texte = `${readMasterFileFromRepo('t1_master_v1')}\n\nRÈGLE AJOUTÉE (e2e) — Le titre commence par le type de document.`;
    const versionId = await versionT1Master(user.id, texte);
    const { activate } = await import('@/services/ai/config/config-version.service');
    await expect(activate(versionId, user.id)).resolves.toBeTruthy();
  });

  it('AC11 — restauration sans corpus : aucune justification demandée', async () => {
    const user = await make.user();
    const versionId = await versionT1Master(user.id, null);
    await sql`UPDATE ai_config_versions SET activated_at = now() - interval '1 day' WHERE id = ${versionId}`;
    await sql`DELETE FROM ai_master_corpus_runs WHERE master_prompt_code = 't1_master_v1'`;
    const { rollback } = await import('@/services/ai/config/config-version.service');
    await expect(rollback(versionId, user.id)).resolves.toMatchObject({ interrupts: true });
    const [v] = await sql<{ status: string }[]>`SELECT status FROM ai_config_versions WHERE id = ${versionId}`;
    expect(v.status).toBe('ACTIVE');
  });

  it('diagnostic conservé : un master cassé (branche supprimée) est rouge au corpus', async () => {
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
