/**
 * CDC 15 §22.3, §29 étape 11, §29.1, ARCH-02, ARCH-03, D-06 — opérations T1
 * master (seules depuis le lot 16b-3) et rattachement des étapes historiques
 * restantes (T3) au master de leur traitement.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_OPERATIONS, getOperation, isMasterOperation, listMasterTasks, listMasterPrompts,
  listOperationsByUseCase, type AiOperationDefinition,
} from '../operations';
import { assertMasterDeclaration } from '../index';
import { MASTER_OUTPUT_SCHEMAS } from '../../gateway/master-output-schemas';
import { T1_MASTER_PROMPT_CODE, T1_TASKS } from '../../source-analysis/master/t1-contract';

describe('opérations T1 master (seules depuis le lot 16b-3)', () => {
  const DOC = { primaryModel: 'gemini-3.1-flash-lite' };

  it('t1_group_upload : TASK=GROUP_UPLOAD, non facturée', () => {
    expect(getOperation('t1_group_upload')).toMatchObject({
      useCaseCode: 'SOURCE_ANALYSIS', promptCode: T1_MASTER_PROMPT_CODE, masterPromptCode: T1_MASTER_PROMPT_CODE,
      task: 'GROUP_UPLOAD', timeoutMs: 45_000, billable: false, active: true, ...DOC, outputSchema: 'T1GroupUploadOutput',
    });
  });

  it('t1_analyze_document : TASK=ANALYZE_DOCUMENT, facturée, plancher de sortie D-06, mêmes modèles', () => {
    const op = getOperation('t1_analyze_document');
    expect(op).toMatchObject({
      useCaseCode: 'SOURCE_ANALYSIS', promptCode: T1_MASTER_PROMPT_CODE, masterPromptCode: T1_MASTER_PROMPT_CODE,
      task: 'ANALYZE_DOCUMENT', timeoutMs: 120_000, billable: true, active: true, ...DOC, outputSchema: 'T1AnalyzeDocumentOutput',
    });
    expect(op.fallbackModels).toEqual(getOperation('t1_group_upload').fallbackModels);
    expect(op.minOutputTokens).toBeGreaterThanOrEqual(32_768);
  });

  it('étapes historiques et relais T1 retirés du registre', () => {
    for (const retire of [
      'group_sources', 'extract_source', 'classify_document', 'classify_rubric',
      'identify_entities', 'propose_links', 'legacy_document_analysis',
    ]) expect(AI_OPERATIONS[retire], retire).toBeUndefined();
    const actives = listOperationsByUseCase('SOURCE_ANALYSIS').filter((o) => o.active && o.provider !== 'none');
    expect(actives.map((o) => o.operationCode)).toEqual(['t1_group_upload', 't1_analyze_document']);
    for (const op of actives) expect(isMasterOperation(op), op.operationCode).toBe(true);
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

  it('le disjoncteur sonde la première opération active : le master T1 (GROUP_UPLOAD)', () => {
    const codes = listOperationsByUseCase('SOURCE_ANALYSIS').filter((o) => o.active).map((o) => o.operationCode);
    expect(codes[0]).toBe('t1_group_upload');
  });
});

describe('opérations restantes', () => {
  it('lot 16b : classify_category et propose_change (inactives, sans appelant) retirées du registre ; plus aucune opération inactive', () => {
    expect(AI_OPERATIONS.classify_category).toBeUndefined();
    expect(AI_OPERATIONS.propose_change).toBeUndefined();
    expect(Object.values(AI_OPERATIONS).filter((o) => !o.active).map((o) => o.operationCode)).toEqual([]);
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
    expect(refuse({ promptCode: 'resolve_ambiguity_v1' })).toThrow(/doit être le master/);
    expect(refuse({ dynamicPrompt: true })).toThrow(/n'est pas dynamique/);
    expect(refuse({ masterPromptCode: 't1_master_v2', promptCode: 't1_master_v2' })).toThrow(/un seul prompt maître/);
  });
});

describe('opérations T3 master (CDC 15 §25, lot 13 ; seules depuis le lot 16b-3)', () => {
  it('t3_value_conflict : mêmes modèles et facturation que l’ancien resolve_ambiguity, TASK=VALUE_CONFLICT', () => {
    expect(getOperation('t3_value_conflict')).toMatchObject({
      useCaseCode: 'DATA_RECONCILIATION', promptCode: 't3_master_v1', masterPromptCode: 't3_master_v1',
      task: 'VALUE_CONFLICT', billable: true, primaryModel: 'gemini-3.1-flash-lite',
      fallbackModels: ['gemini-3.5-flash', 'gemini-2.5-pro'], timeoutMs: 30_000,
      outputSchema: 'T3ValueConflictOutput', active: true,
    });
  });

  it('t3_link_ambiguity : mêmes modèles et facturation que l’ancien reconcile_links, TASK=LINK_AMBIGUITY', () => {
    expect(getOperation('t3_link_ambiguity')).toMatchObject({
      useCaseCode: 'DATA_RECONCILIATION', promptCode: 't3_master_v1', masterPromptCode: 't3_master_v1',
      task: 'LINK_AMBIGUITY', billable: false, primaryModel: 'gemini-3.1-flash-lite', timeoutMs: 30_000,
      outputSchema: 'T3LinkAmbiguityOutput', active: true,
    });
  });

  it('étapes et relais T3 retirés : seules les branches du master appellent un modèle (disjoncteur : t3_value_conflict)', () => {
    for (const c of ['resolve_ambiguity', 'reconcile_links', 'legacy_asset_suggest', 'legacy_apply_suggestions', 'legacy_enrich_coherence']) {
      expect(AI_OPERATIONS[c], c).toBeUndefined();
    }
    const actives = listOperationsByUseCase('DATA_RECONCILIATION').filter((o) => o.active && o.provider !== 'none');
    expect(actives.map((o) => o.operationCode)).toEqual(['t3_value_conflict', 't3_link_ambiguity']);
    for (const op of actives) expect(isMasterOperation(op), op.operationCode).toBe(true);
  });
});

describe('opérations T4 master (CDC 15 §26, lot 14 ; seules depuis le lot 16b-2)', () => {
  it('trois branches, famille de modèles documentaire, étapes historiques retirées', () => {
    // `t4_temporal_ambiguity` : active depuis le lot 18 (R5), appelée par T4.
    for (const [code, task, schema] of [
      ['t4_classify_event', 'CLASSIFY_EVENT', 'T4ClassifyEventOutput'],
      ['t4_verify_completion', 'VERIFY_COMPLETION', 'T4VerifyCompletionOutput'],
      ['t4_temporal_ambiguity', 'TEMPORAL_AMBIGUITY', 'T4TemporalAmbiguityOutput'],
    ] as const) {
      expect(getOperation(code)).toMatchObject({
        useCaseCode: 'AGENDA_INTELLIGENCE', promptCode: 't4_master_v1', masterPromptCode: 't4_master_v1', task,
        outputSchema: schema, primaryModel: getOperation('t4_classify_event').primaryModel, billable: false, active: true,
      });
    }
    for (const retire of ['classify_event', 'reconcile_status', 'legacy_classify_home_category']) {
      expect(AI_OPERATIONS[retire], retire).toBeUndefined();
    }
    const actives = listOperationsByUseCase('AGENDA_INTELLIGENCE').filter((o) => o.active && o.provider !== 'none');
    // Le disjoncteur sonde la première opération active : désormais le master.
    expect(actives[0].operationCode).toBe('t4_classify_event');
    for (const op of actives) expect(isMasterOperation(op), op.operationCode).toBe(true);
  });
});

describe('opérations T2 master (CDC 15 §24 ; seules depuis le lot 16b-2)', () => {
  it('trois branches, étapes historiques et relais de recherche retirés', () => {
    for (const retire of [
      'understand_request', 'generate_answer', 'generate_answer_canonical', 'revalidate_fact',
      'legacy_semantic_search', 'legacy_intelligent_search',
    ]) expect(AI_OPERATIONS[retire], retire).toBeUndefined();
    const actives = listOperationsByUseCase('INTELLIGENT_ASSISTANT').filter((o) => o.active && o.provider !== 'none');
    expect(actives.map((o) => o.operationCode)).toEqual(['t2_understand', 't2_answer', 't2_revalidate']);
    for (const op of actives) expect(op).toMatchObject({ masterPromptCode: 't2_master_v1', taskField: 'mode' });
  });
});

