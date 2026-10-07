/**
 * Lot 26, point 17 — la prise de parole de la mascotte s'affiche sans
 * attendre le modèle (CDC Mascotte RUN-001, RUN-002, RUN-010, RUN-011).
 *
 *   AC17-1 : à l'affichage, une génération T6 n'est jamais attendue par
 *            défaut — texte déterministe tout de suite ;
 *   AC17-2 : la génération continue en arrière-plan, écrit le cache du compte
 *            sous SA clé, est journalisée en pré-génération (non affichée) ;
 *            l'affichage suivant du même contexte sert la formulation T6 ;
 *   AC17-3 : les lectures préalables (disponibilité, version, cache, bulles
 *            précédentes) partent en parallèle ;
 *   AC17-4 : `MASCOT_T6_DISPLAY_WAIT_MS` borne une attente facultative (0–6000).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const execute = vi.fn();
const cacheRows = new Map<string, unknown>();
const logs: Array<{ mode: string; status: string }> = [];
const unsafe = vi.fn(async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
  if (/SELECT messages FROM home_mascot_cache/.test(sql)) {
    const m = cacheRows.get(String(p[1]));
    return m ? [{ messages: m }] : [];
  }
  if (/INSERT INTO home_mascot_cache/.test(sql)) { cacheRows.set(String(p[1]), JSON.parse(String(p[5]))); return []; }
  if (/INSERT INTO home_mascot_generations/.test(sql)) { logs.push({ mode: String(p[2]), status: String(p[3]) }); return []; }
  return [];
});
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute: (r: unknown) => execute(r) } }));
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
vi.mock('@/services/ai/config/config-resolver', () => ({ resolveOperationConfig: async () => ({ masterPromptText: null, configVersionId: 3 }) }));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));

const { buildT6Input } = await import('../t6-contract');
const R = await import('../t6-runner');

const input = buildT6Input([{
  subjectId: 'DATE-NEXT:1', sourceFamily: 'DATE', sourceCode: 'DATE-NEXT', accountId: 7,
  priority: null, requiresAttention: false, intent: 'deadline',
  facts: { title: 'Ramonage', dateLabel: '15 octobre 2026', date: '2026-10-15', dateNature: 'confirmée' }, actions: [],
  fallbackText: 'Votre prochaine échéance est « Ramonage », le 15 octobre 2026.',
  allowedHighlight: '15 octobre 2026', occurrenceKey: 'DATE-NEXT:1', dedupeKeys: [], secondaryLabel: '',
}]);
const OK = { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'DATE-NEXT:1', text: 'Le ramonage est prévu le 15 octobre 2026.', highlight: '15 octobre 2026' }] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Dépendances de test (le simulacre de passerelle n'est pas typé). */
const D = (d: Record<string, unknown>) => d as unknown as import('../t6-runner').T6Dependencies;

