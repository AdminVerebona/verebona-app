/**
 * CDC 15 D-03, D-04, §29 étape 14, §29.1 — architecture des prompts par
 * traitement, portée par la version de configuration IA.
 *
 * Lot 16b-3b : PLUS AUCUN traitement n'a d'architecture `steps` (T3, dernier,
 * migration 0234). `master` est lu partout ; `steps` n'est plus qu'une donnée
 * héritée, refusée à l'enregistrement et à la promotion.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  checkPromptArchitectureChange, masterConfigIssues, masterPromptForTreatment, masterCapableTreatments,
  promptArchitectureWarnings,
} from '../prompt-architecture';
import {
  emptyTreatmentConfig, promptArchitectureOf, DEFAULT_PROMPT_ARCHITECTURE, type TreatmentConfig,
} from '../config-types';
import { __setConfigForTests, resolveOperationConfig } from '../config-resolver';
import { diffVersions } from '../config-diff.service';
import { validateTreatment, type ConfigCatalogs } from '../config-validation.service';
import { runInJobContext } from '../../queue/job-context';
import { T3_MASTER_VARIABLES } from '../../registry/operations';
import { MASTER_ONLY_TREATMENTS, TREATMENTS } from '../treatments';

const MASTER_T3 = `{{TASK}}\n${T3_MASTER_VARIABLES.map((v) => `{{${v}}}`).join('\n')}\nBRANCHE TASK = VALUE_CONFLICT\nBRANCHE TASK = LINK_AMBIGUITY\n`;
/** Traitement fictif sans master (lot 16 : T1 à T6 en ont tous un). */
const SANS_MASTER = 'T9' as never;
const t3 = (over: Partial<TreatmentConfig> = {}): TreatmentConfig => ({
  ...emptyTreatmentConfig('T3'), primaryModel: 'm-a', ...over,
});

afterEach(() => __setConfigForTests(null));

describe('valeur par défaut', () => {
  it('master pour tous, y compris une ligne antérieure au lot 12 (champ absent, illisible ou `steps`)', () => {
    expect(DEFAULT_PROMPT_ARCHITECTURE).toBe('master');
    expect([...MASTER_ONLY_TREATMENTS]).toEqual([...TREATMENTS]);
    for (const t of TREATMENTS) {
      expect(emptyTreatmentConfig(t).promptArchitecture, t).toBe('master');
      expect(promptArchitectureOf({ treatment: t, promptArchitecture: 'steps' }), t).toBe('master');
    }
    expect(promptArchitectureOf({})).toBe('master');
    expect(promptArchitectureOf({ promptArchitecture: 'steps' })).toBe('master');
    expect(promptArchitectureOf({ promptArchitecture: 'autre' as never })).toBe('master');
    expect(promptArchitectureOf(null)).toBe('master');
  });

  it('masters déclarés : T1 (lot 12), T3 (lot 13), T4 (lot 14), T2 (lot 15)', () => {
    expect(masterPromptForTreatment('T1')).toEqual({
      masterPromptCode: 't1_master_v1', tasks: ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'],
    });
    expect(masterPromptForTreatment('T3')).toEqual({
      masterPromptCode: 't3_master_v1', tasks: ['VALUE_CONFLICT', 'LINK_AMBIGUITY'],
    });
    expect(masterPromptForTreatment('T4')).toEqual({
      // TEMPORAL_AMBIGUITY : active depuis le lot 18 (R5).
      masterPromptCode: 't4_master_v1', tasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'],
    });
    expect(masterPromptForTreatment('T2')).toEqual({
      masterPromptCode: 't2_master_v1', tasks: ['UNDERSTAND', 'ANSWER', 'REVALIDATE'],
    });
    // Lot 16 : T5 (§27), discriminant MODE, branches déclarées « Valeurs autorisées ».
    expect(masterPromptForTreatment('T5')).toEqual({ masterPromptCode: 't5_master_v1', tasks: ['ANALYZE', 'MODIFY'] });
    expect([...masterCapableTreatments()].sort()).toEqual(expect.arrayContaining(['T1', 'T2', 'T3', 'T4', 'T5']));
  });
});

