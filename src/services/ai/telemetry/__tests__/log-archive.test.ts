/**
 * Archivage S3 des logs IA — WF-25, WF-45, LOG-UI-09.
 */
import { gunzipSync } from 'node:zlib';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();
const txUnsafe = vi.fn(async (_q: string, _p?: unknown[]) => [] as unknown[]);
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: (sql: string, p: unknown[]) => unsafe(sql, p),
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({ unsafe: txUnsafe }),
  },
}));

const { archiveAiLogs, sanitizeForArchive, archiveKey, archiveAfterDays, ARCHIVED_TABLES } = await import('../log-archive.job');

beforeEach(() => {
  unsafe.mockReset();
  txUnsafe.mockClear();
});

describe('WF-45 : aucun contenu conversationnel T2 archivé', () => {
  it('aperçu de sortie jamais archivé ; erreur et métadonnées T2 réduites', () => {
    expect(sanitizeForArchive('ai_pipeline_step', { output_preview: 'réponse', error_message: 'x', use_case_code: 'SOURCE_ANALYSIS' }))
      .toMatchObject({ output_preview: null, error_message: 'x' });
    const t2 = sanitizeForArchive('ai_usage_event', {
      use_case_code: 'INTELLIGENT_ASSISTANT', error_message: 'le texte de l’utilisateur',
      metadata: { traceId: 't', promptVersion: 'p', pricing: null, question: 'secret' },
    });
    expect(t2.error_message).toBeNull();
    expect(t2.metadata).toEqual({ traceId: 't', promptVersion: 'p', pricing: null });
  });
});

describe('CDC Mascotte LOG-006 : journal T6 soumis à la rétention BO IA', () => {
  it('home_mascot_generations est archivée ; entrée et sortie T6 jamais dans l’archive', () => {
    expect(ARCHIVED_TABLES).toContain('home_mascot_generations');
    const row = sanitizeForArchive('home_mascot_generations', {
      id: 1, status: 'generated', input_json: { subjects: ['Maison'] }, output_json: { messages: [] }, trace_id: 't',
    });
    expect(row).toMatchObject({ id: 1, status: 'generated', trace_id: 't', input_json: null, output_json: null });
  });

  it('une journée échue du journal T6 est déposée, enregistrée puis retirée (sans agrégat de coûts)', async () => {
    const put = vi.fn(async () => {});
    unsafe.mockImplementation(async (sql: string) => {
      if (/SELECT DISTINCT/.test(sql) && /FROM home_mascot_generations/.test(sql)) return [{ d: '2026-06-02' }];
      if (/SELECT DISTINCT/.test(sql)) return [];
      if (/SELECT \* FROM home_mascot_generations/.test(sql)) {
        return unsafe.mock.calls.filter(([q]) => /SELECT \* FROM/.test(String(q))).length === 1
          ? [{ id: 5, input_json: { secret: 'Maison' }, status: 'generated' }]
          : [];
      }
      if (/MAX\(part\)/.test(sql)) return [{ part: 0 }];
      return [];
    });
    const r = await archiveAiLogs({ store: { put }, chunk: 10 });
    expect(r.rowsArchived.home_mascot_generations).toBe(1);
    const [key, body] = put.mock.calls[0] as unknown as [string, Buffer];
    expect(key).toMatch(/home_mascot_generations\/2026\/06\/2026-06-02-part-000/);
    expect(gunzipSync(body).toString('utf8')).not.toMatch(/Maison/);
    const tx = txUnsafe.mock.calls.map(([q]) => String(q));
    expect(tx.some((q) => /ai_usage_daily_rollup/.test(q))).toBe(false);
    expect(tx.at(-1)).toMatch(/DELETE FROM home_mascot_generations/);
  });
});

describe('archivage (WF-25)', () => {
  it('88 jours complets par défaut, clé S3 par table et par jour', () => {
    expect(archiveAfterDays({} as NodeJS.ProcessEnv)).toBe(88);
    expect(archiveKey('production', 'ai_usage_event', '2026-06-01', 2)).toBe('ai-logs/production/ai_usage_event/2026/06/2026-06-01-part-002.ndjson.gz');
  });

  it('dépose d’abord sur S3, puis registre + agrégats + suppression dans une transaction', async () => {
    const put = vi.fn(async () => {});
    unsafe.mockImplementation(async (sql: string) => {
      if (/SELECT DISTINCT/.test(sql) && /FROM ai_usage_event/.test(sql)) return [{ d: '2026-06-01' }];
      if (/SELECT DISTINCT/.test(sql)) return [];
      if (/SELECT \* FROM ai_usage_event/.test(sql)) {
        return unsafe.mock.calls.filter(([q]) => /SELECT \* FROM/.test(String(q))).length === 1
          ? [{ id: 1, use_case_code: 'INTELLIGENT_ASSISTANT', error_message: 'secret', metadata: {} }, { id: 2, use_case_code: 'SOURCE_ANALYSIS' }]
          : [];
      }
      if (/MAX\(part\)/.test(sql)) return [{ part: 0 }];
      return [];
    });
    const r = await archiveAiLogs({ store: { put }, chunk: 10 });
    expect(r.rowsArchived.ai_usage_event).toBe(2);
    expect(put).toHaveBeenCalledTimes(1);
    const [key, body] = put.mock.calls[0] as unknown as [string, Buffer];
    expect(key).toMatch(/ai_usage_event\/2026\/06\/2026-06-01-part-000/);
    const lignes = gunzipSync(body).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lignes).toHaveLength(2);
    expect(JSON.stringify(lignes)).not.toMatch(/secret/);
    const tx = txUnsafe.mock.calls.map(([q]) => String(q));
    expect(tx[0]).toMatch(/INSERT INTO ai_log_archives/);
    expect(tx[1]).toMatch(/INSERT INTO ai_usage_daily_rollup/);
    expect(tx[2]).toMatch(/DELETE FROM ai_usage_event/);
  });

  it('échec du dépôt S3 : rien n’est supprimé', async () => {
    unsafe.mockImplementation(async (sql: string) => {
      if (/SELECT DISTINCT/.test(sql) && /ai_usage_event/.test(sql)) return [{ d: '2026-06-01' }];
      if (/SELECT \* FROM ai_usage_event/.test(sql)) return [{ id: 1 }];
      if (/MAX\(part\)/.test(sql)) return [{ part: 0 }];
      return [];
    });
    await expect(archiveAiLogs({ store: { put: async () => { throw new Error('S3 KO'); } } })).rejects.toThrow('S3 KO');
    expect(txUnsafe).not.toHaveBeenCalled();
  });
});