describe('affichage immédiat de la mascotte (lot 26, point 17)', () => {
  beforeEach(() => { execute.mockReset(); unsafe.mockClear(); cacheRows.clear(); logs.length = 0; R.resetT6Breaker(); });

  it('AC17-1 / AC17-2 — défaut : secours immédiat, génération en arrière-plan, puis formulation servie depuis le cache', async () => {
    let finir!: () => void;
    execute.mockImplementation(() => new Promise((resolve) => {
      finir = () => resolve({ data: OK, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' });
    }));
    const deps = D({ treatmentAvailable: async () => true, promptVersion: async () => 'v-imm', execute: (r: unknown) => execute(r) });

    const t0 = Date.now();
    const o = await R.formulateWithT6({ accountId: 7, input, contextHash: 'imm', mode: 'display' }, deps);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(o).toMatchObject({ status: 'fallback', messages: null, error: R.T6_BACKGROUND_NOTE });
    expect(execute).toHaveBeenCalledTimes(1); // la génération est bien partie

    // Le modèle répond plus tard : cache écrit, appel journalisé en pré-génération.
    finir();
    await sleep(10);
    expect(cacheRows.size).toBe(1);
    expect(logs).toContainEqual({ mode: 'pregen', status: 'generated' });

    // Affichage suivant, même contexte : la formulation T6, sans nouvel appel.
    const o2 = await R.formulateWithT6({ accountId: 7, input, contextHash: 'imm', mode: 'display' }, deps);
    expect(o2.status).toBe('cache_hit');
    expect(o2.messages?.[0].text).toBe(OK.messages[0].text);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('AC17-2 — deux affichages rapprochés pendant la génération : un seul appel modèle', async () => {
    execute.mockImplementation(() => new Promise(() => {}));
    const deps = D({ treatmentAvailable: async () => true, promptVersion: async () => 'v-dedup', execute: (r: unknown) => execute(r) });
    await R.formulateWithT6({ accountId: 7, input, contextHash: 'd', mode: 'display' }, deps);
    await R.formulateWithT6({ accountId: 7, input, contextHash: 'd', mode: 'display' }, deps);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('AC17-3 — disponibilité et version, puis cache et bulles précédentes : lus en parallèle', async () => {
    const debuts: Record<string, number> = {};
    const lent = <T>(nom: string, v: T) => async () => { debuts[nom] = Date.now(); await sleep(40); return v; };
    execute.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    await R.formulateWithT6({ accountId: 7, input, contextHash: 'par', mode: 'display' }, D({
      treatmentAvailable: lent('dispo', true),
      promptVersion: lent('version', 'v-par'),
      previousBubbles: async () => { debuts.bulles = Date.now(); await sleep(40); return []; },
      execute: (r: unknown) => execute(r),
    }));
    // Deux étapes de 40 ms (et non quatre) : ≈ 80 ms.
    expect(Date.now() - t0).toBeLessThan(150);
    expect(Math.abs(debuts.dispo - debuts.version)).toBeLessThan(15);
  });

  it('AC17-4 — MASCOT_T6_DISPLAY_WAIT_MS : absent → 0 ; borné à 6000 ; invalide → 0', () => {
    expect(R.t6DisplayWaitMs({} as unknown as NodeJS.ProcessEnv)).toBe(0);
    expect(R.t6DisplayWaitMs({ MASCOT_T6_DISPLAY_WAIT_MS: '1500' } as unknown as NodeJS.ProcessEnv)).toBe(1500);
    expect(R.t6DisplayWaitMs({ MASCOT_T6_DISPLAY_WAIT_MS: '60000' } as unknown as NodeJS.ProcessEnv)).toBe(6000);
    expect(R.t6DisplayWaitMs({ MASCOT_T6_DISPLAY_WAIT_MS: 'abc' } as unknown as NodeJS.ProcessEnv)).toBe(0);
    expect(R.t6DisplayWaitMs({ MASCOT_T6_DISPLAY_WAIT_MS: '-5' } as unknown as NodeJS.ProcessEnv)).toBe(0);
  });

  it('AC17-4 — attente configurée : une génération rapide est affichée', async () => {
    execute.mockResolvedValue({ data: OK, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' });
    const o = await R.formulateWithT6({ accountId: 7, input, contextHash: 'att', mode: 'display' }, D({
      treatmentAvailable: async () => true, promptVersion: async () => 'v-att', execute: (r: unknown) => execute(r), displayWaitMs: () => 1_000,
    }));
    expect(o.status).toBe('generated');
  });

  it('AC17-5 — client : lecture lancée au montage de la page, mémoire liée à la session, jamais de texte remplacé (RUN-001)', () => {
    const hook = readFileSync(join(process.cwd(), 'src/components/home/useMascotPresentation.ts'), 'utf-8');
    const page = readFileSync(join(process.cwd(), 'src/app/(dashboard)/accueil/page.tsx'), 'utf-8');
    expect(page).toMatch(/useEffect\(\(\) => \{ prefetchMascotPresentation\(\); \}, \[\]\)/);
    expect(hook).toMatch(/getSessionEpoch\(\)/);
    expect(hook).toMatch(/verebona:session-changed', purgeMascotPresentationMemory/);
    expect(hook).not.toMatch(/localStorage\.setItem|sessionStorage/);
    expect(hook).toMatch(/prev && prev\.contextHash === data\.contextHash \? prev : data/);
  });
});