describe('checkPromptArchitectureChange — §29.1', () => {
  it('`steps` refusé pour TOUS les traitements, quel que soit le statut (lot 16b)', () => {
    for (const t of TREATMENTS) {
      for (const status of ['DRAFT', 'ACTIVE'] as const) {
        expect(checkPromptArchitectureChange({ status, treatment: t, from: 'master', to: 'steps' }), `${t} ${status}`)
          .toMatchObject({ allowed: false, code: 'MASTER_ONLY_TREATMENT' });
      }
    }
  });

  it('enregistrer `master` (ligne stockée `steps` ou absente) n’est pas une bascule : permis, même hors Brouillon', () => {
    for (const status of ['DRAFT', 'ACTIVE', 'TO_TEST'] as const) {
      expect(checkPromptArchitectureChange({ status, treatment: 'T3', from: 'steps', to: 'master' })).toEqual({ allowed: true });
      expect(checkPromptArchitectureChange({ status, treatment: 'T3', from: undefined, to: 'master' })).toEqual({ allowed: true });
    }
  });
});

describe('version figée d’un job (VER-015) : plus d’aiguillage steps / master', () => {
  it('le texte master de la version FIGÉE s’applique, la ligne stockée `steps` ne change rien', async () => {
    __setConfigForTests(
      { versionId: 12, entries: [t3({ masterPrompt: 'MASTER v12' })] },
      [{ versionId: 10, entries: [t3({ promptArchitecture: 'steps', masterPrompt: 'MASTER v10' })] }],
    );
    const cfg = await runInJobContext(
      { jobId: 1, treatment: 'T3', configVersionId: 10 },
      () => resolveOperationConfig('t3_value_conflict'),
    );
    expect(cfg).toMatchObject({ promptArchitecture: 'master', masterPromptText: 'MASTER v10', configVersionId: 10 });
  });
});

describe('resolveOperationConfig — D-03 (texte master distinct du préambule)', () => {
  it('master : le texte vient de son champ, même si la ligne est stockée `steps` (lot 16b-3)', async () => {
    __setConfigForTests({ versionId: 13, entries: [t3({ prompt: 'Préambule', masterPrompt: MASTER_T3, promptArchitecture: 'steps' })] });
    expect(await resolveOperationConfig('t3_value_conflict'))
      .toMatchObject({ promptArchitecture: 'master', masterPromptText: MASTER_T3 });
  });

  it('master sans texte : fichier du dépôt (masterPromptText null) ; sans version : master', async () => {
    __setConfigForTests({ versionId: 15, entries: [t3({ prompt: 'P', masterPrompt: '  ' })] });
    expect((await resolveOperationConfig('t3_link_ambiguity')).masterPromptText).toBeNull();
    __setConfigForTests(null);
    for (const op of ['t1_analyze_document', 't2_answer', 't3_value_conflict', 't4_classify_event', 't6_formulate']) {
      expect(await resolveOperationConfig(op), op).toMatchObject({ promptArchitecture: 'master' });
    }
  });
});

