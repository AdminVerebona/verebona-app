/**
 * Lot 3 — file mémoire T1 (chemin `legacy`, défaut jusqu'à la bascule).
 *
 *  · VER-017, WF-06 : un rollback (ou un arrêt d'urgence, une désactivation)
 *    interrompt AUSSI les analyses de la file mémoire — `requeueRunning` ne
 *    visait que `ai_job_queue`. L'analyse coupée n'écrit plus rien et reprend
 *    en tête, avec la nouvelle configuration ;
 *  · GEN-012 : délai global d'exécution appliqué ici aussi ; au dépassement,
 *    la source passe en échec (pas de remise en tête, qui bouclerait) ;
 *  · §5.7 : la déduplication des sources en cours est conservée.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const updates: Array<Record<string, unknown>> = [];
let etatFichier: string | null = null;
/** Fichiers que la reprise serveur verrait comme « échec récupérable ». */
let candidatsReprise: number[] = [];
vi.mock('@/db', () => ({
  db: {
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => { updates.push(patch); },
      }),
    }),
    // Chaîne « thenable » : sert l'état lu par la file (`{ state }`), et les
    // comptes puis candidats lus par la reprise serveur (`analysis-recovery`).
    select: (champs: Record<string, unknown> = {}) => {
      const resultat = () => {
        if ('state' in champs) return [{ state: etatFichier }];
        if ('analysisState' in champs) {
          return etatFichier === 'ANALYSIS_FAILED'
            ? candidatsReprise.map((id) => ({ id, accountId: 1, analysisState: 'ANALYSIS_FAILED', updatedAt: new Date(0) }))
            : [];
        }
        return [{ id: 1 }];
      };
      const c: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'limit']) c[m] = () => c;
      c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resultat()).then(ok, ko);
      return c;
    },
  },
  // Dépôt réel de la file, base factice : aucun job durable, T1 activé.
  pgClient: { unsafe: async () => [] },
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => 7 }));

let delaiGlobal: number | null = 15 * 60_000;
vi.mock('../../queue/job-context', async (orig) => ({
  ...(await orig<typeof import('../../queue/job-context')>()),
  executionTimeoutMs: () => delaiGlobal,
}));

