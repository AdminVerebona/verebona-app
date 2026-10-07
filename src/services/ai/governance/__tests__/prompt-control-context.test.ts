/**
 * T5-009 (journaux sur demande) et T5-010 (comparaison de versions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getVersion = vi.fn();
const execute = vi.fn();
const getErrorBreakdown = vi.fn();
const getTreatmentMetrics = vi.fn();

vi.mock('../../config/config-version.repository', () => ({
  getVersion: (id: unknown) => getVersion(id),
}));
vi.mock('../../master-prompts/master-prompt.service', () => ({
  workingTexts: async () => new Map(), writeDraftFromPromptControl: vi.fn(),
}));
vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: (req: unknown) => execute(req) } }));
vi.mock('../prompt-control.audit', () => ({ recordT5Modification: vi.fn() }));
vi.mock('../../queue/job-queue.repository', () => ({ getEmergencyStop: async () => ({ active: false, reason: null }) }));
vi.mock('../../telemetry/execution-log.repository', () => ({ getErrorBreakdown: (d: number) => getErrorBreakdown(d) }));
vi.mock('../../config/treatment-metrics.repository', () => ({ getTreatmentMetrics: (t: string, d: number) => getTreatmentMetrics(t, d) }));

const { analyze } = await import('../prompt-control.service');

const entree = (treatment: string, prompt: string) => ({
  treatment, prompt, primaryModel: 'm1', fallback1: 'm2', fallback2: null, guardrails: [], triggers: [],
});
const v = (id: number, status: string, promptT1: string, visibleNumber: number | null) => ({
  id, status, environment: 'preprod', label: null, visibleNumber, isStale: false, createdAt: new Date(),
  entries: [entree('T1', promptT1), entree('T2', 'Socle T2 identique, assez long pour être un prompt.')],
});

beforeEach(() => {
  execute.mockReset().mockResolvedValue({
    data: { mode: 'ANALYZE', verdict: 'configuration', analysis: 'Le repli est trop fréquent.', targets: [], risks: [], configurationRecommendations: [] },
    traceId: 't',
  });
  getVersion.mockReset().mockImplementation(async (id: number) => (id === 1
    ? v(1, 'DRAFT', 'Prompt T1 du brouillon, nommer les documents par leur type.', null)
    : v(2, 'ACTIVE', 'Prompt T1 actif, sans règle de nommage des documents.', 4)));
  getErrorBreakdown.mockReset().mockResolvedValue([
    { treatment: 'T1', errorCode: 'TIMEOUT', model: 'm1', count: 12, lastSeen: new Date('2026-09-20') },
    { treatment: 'T5', errorCode: 'X', model: 'm1', count: 3, lastSeen: new Date('2026-09-20') },
  ]);
  getTreatmentMetrics.mockReset().mockResolvedValue({ metrics: [{ label: 'Taux de repli modèle', value: 40, unit: 'percent' }] });
});

describe('T5 — contexte sur demande', () => {
  it('sans demande : ni journaux ni comparaison (T5-009 : pas de chargement systématique)', async () => {
    const r = await analyze(1, 'Les titres sont mauvais', 99, 7);
    expect(getErrorBreakdown).not.toHaveBeenCalled();
    expect(r.comparison ?? null).toBeNull();
    // Master T5 : sans contexte demandé, INSTRUCTION est la demande seule.
    expect(execute.mock.calls[0][0].promptVariables.INSTRUCTION).toBe('Les titres sont mauvais');
  });

  it('T5-010 : comparaison avec l’Active — diff rendu et transmis au modèle', async () => {
    const r = await analyze(1, 'Qu’est-ce qui change ?', 99, 7, { compareWithVersionId: 2 });
    expect(r.comparison).toMatchObject({ versionId: 2, status: 'ACTIVE', label: 'v4' });
    expect(r.comparison!.diff.identical).toBe(false);
    expect(r.comparison!.diff.treatments.map((t) => t.treatment)).toEqual(['T1']);
    expect(execute.mock.calls[0][0].promptVariables.INSTRUCTION).toMatch(/Comparaison demandée/);
  });

  it('T5-009 : journaux sur demande, synthèse bornée au traitement demandé', async () => {
    const r = await analyze(1, 'Beaucoup d’échecs T1', 99, 7, { includeLogs: true, logsTreatment: 'T1', logsDays: 90 });
    expect(getErrorBreakdown).toHaveBeenCalledWith(30); // borné
    expect(r.logsDigest).toMatch(/T1 TIMEOUT/);
    expect(r.logsDigest).not.toMatch(/T5 X/);
    expect(r.logsDigest).toMatch(/Taux de repli modèle = 40 %/);
  });
});