describe('diff et contrôles de promotion', () => {
  const cat: ConfigCatalogs = {
    availableModels: new Set(['m-a']), pricedModels: new Set(['m-a']),
    guardrailCodes: new Set(), triggerCodes: new Set(),
  };

  it('plus de « bascule » au diff : une ligne sans champ ou stockée `steps` vaut master (pas de faux changement)', () => {
    const avant = { ...t3() };
    delete (avant as Partial<TreatmentConfig>).promptArchitecture;
    delete (avant as Partial<TreatmentConfig>).masterPrompt;
    expect(diffVersions([avant], [t3()]).identical).toBe(true);
    expect(diffVersions([t3({ promptArchitecture: 'steps' })], [t3()]).identical).toBe(true);
  });

  it('le texte master apparaît au diff comme un champ distinct du prompt', () => {
    const d = diffVersions([t3({ prompt: 'P' })], [t3({ prompt: 'P', masterPrompt: MASTER_T3 })]);
    expect(d.treatments[0].changes).toEqual([expect.objectContaining({
      field: 'masterPrompt', kind: 'added', before: null, after: MASTER_T3,
    })]);
  });

  it('texte master vide : fichier du dépôt, signalé sans bloquer ; le préambule n’est plus obligatoire (lot 16b)', () => {
    const issues = validateTreatment(t3({ prompt: '', maxOutputTokens: 1000 }), cat);
    expect(issues).toContainEqual(expect.objectContaining({ field: 'masterPrompt', blocking: false }));
    expect(issues.filter((i) => i.field === 'prompt')).toEqual([]);
  });

  it('texte master incomplet : bloquant (plus de cas « champ ignoré en steps »)', () => {
    const issues = masterConfigIssues(t3({ prompt: 'P', masterPrompt: 'Sois précis.' }));
    // {{TASK}}, deux sections, et (lot 16) les emplacements attendus par le code.
    expect(issues.length).toBe(4);
    expect(issues.every((i) => i.field === 'masterPrompt' && i.blocking)).toBe(true);
    expect(issues[3].message).toMatch(/emplacement\(s\) supprimé/);
    expect(issues[0].message).toMatch(/\{\{TASK\}\}/);
  });

  it('master complet : aucune anomalie ; ligne T3 stockée `steps` : bloquante (migration 0234 non passée)', () => {
    expect(masterConfigIssues(t3({ prompt: 'P', masterPrompt: MASTER_T3 }))).toEqual([]);
    expect(masterConfigIssues(t3({ prompt: 'P', masterPrompt: MASTER_T3, promptArchitecture: 'steps' })))
      .toEqual([expect.objectContaining({ field: 'promptArchitecture', blocking: true })]);
  });

  it('signale sans bloquer un ancien préambule qui contient un master ({{TASK}} ou « BRANCHE TASK = ») : plus éditable ni appliqué', () => {
    for (const prompt of ['Contexte {{TASK}}', 'BRANCHE TASK = VALUE_CONFLICT\n…', MASTER_T3]) {
      expect(validateTreatment(t3({ prompt, maxOutputTokens: 1000 }), cat)).toContainEqual(expect.objectContaining({
        field: 'prompt', blocking: false, message: expect.stringMatching(/ancien préambule contient un prompt maître/),
      }));
    }
    expect(masterConfigIssues(t3({ prompt: 'Sois précis. La tâche est décrite plus bas.', masterPrompt: MASTER_T3 }))).toEqual([]);
  });

  it('master ou texte master sur un traitement sans master : bloquant', () => {
    const c = { ...emptyTreatmentConfig(SANS_MASTER), prompt: 'x', promptArchitecture: 'master' as const, masterPrompt: MASTER_T3 };
    // `masterConfigIssues` : le contrôle que `validateTreatment` applique à chaque ligne.
    const issues = masterConfigIssues(c);
    expect(issues).toContainEqual(expect.objectContaining({ field: 'promptArchitecture', blocking: true }));
    expect(issues).toContainEqual(expect.objectContaining({ field: 'masterPrompt', blocking: true }));
  });
});

describe('variables retirées encore posées (/api/health) — lot 16b : plus aucun commutateur', () => {
  it('chaque drapeau / commutateur retiré posé est signalé, ignoré par le code', async () => {
    const w = await promptArchitectureWarnings({ env: {
      AI_RECONCILIATION_ENGINE: 'enabled', T3_NEGATIVE_RECONCILIATION: 'shadow', CANONICAL_WRITE_MODE: 'enabled',
      EXPORTS_CANONICAL_SOURCE: 'legacy', AI_T1_ANALYSIS_MODE: 'enabled', GEMINI_API_KEY: 'x',
    } });
    expect(w.map((x) => x.switchName).sort()).toEqual([
      'AI_RECONCILIATION_ENGINE', 'AI_T1_ANALYSIS_MODE', 'CANONICAL_WRITE_MODE', 'EXPORTS_CANONICAL_SOURCE', 'T3_NEGATIVE_RECONCILIATION',
    ]);
    expect(w.every((x) => x.code === 'RETIRED_ENV_VARIABLE')).toBe(true);
    expect(w.find((x) => x.switchName === 'CANONICAL_WRITE_MODE')?.message).toMatch(/IGNORÉE.*L16b-3/);
  });

  it('rien de posé (ou valeur vide) : aucun avertissement ; ne lit jamais la base', async () => {
    expect(await promptArchitectureWarnings({ env: {} })).toEqual([]);
    expect(await promptArchitectureWarnings({ env: { AI_RECONCILIATION_ENGINE: '  ' } })).toEqual([]);
  });
});

