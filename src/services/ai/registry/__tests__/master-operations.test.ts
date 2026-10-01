/**
 * CDC 15 §22.3, §29 étape 11, §29.1, ARCH-02, ARCH-03, D-06 — opérations T1
 * master et rattachement des étapes historiques au master de leur traitement.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_OPERATIONS, getOperation, isMasterOperation, listMasterTasks, listMasterPrompts,
  listOperationsByUseCase, type AiOperationDefinition,
} from '../operations';
import { assertMasterDeclaration } from '../index';
import { MASTER_OUTPUT_SCHEMAS } from '../../gateway/master-output-schemas';
import { T1_MASTER_PROMPT_CODE, T1_TASKS } from '../../source-analysis/master/t1-contract';

describe('opérations T1 master', () => {
  it('t1_group_upload : comme group_sources, TASK=GROUP_UPLOAD', () => {
    const op = getOperation('t1_group_upload');
    const ref = getOperation('group_sources');
    expect(op).toMatchObject({
      useCaseCode: 'SOURCE_ANALYSIS', promptCode: T1_MASTER_PROMPT_CODE, masterPromptCode: T1_MASTER_PROMPT_CODE,
      task: 'GROUP_UPLOAD', timeoutMs: 45_000, billable: ref.billable, active: true,
      primaryModel: ref.primaryModel, fallbackModels: ref.fallbackModels, outputSchema: 'T1GroupUploadOutput',
    });
  });

  it('t1_analyze_document : comme extract_source, TASK=ANALYZE_DOCUMENT, plancher de sortie D-06', () => {
    const op = getOperation('t1_analyze_document');
    const ref = getOperation('extract_source');
    expect(op).toMatchObject({
      useCaseCode: 'SOURCE_ANALYSIS', promptCode: T1_MASTER_PROMPT_CODE, masterPromptCode: T1_MASTER_PROMPT_CODE,
      task: 'ANALYZE_DOCUMENT', timeoutMs: 120_000, billable: ref.billable, active: true,
      primaryModel: ref.primaryModel, fallbackModels: ref.fallbackModels, outputSchema: 'T1AnalyzeDocumentOutput',
    });
    expect(op.minOutputTokens).toBeGreaterThanOrEqual(32_768);
  });

  it('les branches déclarées sont exactement celles du contrat', () => {
    expect(listMasterTasks(T1_MASTER_PROMPT_CODE).sort()).toEqual([...T1_TASKS].sort());
    expect(listMasterPrompts()).toEqual([
      { masterPromptCode: T1_MASTER_PROMPT_CODE, useCaseCode: 'SOURCE_ANALYSIS', tasks: ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'] },
      { masterPromptCode: 't3_master_v1', useCaseCode: 'DATA_RECONCILIATION', tasks: ['VALUE_CONFLICT', 'LINK_AMBIGUITY'] },
      // Lot 15 : T2, discriminant MODE (§24).
      { masterPromptCode: 't2_master_v1', useCaseCode: 'INTELLIGENT_ASSISTANT', tasks: ['UNDERSTAND', 'ANSWER', 'REVALIDATE'] },
      // TEMPORAL_AMBIGUITY : active depuis le lot 18 (R5).
      { masterPromptCode: 't4_master_v1', useCaseCode: 'AGENDA_INTELLIGENCE', tasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] },
      // Lot 16 : T5 (§27), MODE ANALYZE / MODIFY.
      { masterPromptCode: 't5_master_v1', useCaseCode: 'AI_GOVERNANCE', tasks: ['ANALYZE', 'MODIFY'] },
      // Lot 16 (C) : T6 (§28), MODE FORMULATE, sortie sans discriminant.
      { masterPromptCode: 't6_master_v1', useCaseCode: 'HOME_MASCOT', tasks: ['FORMULATE'] },
    ]);
  });

  it('schéma de sortie d’une opération master : schéma discriminé connu', () => {
    for (const op of Object.values(AI_OPERATIONS).filter(isMasterOperation)) {
      expect(MASTER_OUTPUT_SCHEMAS[op.outputSchema], op.operationCode).toBeTruthy();
    }
  });

  it('déclarées après les étapes historiques (le disjoncteur sonde la première opération active)', () => {
    const codes = listOperationsByUseCase('SOURCE_ANALYSIS').filter((o) => o.active).map((o) => o.operationCode);
    expect(codes[0]).toBe('group_sources');
  });
});

describe('§22.3 : chaque étape T1 référence le master et une TASK explicite', () => {
  const attendu: Record<string, string> = {
    group_sources: 'GROUP_UPLOAD',
    extract_source: 'ANALYZE_DOCUMENT',
    classify_document: 'ANALYZE_DOCUMENT',
    classify_category: 'ANALYZE_DOCUMENT',
    classify_rubric: 'ANALYZE_DOCUMENT',
    identify_entities: 'ANALYZE_DOCUMENT',
    propose_links: 'ANALYZE_DOCUMENT',
  };

  it('migratesTo déclaré, prompt effectif inchangé', () => {
    for (const [code, task] of Object.entries(attendu)) {
      const op = getOperation(code);
      expect(op.migratesTo, code).toEqual({
        masterPromptCode: T1_MASTER_PROMPT_CODE, task,
        operationCode: task === 'GROUP_UPLOAD' ? 't1_group_upload' : 't1_analyze_document',
      });
      // Comportement de production inchangé : pas d'exécution master.
      expect(isMasterOperation(op), code).toBe(false);
      expect(op.promptCode).not.toBe(T1_MASTER_PROMPT_CODE);
    }
  });

  it('toute opération LLM active de T1 est master ou rattachée (hors relais historique)', () => {
    for (const op of listOperationsByUseCase('SOURCE_ANALYSIS')) {
      if (op.provider === 'none' || !op.active || op.legacyPrompt) continue;
      expect(isMasterOperation(op) || Boolean(op.migratesTo), op.operationCode).toBe(true);
    }
  });

  it('ARCH-02 : classify_category et propose_change (fichiers absents, sans appelant) désactivées', () => {
    expect(getOperation('classify_category').active).toBe(false);
    expect(getOperation('propose_change').active).toBe(false);
  });
});

describe('assertMasterDeclaration', () => {
  const base = getOperation('t1_group_upload');
  const refuse = (op: Partial<AiOperationDefinition>) => () => assertMasterDeclaration({ ...base, ...op });

  it('passe sur le référentiel courant', () => {
    for (const op of Object.values(AI_OPERATIONS)) expect(() => assertMasterDeclaration(op)).not.toThrow();
  });

  it('refuse les déclarations incohérentes', () => {
    expect(refuse({ task: undefined })).toThrow(/vont ensemble/);
    expect(refuse({ promptCode: 'group_sources_v2' })).toThrow(/doit être le master/);
    expect(refuse({ legacyPrompt: true })).toThrow(/ni relayé ni dynamique/);
    expect(refuse({ masterPromptCode: 't1_master_v2', promptCode: 't1_master_v2' })).toThrow(/un seul prompt maître/);
    expect(() => assertMasterDeclaration({
      ...getOperation('extract_source'),
      migratesTo: { masterPromptCode: 't1_master_v1', task: 'GROUP_UPLOAD', operationCode: 't1_analyze_document' },
    })).toThrow(/migratesTo/);
  });
});

describe('opérations T3 master (CDC 15 §25, lot 13)', () => {
  it('t3_value_conflict : comme resolve_ambiguity, TASK=VALUE_CONFLICT', () => {
    const op = getOperation('t3_value_conflict');
    const ref = getOperation('resolve_ambiguity');
    expect(op).toMatchObject({
      useCaseCode: 'DATA_RECONCILIATION', promptCode: 't3_master_v1', masterPromptCode: 't3_master_v1',
      task: 'VALUE_CONFLICT', billable: ref.billable, primaryModel: ref.primaryModel, fallbackModels: ref.fallbackModels,
      outputSchema: 'T3ValueConflictOutput', active: true,
    });
  });

  it('t3_link_ambiguity : comme reconcile_links, TASK=LINK_AMBIGUITY', () => {
    const op = getOperation('t3_link_ambiguity');
    const ref = getOperation('reconcile_links');
    expect(op).toMatchObject({
      useCaseCode: 'DATA_RECONCILIATION', promptCode: 't3_master_v1', masterPromptCode: 't3_master_v1',
      task: 'LINK_AMBIGUITY', billable: ref.billable, primaryModel: ref.primaryModel,
      outputSchema: 'T3LinkAmbiguityOutput', active: true,
    });
  });

  it('étapes historiques rattachées au master T3, prompt effectif inchangé', () => {
    expect(getOperation('resolve_ambiguity')).toMatchObject({
      promptCode: 'resolve_ambiguity_v1',
      migratesTo: { masterPromptCode: 't3_master_v1', task: 'VALUE_CONFLICT', operationCode: 't3_value_conflict' },
    });
    expect(getOperation('reconcile_links')).toMatchObject({
      promptCode: 'reconcile_links_v1',
      migratesTo: { masterPromptCode: 't3_master_v1', task: 'LINK_AMBIGUITY', operationCode: 't3_link_ambiguity' },
    });
    const actives = listOperationsByUseCase('DATA_RECONCILIATION').filter((o) => o.active && o.provider !== 'none');
    expect(actives[0].operationCode).toBe('resolve_ambiguity');
    for (const op of actives) {
      if (op.legacyPrompt) continue;
      expect(isMasterOperation(op) || Boolean(op.migratesTo), op.operationCode).toBe(true);
    }
  });
});

describe('opérations T4 master (CDC 15 §26, lot 14)', () => {
  it('trois branches, rattachées aux étapes historiques, mêmes modèles', () => {
    const ref = getOperation('classify_event');
    // `t4_temporal_ambiguity` : active depuis le lot 18 (R5), appelée par T4.
    for (const [code, task, schema, active] of [
      ['t4_classify_event', 'CLASSIFY_EVENT', 'T4ClassifyEventOutput', true],
      ['t4_verify_completion', 'VERIFY_COMPLETION', 'T4VerifyCompletionOutput', true],
      ['t4_temporal_ambiguity', 'TEMPORAL_AMBIGUITY', 'T4TemporalAmbiguityOutput', true],
    ] as const) {
      expect(getOperation(code)).toMatchObject({
        useCaseCode: 'AGENDA_INTELLIGENCE', promptCode: 't4_master_v1', masterPromptCode: 't4_master_v1', task,
        outputSchema: schema, primaryModel: ref.primaryModel, billable: false, active,
      });
    }
    expect(getOperation('classify_event')).toMatchObject({
      promptCode: 'classify_event_v2',
      migratesTo: { masterPromptCode: 't4_master_v1', task: 'CLASSIFY_EVENT', operationCode: 't4_classify_event' },
    });
    expect(getOperation('reconcile_status')).toMatchObject({
      promptCode: 'reconcile_status_v1',
      migratesTo: { masterPromptCode: 't4_master_v1', task: 'VERIFY_COMPLETION', operationCode: 't4_verify_completion' },
    });
    const actives = listOperationsByUseCase('AGENDA_INTELLIGENCE').filter((o) => o.active && o.provider !== 'none');
    expect(actives[0].operationCode).toBe('classify_event');
  });
});
