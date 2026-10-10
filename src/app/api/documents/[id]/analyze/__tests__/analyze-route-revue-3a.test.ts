/**
 * Revue L16b-3a, points 4 et 5 — réanalyse depuis le tiroir :
 *   · un job T1 vivant pour le document → `ALREADY_ANALYZING` avec un motif,
 *     sans analyse directe (pas de double appel au master) ;
 *   · panne inattendue du pipeline (`null`) → `ANALYSIS_INTERRUPTED`, jamais
 *     « remis en file » ni un `done` trompeur ;
 *   · échec motivé → `ANALYSIS_FAILED` avec le statut FONCTIONNEL (lot 34C :
 *     jamais le motif technique écrit sur le fichier, UXERR-04).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  live: new Set<string>(),
  analyze: vi.fn(),
}));
vi.mock('@/lib/auth-guards', () => ({ getSession: async () => ({ currentAccountId: 5, userId: 3 }) }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiPasDIA: async () => null }));
vi.mock('@/services/commercial-model.service', () => ({ canConsumeAnalysis: async () => ({ allowed: true }) }));
vi.mock('@/db', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => [{ id: 42, reason: 'Analyse impossible (prompt maître T1) : sortie invalide' }] };
  return { db: { select: () => chain } };
});
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ listLiveTargets: async () => h.live }));
vi.mock('@/services/ai/processing-status/processing-status.service', async (o) => ({
  ...(await o<object>()),
  getFileProcessingView: async () => ({
    processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false, nextAttemptAt: null, resumeAt: null,
  }),
}));
vi.mock('@/services/ai/source-analysis/entrypoint', () => ({
  analyzeFileSources: (...a: unknown[]) => h.analyze(...a),
  registerAnalysisStreamWriter: async () => () => {},
}));

const { POST } = await import('../route');

async function evenements(): Promise<Array<Record<string, unknown>>> {
  const res = await POST(new NextRequest('http://x/api/documents/42/analyze', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: '42' }) });
  const texte = await res.text();
  return texte.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

beforeEach(() => { h.live = new Set(); h.analyze.mockReset(); });

describe('POST /api/documents/[id]/analyze — revue 3a', () => {
  it('job T1 vivant : ALREADY_ANALYZING motivé, aucune analyse directe', async () => {
    h.live = new Set(['42']);
    const ev = await evenements();
    expect(ev.at(-1)).toMatchObject({ type: 'error', code: 'ALREADY_ANALYZING', message: expect.stringMatching(/déjà en file/) });
    expect(h.analyze).not.toHaveBeenCalled();
  });

  it('panne du pipeline (null) : code d’interruption, aucun texte technique, pas de « done »', async () => {
    h.analyze.mockResolvedValue(null);
    const ev = await evenements();
    expect(ev.at(-1)).toEqual({ type: 'error', code: 'ANALYSIS_INTERRUPTED' });
  });

  it('UXERR-04 — échec motivé : statut fonctionnel, JAMAIS le motif technique du fichier', async () => {
    h.analyze.mockResolvedValue({ results: [], analysedCount: 0, failedSourceIds: [42] });
    const ev = await evenements();
    expect(ev.at(-1)).toEqual({
      type: 'error', code: 'ANALYSIS_FAILED', processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL',
      retryScheduled: false, nextAttemptAt: null, processingResumeAt: null,
    });
    expect(JSON.stringify(ev)).not.toMatch(/prompt|sortie invalide/);
  });

  it('déjà en cours (pipeline) : ALREADY_ANALYZING avec un motif', async () => {
    h.analyze.mockResolvedValue({ results: [], analysedCount: 0, failedSourceIds: [], skippedReason: 'already_running' });
    expect((await evenements()).at(-1)).toMatchObject({ code: 'ALREADY_ANALYZING', message: expect.stringMatching(/déjà en cours/) });
  });

  it('succès : done', async () => {
    h.analyze.mockResolvedValue({ results: [], analysedCount: 1, failedSourceIds: [] });
    expect((await evenements()).at(-1)).toEqual({ type: 'done' });
  });
});
