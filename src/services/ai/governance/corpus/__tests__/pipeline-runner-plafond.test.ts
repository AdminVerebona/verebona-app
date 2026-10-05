/**
 * Lot 22 (revue) — campagne de corpus en mode pipeline : un cas NON analysé
 * (sauté pour plafond ou pour une autre raison) n'est jamais compté valide.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let etat: string | null = null;
vi.mock('@/db', () => ({
  db: {
    insert: () => ({ values: () => ({ returning: async () => [{ id: 501 }] }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
  pgClient: (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('owner_user_id')) return Promise.resolve([{ owner_user_id: 1 }]);
    if (q.includes('FROM asset_files')) return Promise.resolve([{ document_type: null, analysis_state: etat, asset_id: null }]);
    return Promise.resolve([]);
  },
}));
const analyze = vi.fn();
vi.mock('../../../source-analysis/entrypoint', () => ({ analyzeFileSources: (...a: unknown[]) => analyze(...a) }));
vi.mock('../../../source-analysis/adapters', () => ({ registerSourceAdapter: () => undefined }));
vi.mock('../../../source-analysis/adapters/corpus-source.adapter', () => ({
  CorpusSourceAdapter: class {}, declarerFixture: () => undefined, viderFixtures: () => undefined,
}));

const { createPipelineRunner } = await import('../pipeline-runner');
const cas = { corpusCase: { caseId: 'C-01' }, content: 'x' } as never;

beforeEach(() => { vi.stubEnv('CORPUS_ACCOUNT_ID', '9'); analyze.mockReset(); });

describe('runner pipeline : cas sauté jamais valide', () => {
  it('plafond (ou autre saut) : schemaValid = false, même sans ANALYSIS_FAILED', async () => {
    etat = 'UPLOADED';
    analyze.mockResolvedValueOnce({ results: [], analysedCount: 0, failedSourceIds: [], skippedReason: 'cost_cap', costCapSourceIds: [501] });
    expect((await createPipelineRunner()(cas)).schemaValid).toBe(false);
    etat = null;
    analyze.mockResolvedValueOnce({ results: [], analysedCount: 0, failedSourceIds: [], skippedReason: 'quota' });
    expect((await createPipelineRunner()(cas)).schemaValid).toBe(false);
  });
  it('analyse menée : valide', async () => {
    etat = 'ANALYZED';
    analyze.mockResolvedValueOnce({ results: [{}], analysedCount: 1, failedSourceIds: [] });
    expect((await createPipelineRunner()(cas)).schemaValid).toBe(true);
  });
});