describe('saveTreatmentConfig — §29.1 appliqué par le service', () => {
  it('refuse `steps` ; conserve architecture et texte master omis', async () => {
    vi.resetModules();
    const saveEntry = vi.fn(async (..._a: unknown[]) => undefined);
    const brouillon = {
      id: 5, status: 'DRAFT', environment: 'local', entries: [
        { ...emptyTreatmentConfig('T1'), promptArchitecture: 'master', masterPrompt: 'MASTER EN PLACE' }, emptyTreatmentConfig(SANS_MASTER),
      ],
    };
    vi.doMock('../config-version.repository', () => ({ getVersion: async () => brouillon, saveEntry }));
    vi.doMock('../config-cache-version', () => ({ bumpConfigVersionCounter: async () => true }));
    const svc = await import('../config-version.service');

    // Lot 16b : `master` est l'architecture de toute ligne — l'enregistrer
    // n'est pas une bascule ; un traitement sans master déclaré est bloqué à
    // la PROMOTION (`masterConfigIssues`, test ci-dessus), et `steps` refusé.
    await expect(svc.saveTreatmentConfig(5, { ...emptyTreatmentConfig('T3'), promptArchitecture: 'steps' }, 1))
      .rejects.toMatchObject({ code: 'MASTER_ONLY_TREATMENT' });
    saveEntry.mockClear();

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
    const w = await promptArchitectureWarnings({ env: { VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS: '300' } });
    expect(w.map((x) => x.code)).toEqual(['RETIRED_ENV_VARIABLE']);
    expect(w[0].treatment).toBe('T2');
    expect(await promptArchitectureWarnings({ env: {} })).toEqual([]);
  });
});

describe('lot 16b — T5 et T6 : master seul', () => {
  it('lus `master` quelle que soit la valeur stockée (T3 aussi depuis le lot 16b-3)', () => {
    for (const t of ['T5', 'T6', 'T3'] as const) {
      expect(promptArchitectureOf({ treatment: t, promptArchitecture: 'steps' }), t).toBe('master');
      expect(promptArchitectureOf({ treatment: t }), t).toBe('master');
      expect(emptyTreatmentConfig(t).promptArchitecture, t).toBe('master');
    }
  });

  it('master T6 de la version appliqué même si la ligne stockée dit `steps`', async () => {
    const texte = 'MASTER T6 de la version';
    __setConfigForTests({ versionId: 3, entries: [{ ...emptyTreatmentConfig('T6'), promptArchitecture: 'steps', masterPrompt: texte }] });
    expect(await resolveOperationConfig('t6_formulate')).toMatchObject({ promptArchitecture: 'master', masterPromptText: texte });
  });

  it('refus explicite de `steps` pour T5/T6, quel que soit le statut', () => {
    for (const t of ['T5', 'T6'] as const) {
      expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: t, from: 'master', to: 'steps' }))
        .toMatchObject({ allowed: false, code: 'MASTER_ONLY_TREATMENT' });
      expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: t, from: 'steps', to: 'master' }))
        .toEqual({ allowed: true });
    }
  });

  it('promotion : une ligne T5/T6 encore en `steps` (valeur brute) est bloquante', () => {
    for (const t of ['T5', 'T6'] as const) {
      const issues = masterConfigIssues({ ...emptyTreatmentConfig(t), promptArchitecture: 'steps' });
      expect(issues.some((i) => i.field === 'promptArchitecture' && i.blocking), t).toBe(true);
    }
    // T5 en master, texte vide (fichier du dépôt par construction) : rien à signaler.
    expect(masterConfigIssues(emptyTreatmentConfig('T5'))).toEqual([]);
  });

  it('migration 0231 : aligne la donnée stockée, idempotente', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0231_ai_config_t5_t6_master_only.sql'), 'utf8');
    expect(sql).toMatch(/UPDATE ai_config_entries\s+SET prompt_architecture = 'master'\s+WHERE treatment IN \('T5', 'T6'\)\s+AND prompt_architecture IS DISTINCT FROM 'master'/);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
    expect(sql).not.toMatch(/master_prompt\s*=/);
  });
});

