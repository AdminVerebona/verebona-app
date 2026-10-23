/**
 * Tableau de bord IA — SCR-01 : VER-01 (UID abrégé, date d'activation),
 * DRF-01 (brouillons détaillés), PER-01 (fenêtre 24 h / 7 j / 30 j), GST-01
 * (« Opérationnel » / « Arrêt d'urgence »).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../config-versions/_shared', async (orig) => ({
  ...(await orig<typeof import('../../config-versions/_shared')>()),
  requireAdminContext: async () => ({ ok: true, ctx: { adminUserId: 1 } }),
}));
vi.mock('@/services/ai/config/environment', () => ({ getAiEnvironment: () => 'preprod' }));

const active = {
  id: 3, uid: '1a2b3c4d-5e6f-7a8b-9c0d-112233445566', environment: 'preprod', status: 'ACTIVE',
  visibleNumber: 3, label: 'Septembre', baseVersionId: 2, isStale: false, createdBy: 1,
  createdAt: new Date('2026-09-01T00:00:00Z'), validatedAt: new Date('2026-09-02T00:00:00Z'),
  activatedAt: new Date('2026-09-03T08:00:00Z'), archivedAt: null, entries: [],
};
vi.mock('@/services/ai/config/config-version.repository', () => ({
  listVersions: async () => [],
  getActiveVersion: async () => active,
  getEffectiveVersion: async () => active,
}));
vi.mock('@/services/ai/config/config-package.service', () => ({ listPackages: async () => [] }));
let stopActive = false;
vi.mock('@/services/ai/queue/job-queue.repository', () => ({
  getQueueSummary: async () => [],
  getTreatmentStates: async () => [],
  getEmergencyStop: async () => ({ active: stopActive, reason: stopActive ? 'incident' : null, engagedAt: null }),
}));
// Lot 83C : la fenêtre lit les exécutions MÉTIER (plus le comptage d'appels en échec).
type Fenetre = { from: Date; to: Date };
const projectBusinessExecutions = vi.fn(async (_f: Fenetre) => ({ rows: [] as unknown[], truncated: [], unavailable: [] }));
let resume: Array<Record<string, unknown>> = [];
vi.mock('@/services/ai/business-execution/repository', () => ({
  projectBusinessExecutions: (f: Fenetre) => projectBusinessExecutions(f),
  summarize: () => resume,
}));
const fenetreJours = () => {
  const f = projectBusinessExecutions.mock.calls.at(-1)![0];
  return Math.round((f.to.getTime() - f.from.getTime()) / 86_400_000);
};
const getCostReport = vi.fn(async (_o: { since: Date }) => ({
  totals: { functionalMicros: 1, technicalMicros: 2, calls: 3, failedCalls: 0, inputTokens: 0, outputTokens: 0, unpricedCalls: 0 },
  incomplete: false,
}));
vi.mock('@/services/ai/telemetry/cost-report.repository', () => ({ getCostReport: (o: { since: Date }) => getCostReport(o) }));
vi.mock('@/services/ai/queue/circuit-breaker.repository', () => ({ getModelAlerts: async () => [] }));
vi.mock('@/services/ai/alerts/alerts.repository', () => ({ listAlerts: async () => [] }));
vi.mock('@/services/ai/telemetry/treatment-activity.repository', () => ({
  getTreatmentActivity: async () => [{
    treatment: 'T1', calls24h: 4, calls7d: 10, calls30d: 20, successRate24h: 0.5, successRate7d: 0.9,
    successRate30d: 0.75, failed24h: 2, failed7d: 1, failed30d: 5, lastCallAt: null, lastErrorAt: null,
  }],
}));
vi.mock('@/services/ai/config/draft-summary.repository', () => ({
  listDraftSummaries: async () => [{
    id: 7, uid: 'u', label: 'Essai prompt', isStale: true, createdAt: '2026-09-20T10:00:00.000Z',
    base: { id: 3, visibleNumber: 3, label: 'Septembre' }, author: 'Alice Martin',
  }],
}));

const corpusAide = vi.fn(() => ({ status: 'ok', source: 'live', version: 'v1', alert: null } as Record<string, unknown>));
vi.mock('@/services/verebona-assistant/core/help-corpus.service', () => ({
  loadHelpCorpus: async () => null, helpCorpusHealth: () => corpusAide(),
}));

const { GET } = await import('../route');
const call = (qs = '') => GET(new NextRequest(`http://localhost/api/admin/ai/dashboard${qs}`));

beforeEach(() => {
  stopActive = false;
  resume = [];
  projectBusinessExecutions.mockClear();
  getCostReport.mockClear();
});

describe('GET /api/admin/ai/dashboard', () => {
  it('VER-01 : UID abrégé et date d’activation de la version active', async () => {
    const body = await (await call()).json();
    expect(body.activeVersion).toMatchObject({
      visibleNumber: 3, label: 'Septembre', shortUid: '1a2b3c4d', activatedAt: '2026-09-03T08:00:00.000Z',
    });
  });

  it('DRF-01 : brouillons détaillés (base, obsolète, auteur)', async () => {
    const body = await (await call()).json();
    expect(body.drafts).toEqual([expect.objectContaining({ id: 7, isStale: true, author: 'Alice Martin', base: expect.objectContaining({ visibleNumber: 3 }) })]);
  });

  it('PER-01 : 7 j par défaut, 24 h et 30 j sur demande, valeur inconnue ignorée', async () => {
    let body = await (await call()).json();
    expect(body.windowDays).toBe(7);
    expect(fenetreJours()).toBe(7);
    expect(body.health.find((h: { treatment: string }) => h.treatment === 'T1').activity.window)
      .toEqual({ calls: 10, failed: 1, successRate: 0.9 });

    body = await (await call('?days=1')).json();
    expect(body.windowDays).toBe(1);
    expect(fenetreJours()).toBe(1);
    expect(body.health.find((h: { treatment: string }) => h.treatment === 'T1').activity.window)
      .toEqual({ calls: 4, failed: 2, successRate: 0.5 });
    const since = getCostReport.mock.calls.at(-1)![0].since.getTime();
    expect(Date.now() - since).toBeGreaterThan(86_000_000);
    expect(Date.now() - since).toBeLessThan(87_000_000);

    body = await (await call('?days=30')).json();
    expect(body.windowDays).toBe(30);
    expect(body.costs).toMatchObject({ functionalMicros: 1, technicalMicros: 2, calls: 3 });

    body = await (await call('?days=365')).json();
    expect(body.windowDays).toBe(7);
  });

  it('L83C-U-DASH : alertes et cartes sur les exécutions MÉTIER (une par traitement), jamais sur des appels en échec', async () => {
    resume = [
      { treatment: 'T1', succeeded: 4, incomplete: 1, failed: 0, notFinal: 0, void: 0, undetermined: 0, technical: 0 },
      { treatment: 'T3', succeeded: 2, incomplete: 0, failed: 2, notFinal: 1, void: 0, undetermined: 0, technical: 3 },
      { treatment: 'T4', succeeded: 1, incomplete: 0, failed: 0, notFinal: 0, void: 0, undetermined: 0, technical: 0 },
    ];
    const body = await (await call()).json();
    expect(body.alerts).toContainEqual({ severity: 'info', message: 'T1 : 1 incomplète en 7 jours.', href: '/admin/ai-executions?treatment=T1' });
    expect(body.alerts).toContainEqual({ severity: 'warning', message: 'T3 : 2 exécutions échouées en 7 jours.', href: '/admin/ai-executions?treatment=T3' });
    expect(body.alerts.some((a: { message: string }) => a.message.startsWith('T4'))).toBe(false);
    expect(body.health.find((h: { treatment: string }) => h.treatment === 'T1').executions).toMatchObject({ succeeded: 4, incomplete: 1 });
  });

  it('GST-01 : « Opérationnel » puis « Arrêt d’urgence »', async () => {
    expect((await (await call()).json()).globalStatus).toEqual({ key: 'operational', label: 'Opérationnel' });
    stopActive = true;
    expect((await (await call()).json()).globalStatus).toEqual({ key: 'emergency_stop', label: 'Arrêt d’urgence' });
  });

  it('PUB-01 : corpus d’aide refusé → alerte, critique sans aucun corpus valide', async () => {
    corpusAide.mockReturnValueOnce({
      status: 'warning', source: 'last_valid_memory', version: 'v1', lastValidAt: '2026-09-30T08:00:00.000Z', lastValidAgeSeconds: 3 * 3600,
      alert: { code: 'HELP_CORPUS_INVALID', message: 'Corpus d’aide publié invalide.', at: 'x' },
    });
    let body = await (await call()).json();
    expect(body.alerts).toContainEqual(expect.objectContaining({
      severity: 'warning', message: expect.stringContaining('Corpus servi : v1, lu le 2026-09-30 08:00 UTC (il y a 3 h)'),
    }));
    corpusAide.mockReturnValueOnce({ status: 'warning', source: 'none', version: null, alert: { code: 'HELP_CORPUS_WRONG_ENVIRONMENT', message: 'Refusé.', at: 'x' } });
    body = await (await call()).json();
    expect(body.alerts).toContainEqual(expect.objectContaining({ severity: 'critical', message: expect.stringContaining('Aucun corpus valide') }));
    body = await (await call()).json();
    expect(body.alerts.some((a: { message: string }) => /corpus/i.test(a.message))).toBe(false);
  });
  it('D-J2 : base trop lente (statement_timeout) → repli mémoire signalé au tableau de bord', async () => {
    const { SharedRateLimiter, setAssistantRateLimiterForTests } = await import('@/lib/verebona/rate-limit');
    const lent = {
      hit: async () => { throw new Error('canceling statement due to statement timeout'); },
      purge: async () => undefined,
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const l = new SharedRateLimiter(lent);
    setAssistantRateLimiterForTests(l);
    try {
      const d = await l.check([{ key: 'u:1', limit: 5, scope: 'user' }]);
      expect(d.allowed).toBe(true); // repli mémoire, la requête passe
      const body = await (await call()).json();
      expect(body.alerts).toContainEqual(expect.objectContaining({
        severity: 'warning', message: expect.stringContaining('repli mémoire'),
      }));
      expect(body.alerts.find((a: { message: string }) => /repli mémoire/.test(a.message)).message).toContain('statement timeout');
    } finally {
      setAssistantRateLimiterForTests(null);
      err.mockRestore();
    }
    const body = await (await call()).json();
    expect(body.alerts.some((a: { message: string }) => /repli mémoire/.test(a.message))).toBe(false);
  });
});
