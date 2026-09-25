/**
 * CDC BO IA SCR-06, WF-20, WF-39, T5-001 à T5-015 — Prompt Control.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CES TESTS PROTÈGENT
 *
 * T5 reçoit une demande en langage naturel et réécrit des prompts. Ses
 * interdits ne peuvent pas reposer sur une consigne écrite dans un prompt :
 * un modèle à qui l'on demande de ne pas se modifier lui-même finira un jour
 * par le faire. Ils sont donc tenus par le serveur, et ces tests vérifient
 * qu'ils refusent quelle que soit la sortie du modèle.
 *
 * Ils verrouillent aussi l'écart E-01 : une demande de modification s'écrit
 * directement dans le Brouillon, en un seul geste ; une analyse n'écrit rien.
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
vi.mock('../../gateway/ai-gateway', () => ({
  AiGateway: { execute: (req: unknown) => execute(req) },
}));
vi.mock('../prompt-control.audit', () => ({
  recordT5Modification: (t: unknown) => recordT5Modification(t),
}));
vi.mock('../../queue/job-queue.repository', () => ({
  getEmergencyStop: () => getEmergencyStop(),
}));

const {
  assertTarget, analyze, modify, interpret, resolveWriteTarget, T5Refused, VERDICTS,
} = await import('../prompt-control.service');

const PROMPT_ACTUEL = 'Prompt T1 actuel, suffisamment long pour être un vrai prompt de travail.';
const PROMPT_NOUVEAU = 'Prompt T1 réécrit : extrais aussi les numéros de série en pied de facture.';

const entree = (treatment: string, prompt = PROMPT_ACTUEL) => ({
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
    analysis: 'Le prompt ne mentionne pas le pied de facture : les numéros de série y sont ignorés.',
    proposedContent: PROMPT_NOUVEAU,
    risks: [],
    recommendations: [],
    ...over,
  },
  traceId: 'trace-1',
});

const demande = (over: Record<string, unknown> = {}) => ({
  versionId: 1, treatment: 'T1', instruction: 'Les numéros de série ne sont pas extraits.',
  accountId: 99, userId: 7, ...over,
});

beforeEach(() => {
  for (const m of [getVersion, getActiveVersion, listVersions, createDraft, execute]) m.mockReset();
  saveEntry.mockClear();
  recordT5Modification.mockClear();
  getEmergencyStop.mockReset();
  getEmergencyStop.mockResolvedValue({ active: false, reason: null, engagedAt: null });
});
afterEach(() => vi.restoreAllMocks());

// ── Cibles ──────────────────────────────────────────────────────────────────

describe('T5-002 — Prompt Control ne se modifie pas lui-même', () => {
  it('refuse la cible T5, avant tout appel modèle', async () => {
    expect(() => assertTarget('T5')).toThrow(T5Refused);
    await expect(modify(demande({ treatment: 'T5' }))).rejects.toThrow(/T5-002/);
    await expect(analyze(1, 'T5', 'x'.repeat(10), 99, 7)).rejects.toThrow(T5Refused);
    expect(execute).not.toHaveBeenCalled();
    expect(saveEntry).not.toHaveBeenCalled();
  });

  it('accepte T1 à T4, refuse un traitement inconnu', () => {
    for (const t of ['T1', 'T2', 'T3', 'T4']) expect(assertTarget(t), t).toBe(t);
    expect(() => assertTarget('T9')).toThrow(/inconnu/);
    expect(() => assertTarget('T2 ')).toThrow(T5Refused);
  });
});

describe('T5-015 — IA bloquée', () => {
  it("refuse d'opérer pendant l'arrêt d'urgence, sans appel modèle", async () => {
    getEmergencyStop.mockResolvedValue({ active: true, reason: 'incident fournisseur', engagedAt: null });
    await expect(analyze(1, 'T1', 'x'.repeat(10), 99, 7)).rejects.toMatchObject({ code: 'AI_BLOCKED' });
    await expect(modify(demande())).rejects.toMatchObject({ code: 'AI_BLOCKED' });
    expect(execute).not.toHaveBeenCalled();
  });
});

// ── Analyse seule ───────────────────────────────────────────────────────────

describe('T5-006 — une analyse ne modifie rien', () => {
  it("n'écrit rien et ne crée aucun brouillon, même si le modèle propose un texte", async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());

    const r = await analyze(1, 'T1', 'Pourquoi les numéros de série manquent ?', 99, 7);

    expect(r.mode).toBe('analyze');
    expect(r.applied).toBe(false);
    expect(r.proposedContent).toBeNull();
    expect(saveEntry).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("est possible sur l'Active : comprendre ce qui tourne n'engage aucune écriture", async () => {
    getVersion.mockResolvedValue(version({ status: 'ACTIVE' }));
    execute.mockResolvedValue(sortie({ proposedContent: null }));
    await expect(analyze(1, 'T1', 'Pourquoi ?', 99, 7)).resolves.toMatchObject({ applied: false });
  });

  it('transmet au modèle le mode et le prompt de la version affichée', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie({ proposedContent: null }));
    await analyze(1, 'T2', 'Le ton est trop sec.', 99, 7);

    const vars = execute.mock.calls[0][0].promptVariables;
    expect(vars.MODE).toMatch(/^ANALYSE/);
    expect(vars.CURRENT_CONTENT).toBe(PROMPT_ACTUEL);
    expect(vars.INSTRUCTION).toBe('Le ton est trop sec.');
    expect(vars.PROMPT_CODE).toMatch(/socle commun/);
  });
});

// ── Modification en un geste ────────────────────────────────────────────────

describe('T5-005, E-01 — une demande de modification écrit directement dans le brouillon', () => {
  it('écrit le prompt réécrit et rend le diff, en un seul appel', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());

    const r = await modify(demande());

    expect(execute.mock.calls[0][0].promptVariables.MODE).toMatch(/^MODIFICATION/);
    expect(saveEntry).toHaveBeenCalledTimes(1);
    expect(saveEntry.mock.calls[0][0]).toBe(1);
    expect((saveEntry.mock.calls[0][1] as { prompt: string }).prompt).toBe(PROMPT_NOUVEAU);
    expect(r).toMatchObject({ applied: true, draftId: 1, draftCreated: false, mode: 'modify' });
    expect(r.diff?.identical).toBe(false);
    expect(r.diff?.added).toBeGreaterThan(0);
  });

  it('T5-001 — ne change que le prompt : modèles et garde-fous restent', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    await modify(demande());

    const ecrit = saveEntry.mock.calls[0][1] as Record<string, unknown>;
    expect(ecrit.primaryModel).toBe('m1');
    expect(ecrit.fallback1).toBe('m2');
    expect(ecrit.guardrails).toEqual([{ code: 'g' }]);
  });

  it('T5-014 — trace instruction, cible, avant/après, brouillon et exécution', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    await modify(demande());

    expect(recordT5Modification).toHaveBeenCalledWith(expect.objectContaining({
      adminUserId: 7,
      instruction: 'Les numéros de série ne sont pas extraits.',
      treatment: 'T1',
      versionId: 1,
      before: PROMPT_ACTUEL,
      after: PROMPT_NOUVEAU,
      traceId: 'trace-1',
    }));
  });

  it("un échec du journal ne défait pas l'écriture", async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie());
    recordT5Modification.mockRejectedValueOnce(new Error('base indisponible'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(modify(demande())).resolves.toMatchObject({ applied: true });
  });
});

describe('T5-011, WF-39 — diagnostic non-prompt : aucune fausse correction', () => {
  it.each(['code', 'donnees', 'configuration'] as const)(
    'verdict « %s » : rien n’est écrit, même si le modèle propose un texte',
    async (verdict) => {
      getVersion.mockResolvedValue(version());
      execute.mockResolvedValue(sortie({ verdict }));

      const r = await modify(demande());

      expect(r.applied).toBe(false);
      expect(r.proposedContent).toBeNull();
      expect(r.rejected).toMatch(/pas en cause/);
      expect(saveEntry).not.toHaveBeenCalled();
    },
  );

  it('T5-012 — les recommandations sont rendues, jamais appliquées', async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie({
      verdict: 'configuration', proposedContent: null,
      recommendations: ['Passer T1 sur un modèle plus récent'],
    }));
    const r = await modify(demande());
    expect(r.recommendations).toEqual(['Passer T1 sur un modèle plus récent']);
    expect(saveEntry).not.toHaveBeenCalled();
  });

  it("n'écrit pas une proposition identique au prompt actuel", async () => {
    getVersion.mockResolvedValue(version());
    execute.mockResolvedValue(sortie({ proposedContent: PROMPT_ACTUEL }));
    const r = await modify(demande());
    expect(r.applied).toBe(false);
    expect(saveEntry).not.toHaveBeenCalled();
  });
});

// ── Choix du brouillon ──────────────────────────────────────────────────────

describe('T5-004, T5-007 — dans quel brouillon écrire', () => {
  it("crée un brouillon depuis l'Active quand aucun n'existe", async () => {
    const active = version({ id: 5, status: 'ACTIVE' });
    const cree = version({ id: 6, status: 'DRAFT' });
    getVersion.mockImplementation(async (id: number) => (id === 5 ? active : id === 6 ? cree : null));
    getActiveVersion.mockResolvedValue(active);
    listVersions.mockResolvedValue([active]);
    createDraft.mockResolvedValue(cree);
    execute.mockResolvedValue(sortie());

    const r = await modify(demande({ versionId: 5 }));

    expect(createDraft).toHaveBeenCalledWith(7, 'Prompt Control — T1');
    expect(saveEntry.mock.calls[0][0]).toBe(6);
    expect(r).toMatchObject({ applied: true, draftId: 6, draftCreated: true });
  });

  it("ne crée pas de brouillon si le prompt n'est pas en cause", async () => {
    const active = version({ id: 5, status: 'ACTIVE' });
    getVersion.mockResolvedValue(active);
    getActiveVersion.mockResolvedValue(active);
    listVersions.mockResolvedValue([active]);
    execute.mockResolvedValue(sortie({ verdict: 'code', proposedContent: null }));

    await modify(demande({ versionId: 5 }));
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('ne choisit jamais un brouillon existant à la place de l’administrateur', async () => {
    const active = version({ id: 5, status: 'ACTIVE' });
    getVersion.mockResolvedValue(active);
    getActiveVersion.mockResolvedValue(active);
    listVersions.mockResolvedValue([active, version({ id: 8, label: 'lot agenda' })]);

    await expect(resolveWriteTarget(5, false)).rejects.toMatchObject({
      code: 'DRAFT_SELECTION_REQUIRED',
      details: { drafts: [expect.objectContaining({ id: 8, label: 'lot agenda' })] },
    });
    await expect(modify(demande({ versionId: 5 }))).rejects.toMatchObject({ code: 'DRAFT_SELECTION_REQUIRED' });
    expect(execute).not.toHaveBeenCalled();
    expect(saveEntry).not.toHaveBeenCalled();
  });

  it("crée un nouveau brouillon quand l'administrateur le demande, même si d'autres existent", async () => {
    const active = version({ id: 5, status: 'ACTIVE' });
    getVersion.mockResolvedValue(active);
    getActiveVersion.mockResolvedValue(active);
    listVersions.mockResolvedValue([active, version({ id: 8 })]);
    await expect(resolveWriteTarget(5, true)).resolves.toMatchObject({ kind: 'create' });
  });

  it('écrit dans le brouillon affiché : c’est le contexte', async () => {
    getVersion.mockResolvedValue(version({ id: 3 }));
    await expect(resolveWriteTarget(3, false)).resolves.toMatchObject({ kind: 'existing' });
    expect(listVersions).not.toHaveBeenCalled();
  });

  it('refuse une version introuvable', async () => {
    getVersion.mockResolvedValue(null);
    await expect(modify(demande({ versionId: 9 }))).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
  });
});

describe('écriture concurrente', () => {
  it("n'écrase pas un prompt modifié pendant l'appel modèle", async () => {
    getVersion
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce(version({ entries: [entree('T1', 'Texte enregistré entre-temps par un autre administrateur.')] }));
    execute.mockResolvedValue(sortie());

    await expect(modify(demande())).rejects.toMatchObject({ code: 'PROMPT_CHANGED' });
    expect(saveEntry).not.toHaveBeenCalled();
  });

  it("refuse d'écrire si le brouillon a été promu entre-temps", async () => {
    getVersion
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce(version({ status: 'TO_TEST' }));
    execute.mockResolvedValue(sortie());

    await expect(modify(demande())).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
    expect(saveEntry).not.toHaveBeenCalled();
  });
});

describe('T5-009 — quatre verdicts, pas un seul', () => {
  it('distingue les causes qui n’appellent pas le même geste', () => {
    expect([...VERDICTS]).toEqual(['prompt', 'code', 'donnees', 'configuration']);
  });

  it('verdict « prompt » sans texte : rendu visible, rien à écrire', () => {
    const r = interpret('modify', { ...sortie().data, proposedContent: null } as never, PROMPT_ACTUEL);
    expect(r.proposedContent).toBeNull();
    expect(r.rejected).toMatch(/reformulez/);
  });
});