describe('lot 16b-2 — T2 et T4 : master seul', () => {
  it('lus `master` quelle que soit la valeur stockée, par défaut aussi', async () => {
    for (const t of ['T2', 'T4'] as const) {
      expect(promptArchitectureOf({ treatment: t, promptArchitecture: 'steps' }), t).toBe('master');
      expect(emptyTreatmentConfig(t).promptArchitecture, t).toBe('master');
    }
    // Sans version : les opérations T2/T4 sont résolues en master.
    __setConfigForTests(null);
    expect(await resolveOperationConfig('t2_answer')).toMatchObject({ promptArchitecture: 'master' });
    expect(await resolveOperationConfig('t4_classify_event')).toMatchObject({ promptArchitecture: 'master' });
  });

  it('master T2 de la version appliqué même si la ligne stockée dit `steps`', async () => {
    const texte = 'MASTER T2 de la version {{TASK}}';
    __setConfigForTests({ versionId: 5, entries: [{ ...emptyTreatmentConfig('T2'), promptArchitecture: 'steps', masterPrompt: texte }] });
    expect(await resolveOperationConfig('t2_answer')).toMatchObject({ promptArchitecture: 'master', masterPromptText: texte });
  });

  it('`steps` refusé à l’enregistrement et bloquant à la promotion', () => {
    for (const t of ['T2', 'T4'] as const) {
      expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: t, from: 'master', to: 'steps' }))
        .toMatchObject({ allowed: false, code: 'MASTER_ONLY_TREATMENT' });
      const issues = masterConfigIssues({ ...emptyTreatmentConfig(t), promptArchitecture: 'steps' });
      expect(issues.some((i) => i.field === 'promptArchitecture' && i.blocking), t).toBe(true);
    }
  });

  it('migration 0232 : aligne la donnée stockée, idempotente, sans toucher au texte master', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0232_ai_config_t2_t4_master_only.sql'), 'utf8');
    expect(sql).toMatch(/UPDATE ai_config_entries\s+SET prompt_architecture = 'master'\s+WHERE treatment IN \('T2', 'T4'\)\s+AND prompt_architecture IS DISTINCT FROM 'master'/);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
    expect(sql).toMatch(/column_name = 'prompt_architecture'/);
    expect(sql).not.toMatch(/master_prompt\s*=/);
  });
});

describe('lot 16b-3 — T1 : master seul', () => {
  it('lu `master` quelle que soit la valeur stockée, par défaut aussi', async () => {
    expect(promptArchitectureOf({ treatment: 'T1', promptArchitecture: 'steps' })).toBe('master');
    expect(emptyTreatmentConfig('T1').promptArchitecture).toBe('master');
    __setConfigForTests(null);
    expect(await resolveOperationConfig('t1_analyze_document')).toMatchObject({ promptArchitecture: 'master' });
    expect(await resolveOperationConfig('t1_group_upload')).toMatchObject({ promptArchitecture: 'master' });
  });

  it('master T1 de la version appliqué même si la ligne stockée dit `steps`', async () => {
    const texte = 'MASTER T1 de la version {{TASK}}';
    __setConfigForTests({ versionId: 7, entries: [{ ...emptyTreatmentConfig('T1'), promptArchitecture: 'steps', masterPrompt: texte }] });
    expect(await resolveOperationConfig('t1_analyze_document')).toMatchObject({ promptArchitecture: 'master', masterPromptText: texte });
  });

  it('`steps` refusé à l’enregistrement et bloquant à la promotion', () => {
    expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: 'T1', from: 'master', to: 'steps' }))
      .toMatchObject({ allowed: false, code: 'MASTER_ONLY_TREATMENT' });
    const issues = masterConfigIssues({ ...emptyTreatmentConfig('T1'), promptArchitecture: 'steps' });
    expect(issues.some((i) => i.field === 'promptArchitecture' && i.blocking)).toBe(true);
  });

  it('migration 0233 : aligne la donnée stockée, idempotente, sans toucher au texte master', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0233_ai_config_t1_master_only.sql'), 'utf8');
    expect(sql).toMatch(/UPDATE ai_config_entries\s+SET prompt_architecture = 'master'\s+WHERE treatment IN \('T1'\)\s+AND prompt_architecture IS DISTINCT FROM 'master'/);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
    expect(sql).toMatch(/column_name = 'prompt_architecture'/);
    expect(sql).not.toMatch(/master_prompt\s*=/);
  });
});

describe('lot 16b-3b — T3 : master seul, dernier traitement', () => {
  it('`steps` refusé à l’enregistrement et bloquant à la promotion', () => {
    expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: 'T3', from: 'master', to: 'steps' }))
      .toMatchObject({ allowed: false, code: 'MASTER_ONLY_TREATMENT' });
    const issues = masterConfigIssues({ ...emptyTreatmentConfig('T3'), promptArchitecture: 'steps' });
    expect(issues.some((i) => i.field === 'promptArchitecture' && i.blocking)).toBe(true);
  });

  it('migration 0234 : aligne la donnée stockée de TOUS les traitements, idempotente, sans toucher au texte master', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0234_ai_config_t3_master_only.sql'), 'utf8');
    expect(sql).toMatch(/UPDATE ai_config_entries\s+SET prompt_architecture = 'master'\s+WHERE treatment IN \('T1', 'T2', 'T3', 'T4', 'T5', 'T6'\)\s+AND prompt_architecture IS DISTINCT FROM 'master'/);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
    expect(sql).toMatch(/column_name = 'prompt_architecture'/);
    expect(sql).not.toMatch(/master_prompt\s*=/);
  });
});
