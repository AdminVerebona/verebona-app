/**
 * CDC 15 D-03, D-04, §29 étape 14, §29.1 — architecture des prompts par
 * traitement, portée par la version de configuration IA.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  checkPromptArchitectureChange, masterConfigIssues, masterPromptForTreatment, masterCapableTreatments,
  promptArchitectureWarning, promptArchitectureWarnings,
} from '../prompt-architecture';
import {
  emptyTreatmentConfig, promptArchitectureOf, DEFAULT_PROMPT_ARCHITECTURE, type TreatmentConfig,
} from '../config-types';
import {
  __setConfigForTests, getPromptArchitecture, resolveOperationConfig,
} from '../config-resolver';
import { diffVersions } from '../config-diff.service';
import { validateTreatment, type ConfigCatalogs } from '../config-validation.service';
import { runInJobContext } from '../../queue/job-context';

const MASTER_T1 = '{{TASK}}\nBRANCHE TASK = GROUP_UPLOAD\nBRANCHE TASK = ANALYZE_DOCUMENT\n';
const t1 = (over: Partial<TreatmentConfig> = {}): TreatmentConfig => ({
  ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', ...over,
});

afterEach(() => __setConfigForTests(null));

describe('valeur par défaut', () => {
  it('steps, y compris pour une ligne antérieure au lot 12 (champ absent ou illisible)', () => {
    expect(DEFAULT_PROMPT_ARCHITECTURE).toBe('steps');
    expect(emptyTreatmentConfig('T1').promptArchitecture).toBe('steps');
    expect(promptArchitectureOf({})).toBe('steps');
    expect(promptArchitectureOf({ promptArchitecture: 'autre' as never })).toBe('steps');
    expect(promptArchitectureOf(null)).toBe('steps');
  });

  it('masters déclarés : T1 (lot 12), T3 (lot 13), T4 (lot 14), T2 (lot 15)', () => {
    expect(masterPromptForTreatment('T1')).toEqual({
      masterPromptCode: 't1_master_v1', tasks: ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'],
    });
    expect(masterPromptForTreatment('T3')).toEqual({
      masterPromptCode: 't3_master_v1', tasks: ['VALUE_CONFLICT', 'LINK_AMBIGUITY'],
    });
    expect(masterPromptForTreatment('T4')).toEqual({
      // TEMPORAL_AMBIGUITY : opération inactive tant qu'aucun appelant (relecture lot 14).
      masterPromptCode: 't4_master_v1', tasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION'],
    });
    expect(masterPromptForTreatment('T2')).toEqual({
      masterPromptCode: 't2_master_v1', tasks: ['UNDERSTAND', 'ANSWER', 'REVALIDATE'],
    });
    expect(masterPromptForTreatment('T5')).toBeNull();
    expect([...masterCapableTreatments()].sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
  });
});

describe('checkPromptArchitectureChange — §29.1', () => {
  it('Brouillon : bascule steps → master permise pour T1', () => {
    expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: 'T1', from: 'steps', to: 'master' }))
      .toEqual({ allowed: true });
    expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: 'T1', from: 'master', to: 'steps' }))
      .toEqual({ allowed: true });
  });

  it('jamais en éditant une Active (ni À tester, Validée, Archivée)', () => {
    for (const status of ['ACTIVE', 'TO_TEST', 'VALIDATED', 'ARCHIVED'] as const) {
      expect(checkPromptArchitectureChange({ status, treatment: 'T1', from: 'steps', to: 'master' }))
        .toMatchObject({ allowed: false, code: 'VERSION_NOT_EDITABLE' });
    }
  });

  it('sans changement : toujours permis (enregistrement d’autres champs)', () => {
    expect(checkPromptArchitectureChange({ status: 'ACTIVE', treatment: 'T1', from: undefined, to: 'steps' }))
      .toEqual({ allowed: true });
  });

  it('master refusé pour un traitement sans prompt maître déclaré', () => {
    expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: 'T6', from: 'steps', to: 'master' }))
      .toMatchObject({ allowed: false, code: 'NO_MASTER_FOR_TREATMENT' });
  });
});

describe('getPromptArchitecture — version effective ou figée', () => {
  it('sans version : steps', async () => {
    expect(await getPromptArchitecture('T1')).toBe('steps');
  });

  it('version effective (TO_TEST en préprod) : lue par traitement', async () => {
    __setConfigForTests({ versionId: 11, entries: [t1({ promptArchitecture: 'master' }), emptyTreatmentConfig('T2')] });
    expect(await getPromptArchitecture('T1')).toBe('master');
    expect(await getPromptArchitecture('T2')).toBe('steps');
    expect(await getPromptArchitecture('T3')).toBe('steps');
  });

  it('job de file : version figée au démarrage (VER-015), pas l’effective', async () => {
    __setConfigForTests(
      { versionId: 12, entries: [t1({ promptArchitecture: 'master' })] },
      [{ versionId: 10, entries: [t1({ promptArchitecture: 'steps' })] }],
    );
    const arch = await runInJobContext(
      { jobId: 1, treatment: 'T1', configVersionId: 10 },
      () => getPromptArchitecture('T1'),
    );
    expect(arch).toBe('steps');
  });
});

describe('resolveOperationConfig — D-03 (texte master distinct du préambule)', () => {
  it('master : le préambule sert TOUJOURS aux étapes, le master vient de son champ', async () => {
    __setConfigForTests({ versionId: 13, entries: [t1({ prompt: 'Préambule', masterPrompt: MASTER_T1, promptArchitecture: 'master' })] });
    expect(await resolveOperationConfig('t1_analyze_document'))
      .toMatchObject({ promptArchitecture: 'master', masterPromptText: MASTER_T1, promptPreamble: 'Préambule' });
    // Revue lot 12 : version master activée, commutateur ≠ enabled ⇒ les
    // étapes tournent et gardent leur préambule.
    expect((await resolveOperationConfig('extract_source')).promptPreamble).toBe('Préambule');
  });

  it('steps : préambule comme avant ; un texte master préparé n’est pas exposé', async () => {
    __setConfigForTests({ versionId: 14, entries: [t1({ prompt: 'Préambule', masterPrompt: MASTER_T1 })] });
    expect(await resolveOperationConfig('extract_source'))
      .toMatchObject({ promptArchitecture: 'steps', promptPreamble: 'Préambule', masterPromptText: null });
  });

  it('master sans texte : fichier du dépôt (masterPromptText null)', async () => {
    __setConfigForTests({ versionId: 15, entries: [t1({ prompt: 'P', masterPrompt: '  ', promptArchitecture: 'master' })] });
    expect((await resolveOperationConfig('t1_group_upload')).masterPromptText).toBeNull();
  });
});

describe('diff et contrôles de promotion', () => {
  const cat: ConfigCatalogs = {
    availableModels: new Set(['m-a']), pricedModels: new Set(['m-a']),
    guardrailCodes: new Set(), triggerCodes: new Set(),
  };

  it('la bascule apparaît au diff ; une ligne sans champ vaut steps (pas de faux changement)', () => {
    const avant = { ...t1() };
    delete (avant as Partial<TreatmentConfig>).promptArchitecture;
    delete (avant as Partial<TreatmentConfig>).masterPrompt;
    expect(diffVersions([avant], [t1()]).identical).toBe(true);
    const d = diffVersions([avant], [t1({ promptArchitecture: 'master' })]);
    expect(d.treatments[0].changes).toContainEqual(expect.objectContaining({
      field: 'promptArchitecture', before: 'steps', after: 'master',
    }));
  });

  it('le texte master apparaît au diff comme un champ distinct du prompt', () => {
    const d = diffVersions([t1({ prompt: 'P' })], [t1({ prompt: 'P', masterPrompt: MASTER_T1 })]);
    expect(d.treatments[0].changes).toEqual([expect.objectContaining({
      field: 'masterPrompt', kind: 'added', before: null, after: MASTER_T1,
    })]);
  });

  it('master avec texte vide : fichier du dépôt, signalé sans bloquer ; le préambule reste obligatoire', () => {
    const issues = validateTreatment(t1({ prompt: '', promptArchitecture: 'master', maxOutputTokens: 1000 }), cat);
    expect(issues).toContainEqual(expect.objectContaining({ field: 'masterPrompt', blocking: false }));
    expect(issues).toContainEqual(expect.objectContaining({ field: 'prompt', blocking: true, message: 'Le prompt est obligatoire.' }));
  });

  it('texte master incomplet : bloquant, même préparé en steps', () => {
    for (const promptArchitecture of ['master', 'steps'] as const) {
      const issues = masterConfigIssues(t1({ prompt: 'P', masterPrompt: 'Sois précis.', promptArchitecture }));
      expect(issues.map((i) => [i.field, i.blocking])).toEqual([
        ['masterPrompt', true], ['masterPrompt', true], ['masterPrompt', true],
      ]);
      expect(issues[0].message).toMatch(/\{\{TASK\}\}/);
    }
  });

  it('master complet : aucune anomalie ; steps sans texte : non concerné', () => {
    expect(masterConfigIssues(t1({ prompt: 'P', masterPrompt: MASTER_T1, promptArchitecture: 'master' }))).toEqual([]);
    expect(masterConfigIssues(t1({ prompt: 'P' }))).toEqual([]);
  });

  it('refuse un préambule qui contient un master ({{TASK}} ou « BRANCHE TASK = »)', () => {
    for (const prompt of ['Contexte {{TASK}}', 'BRANCHE TASK = GROUP_UPLOAD\n…', MASTER_T1]) {
      expect(validateTreatment(t1({ prompt, maxOutputTokens: 1000 }), cat)).toContainEqual(expect.objectContaining({
        field: 'prompt', blocking: true, message: expect.stringMatching(/préambule des étapes contient un prompt maître/),
      }));
    }
    expect(masterConfigIssues(t1({ prompt: 'Sois précis. La tâche est décrite plus bas.' }))).toEqual([]);
  });

  it('master ou texte master sur un traitement sans master : bloquant', () => {
    const c = { ...emptyTreatmentConfig('T6'), prompt: 'x', promptArchitecture: 'master' as const, masterPrompt: MASTER_T1 };
    const issues = validateTreatment(c, cat);
    expect(issues).toContainEqual(expect.objectContaining({ field: 'promptArchitecture', blocking: true }));
    expect(issues).toContainEqual(expect.objectContaining({ field: 'masterPrompt', blocking: true }));
  });
});

describe('alerte master déclaré mais non appliqué (commutateur ≠ enabled)', () => {
  it('fonction pure', () => {
    expect(promptArchitectureWarning('T1', 'steps', 'legacy')).toBeNull();
    expect(promptArchitectureWarning('T1', 'master', 'enabled')).toBeNull();
    expect(promptArchitectureWarning('T5', 'master', 'legacy')).toBeNull();
    // Lot 15 : T2 en master mais AI_INTELLIGENT_ASSISTANT ≠ enabled ⇒ aucun appel modèle.
    expect(promptArchitectureWarning('T2', 'master', 'legacy')).toMatchObject({
      treatment: 'T2', code: 'MASTER_ENGINE_NOT_ENABLED', switchName: 'AI_INTELLIGENT_ASSISTANT',
    });
    expect(promptArchitectureWarning('T2', 'master', 'enabled')).toBeNull();
    for (const mode of ['legacy', 'shadow']) {
      expect(promptArchitectureWarning('T1', 'master', mode)).toMatchObject({
        treatment: 'T1', code: 'MASTER_NOT_APPLIED', switchName: 'AI_T1_ANALYSIS_MODE', switchMode: mode,
      });
    }
  });

  it('lit la version effective et le commutateur (rollout de C)', async () => {
    __setConfigForTests({ versionId: 16, entries: [t1({ promptArchitecture: 'master' })] });
    const avant = process.env.AI_T1_ANALYSIS_MODE;
    try {
      delete process.env.AI_T1_ANALYSIS_MODE;
      expect(await promptArchitectureWarnings()).toEqual([expect.objectContaining({ treatment: 'T1', switchMode: 'legacy' })]);
      process.env.AI_T1_ANALYSIS_MODE = 'enabled';
      expect(await promptArchitectureWarnings()).toEqual([]);
    } finally {
      if (avant === undefined) delete process.env.AI_T1_ANALYSIS_MODE; else process.env.AI_T1_ANALYSIS_MODE = avant;
    }
  });

  it('T3 en master : alerte si AI_RECONCILIATION_ENGINE ≠ enabled (arbitrage lead, lot 13)', async () => {
    expect(promptArchitectureWarning('T3', 'steps', 'legacy')).toBeNull();
    expect(promptArchitectureWarning('T3', 'master', 'enabled')).toBeNull();
    expect(promptArchitectureWarning('T3', 'master', 'legacy')).toMatchObject({
      treatment: 'T3', code: 'MASTER_ENGINE_NOT_ENABLED', switchName: 'AI_RECONCILIATION_ENGINE', switchMode: 'legacy',
      message: expect.stringMatching(/ne tourne pas/),
    });
    expect(promptArchitectureWarning('T3', 'master', 'shadow')?.message).toMatch(/observation/);

    __setConfigForTests({ versionId: 17, entries: [
      { ...emptyTreatmentConfig('T1'), promptArchitecture: 'steps' },
      { ...emptyTreatmentConfig('T3'), promptArchitecture: 'master' },
    ] });
    const avant = { t1: process.env.AI_T1_ANALYSIS_MODE, rec: process.env.AI_RECONCILIATION_ENGINE };
    try {
      delete process.env.AI_RECONCILIATION_ENGINE;
      expect(await promptArchitectureWarnings()).toEqual([expect.objectContaining({ treatment: 'T3', switchMode: 'legacy' })]);
      process.env.AI_RECONCILIATION_ENGINE = 'enabled';
      expect(await promptArchitectureWarnings()).toEqual([]);
    } finally {
      if (avant.rec === undefined) delete process.env.AI_RECONCILIATION_ENGINE; else process.env.AI_RECONCILIATION_ENGINE = avant.rec;
    }
  });

  it('T4 en master : alerte si AI_AGENDA_ENGINE ≠ enabled ; AI_T4_EFFECTS ne conditionne pas le master (lot 14)', async () => {
    expect(promptArchitectureWarning('T4', 'master', 'legacy')).toMatchObject({
      treatment: 'T4', code: 'MASTER_ENGINE_NOT_ENABLED', switchName: 'AI_AGENDA_ENGINE',
      message: expect.stringMatching(/CLASSIFY_EVENT/),
    });
    expect(promptArchitectureWarning('T4', 'master', 'enabled')).toBeNull();
    const lus: string[] = [];
    await promptArchitectureWarnings({
      readMode: (n) => { lus.push(n); return 'enabled'; },
      readArchitecture: async () => 'master',
    });
    expect(lus).toContain('AI_AGENDA_ENGINE');
    expect(lus).not.toContain('AI_T4_EFFECTS');
  });

  it('bascule T3 → master permise en Brouillon (master déclaré)', () => {
    expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: 'T3', from: 'steps', to: 'master' })).toEqual({ allowed: true });
  });

  it('ne lève jamais', async () => {
    expect(await promptArchitectureWarnings({ readArchitecture: async () => { throw new Error('base'); } })).toEqual([]);
  });
});

describe('saveTreatmentConfig — §29.1 appliqué par le service', () => {
  it('refuse master sur un traitement sans master ; conserve architecture et texte master omis', async () => {
    vi.resetModules();
    const saveEntry = vi.fn(async (..._a: unknown[]) => undefined);
    const brouillon = {
      id: 5, status: 'DRAFT', environment: 'local', entries: [
        { ...emptyTreatmentConfig('T1'), promptArchitecture: 'master', masterPrompt: 'MASTER EN PLACE' }, emptyTreatmentConfig('T6'),
      ],
    };
    vi.doMock('../config-version.repository', () => ({ getVersion: async () => brouillon, saveEntry }));
    vi.doMock('../config-cache-version', () => ({ bumpConfigVersionCounter: async () => true }));
    const svc = await import('../config-version.service');

    await expect(svc.saveTreatmentConfig(5, { ...emptyTreatmentConfig('T6'), promptArchitecture: 'master' }, 1))
      .rejects.toMatchObject({ code: 'NO_MASTER_FOR_TREATMENT' });

    const sansChamp = { ...emptyTreatmentConfig('T1') };
    delete (sansChamp as Partial<TreatmentConfig>).promptArchitecture;
    delete (sansChamp as Partial<TreatmentConfig>).masterPrompt;
    await svc.saveTreatmentConfig(5, sansChamp, 1);
    expect((saveEntry.mock.calls[0][1] as TreatmentConfig).promptArchitecture).toBe('master');
    expect((saveEntry.mock.calls[0][1] as TreatmentConfig).masterPrompt).toBe('MASTER EN PLACE');
    vi.doUnmock('../config-version.repository');
    vi.doUnmock('../config-cache-version');
  });
});

describe('T2-43 : variable retirée VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS', () => {
  it('posée : alerte (admin, health) ; absente : rien', async () => {
    const { retiredOutputTokensWarning } = await import('../prompt-architecture');
    expect(retiredOutputTokensWarning({})).toBeNull();
    expect(retiredOutputTokensWarning({ VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS: '300' })).toMatchObject({
      treatment: 'T2', code: 'RETIRED_ENV_VARIABLE', switchName: 'VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS', switchMode: '300',
    });
    const w = await promptArchitectureWarnings({
      env: { VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS: '300' }, readMode: () => 'enabled', readArchitecture: async () => 'steps',
    });
    expect(w.map((x) => x.code)).toEqual(['RETIRED_ENV_VARIABLE']);
    expect(await promptArchitectureWarnings({ env: {}, readMode: () => 'enabled', readArchitecture: async () => 'steps' })).toEqual([]);
  });
});
