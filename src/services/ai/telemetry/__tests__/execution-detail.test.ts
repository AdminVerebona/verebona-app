/**
 * Exécutions — filtres serveur complets (LOG-UI-02, CST-UI-10), détail
 * d'exécution (LOG-UI-04) et routage T2 (LOG-UI-06/07, SCR-07 : requête
 * déterministe visible avec zéro appel).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ sql: string; params: unknown[] }> = [];
let respond: (sql: string, params: unknown[]) => unknown[] = () => [];
vi.mock('@/db', () => ({
  pgClient: { unsafe: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return respond(sql, params); } },
}));

const { searchExecutions, getExecutionDetail } = await import('../execution-log.repository');
const { searchT2Requests } = await import('../t2-routing.repository');

const placeholders = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

beforeEach(() => { calls.length = 0; respond = () => []; });

describe('filtres des exécutions', () => {
  it('rang, utilisateur et job sont appliqués côté serveur ; dates en ISO', async () => {
    await searchExecutions({ rank: 'fallback', userId: 4, jobId: 9, since: new Date('2026-09-01T00:00:00Z') });
    const q = calls[0];
    expect(placeholders(q.sql)).toBe(q.params.length);
    expect(q.params.slice(10, 13)).toEqual([4, 'fallback', 9]);
    expect(q.params[7]).toBe('2026-09-01T00:00:00.000Z');
    expect(q.sql).toMatch(/\$12 = 'fallback'/);
  });
});

describe('filtres objet et déclencheur (LOG-UI-02, LOG-UI-03)', () => {
  it('objet (type, id) et déclencheur filtrés côté serveur, via le job parent ou le fichier source', async () => {
    respond = (sql) => (sql.includes('ORDER BY e.created_at')
      ? [{ id: 1, created_at: new Date(), status: 'success', object_type: 'asset_file', object_id: '42', trigger_code: 'manual', job_origin: 'manual', metadata: {} }]
      : [{ total: 1 }]);
    const page = await searchExecutions({ objectType: 'asset_file', objectId: '42', trigger: 'manual' });
    const q = calls[0];
    expect(placeholders(q.sql)).toBe(q.params.length);
    expect(q.params.slice(13)).toEqual(['asset_file', '42', 'manual']);
    expect(q.sql).toMatch(/LEFT JOIN ai_job_queue j ON j.id = e.job_id/);
    expect(q.sql).toMatch(/j.trigger_code = \$16 OR j.origin = \$16/);
    expect(page.rows[0]).toMatchObject({ objectType: 'asset_file', objectId: '42', trigger: 'manual', origin: 'manual' });
  });
});

describe('détail d’une exécution', () => {
  it('LOG-UI-04 : instantanés d’entrée et modifications produites (T3) ; LOG-UI-07 : sources T2', async () => {
    respond = (sql) => {
      if (sql.includes('WHERE e.id = $1')) {
        return [{ id: 7, created_at: new Date(), use_case_code: 'DATA_RECONCILIATION', status: 'success', account_id: 3,
          metadata: { traceId: 'tr-3', promptVersion: 'p3', pricing: { inputMicros: 1 } } }];
      }
      if (sql.includes("metadata->>'traceId'")) return [];
      if (sql.includes('FROM reconciliation_decisions')) {
        return [{ field_key: 'city', action: 'apply', reason_code: 'BETTER_EVIDENCE', confidence: 'certain', asset_id: 9, created_at: new Date(), shadow: false }];
      }
      return [];
    };
    const d = await getExecutionDetail(7);
    expect(d?.inputs.find((i) => i.label === 'Version de prompt')?.value).toBe('p3');
    expect(d?.inputs.find((i) => i.label === 'Tarif figé')?.value).toEqual({ inputMicros: 1 });
    expect(d?.modifications).toEqual([expect.objectContaining({ kind: 'apply', label: 'Bien 9 · city' })]);
    expect(d?.t2).toBeNull();

    calls.length = 0;
    respond = (sql) => {
      if (sql.includes('WHERE e.id = $1')) return [{ id: 8, created_at: new Date(), use_case_code: 'INTELLIGENT_ASSISTANT', status: 'success', account_id: 3, model: 'm', metadata: {} }];
      if (sql.includes('FROM verebona_ai_runs')) return [{ request_id: 'req-9' }];
      if (sql.includes('FROM verebona_message_sources')) return [{ message_id: 1, source_type: 'document', source_id: 'doc_1', title_snapshot: 'Facture', rank: 1, relevance_score: 0.8, is_available: true }];
      return [];
    };
    const t2 = await getExecutionDetail(8);
    expect(t2?.t2).toMatchObject({ requestId: 'req-9', sources: [expect.objectContaining({ sourceId: 'doc_1' })] });
  });


  it('reconstitue la trace : appels, étapes et job parent', async () => {
    const ligne = (id: number, rank: string) => ({
      id, created_at: new Date(), use_case_code: 'SOURCE_ANALYSIS', status: 'success', model_rank: rank,
      job_id: 5, metadata: { traceId: 'tr-1', promptVersion: 'v3' },
    });
    respond = (sql) => {
      if (sql.includes('WHERE e.id = $1')) return [ligne(2, 'fallback_1')];
      if (sql.includes("metadata->>'traceId'")) return [ligne(1, 'primary'), ligne(2, 'fallback_1')];
      if (sql.includes('FROM ai_pipeline_step')) return [{ step_name: 'classify', step_order: 0, status: 'done' }];
      if (sql.includes('FROM ai_job_queue')) return [{ id: 5, treatment: 'T1', status: 'DONE', origin: 'automatic', trigger_code: 'source_uploaded', attempts: 1, config_version_id: 3, created_at: new Date() }];
      return [];
    };
    const d = await getExecutionDetail(2);
    expect(d?.traceId).toBe('tr-1');
    expect(d?.calls.map((c) => c.modelRank)).toEqual(['primary', 'fallback_1']);
    expect(d?.steps).toHaveLength(1);
    expect(d?.job).toMatchObject({ id: 5, triggerCode: 'source_uploaded', configVersionId: 3 });
  });
  it('introuvable : null', async () => {
    expect(await getExecutionDetail(404)).toBeNull();
  });
});

describe('routage T2', () => {
  it('requête déterministe : zéro appel, coût nul, filtrable', async () => {
    respond = (sql) => (sql.includes('ORDER BY r.created_at')
      ? [{ id: 1, request_id: 'r1', created_at: new Date(), account_id: 2, mode: 'database', calls: 0, cost: 0, reasons: [], models: [] }]
      : [{ total: 1 }]);
    const page = await searchT2Requests({ deterministicOnly: true });
    expect(page.rows[0]).toMatchObject({ aiCalls: 0, costMicros: 0, mode: 'database' });
    expect(calls[0].params[4]).toBe(true);
    expect(placeholders(calls[0].sql)).toBe(calls[0].params.length);
    // LOG-UI-08 : aucun contenu conversationnel lu.
    expect(calls[0].sql).not.toMatch(/content|question|answer/i);
  });
});
