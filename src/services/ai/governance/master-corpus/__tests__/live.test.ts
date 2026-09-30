/**
 * CDC 15 D-17 — passage RÉEL du corpus (préprod) : variables réelles des cas
 * du sous-ensemble critique, appel par la passerelle, mêmes contrôles.
 * Ici la passerelle est simulée (sortie = sortie enregistrée du cas).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn() }, db: {} }));
const execute = vi.fn();
vi.mock('../../../gateway/ai-gateway', () => ({ AiGateway: { execute: (r: unknown) => execute(r) } }));

const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('../cases');
const { liveVariablesFor, buildLiveRunner } = await import('../live');
const { runMasterCorpus } = await import('../runner');
const { listMasterPrompts } = await import('../../../registry/operations');

const cases = loadMasterCorpusCases(readMasterFileFromRepo);

describe('sous-ensemble critique du passage réel', () => {
  it('chaque branche de chaque master a au moins un cas à variables réelles', async () => {
    for (const m of listMasterPrompts()) {
      for (const t of m.tasks) {
        const reels = [];
        for (const c of cases.filter((x) => x.masterPromptCode === m.masterPromptCode && x.task === t)) {
          if (await liveVariablesFor(c)) reels.push(c.id);
        }
        expect(reels.length, `${m.masterPromptCode}/${t}`).toBeGreaterThan(0);
      }
    }
  });

  it('cas à pièce jointe (REVALIDATE visuel) hors sous-ensemble ; variables réelles construites par les constructeurs de production', async () => {
    expect(await liveVariablesFor(cases.find((c) => c.id === 'P-T2-04')!)).toBeNull();
    const t6 = await liveVariablesFor(cases.find((c) => c.id === 'P-T6-01')!);
    expect(Object.keys(t6!)).toEqual(['INPUT_JSON']);
    const t1 = await liveVariablesFor(cases.find((c) => c.id === 'P-T1-02')!);
    expect(String(t1!.EXTRACTED_CONTENT)).toContain('DRAISIENNE BOIS');
  });

  it('runner en mode réel : appel par la passerelle (compte technique), contrôles serveur, cas ignorés signalés', async () => {
    execute.mockReset().mockImplementation(async (req: { operationCode: string; idempotencyKey: string }) => {
      const id = req.idempotencyKey.split(':')[1];
      return { data: cases.find((c) => c.id === id && c.operationCode === req.operationCode)!.output };
    });
    const live = await buildLiveRunner(cases, { accountId: 42, userId: 3 });
    const r = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, cases, live });
    expect(r.every((m) => m.status === 'PASSED')).toBe(true);
    expect(r.find((m) => m.masterPromptCode === 't2_master_v1')!.skipped).toContain('P-T2-04');
    expect(execute.mock.calls.every(([x]) => (x as { accountId: number }).accountId === 42)).toBe(true);
  });

  it('sortie réelle contraire à l’attendu : rouge', async () => {
    execute.mockReset().mockImplementation(async (req: { operationCode: string; idempotencyKey: string }) => {
      const id = req.idempotencyKey.split(':')[1];
      const out = cases.find((c) => c.id === id && c.operationCode === req.operationCode)!.output as Record<string, unknown>;
      return { data: id === 'P-T4-01' ? { ...out, homeCategory: 'information' } : out };
    });
    const live = await buildLiveRunner(cases, { accountId: 42, userId: 3 });
    const [t4] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, cases, live, treatments: ['T4'] });
    expect(t4.status).toBe('FAILED');
  });
});
