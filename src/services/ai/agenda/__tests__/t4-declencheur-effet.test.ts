/**
 * Ticket BO IA / T4 §4.6 — effet RÉEL du déclencheur `source_analyzed`.
 *
 * Chaîne testée : fin d'analyse T1 (`emitSourceAnalyzed`) → abonné agenda →
 * lecture de la configuration EFFECTIVE (`isTriggerActive`) → mise en file T4.
 *   · `source_analyzed` actif     → le parcours T4 est alimenté ;
 *   · explicitement inactif       → aucun déclenchement automatique ;
 *   · liste vide                  → défauts du code (source_analyzed inclus).
 * Mettre en file n'implique pas d'appel modèle : T4 garde ses décisions
 * déterministes à l'exécution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(async (_i: unknown) => ({ decision: 'create' as const, jobId: 1 }));
vi.mock('../../queue/job-queue.repository', () => ({ enqueue: (i: unknown) => enqueue(i) }));
vi.mock('../../queue/queue-worker', () => ({ registerJobHandler: () => {} }));
vi.mock('../agenda-intelligence.service', () => ({ processAgendaCandidates: vi.fn() }));

const { registerAgendaHandlers } = await import('../index');
const { emitSourceAnalyzed, clearSourceAnalyzedHandlers } = await import('../../source-analysis/events');
const { __setTriggerConfigLoader } = await import('../../queue/triggers');

type Setting = { kind: 'event' | 'schedule'; code: string; active: boolean };
const effective = (triggers: Setting[]) => __setTriggerConfigLoader(async (t) => (t === 'T4' ? { triggers } : null));

const finAnalyseT1 = () => emitSourceAnalyzed({
  accountId: 5, userId: 1, assetId: 2, leadSourceId: 3,
  result: { agendaCandidates: [{ title: 'Entretien chaudière', date: '2027-01-10' }], warnings: [] } as never,
});

beforeEach(() => {
  enqueue.mockClear();
  clearSourceAnalyzedHandlers();
  registerAgendaHandlers(async () => [] as never, async () => {});
});
afterEach(() => {
  __setTriggerConfigLoader(null);
  clearSourceAnalyzedHandlers();
});

describe('source_analyzed → T4 (configuration effective)', () => {
  it('actif : une analyse T1 terminée alimente le parcours T4', async () => {
    effective([{ kind: 'event', code: 'source_analyzed', active: true }]);
    await finAnalyseT1();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ treatment: 'T4', triggerCode: 'source_analyzed' });
  });

  it('explicitement inactif : aucun déclenchement automatique', async () => {
    effective([{ kind: 'event', code: 'source_analyzed', active: false }]);
    await finAnalyseT1();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('liste vide : les défauts du code s’appliquent (source_analyzed inclus)', async () => {
    effective([]);
    await finAnalyseT1();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
