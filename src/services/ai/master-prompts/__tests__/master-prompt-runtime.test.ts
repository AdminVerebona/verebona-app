/**
 * BO-IA-PROMPTS-01 — AC15 : la version ACTIVE d'un prompt maître administrée
 * au BO est celle qu'utilisent les traitements (résolution d'exécution, rendu,
 * version tracée et clés de cache), avant la version de configuration et le
 * fichier du dépôt. T5 depuis le lot 32B (version BO seulement, jamais le texte
 * d'une version de configuration). Le brouillon n'est jamais utilisé (AC02).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { __setActiveMasterPromptsForTests } from '../master-prompt-runtime';
import { __setConfigForTests, resolveOperationConfig } from '../../config/config-resolver';
import { emptyTreatmentConfig } from '../../config/config-types';
import { masterPromptVersionOf, resolveMasterPrompt } from '../../prompts/prompt-loader';
import { declaredMasterVariables } from '../../config/prompt-architecture';
import { AI_OPERATIONS } from '../../registry/operations';

const T2 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/assistant/t2_master_v1.txt'), 'utf8');
const ACTIF = `${T2}\n\nRÈGLE ACTIVÉE AU BO (v14).`;
const CONFIG = `${T2}\n\nTEXTE DE LA VERSION DE CONFIGURATION.`;

afterEach(() => { __setActiveMasterPromptsForTests(null); __setConfigForTests(null); });

describe('AC15 — la version activée au BO est celle utilisée', () => {
  it('AC15 — sans version de configuration : texte actif du BO, version tracée @pv', async () => {
    __setActiveMasterPromptsForTests([{ id: 41, treatment: 'T2', versionNumber: 14, content: ACTIF }]);
    const cfg = await resolveOperationConfig('t2_answer');
    expect(cfg).toMatchObject({ masterPromptText: ACTIF, masterPromptVersionId: 41, masterPromptVersionNumber: 14, configVersionId: null });
    const v = masterPromptVersionOf({ masterPromptCode: 't2_master_v1', configuredText: cfg.masterPromptText, promptVersionId: cfg.masterPromptVersionId });
    expect(v).toMatch(/^t2_master_v1@pv41:[0-9a-f]{12}$/);
  });

  it('AC15 — avec une version de configuration portant un autre texte : le BO prime ; modèles de la configuration conservés', async () => {
    __setConfigForTests({ versionId: 9, entries: [{ ...emptyTreatmentConfig('T2'), promptArchitecture: 'master', masterPrompt: CONFIG, primaryModel: 'gemini-2.5-flash' }] });
    expect((await resolveOperationConfig('t2_answer')).masterPromptText).toBe(CONFIG);
    __setActiveMasterPromptsForTests([{ id: 41, treatment: 'T2', versionNumber: 14, content: ACTIF }]);
    const cfg = await resolveOperationConfig('t2_answer');
    expect(cfg).toMatchObject({ masterPromptText: ACTIF, masterPromptVersionId: 41, configVersionId: 9, primaryModel: 'gemini-2.5-flash' });
  });

  it('AC15 — rendu réel : le texte activé est envoyé au modèle, version distincte de l’ancienne (aucun cache resservi)', async () => {
    const op = AI_OPERATIONS.t2_answer;
    const variables = Object.fromEntries(declaredMasterVariables('t2_master_v1').map((k) => [k, 'x']));
    const ancien = await resolveMasterPrompt({ masterPromptCode: 't2_master_v1', task: op.task!, variables, configuredText: null });
    const nouveau = await resolveMasterPrompt({
      masterPromptCode: 't2_master_v1', task: op.task!, variables, configuredText: ACTIF, promptVersionId: 41,
    });
    expect(nouveau.text).toContain('RÈGLE ACTIVÉE AU BO');
    expect(ancien.text).not.toContain('RÈGLE ACTIVÉE AU BO');
    expect(nouveau.version).not.toBe(ancien.version);
    expect(nouveau.version).toMatch(/@pv41:/);
  });

  it('PO15-07 — T5 : la version ACTIVE du BO est celle utilisée par t5_analyze / t5_modify ; le texte d’une version de configuration reste ignoré', async () => {
    const T5 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/governance/t5_master_v1.txt'), 'utf8');
    // Sans version BO : texte de configuration T5 ignoré (fichier du dépôt).
    __setConfigForTests({ versionId: 9, entries: [{ ...emptyTreatmentConfig('T5'), promptArchitecture: 'master', masterPrompt: 'TEXTE DE CONFIGURATION', primaryModel: 'gemini-3.6-flash' }] });
    expect((await resolveOperationConfig('t5_modify')).masterPromptText).toBeNull();
    // Version active au BO : appliquée, tracée @pv.
    const actif = `${T5}\n\nR9 — RÈGLE T5 ACTIVÉE AU BO.`;
    __setActiveMasterPromptsForTests([{ id: 50, treatment: 'T5', versionNumber: 2, content: actif }]);
    for (const op of ['t5_analyze', 't5_modify']) {
      const cfg = await resolveOperationConfig(op);
      expect(cfg).toMatchObject({ masterPromptText: actif, masterPromptVersionId: 50, masterPromptVersionNumber: 2, primaryModel: 'gemini-3.6-flash' });
      const rendu = await resolveMasterPrompt({
        masterPromptCode: 't5_master_v1', task: AI_OPERATIONS[op].task!, variables: { CURRENT_MASTER_PROMPTS: 'x', INSTRUCTION: 'y' },
        configuredText: cfg.masterPromptText, promptVersionId: cfg.masterPromptVersionId,
      });
      expect(rendu.text).toContain('RÈGLE T5 ACTIVÉE AU BO');
      expect(rendu.version).toMatch(/^t5_master_v1@pv50:/);
    }
  });

  it('AC02 — sans version active au BO : comportement antérieur (configuration, puis fichier du dépôt)', async () => {
    const cfg = await resolveOperationConfig('t6_formulate');
    expect(cfg.masterPromptText).toBeNull();
    expect(cfg.masterPromptVersionId ?? null).toBeNull();
  });
});
