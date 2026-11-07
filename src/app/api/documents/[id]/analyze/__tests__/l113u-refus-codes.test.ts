/**
 * Lot 113U (carte #720) — `POST /api/documents/[id]/analyze`, sans base :
 *   · une erreur de session LEVÉE par la garde garde son code (plus
 *     `INTERNAL_ERROR`) ;
 *   · un job T1 vivant est signalé AVANT les contrôles d'offre et de droits ;
 *   · l'échec relayé du pipeline (`error` sans code) devient un `state_update` ;
 *   · chaque verdict d'erreur porte une référence d'incident et est journalisé.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  session: null as null | (() => Promise<unknown>),
  live: new Set<string>(),
  dia: null as null | { code: string; message: string },
  quota: { allowed: true } as { allowed: boolean; reason?: string },
  analyze: vi.fn(),
  writer: null as null | ((d: Record<string, unknown>) => void),
  journal: [] as Array<Record<string, unknown>>,
  vue: { processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false, nextAttemptAt: null, resumeAt: null } as Record<string, unknown>,
}));
vi.mock('@/lib/auth-guards', () => ({ getSession: async () => (h.session ? h.session() : { currentAccountId: 5, userId: 3 }) }));
vi.mock('@/lib/write-access-guard', () => ({
  refuserSiPasDIA: async () => (h.dia ? { json: async () => h.dia } : null),
}));
vi.mock('@/services/commercial-model.service', () => ({ canConsumeAnalysis: async () => h.quota }));
vi.mock('@/db', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => [{ id: 42 }] };
  return { db: { select: () => chain } };
});
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ listLiveTargets: async () => h.live }));
vi.mock('@/services/ai/gateway/account-cost-cap', () => ({ costCapReachedFor: async () => null, costCapAnalysisReason: () => '' }));
vi.mock('@/services/ai/processing-status/processing-status.service', async (o) => ({
  ...(await o<object>()),
  getFileProcessingView: async () => h.vue,
  userStreamEvent: async (_f: number, _a: number, d: Record<string, unknown>) => ({ ...d, ...h.vue }),
}));
vi.mock('@/services/ai/source-analysis/entrypoint', () => ({
  analyzeFileSources: (...a: unknown[]) => h.analyze(...a),
  registerAnalysisStreamWriter: async (_id: number, w: (d: Record<string, unknown>) => void) => { h.writer = w; return () => { h.writer = null; }; },
}));
vi.mock('@/services/ai/source-analysis/launch-refusals', () => ({
  recordLaunchRefusal: async (r: Record<string, unknown>) => { h.journal.push(r); return true; },
}));

const { POST } = await import('../route');

async function evenements(headers: Record<string, string> = {}): Promise<Array<Record<string, unknown>>> {
  const res = await POST(new NextRequest('http://x/api/documents/42/analyze', { method: 'POST', body: '{}', headers }), { params: Promise.resolve({ id: '42' }) });
  return (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

beforeEach(() => {
  h.session = null; h.live = new Set(); h.dia = null; h.quota = { allowed: true }; h.analyze.mockReset(); h.journal = [];
  h.vue = { processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false, nextAttemptAt: null, resumeAt: null };
});

describe('113U — codes de refus de la route', () => {
  it.each(['AUTH_REQUIRED', 'INVALID_TOKEN', 'MFA_REQUIRED', 'CGUV_REACCEPTANCE_REQUIRED', 'SESSION_UNAVAILABLE', 'ACCOUNT_SUSPENDED'])(
    'erreur de session %s : code propagé (jamais INTERNAL_ERROR), journalisée', async (code) => {
      h.session = async () => { throw new Error(code); };
      const ev = await evenements();
      expect(ev).toEqual([{ type: 'error', code, incidentRef: expect.stringMatching(/^AN-/) }]);
      expect(h.journal[0]).toMatchObject({ code, source: 'server', httpStatus: 200, incidentRef: ev[0].incidentRef });
    });

  it('garde FORBIDDEN → ACCESS_DENIED ; exception inconnue → INTERNAL_ERROR (journalisée, référence)', async () => {
    h.session = async () => { throw new Error('FORBIDDEN'); };
    expect((await evenements())[0]).toMatchObject({ code: 'ACCESS_DENIED' });
    h.session = async () => { throw new TypeError('boom'); };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ev = await evenements();
    spy.mockRestore();
    expect(ev[0]).toEqual({ type: 'error', code: 'INTERNAL_ERROR', incidentRef: expect.stringMatching(/^AN-/) });
    expect(JSON.stringify(ev)).not.toMatch(/boom/);
  });

  it('job vivant : ALREADY_ANALYZING + statut fonctionnel, même si l’offre refuserait (contrôle AVANT)', async () => {
    h.live = new Set(['42']);
    h.dia = { code: 'TRIAL_EXPIRED', message: 'Essai terminé.' };
    h.quota = { allowed: false, reason: 'PLAN_NOT_SUBSCRIBABLE' };
    h.vue = { processingStatus: 'PENDING', userMessageCode: 'ANALYSIS_WAITING_TECHNICAL', retryScheduled: true, nextAttemptAt: '2026-11-07T10:15:00.000Z', resumeAt: null };
    const ev = await evenements();
    expect(ev.at(-1)).toMatchObject({
      type: 'error', code: 'ALREADY_ANALYZING', processingStatus: 'PENDING', userMessageCode: 'ANALYSIS_WAITING_TECHNICAL',
      nextAttemptAt: '2026-11-07T10:15:00.000Z', incidentRef: expect.stringMatching(/^AN-/),
    });
    expect(h.analyze).not.toHaveBeenCalled();
  });

  it('sans job vivant : refus d’offre et de quota transmis avec leur code', async () => {
    h.dia = { code: 'TRIAL_EXPIRED', message: 'Essai terminé.' };
    expect((await evenements()).at(-1)).toMatchObject({ code: 'TRIAL_EXPIRED', message: 'Essai terminé.' });
    h.dia = null; h.quota = { allowed: false, reason: 'PLAN_NOT_SUBSCRIBABLE' };
    expect((await evenements()).at(-1)).toMatchObject({ code: 'PLAN_NOT_SUBSCRIBABLE' });
  });

  it('CAUSE #720 : l’échec relayé du pipeline (error sans code) devient un state_update ; seul le verdict final est une erreur', async () => {
    h.analyze.mockImplementation(async () => {
      h.writer?.({ type: 'error', analysisState: 'ANALYSIS_FAILED' });
      await new Promise((r) => setTimeout(r, 0));
      h.vue = { processingStatus: 'PENDING', userMessageCode: null, retryScheduled: true, nextAttemptAt: '2026-11-07T10:15:00.000Z', resumeAt: null };
      return { results: [], analysedCount: 0, failedSourceIds: [42] };
    });
    const ev = await evenements();
    const erreurs = ev.filter((e) => e.type === 'error');
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toMatchObject({ code: 'ANALYSIS_FAILED', processingStatus: 'PENDING' });
    expect(ev.some((e) => e.type === 'state_update' && e.analysisState === 'ANALYSIS_FAILED')).toBe(true);
  });

  it('origine iOS lue dans l’en-tête du client ou le marqueur de la vue mobile', async () => {
    h.session = async () => { throw new Error('MFA_REQUIRED'); };
    await evenements({ 'x-verebona-client': 'IOS', 'x-verebona-app-version': '1.4.0' });
    expect(h.journal[0]).toMatchObject({ client: 'IOS', appVersion: '1.4.0' });
    await evenements({ 'user-agent': 'Mozilla/5.0 (iPhone) VerebonaApp/1.4.0 (52; preprod)' });
    expect(h.journal[1]).toMatchObject({ client: 'IOS', appVersion: '1.4.0 (52)' });
  });
});
