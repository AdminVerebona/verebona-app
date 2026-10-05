/**
 * CDC BO IA SCR-06, WF-20, WF-39, T5-001 à T5-015 — Prompt Control.
 *
 * Une demande en langage naturel, sans traitement désigné : T5 choisit lui-même
 * le ou les prompts à faire évoluer. Les interdits sont tenus par le serveur,
 * quelle que soit la sortie du modèle — ces tests le vérifient.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const getVersion = vi.fn();
const getActiveVersion = vi.fn();
const listVersions = vi.fn();
const createDraft = vi.fn();
const savePrompt = vi.fn(async (_p: Record<string, unknown>) => true);
const execute = vi.fn();
const recordT5Modification = vi.fn(async (_t: unknown) => {});
const getEmergencyStop = vi.fn(async (): Promise<{ active: boolean; reason: string | null; engagedAt: Date | null }> =>
  ({ active: false, reason: null, engagedAt: null }));

vi.mock('../../config/config-version.repository', () => ({
  getVersion: (id: unknown) => getVersion(id),
  getActiveVersion: (env: unknown) => getActiveVersion(env),
  listVersions: (env: unknown) => listVersions(env),
  createDraft: (u: unknown, l: unknown) => createDraft(u, l),
  savePromptFieldIfUnchanged: (p: Record<string, unknown>) => savePrompt(p),
}));
vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: (req: unknown) => execute(req) } }));
vi.mock('../prompt-control.audit', () => ({ recordT5Modification: (t: unknown) => recordT5Modification(t) }));
vi.mock('../../queue/job-queue.repository', () => ({ getEmergencyStop: () => getEmergencyStop() }));

const { analyze, modify, interpret, resolveWriteTarget, formatCurrentPrompts, VERDICTS } =
  await import('../prompt-control.service');
const { AI_OPERATIONS } = await import('../../registry/operations');

const P = (t: string) => `Prompt ${t} actuel, suffisamment long pour être un vrai prompt de travail administrable.`;
const NEW = (t: string) => `Prompt ${t} réécrit : nommer chaque document par son type et ce qu'il concerne, sans numéro.`;

const entree = (treatment: string, prompt = P(treatment), masterPrompt: string | null = null) => ({
  treatment, prompt, masterPrompt, primaryModel: 'm1', fallback1: 'm2', guardrails: [{ code: 'g' }], triggers: [],
});
// Lot 16b-3 : T3 est master seul — T5 réécrit le master COMPLET (fichier du
// dépôt présenté quand la version n'a pas de texte master).
const FICHIER_T3 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
const MASTER_T3 = `${FICHIER_T3}\nRègle ajoutée : citer le titre du document arbitré.`;
const version = (over: Record<string, unknown> = {}) => ({
  id: 1, status: 'DRAFT', environment: 'preprod', label: null, isStale: false,
  createdAt: new Date('2026-09-20T10:00:00Z'),
  entries: ['T1', 'T2', 'T3', 'T4', 'T5'].map((t) => entree(t)),
  ...over,
});
// Sortie du master T5 (§27) — seul moteur de Prompt Control depuis le lot 16b.
const sortie = (over: Record<string, unknown> = {}) => ({
  data: {
    mode: 'MODIFY',
    verdict: 'prompt',
    analysis: 'Les titres reprennent le numéro de facture : T1 ne donne aucune règle de nommage.',
    // Lot 16b-3 : tous les traitements sont master — la cible est le master complet.
    targets: [{ treatment: 'T3', reason: 'Aucune règle de titre.', proposedContent: MASTER_T3 }],
    requiredCodeChanges: [], requiredSchemaChanges: [], configurationRecommendations: [], risks: [], requiredTests: [],
    ...over,
  },
  traceId: 'trace-1',
});
const demande = (over: Record<string, unknown> = {}) => ({
  versionId: 1, instruction: 'Les titres de factures ne se distinguent pas.', accountId: 99, userId: 7, ...over,
});

beforeEach(() => {
  for (const m of [getVersion, getActiveVersion, listVersions, createDraft, execute]) m.mockReset();
  savePrompt.mockClear();
  recordT5Modification.mockClear();
  getEmergencyStop.mockResolvedValue({ active: false, reason: null, engagedAt: null });
});
afterEach(() => vi.restoreAllMocks());

describe('opération dédiée', () => {
  it('utilise t5_modify (master T5), avec un plancher de tokens ; les opérations d’étapes sont retirées', () => {
    const op = AI_OPERATIONS.t5_modify;
    expect(op.promptCode).toBe('t5_master_v1');
    expect(op.useCaseCode).toBe('AI_GOVERNANCE');
    expect(op.minOutputTokens).toBeGreaterThanOrEqual(16_000);
    for (const retiree of ['analyze_instruction', 'control_prompts', 'propose_change']) expect(AI_OPERATIONS[retiree]).toBeUndefined();
  });

  it('présente au modèle les quatre prompts administrables, jamais celui de T5', () => {
    const txt = formatCurrentPrompts(version() as never);
    for (const t of ['T1', 'T2', 'T3', 'T4']) expect(txt).toContain(P(t));
    expect(txt).not.toContain(P('T5'));
  });
});

describe('T5 choisit les cibles', () => {
  it('écrit chaque prompt proposé, un ou plusieurs', async () => {
    getVersion.mockResolvedValue(version());
    // Lot 16b-3 : T1 et T3 master seul — master COMPLET proposé pour chacun.
    const masterT1 = `${readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8')}\nRègle ajoutée.`;
    execute.mockResolvedValue(sortie({ targets: [
      { treatment: 'T1', reason: 'titre', proposedContent: masterT1 },
      { treatment: 'T3', reason: 'citation', proposedContent: MASTER_T3 },
    ] }));
    const r = await modify(demande());
    expect(savePrompt).toHaveBeenCalledTimes(2);
    expect(savePrompt).toHaveBeenCalledWith(expect.objectContaining({ treatment: 'T3', field: 'masterPrompt', next: MASTER_T3 }));
    expect(savePrompt).toHaveBeenCalledWith(expect.objectContaining({ treatment: 'T1', field: 'masterPrompt', next: masterT1 }));
    expect(r.changes.map((c) => [c.treatment, c.applied])).toEqual([['T1', true], ['T3', true]]);
    expect(r).toMatchObject({ applied: true, draftId: 1, mode: 'modify' });
    expect(execute.mock.calls[0][0]).toMatchObject({ operationCode: 't5_modify' });
    expect(Object.keys(execute.mock.calls[0][0].promptVariables).sort()).toEqual(['CURRENT_MASTER_PROMPTS', 'INSTRUCTION']);
  });

  it('T5-002 — écarte une cible T5 ou inconnue rendue par le modèle', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie({ targets: [
      { treatment: 'T5', reason: 'moi-même', proposedContent: NEW('T5') },
      { treatment: 'T9', reason: '?', proposedContent: NEW('T9') },
      { treatment: 't3', reason: 'casse', proposedContent: MASTER_T3 },
    ] }));
    const r = await modify(demande());
    expect(r.changes.map((c) => c.treatment)).toEqual(['T3']);
    expect(savePrompt).toHaveBeenCalledTimes(1);
  });

  it('T5-001 — ne change que le prompt', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    await modify(demande());
    // Écriture conditionnelle de la SEULE zone prompt (revue lot 16) :
    // modèles, replis et garde-fous ne font pas partie de l'écriture.
    expect(savePrompt).toHaveBeenCalledWith({
      versionId: 1, treatment: 'T3', field: 'masterPrompt', expected: null, next: MASTER_T3, userId: 7,
    });
  });

  it('T5-014 — trace chaque modification', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    await modify(demande());
    expect(recordT5Modification).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T3', before: FICHIER_T3, after: MASTER_T3, traceId: 'trace-1', versionId: 1, field: 'masterPrompt',
    }));
  });
});

describe('analyse seule (T5-006)', () => {
  it('n’écrit rien et ne crée aucun brouillon, même si le modèle propose des textes', async () => {
    getVersion.mockResolvedValue(version({ status: 'ACTIVE' }));
    execute.mockResolvedValue(sortie());
    const r = await analyze(1, 'Pourquoi ces titres ?', 99, 7);
    expect(r.applied).toBe(false);
    expect(r.changes).toEqual([expect.objectContaining({ treatment: 'T3', applied: false, diff: null })]);
    expect(savePrompt).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][0]).toMatchObject({ operationCode: 't5_analyze' });
  });
});

describe('diagnostic non-prompt (T5-011, WF-39)', () => {
  it.each(['code', 'donnees', 'configuration'] as const)('verdict « %s » : rien n’est écrit', async (verdict) => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie({ verdict }));
    const r = await modify(demande());
    expect(r.applied).toBe(false);
    expect(savePrompt).not.toHaveBeenCalled();
  });

  it('n’écrit pas une proposition identique ou trop courte', () => {
    const r = interpret('modify', {
      verdict: 'prompt', analysis: 'x', risks: [], recommendations: [],
      targets: [
        { treatment: 'T1', reason: '', proposedContent: P('T1') },
        { treatment: 'T2', reason: '', proposedContent: 'court' },
      ],
    }, (t) => P(t));
    expect(r.changes.map((c) => [c.treatment, c.proposedContent, Boolean(c.rejected)])).toEqual([
      ['T1', null, true], ['T2', null, true],
    ]);
  });
});

describe('brouillon (T5-004, T5-007)', () => {
  it('crée un brouillon depuis l’Active quand aucun n’existe, seulement s’il y a quelque chose à écrire', async () => {
    const active = version({ id: 5, status: 'ACTIVE' });
    const cree = version({ id: 6 });
    getVersion.mockImplementation(async (id: number) => (id === 5 ? active : cree));
    getActiveVersion.mockResolvedValue(active);
    listVersions.mockResolvedValue([active]);
    createDraft.mockResolvedValue(cree);

    execute.mockResolvedValue(sortie({ verdict: 'code', targets: [] }));
    await modify(demande({ versionId: 5 }));
    expect(createDraft).not.toHaveBeenCalled();

    execute.mockResolvedValue(sortie());
    const r = await modify(demande({ versionId: 5 }));
    expect(createDraft).toHaveBeenCalledWith(7, 'Prompt Control');
    expect(r).toMatchObject({ applied: true, draftId: 6, draftCreated: true });
  });

  it('ne choisit jamais un brouillon existant à la place de l’administrateur', async () => {
    const active = version({ id: 5, status: 'ACTIVE' });
    getVersion.mockResolvedValue(active);
    getActiveVersion.mockResolvedValue(active);
    listVersions.mockResolvedValue([active, version({ id: 8, label: 'lot agenda' })]);
    await expect(resolveWriteTarget(5, false)).rejects.toMatchObject({ code: 'DRAFT_SELECTION_REQUIRED' });
    await expect(resolveWriteTarget(5, true)).resolves.toMatchObject({ kind: 'create' });
  });

  it('n’écrase pas un prompt modifié pendant l’appel modèle', async () => {
    getVersion
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce(version({ entries: [entree('T3', P('T3'), 'Texte master enregistré entre-temps par un autre administrateur.')] }));
    execute.mockResolvedValue(sortie());
    const r = await modify(demande());
    expect(savePrompt).not.toHaveBeenCalled();
    expect(r.changes[0].rejected).toMatch(/modifié pendant l'analyse/);
  });

  it('revue lot 16 — écriture concurrente APRÈS la relecture : 0 ligne, conflit explicite, rien écrasé', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    savePrompt.mockResolvedValueOnce(false);
    const r = await modify(demande());
    expect(r.applied).toBe(false);
    expect(r.changes[0].rejected).toMatch(/^Conflit/);
    expect(recordT5Modification).not.toHaveBeenCalled();
  });
});

describe('disponibilité (T5-015)', () => {
  it('refuse pendant l’arrêt d’urgence, sans appel modèle', async () => {
    getEmergencyStop.mockResolvedValue({ active: true, reason: 'incident', engagedAt: null });
    await expect(analyze(1, 'x'.repeat(10), 99, 7)).rejects.toMatchObject({ code: 'AI_BLOCKED' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('verdicts', () => {
  it('quatre causes, plus « mixed » (CDC 15 §27 R1, lot 16)', () => {
    expect([...VERDICTS]).toEqual(['prompt', 'code', 'donnees', 'configuration', 'mixed']);
  });
});