vi.mock('@/lib/job-lock', () => ({ withJobLock: async (_n: string, _t: number, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/services/commercial-model.service', () => ({ canConsumeAnalysis: async () => ({ allowed: true }) }));

const analyze = vi.fn();
vi.mock('../entrypoint', () => ({ analyzeFileSources: (...a: unknown[]) => analyze(...a) }));

const { enqueueFileAnalyses, getAnalysisQueueState, isFileQueuedInMemory, __resetAnalysisQueueForTests } = await import('../analysis-queue');
const { requeueRunning } = await import('../../queue/job-queue.repository');
const { countMemoryExecutions } = await import('../../queue/execution-control');
const { runAnalysisRecovery } = await import('@/services/document-ai/analysis-recovery.service');
type Guard = import('../../queue/execution-control').ExecutionGuard;

const attendre = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

beforeEach(() => {
  __resetAnalysisQueueForTests();
  updates.length = 0;
  analyze.mockReset();
  etatFichier = null;
  delaiGlobal = 15 * 60_000;
  delete process.env.AI_DURABLE_QUEUE;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { __resetAnalysisQueueForTests(); vi.restoreAllMocks(); });

describe('rollback pendant une analyse en file mémoire (VER-017)', () => {
  it('l’analyse est interrompue, n’écrit rien, et reprend en tête', async () => {
    const ecrits: string[] = [];
    let versions: Array<unknown> = [];
    analyze.mockImplementationOnce(async (_ids: number[], _acc: number, opts: { guard: Guard }) => {
      // L'appel modèle « répond » après le rollback…
      await new Promise((r) => opts.guard.signal.addEventListener('abort', r));
      // …et le pipeline contrôle la garde avant d'écrire.
      await opts.guard.assertActive('persistance du résultat');
      ecrits.push('résultat');
    });
    analyze.mockImplementationOnce(async () => { versions = ['reprise']; });

    await enqueueFileAnalyses([11], 1, { origin: 'test' });
    await attendre(() => countMemoryExecutions('T1') === 1);

    const n = await requeueRunning('T1', 'restauration de la version 3');
    expect(n).toBe(1);

    await attendre(() => analyze.mock.calls.length === 2 && versions.length === 1);
    expect(ecrits).toEqual([]);
    expect(analyze).toHaveBeenCalledTimes(2);
    // Remise « En file d'attente » (pas ANALYSIS_FAILED), avant la reprise.
    expect(updates.some((u) => u.analysisState === 'ANALYSIS_FAILED')).toBe(false);
    expect(updates.some((u) => u.analysisState === 'UPLOADED')).toBe(true);
    await attendre(() => countMemoryExecutions('T1') === 0);
    expect(countMemoryExecutions('T1')).toBe(0);
  });

  it('sans exécution en cours, le rollback ne compte rien de plus', async () => {
    expect(await requeueRunning('T1', 'rollback')).toBe(0);
  });
});

describe('délai global en file mémoire (GEN-012)', () => {
  // Revue lot 3 : le moteur historique (AI_UNIFIED_SOURCE_ANALYSIS=legacy)
  // ignore la garde. Au dépassement, l'exécution continue d'écrire : aucune
  // seconde analyse ne doit démarrer avant sa fin réelle — ni par la file, ni
  // par la reprise serveur.
  const ignoreLaGarde = (dureeMs: number, journal: string[]) => async () => {
    journal.push('début');
    await new Promise((r) => setTimeout(r, dureeMs));
    journal.push('fin');
  };

  it('fin réelle dans le délai de grâce : place tenue, échec écrit APRÈS la fin, aucune reprise entre-temps', async () => {
    delaiGlobal = 40;
    etatFichier = 'ANALYSIS_FAILED'; // tel que la reprise le verrait
    candidatsReprise = [12];
    const journal: string[] = [];
    analyze.mockImplementation(ignoreLaGarde(70, journal));
    await enqueueFileAnalyses([12], 1, { origin: 'test' });

    // Le délai est dépassé, l'exécution tourne encore.
    await new Promise((r) => setTimeout(r, 50));
    expect(journal).toEqual(['début']);
    expect(getAnalysisQueueState().running).toBe(1);
    expect(updates.some((u) => u.analysisState === 'ANALYSIS_FAILED')).toBe(false);

    // Tour de reprise serveur pendant ce temps : fichier écarté.
    const r = await runAnalysisRecovery();
    expect(r.retried).toBe(0);
    // Nouveau dépôt / check-pending : écarté aussi.
    await expect(enqueueFileAnalyses([12], 1, { origin: 'test' })).resolves.toEqual([]);

    await attendre(() => updates.some((u) => u.analysisState === 'ANALYSIS_FAILED'));
    expect(journal).toEqual(['début', 'fin']);
    const echec = updates.find((u) => u.analysisState === 'ANALYSIS_FAILED')!;
    expect(String(echec.analysisFailReason)).toMatch(/délai global/);
    await attendre(() => getAnalysisQueueState().running === 0 && !isFileQueuedInMemory(12));
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('exécution qui dépasse aussi la grâce : place rendue, fichier réservé jusqu’à sa fin réelle', async () => {
    delaiGlobal = 20;
    etatFichier = 'ANALYSIS_FAILED';
    candidatsReprise = [15];
    const journal: string[] = [];
    analyze.mockImplementation(ignoreLaGarde(150, journal));
    await enqueueFileAnalyses([15], 1, { origin: 'test' });

    // Après délai + grâce (40 ms) : place rendue…
    await attendre(() => journal.length === 1);
    await attendre(() => getAnalysisQueueState().running === 0);
    expect(journal).toEqual(['début']);
    // …mais le fichier reste réservé : ni reprise, ni nouveau dépôt.
    expect(isFileQueuedInMemory(15)).toBe(true);
    expect((await runAnalysisRecovery()).retried).toBe(0);
    await expect(enqueueFileAnalyses([15], 1, { origin: 'test' })).resolves.toEqual([]);
    expect(updates.some((u) => u.analysisState === 'ANALYSIS_FAILED')).toBe(false);

    await attendre(() => !isFileQueuedInMemory(15));
    expect(journal).toEqual(['début', 'fin']);
    expect(updates.some((u) => u.analysisState === 'ANALYSIS_FAILED')).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(1);

    // Une fois terminée, la reprise peut relancer le fichier — une seule fois.
    await runAnalysisRecovery();
    await attendre(() => analyze.mock.calls.length === 2);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('pipeline unifié (respecte la garde) : coupé au délai, échec écrit aussitôt', async () => {
    delaiGlobal = 30;
    let signal: AbortSignal | undefined;
    analyze.mockImplementation(async (_ids: number[], _acc: number, opts: { guard: Guard }) => {
      signal = opts.guard.signal;
      await new Promise((r) => opts.guard.signal.addEventListener('abort', r));
      await opts.guard.assertActive('persistance du résultat');
    });
    await enqueueFileAnalyses([16], 1, { origin: 'test' });
    await attendre(() => updates.some((u) => u.analysisState === 'ANALYSIS_FAILED'));
    expect(signal?.aborted).toBe(true);
    await attendre(() => !isFileQueuedInMemory(16));
    expect(getAnalysisQueueState()).toMatchObject({ pending: 0, running: 0 });
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});

describe('déduplication conservée (§5.7)', () => {
  it('une source déjà ANALYZING n’est pas relancée par la file mémoire', async () => {
    etatFichier = 'ANALYZING';
    await enqueueFileAnalyses([13], 1, { origin: 'test' });
    await attendre(() => getAnalysisQueueState().running === 0 && !isFileQueuedInMemory(13));
    expect(analyze).not.toHaveBeenCalled();
  });

  it('la reprise serveur non facturée garde sa non-facturation', async () => {
    let opts: Record<string, unknown> = {};
    analyze.mockImplementation(async (_i: unknown, _a: unknown, o: Record<string, unknown>) => { opts = o; });
    await enqueueFileAnalyses([14], 1, { origin: 'analysis-recovery', billable: false });
    await attendre(() => analyze.mock.calls.length === 1);
    expect(opts).toMatchObject({ billable: false, origin: 'analysis-recovery (file)' });
  });
});
