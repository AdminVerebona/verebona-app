/**
 * Cycle de vie des fichiers générés : expiration à 30 jours (DRH-005/006) —
 * statut « expired », objets confiés à la file de purge du stockage, entrée
 * d'historique conservée ; tâche quotidienne planifiée avant la purge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

type Row = Record<string, unknown>;
const state = { rows: [] as Row[], pending: [] as Row[], inserts: [] as Array<{ table: string; values: Row[] }>, updates: [] as Array<{ table: string; set: Row }>, served: 0 };

const tableOf = (t: unknown) => { try { return getTableName(t as never); } catch { return '?'; } };
function chain(kind: 'select' | 'insert' | 'update') {
  let table = '?';
  const c: Record<string, unknown> = {};
  c.from = (t: unknown) => { table = tableOf(t); return c; };
  c.where = () => c;
  c.limit = () => c;
  c.set = (v: Row) => { state.updates.push({ table, set: v }); return c; };
  c.values = (v: Row[]) => { state.inserts.push({ table, values: v }); return c; };
  c.__t = (t: unknown) => { table = tableOf(t); };
  c.then = (res: (v: unknown) => void) => {
    if (kind !== 'select') return res([]);
    if (table === 'export_generation') { const out = state.served === 0 ? state.rows : []; state.served++; return res(out); }
    if (table === 'pending_blob_deletions') return res(state.pending);
    return res([]);
  };
  return c;
}
vi.mock('@/db', () => {
  const db: Record<string, unknown> = {
    select: () => chain('select'),
    insert: (t: unknown) => { const c = chain('insert'); (c.__t as (t: unknown) => void)(t); return c; },
    update: (t: unknown) => { const c = chain('update'); (c.__t as (t: unknown) => void)(t); return c; },
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});
vi.mock('@/services/storage/blob-purge.service', () => ({ deleteStorageObjects: async (keys: string[]) => ({ deleted: keys, failed: [] }) }));

const { expireExportGenerations } = await import('../generation/files');
const { dailyTasks } = await import('@/services/scheduling/daily-maintenance-scheduler');

beforeEach(() => {
  state.rows = []; state.pending = []; state.inserts = []; state.updates = []; state.served = 0;
});

describe('Expiration à 30 jours (DRH-005/006)', () => {
  it('générations échues → « expired », objets PDF et ZIP en file de purge (sans doublon)', async () => {
    state.rows = [
      { id: 1, outputPayload: JSON.stringify({ pdfS3Key: 'exports/1/2/1/a.pdf', zipS3Key: 'exports/1/2/1/a.zip' }) },
      { id: 2, outputPayload: JSON.stringify({ pdfS3Key: 'exports/1/2/2/b.pdf' }) },
    ];
    state.pending = [{ storagePath: 'exports/1/2/2/b.pdf' }];
    const now = new Date('2026-10-28T05:00:00Z');
    const r = await expireExportGenerations(now);
    expect(r).toEqual({ expired: 2, blobsQueued: 2 });
    const queued = state.inserts.find((i) => i.table === 'pending_blob_deletions')!.values.map((v) => v.storagePath);
    expect(queued).toEqual(['exports/1/2/1/a.pdf', 'exports/1/2/1/a.zip']);
    const upd = state.updates.find((u) => u.table === 'export_generation')!;
    expect(upd.set).toMatchObject({ status: 'expired', fileKey: null });
    expect(String(upd.set.outputPayload)).not.toMatch(/S3Key/);
  });

  it('rien à expirer : aucune écriture', async () => {
    expect(await expireExportGenerations()).toEqual({ expired: 0, blobsQueued: 0 });
    expect(state.updates).toHaveLength(0);
  });

  it('tâche quotidienne planifiée juste avant la purge du stockage ; EXPORTS_EXPIRY=off la retire', () => {
    const locks = dailyTasks({} as NodeJS.ProcessEnv).map((t) => t.lock);
    expect(locks.indexOf('daily-exports-expiry')).toBe(locks.indexOf('daily-blob-purge') - 1);
    expect(dailyTasks({ EXPORTS_EXPIRY: 'off' } as unknown as NodeJS.ProcessEnv).map((t) => t.lock)).not.toContain('daily-exports-expiry');
  });
});
