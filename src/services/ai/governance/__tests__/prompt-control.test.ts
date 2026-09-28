/**
 * CDC BO IA SCR-06, WF-20, WF-39, T5-001 à T5-015 — Prompt Control.
 *
 * Une demande en langage naturel, sans traitement désigné : T5 choisit lui-même
 * le ou les prompts à faire évoluer. Les interdits sont tenus par le serveur,
 * quelle que soit la sortie du modèle — ces tests le vérifient.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getVersion = vi.fn();
const getActiveVersion = vi.fn();
const listVersions = vi.fn();
const createDraft = vi.fn();
const saveEntry = vi.fn(async (_v: unknown, _e: unknown, _u: unknown) => {});
const execute = vi.fn();
const recordT5Modification = vi.fn(async (_t: unknown) => {});
const getEmergencyStop = vi.fn(async (): Promise<{ active: boolean; reason: string | null; engagedAt: Date | null }> =>
  ({ active: false, reason: null, engagedAt: null }));

vi.mock('../../config/config-version.repository', () => ({
  getVersion: (id: unknown) => getVersion(id),
  getActiveVersion: (env: unknown) => getActiveVersion(env),
  listVersions: (env: unknown) => listVersions(env),
  createDraft: (u: unknown, l: unknown) => createDraft(u, l),
  saveEntry: (a: unknown, b: unknown, c: unknown) => saveEntry(a, b, c),
}));
vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: (req: unknown) => execute(req) } }));
vi.mock('../prompt-control.audit', () => ({ recordT5Modification: (t: unknown) => recordT5Modification(t) }));
vi.mock('../../queue/job-queue.repository', () => ({ getEmergencyStop: () => getEmergencyStop() }));

const { analyze, modify, interpret, resolveWriteTarget, formatCurrentPrompts, VERDICTS } =
  await import('../prompt-control.service');
const { AI_OPERATIONS } = await import('../../registry/operations');

const P = (t: string) => `Prompt ${t} actuel, suffisamment long pour être un vrai prompt de travail administrable.`;
const NEW = (t: string) => `Prompt ${t} réécrit : nommer chaque document par son type et ce qu'il concerne, sans numéro.`;

const entree = (treatment: string, prompt = P(treatment)) => ({
  treatment, prompt, primaryModel: 'm1', fallback1: 'm2', guardrails: [{ code: 'g' }], triggers: [],
});
const version = (over: Record<string, unknown> = {}) => ({
  id: 1, status: 'DRAFT', environment: 'preprod', label: null, isStale: false,
  createdAt: new Date('2026-09-20T10:00:00Z'),
  entries: ['T1', 'T2', 'T3', 'T4', 'T5'].map((t) => entree(t)),
  ...over,
});
const sortie = (over: Record<string, unknown> = {}) => ({
  data: {
    verdict: 'prompt',
    analysis: 'Les titres reprennent le numéro de facture : T1 ne donne aucune règle de nommage.',
    targets: [{ treatment: 'T1', reason: 'Aucune règle de titre.', proposedContent: NEW('T1') }],
    risks: [], recommendations: [],
    ...over,
  },
  traceId: 'trace-1',
});
const demande = (over: Record<string, unknown> = {}) => ({
  versionId: 1, instruction: 'Les titres de factures ne se distinguent pas.', accountId: 99, userId: 7, ...over,
});

beforeEach(() => {
  for (const m of [getVersion, getActiveVersion, listVersions, createDraft, execute]) m.mockReset();
  saveEntry.mockClear();
  recordT5Modification.mockClear();
  getEmergencyStop.mockResolvedValue({ active: false, reason: null, engagedAt: null });
});
afterEach(() => vi.restoreAllMocks());

describe('opération dédiée', () => {
  it('utilise control_prompts, avec son propre prompt et un plancher de tokens', () => {
    const op = AI_OPERATIONS.control_prompts;
    expect(op.promptCode).toBe('prompt_control_v2');
    expect(op.useCaseCode).toBe('AI_GOVERNANCE');
    expect(op.minOutputTokens).toBeGreaterThanOrEqual(16_000);
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
    execute.mockResolvedValue(sortie({ targets: [
      { treatment: 'T1', reason: 'titre', proposedContent: NEW('T1') },
      { treatment: 'T2', reason: 'citation', proposedContent: NEW('T2') },
    ] }));
    const r = await modify(demande());
    expect(saveEntry).toHaveBeenCalledTimes(2);
    expect(r.changes.map((c) => [c.treatment, c.applied])).toEqual([['T1', true], ['T2', true]]);
    expect(r).toMatchObject({ applied: true, draftId: 1, mode: 'modify' });
    expect(execute.mock.calls[0][0]).toMatchObject({ operationCode: 'control_prompts' });
    expect(execute.mock.calls[0][0].promptVariables.MODE).toMatch(/^MODIFICATION/);
  });

  it('T5-002 — écarte une cible T5 ou inconnue rendue par le modèle', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie({ targets: [
      { treatment: 'T5', reason: 'moi-même', proposedContent: NEW('T5') },
      { treatment: 'T9', reason: '?', proposedContent: NEW('T9') },
      { treatment: 't3', reason: 'casse', proposedContent: NEW('T3') },
    ] }));
    const r = await modify(demande());
    expect(r.changes.map((c) => c.treatment)).toEqual(['T3']);
    expect(saveEntry).toHaveBeenCalledTimes(1);
  });

  it('T5-001 — ne change que le prompt', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    await modify(demande());
    const ecrit = saveEntry.mock.calls[0][1] as Record<string, unknown>;
    expect(ecrit).toMatchObject({ primaryModel: 'm1', fallback1: 'm2', guardrails: [{ code: 'g' }], prompt: NEW('T1') });
  });

  it('T5-014 — trace chaque modification', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    await modify(demande());
    expect(recordT5Modification).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T1', before: P('T1'), after: NEW('T1'), traceId: 'trace-1', versionId: 1,
    }));
  });
});

describe('analyse seule (T5-006)', () => {
  it('n’écrit rien et ne crée aucun brouillon, même si le modèle propose des textes', async () => {
    getVersion.mockResolvedValue(version({ status: 'ACTIVE' }));
    execute.mockResolvedValue(sortie());
    const r = await analyze(1, 'Pourquoi ces titres ?', 99, 7);
    expect(r.applied).toBe(false);
    expect(r.changes).toEqual([expect.objectContaining({ treatment: 'T1', applied: false, diff: null })]);
    expect(saveEntry).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][0].promptVariables.MODE).toMatch(/^ANALYSE/);
  });
});

describe('diagnostic non-prompt (T5-011, WF-39)', () => {
  it.each(['code', 'donnees', 'configuration'] as const)('verdict « %s » : rien n’est écrit', async (verdict) => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie({ verdict }));
    const r = await modify(demande());
    expect(r.applied).toBe(false);
    expect(saveEntry).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(version({ entries: [entree('T1', 'Texte enregistré entre-temps par un autre administrateur.')] }));
    execute.mockResolvedValue(sortie());
    const r = await modify(demande());
    expect(saveEntry).not.toHaveBeenCalled();
    expect(r.changes[0].rejected).toMatch(/modifié pendant l'analyse/);
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
  it('quatre causes', () => {
    expect([...VERDICTS]).toEqual(['prompt', 'code', 'donnees', 'configuration']);
  });
});
