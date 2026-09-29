/**
 * Relecture lot 11 — traces : écritures isolées (étape / usage) et champs de
 * la migration 0217 écrits à part, seulement si la migration est en place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
const updates: unknown[][] = [];
let echecEtape = false;
let colonnes = 6;

vi.mock('@/db', () => ({
  db: {
    insert: (table: { __name: string }) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          if (table.__name === 'step' && echecEtape) throw new Error('étape : colonne absente');
          inserts.push({ table: table.__name, values });
          return [{ id: inserts.length }];
        },
      }),
    }),
  },
  pgClient: {
    unsafe: async (text: string, params: unknown[]) => {
      if (text.includes('information_schema')) return [{ n: colonnes }];
      updates.push([text, ...params]);
      return [];
    },
  },
}));
vi.mock('@/db/schema', () => ({
  aiPipelineStep: { __name: 'step', id: 'id' },
  aiUsageEvent: { __name: 'usage', id: 'id' },
}));

const { recordCallTrace } = await import('../ai-trace.service');
const { __resetTraceSchemaForTests } = await import('../trace-schema');

const trace = (over: Record<string, unknown> = {}) => ({
  traceId: 't', useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: 'extract_source', accountId: 1,
  provider: 'fake', model: 'm', promptVersion: 'v', usedFallback: false, inputTokens: 1, outputTokens: 1,
  costMicros: 0, durationMs: 1, status: 'success' as const, billable: true, shadow: false, ...over,
});

beforeEach(() => {
  inserts.length = 0; updates.length = 0; echecEtape = false; colonnes = 6;
  __resetTraceSchemaForTests();
});

describe('traces IA', () => {
  it('étape en échec : l’événement d’usage est tout de même écrit', async () => {
    echecEtape = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordCallTrace(trace({ parentOperationId: 9 }));
    expect(inserts.map((i) => i.table)).toEqual(['usage']);
  });

  it('aucune colonne 0217 dans les INSERT ; TASK / master écrits à part si la migration est là', async () => {
    await recordCallTrace(trace({ parentOperationId: 9, task: 'ANALYZE_DOCUMENT', masterPromptCode: 't1_master', masterPromptVersion: '1' }));
    for (const i of inserts) expect(Object.keys(i.values)).not.toContain('task');
    expect(updates.map((u) => String(u[0]).split(' ')[1])).toEqual(['ai_pipeline_step', 'ai_usage_event']);
    expect(updates[1].slice(2)).toEqual(['ANALYZE_DOCUMENT', 't1_master', '1']);
  });

  it('0217 absente : traces écrites sans ces champs, signalé une fois', async () => {
    colonnes = 0;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordCallTrace(trace({ task: 'X' }));
    await recordCallTrace(trace({ task: 'Y' }));
    expect(inserts).toHaveLength(2);
    expect(updates).toHaveLength(0);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('0217'))).toHaveLength(1);
  });

  it('appel hors master : aucune écriture supplémentaire', async () => {
    await recordCallTrace(trace());
    expect(updates).toHaveLength(0);
  });
});
