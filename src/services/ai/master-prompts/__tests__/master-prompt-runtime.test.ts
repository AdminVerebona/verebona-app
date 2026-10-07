/**
 * BO-IA-PROMPTS-01 — AC15 : la version ACTIVE d'un prompt maître administrée
 * au BO est celle qu'utilisent les traitements (résolution d'exécution, rendu,
 * version tracée et clés de cache), avant la version de configuration et le
 * fichier du dépôt. Jamais pour T5. Le brouillon n'est jamais utilisé (AC02).
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

  it('T5 n’est jamais remplacé (non administrable)', async () => {
    __setActiveMasterPromptsForTests([{ id: 50, treatment: 'T5' as never, versionNumber: 2, content: 'x' }]);
    const cfg = await resolveOperationConfig('t5_modify');
    expect(cfg.masterPromptVersionId ?? null).toBeNull();
    expect(cfg.masterPromptText).toBeNull();
  });

  it('AC02 — sans version active au BO : comportement antérieur (configuration, puis fichier du dépôt)', async () => {
    const cfg = await resolveOperationConfig('t6_formulate');
    expect(cfg.masterPromptText).toBeNull();
    expect(cfg.masterPromptVersionId ?? null).toBeNull();
  });
});
