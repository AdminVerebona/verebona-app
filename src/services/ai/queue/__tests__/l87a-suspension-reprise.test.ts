/**
 * Lot 87A — CDC Pilotage IA V2, phase P7 : suspension sans écriture, reprise
 * depuis un point sûr, cause visible (P2/P3), anomalies reliées aux secours
 * (INV-10). Tests purs (la file réelle : e2e `l87a-secours-reprise`).
 *
 *   L87A-Q01  reprise bornée d'un travail suspendu (5 min, 15 min, 1 h ;
 *             échec définitif au-delà du plafond — jamais de boucle sans fin)
 *   L87A-Q02  suspension non encore reprise lue sur le travail ; reprise
 *             marquée → plus « suspendue »
 *   L87A-Q03  exécution métier (P2) : « suspendue » avec cause explicite
 *             AI_SUSPENDED (cause établie), jamais un échec ni une réussite
 *   L87A-Q04  INV-10 : anomalie d'un modèle actif reliée au secours que la
 *             passerelle choisira (qualifié / non testé / aucun → suspension)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const { afterAiSuspension, maxAiSuspensions, AI_SUSPENSION_USER_REASON } = await import('../queue-policy');
const { resumeOfSuspension } = await import('../queue-worker');
const { qualifyT3, qualifyT1 } = await import('../../business-execution/mapping');
const A = await import('../../provider/active-model-anomalies');
type JobState = import('../../business-execution/mapping').JobState;
type UsableModelsContext = import('../../registry/usable-models').UsableModelsContext;

const NOW = new Date('2026-10-24T10:00:00.000Z');
const job = (over: Partial<JobState> = {}): JobState => ({
  id: 1, status: 'PENDING', attempts: 1, lastError: null, businessResult: null, businessResultDetail: null,
  createdAt: new Date('2026-10-24T09:00:00Z'), startedAt: null, finishedAt: null, availableAt: new Date('2026-10-24T10:05:00Z'), ...over,
});

describe('L87A-Q01 — reprise bornée', () => {
  it('délais croissants puis plafond : échec définitif avec la cause', () => {
    expect(afterAiSuspension(0, 24)).toEqual({ status: 'PENDING', count: 1, retryInSeconds: 300 });
    expect(afterAiSuspension(1, 24)).toEqual({ status: 'PENDING', count: 2, retryInSeconds: 900 });
    expect(afterAiSuspension(5, 24)).toEqual({ status: 'PENDING', count: 6, retryInSeconds: 3_600 });
    expect(afterAiSuspension(24, 24)).toEqual({ status: 'FAILED', count: 25, retryInSeconds: 0 });
  });
  it('plafond réglable (AI_QUEUE_MAX_AI_SUSPENSIONS), 24 par défaut, valeur invalide ignorée', () => {
    vi.stubEnv('AI_QUEUE_MAX_AI_SUSPENSIONS', '3');
    expect(maxAiSuspensions()).toBe(3);
    vi.stubEnv('AI_QUEUE_MAX_AI_SUSPENSIONS', 'abc');
    expect(maxAiSuspensions()).toBe(24);
    vi.unstubAllEnvs();
  });
  it('motif affiché à l’utilisateur : ni code interne, ni nom de modèle', () => {
    expect(AI_SUSPENSION_USER_REASON).not.toMatch(/AI_SUSPENDED|gemini|QUOTA|secours/i);
  });
});

describe('L87A-Q02 — suspension portée par le travail', () => {
  it('non reprise : lue (cause, date, révision, nombre) ; reprise marquée : plus de reprise à tracer', () => {
    const payload = { aiSuspension: { cause: 'QUOTA', at: '2026-10-24T09:55:00Z', revisionId: 12, count: 2, resumedAt: null } };
    expect(resumeOfSuspension({ payload } as never)).toEqual({ cause: 'QUOTA', suspendedAt: '2026-10-24T09:55:00Z', previousRevisionId: 12, count: 2 });
    expect(resumeOfSuspension({ payload: { aiSuspension: { ...payload.aiSuspension, resumedAt: '2026-10-24T10:00:00Z' } } } as never)).toBeNull();
    expect(resumeOfSuspension({ payload: {} } as never)).toBeNull();
    expect(resumeOfSuspension({ payload: null } as never)).toBeNull();
  });
});

describe('L87A-Q03 — exécution métier (P2) : suspendue, cause explicite', () => {
  const suspendu = { cause: 'KNOWN_UNAVAILABLE', message: 'aucun secours admissible après « modèle connu indisponible »', until: '2026-10-24T10:05:00Z', count: 1, resumedAt: null };
  it('T3 suspendu : NON FINALE, progression SUSPENDED, cause AI_SUSPENDED (cause établie, aucune écriture, reprise)', () => {
    const q = qualifyT3(job({ aiSuspension: suspendu }), [], NOW);
    expect(q).toMatchObject({ outcome: 'NOT_FINAL', progress: 'SUSPENDED' });
    expect(q.cause).toMatch(/^AI_SUSPENDED \(KNOWN_UNAVAILABLE\) : aucun secours admissible, aucune écriture — reprise automatique depuis un point sûr à 2026-10-24T10:05:00/);
  });
  it('suspension reprise : plus affichée comme suspendue', () => {
    const q = qualifyT3(job({ status: 'RUNNING', aiSuspension: { ...suspendu, resumedAt: '2026-10-24T10:06:00Z' } }), [], NOW);
    expect(q.cause ?? '').not.toMatch(/AI_SUSPENDED/);
  });
  it('T1 (document logique) suspendu : même cause, jamais Échouée', () => {
    const q = qualifyT1({ jobs: [job({ aiSuspension: suspendu })], reports: [], coverage: null, file: { analysisState: 'UPLOADED', deleted: false } }, NOW);
    expect(q.outcome).toBe('NOT_FINAL');
    expect(q.cause).toMatch(/AI_SUSPENDED \(KNOWN_UNAVAILABLE\)/);
  });
});

describe('L87A-Q04 — INV-10 : anomalies reliées aux secours qualifiés', () => {
  const ctx: UsableModelsContext = {
    environment: 'production',
    catalog: {
      refreshedAt: '2026-10-10T06:00:00Z',
      models: [['gemini-3.6-flash', false], ['gemini-3.5-flash-lite', true], ['gemini-3.1-flash-lite', true]]
        .map(([model, available]) => ({ model: model as string, available: available as boolean, supportsGeneration: true, lifecycle: 'stable' as const })),
    },
    codeCatalog: [], price: () => ({ verified: false }), operational: new Map(), qualifications: new Map(), today: '2026-10-10',
  } as UsableModelsContext;
  const chains = [
    { treatment: 'T3' as const, rank: 'primaryModel' as const, model: 'gemini-3.6-flash', source: 'version' as const },
    { treatment: 'T3' as const, rank: 'fallback1' as const, model: 'gemini-3.5-flash-lite', source: 'version' as const },
    { treatment: 'T3' as const, rank: 'fallback2' as const, model: 'gemini-3.1-flash-lite', source: 'version' as const },
  ];
  const secours = (q: Record<string, import('../../gateway/fallback-policy').CoupleQualification>, origin: 'manual' | 'auto' = 'manual') =>
    ({ origin, qualificationOf: (_t: unknown, m: string) => q[m] ?? 'UNKNOWN' });

  it('repli 1 refusé, repli 2 qualifié : le secours relié est le repli 2 (« secours qualifié »)', () => {
    const [a] = A.detectActiveModelAnomalies(chains, ctx, secours({ 'gemini-3.5-flash-lite': 'REFUSED', 'gemini-3.1-flash-lite': 'ADMISSIBLE' }));
    expect(a).toMatchObject({ model: 'gemini-3.6-flash', fallbackAvailable: true, secours: { model: 'gemini-3.1-flash-lite', decision: 'QUALIFIED' } });
    expect(A.anomalyMessage(a)).toContain('Le secours qualifié « gemini-3.1-flash-lite » prend le relais.');
  });
  it('configuration manuelle sans preuve : secours non testé (choix de l’administrateur)', () => {
    const [a] = A.detectActiveModelAnomalies(chains, ctx, secours({}));
    expect(a.secours).toMatchObject({ model: 'gemini-3.5-flash-lite', decision: 'MANUAL_UNTESTED' });
  });
  it('aucun secours admissible : exécutions suspendues sans écriture (message d’exploitation et alerte)', () => {
    const [a] = A.detectActiveModelAnomalies(chains, ctx, secours({ 'gemini-3.5-flash-lite': 'OBSOLETE', 'gemini-3.1-flash-lite': 'NEVER_TESTED' }, 'auto'));
    expect(a).toMatchObject({ fallbackAvailable: false, secours: { model: null, decision: 'NONE' } });
    expect(A.anomalyMessage(a)).toMatch(/Aucun secours admissible : les exécutions sont suspendues sans écriture/);
    const g = A.groupAnomaliesByModel([a], new Map());
    expect(A.groupMessage(g[0])).toMatch(/T3 — Aucun secours admissible/);
  });
  it('état de qualification non lu : libellé historique inchangé', () => {
    const [a] = A.detectActiveModelAnomalies(chains, ctx);
    expect(a.secours).toBeUndefined();
    expect(A.anomalyMessage(a)).toMatch(/La chaîne de repli prend le relais/);
  });
});
