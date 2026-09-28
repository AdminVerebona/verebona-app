/**
 * GEN-005 — mesure unique par la passerelle : `AiUsageTracker` ne mesure plus
 * ni coût ni jetons, n'écrit plus de ligne `ai_usage_event`, et garde le
 * quota et les verrous de sécurité.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

type Table = Parameters<typeof getTableName>[0];
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
let selectRows: unknown[] = [];

function chain(result: () => unknown[]) {
  const c: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'limit', 'orderBy', 'groupBy']) c[k] = () => c;
  c.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
  return c;
}

vi.mock('@/db', () => ({
  db: {
    select: () => chain(() => selectRows),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table), values });
        const p = Promise.resolve();
        return Object.assign(p, {
          returning: async () => [{ id: 99 }],
          onConflictDoUpdate: async () => undefined,
        });
      },
    }),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { updates.push({ table: getTableName(table), values }); },
      }),
    }),
  },
}));

const { AiUsageTracker } = await import('../ai-usage-tracker');

beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  vi.restoreAllMocks();
});

describe('AiUsageTracker — GEN-005', () => {
  it('completeOperation relit coût et jetons dans les étapes de la passerelle, sans ligne ai_usage_event', async () => {
    selectRows = [{
      startedAt: new Date(), accountId: 7, isBillable: true, operationCategory: 'document_analysis',
      assetFileId: 21, pipelineVersion: null, providerPrimary: 'gemini',
    }];
    const totals = vi.spyOn(AiUsageTracker, 'gatewayTotals').mockResolvedValue({ costMicros: 1234, inputTokens: 10, outputTokens: 5 });
    const counter = vi.spyOn(AiUsageTracker, 'incrementAnalysisCounter').mockResolvedValue();
    const version = vi.spyOn(AiUsageTracker, 'recordAnalysisVersion').mockResolvedValue();

    await AiUsageTracker.completeOperation({ operationId: 5, businessResult: 'success' });

    expect(totals).toHaveBeenCalledWith(5);
    const op = updates.find((u) => u.table === 'ai_operation');
    expect(op?.values).toMatchObject({ businessResult: 'success', totalCostMicros: 1234, totalInputTokens: 10, totalOutputTokens: 5 });
    expect(version).toHaveBeenCalledWith(expect.objectContaining({ totalCostMicros: 1234 }));
    // Quota inchangé : une analyse documentaire réussie est comptée.
    expect(counter).toHaveBeenCalledWith(7);
    // Plus de seconde mesure dans ai_usage_event.
    expect(inserts.filter((i) => i.table === 'ai_usage_event')).toEqual([]);
  });

  it('doublon : pas de compteur d’analyses (quota inchangé)', async () => {
    selectRows = [{ startedAt: new Date(), accountId: 7, isBillable: true, operationCategory: 'document_analysis', assetFileId: null }];
    vi.spyOn(AiUsageTracker, 'gatewayTotals').mockResolvedValue({ costMicros: 0, inputTokens: 0, outputTokens: 0 });
    const counter = vi.spyOn(AiUsageTracker, 'incrementAnalysisCounter').mockResolvedValue();
    await AiUsageTracker.completeOperation({ operationId: 5, businessResult: 'duplicate' });
    expect(counter).not.toHaveBeenCalled();
  });

  it('completeStep : jalon sans coût, aucune agrégation dans l’opération', async () => {
    selectRows = [{ startedAt: new Date(), operationId: 5 }];
    await AiUsageTracker.completeStep({ stepId: 3, status: 'done' });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('ai_pipeline_step');
    expect(updates[0].values).not.toHaveProperty('costMicros');
    expect(updates.some((u) => u.table === 'ai_operation')).toBe(false);
  });

  it('les options de mesure ont disparu de l’API du tracker', () => {
    expect((AiUsageTracker as unknown as Record<string, unknown>).logUsageEvent).toBeUndefined();
  });

  it('verrou de sécurité « coût aberrant » conservé', async () => {
    const lock = vi.spyOn(AiUsageTracker, 'triggerSecurityLock').mockResolvedValue();
    await AiUsageTracker.checkSecurityRules({ accountId: 7, totalCostMicros: 60_000, checkCost: true });
    expect(lock).toHaveBeenCalledWith(expect.objectContaining({ accountId: 7, lockType: 'aberrant_cost' }));
  });

  it('quota : verrou actif → refus', async () => {
    selectRows = [{ id: 1 }];
    await expect(AiUsageTracker.checkQuota(7)).resolves.toEqual({ allowed: false, reason: 'security_lock' });
  });
});
