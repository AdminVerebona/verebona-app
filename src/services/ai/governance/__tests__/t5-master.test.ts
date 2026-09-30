/**
 * CDC 15 lot 16 — T5 master (§27) et Prompt Control conscient des masters
 * (§29 étape 16, §29.1, MP-16, point 3 reporté du lot 12).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const getVersion = vi.fn();
const saveEntry = vi.fn(async (_p: Record<string, unknown>) => true);
const execute = vi.fn();
const recordT5Modification = vi.fn(async (_t: unknown) => {});

vi.mock('../../config/config-version.repository', () => ({
  getVersion: (id: unknown) => getVersion(id),
  getActiveVersion: vi.fn(), listVersions: vi.fn(), createDraft: vi.fn(),
  savePromptFieldIfUnchanged: (p: Record<string, unknown>) => saveEntry(p),
}));
vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: (req: unknown) => execute(req) } }));
vi.mock('../prompt-control.audit', () => ({ recordT5Modification: (t: unknown) => recordT5Modification(t) }));
vi.mock('../../queue/job-queue.repository', () => ({ getEmergencyStop: async () => ({ active: false, reason: null }) }));

const { analyze, modify, formatCurrentPrompts, targetTexts } = await import('../prompt-control.service');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { AI_OPERATIONS, operationDeprecation, listDeprecatedOperations } = await import('../../registry/operations');
const { inspectMasterTemplate, renderMasterPrompt } = await import('../../prompts/prompt-loader');
const { T5ModifyOutput, T5AnalyzeOutput } = await import('../master/t5-contract');
const { checkMasterProposal } = await import('../../config/prompt-architecture');

const racine = join(process.cwd(), 'src/services/ai/prompts');
const T1_MASTER = readFileSync(join(racine, 'source-analysis/t1_master_v1.txt'), 'utf8');
const T5_MASTER = readFileSync(join(racine, 'governance/t5_master_v1.txt'), 'utf8');

const entree = (treatment: string, over: Record<string, unknown> = {}) => ({
  ...emptyTreatmentConfig(treatment as never), prompt: `Préambule ${treatment}, assez long pour être un prompt administrable.`, ...over,
});
const version = (t1: Record<string, unknown> = {}) => ({
  id: 1, status: 'DRAFT', environment: 'preprod', label: null, isStale: false, createdAt: new Date(),
  entries: [entree('T1', t1), entree('T2'), entree('T3'), entree('T4'), entree('T5'), entree('T6')],
});
const t5Master = () => __setConfigForTests({ versionId: 16, entries: [{ ...emptyTreatmentConfig('T5'), promptArchitecture: 'master' }] });

beforeEach(() => { execute.mockReset(); saveEntry.mockClear(); recordT5Modification.mockClear(); getVersion.mockReset(); });
afterEach(() => __setConfigForTests(null));

describe('t5_master_v1 — contrat §27', () => {
  it('discriminant MODE, branches déclarées « Valeurs autorisées » (texte du CDC sans section ajoutée)', () => {
    const info = inspectMasterTemplate(T5_MASTER);
    expect(info).toMatchObject({ discriminant: 'MODE', branches: ['ANALYZE', 'MODIFY'] });
    expect(info.placeholders.filter((p) => p !== 'MODE').sort()).toEqual(['CURRENT_MASTER_PROMPTS', 'INSTRUCTION']);
    expect(T5_MASTER).toMatch(/Tu ne modifies JAMAIS T5 lui-même/);
    const rendu = renderMasterPrompt(T5_MASTER, {
      masterPromptCode: 't5_master_v1', task: 'MODIFY', allowedTasks: ['ANALYZE', 'MODIFY'],
      variables: { CURRENT_MASTER_PROMPTS: 'x', INSTRUCTION: 'y' },
    });
    expect(rendu).toContain('MODE = MODIFY');
  });

  it('opérations t5_* et migration des chemins historiques (analyze_instruction, control_prompts, propose_change)', () => {
    expect(AI_OPERATIONS.t5_analyze).toMatchObject({ masterPromptCode: 't5_master_v1', task: 'ANALYZE', taskField: 'mode', active: true });
    expect(AI_OPERATIONS.t5_modify).toMatchObject({ masterPromptCode: 't5_master_v1', task: 'MODIFY', taskField: 'mode', active: true });
    for (const op of ['analyze_instruction', 'control_prompts', 'propose_change']) {
      expect(AI_OPERATIONS[op].migratesTo).toMatchObject({ masterPromptCode: 't5_master_v1', operationCode: 't5_modify' });
      expect(operationDeprecation(AI_OPERATIONS[op])).toMatchObject({ reason: 'MIGRATED_TO_MASTER', replacedBy: 't5_modify' });
    }
  });

  it('sortie : cinq verdicts dont mixed ; mode discriminé', () => {
    const base = { verdict: 'mixed', analysis: 'a', targets: [] };
    expect(T5AnalyzeOutput.safeParse({ mode: 'ANALYZE', ...base }).success).toBe(true);
    expect(T5ModifyOutput.safeParse({ mode: 'ANALYZE', ...base }).success).toBe(false);
    expect(T5AnalyzeOutput.parse({ mode: 'ANALYZE', ...base })).toMatchObject({ requiredCodeChanges: [], requiredTests: [] });
  });
});

describe('dépréciation (D-02)', () => {
  it('étapes avec migratesTo et relais legacy_* : dépréciés ; masters et déterministes : non', () => {
    const codes = listDeprecatedOperations().map((o) => o.operationCode);
    expect(codes).toEqual(expect.arrayContaining(['extract_source', 'generate_answer', 'resolve_ambiguity', 'classify_event',
      'control_prompts', 'legacy_document_analysis', 'legacy_intelligent_search']));
    for (const c of ['t1_analyze_document', 't2_answer', 't5_modify', 'collect_evidence', 'evaluate_prompt']) expect(codes).not.toContain(c);
    expect(operationDeprecation(AI_OPERATIONS.legacy_asset_suggest)).toMatchObject({ reason: 'LEGACY_RELAY', replacedBy: null });
  });
});

describe('Prompt Control conscient des masters', () => {
  it('T1 en master : T5 lit le MASTER COMPLET (fichier du dépôt si vide), jamais le préambule', async () => {
    const v = version({ promptArchitecture: 'master', masterPrompt: null });
    const texts = await targetTexts(v as never);
    expect(texts.get('T1')).toMatchObject({ field: 'masterPrompt', fromFile: true, masterPromptCode: 't1_master_v1' });
    expect(texts.get('T2')).toMatchObject({ field: 'prompt' });
    const txt = formatCurrentPrompts(v as never, texts);
    expect(txt).toContain('PROMPT MAÎTRE t1_master_v1 (branches TASK : GROUP_UPLOAD, ANALYZE_DOCUMENT)');
    expect(txt).toContain(T1_MASTER.trim().slice(0, 200));
    expect(txt).not.toContain('Préambule T1');
    expect(txt).not.toMatch(/T5/);
  });

  it('MODIFY : master complet valide écrit dans `masterPrompt` ; préambule intact ; diff master → master', async () => {
    getVersion.mockResolvedValue(version({ promptArchitecture: 'master', masterPrompt: null }));
    const nouveau = `${T1_MASTER}\n\nRÈGLE AJOUTÉE — titre par type de document.`;
    execute.mockResolvedValue({ data: {
      verdict: 'prompt', analysis: 'Règle de titre absente.', risks: [], recommendations: [],
      targets: [{ treatment: 'T1', reason: 'titre', proposedContent: nouveau }],
    }, traceId: 't' });
    const r = await modify({ versionId: 1, instruction: 'titres', accountId: 1, userId: 7 });
    expect(r.changes[0]).toMatchObject({ treatment: 'T1', applied: true, field: 'masterPrompt' });
    // Seule la zone master est écrite, conditionnellement (fichier du dépôt : valeur lue null).
    expect(saveEntry).toHaveBeenCalledWith({ versionId: 1, treatment: 'T1', field: 'masterPrompt', expected: null, next: nouveau, userId: 7 });
    expect(recordT5Modification).toHaveBeenCalledWith(expect.objectContaining({ before: T1_MASTER, field: 'masterPrompt' }));
    expect(r.changes[0].diff?.identical).toBe(false);
  });

  it('MODIFY : master incomplet (branche ou emplacement perdu) refusé, rien écrit', async () => {
    getVersion.mockResolvedValue(version({ promptArchitecture: 'master', masterPrompt: null }));
    const casse = T1_MASTER.replace(/BRANCHE TASK = GROUP_UPLOAD/g, 'SECTION').replace(/\{\{DOCUMENT_CATALOG\}\}/g, '');
    expect(checkMasterProposal('T1', casse).length).toBeGreaterThan(0);
    execute.mockResolvedValue({ data: {
      verdict: 'prompt', analysis: 'a', risks: [], recommendations: [],
      targets: [{ treatment: 'T1', reason: 'r', proposedContent: casse }],
    }, traceId: 't' });
    const r = await modify({ versionId: 1, instruction: 'x', accountId: 1, userId: 7 });
    expect(saveEntry).not.toHaveBeenCalled();
    expect(r.changes[0].rejected).toMatch(/Prompt maître proposé incomplet/);
  });

  it('T5 en master : t5_modify, variables du §27, contexte complémentaire dans INSTRUCTION ; mixed ⇒ rien écrit', async () => {
    t5Master();
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue({ data: {
      mode: 'MODIFY', verdict: 'mixed', analysis: 'Prompt et code.', targets: [{ treatment: 'T1', reason: 'r', proposedContent: `${'x'.repeat(80)}` }],
      requiredCodeChanges: ['corriger le rattachement'], requiredSchemaChanges: [], configurationRecommendations: ['repli'], risks: [], requiredTests: ['P-T1-02'],
    }, traceId: 't' });
    const r = await modify({ versionId: 1, instruction: 'demande', accountId: 1, userId: 7 });
    const req = execute.mock.calls[0][0] as { operationCode: string; promptVariables: Record<string, string> };
    expect(req.operationCode).toBe('t5_modify');
    expect(Object.keys(req.promptVariables).sort()).toEqual(['CURRENT_MASTER_PROMPTS', 'INSTRUCTION']);
    expect(saveEntry).not.toHaveBeenCalled();
    expect(r).toMatchObject({ verdict: 'mixed', architecture: 'master', requiredCodeChanges: ['corriger le rattachement'], recommendations: ['repli'] });
  });

  it('T5 en master, ANALYZE : t5_analyze ; en steps : control_prompts inchangé', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue({ data: { verdict: 'code', analysis: 'code', targets: [], risks: [], recommendations: [] }, traceId: 't' });
    await analyze(1, 'demande', 1, 7);
    expect((execute.mock.calls[0][0] as { operationCode: string }).operationCode).toBe('control_prompts');
    t5Master();
    execute.mockResolvedValue({ data: { mode: 'ANALYZE', verdict: 'code', analysis: 'code', targets: [],
      requiredCodeChanges: [], requiredSchemaChanges: [], configurationRecommendations: [], risks: [], requiredTests: [] }, traceId: 't' });
    const r = await analyze(1, 'demande', 1, 7);
    expect((execute.mock.calls[1][0] as { operationCode: string }).operationCode).toBe('t5_analyze');
    expect(r.architecture).toBe('master');
  });
});
