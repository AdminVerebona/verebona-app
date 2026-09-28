/**
 * File de purge du stockage : ordre `scheduled_for`, lots successifs, backoff
 * et exclusion après MAX_ATTEMPTS ; suppression directe au mieux.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

type Row = { id: number; storagePath: string; attemptCount: number };
const st = {
  batches: [] as Row[][],
  queries: [] as { where: unknown; orderBy: unknown[]; limit: number }[],
  updates: [] as { set: Record<string, unknown>; where: unknown }[],
};

vi.mock('@/db', () => ({
  db: {
    select: () => {
      const q = { where: null as unknown, orderBy: [] as unknown[], limit: 0 };
      const c: Record<string, unknown> = {
        from: () => c,
        where: (w: unknown) => { q.where = w; return c; },
        orderBy: (...o: unknown[]) => { q.orderBy = o; return c; },
        limit: (n: number) => { q.limit = n; st.queries.push(q); return Promise.resolve(st.batches.shift() ?? []); },
      };
      return c;
    },
    update: () => {
      const u = { set: {} as Record<string, unknown>, where: null as unknown };
      const c: Record<string, unknown> = {
        set: (v: Record<string, unknown>) => { u.set = v; return c; },
        where: (w: unknown) => { u.where = w; st.updates.push(u); return Promise.resolve([]); },
      };
      return c;
    },
  },
}));

const { purgePendingBlobs, deleteStorageObjects, backoffMs, MAX_ATTEMPTS } = await import('../blob-purge.service');

const NOW = new Date('2026-09-28T03:00:00Z');
const sqlOf = (x: unknown) => new PgDialect().sqlToQuery(x as never);

beforeEach(() => {
  st.batches = []; st.queries = []; st.updates = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('purgePendingBlobs', () => {
  it('lit la file dans l’ordre scheduled_for, id, hors lignes traitées ou épuisées', async () => {
    st.batches = [[{ id: 1, storagePath: 'a', attemptCount: 0 }]];
    const del = vi.fn(async () => {});
    const r = await purgePendingBlobs({ now: NOW, deleteObject: del });
    expect(r).toEqual({ processed: 1, failed: 0, abandoned: 0 });
    const q = st.queries[0];
    const where = sqlOf(q.where);
    expect(where.sql).toContain('"processed_at" is null');
    expect(where.sql).toContain('"scheduled_for" <= $');
    expect(where.sql).toContain('"attempt_count" < $');
    expect(where.params).toContain(MAX_ATTEMPTS);
    expect(q.orderBy.map(o => sqlOf(o).sql)).toEqual([
      '"pending_blob_deletions"."scheduled_for" asc', '"pending_blob_deletions"."id" asc',
    ]);
    expect(st.updates[0].set).toMatchObject({ processedAt: NOW, errorMessage: null });
  });

  it('un échec incrémente attempt_count et repousse scheduled_for (backoff)', async () => {
    st.batches = [[{ id: 1, storagePath: 'a', attemptCount: 2 }, { id: 2, storagePath: 'b', attemptCount: 0 }]];
    const del = vi.fn(async (k: string) => { if (k === 'a') throw new Error('AccessDenied'); });
    const r = await purgePendingBlobs({ now: NOW, deleteObject: del });
    expect(r).toEqual({ processed: 1, failed: 1, abandoned: 0 });
    const echec = st.updates.find(u => u.set.attemptCount !== undefined)!;
    expect(echec.set).toMatchObject({ attemptCount: 3, errorMessage: 'AccessDenied' });
    expect((echec.set.scheduledFor as Date).getTime()).toBe(NOW.getTime() + backoffMs(3));
    // La ligne suivante est traitée malgré l'échec : la file n'est pas bloquée.
    expect(del).toHaveBeenCalledWith('b');
  });

  it('dernier échec autorisé : ligne comptée comme abandonnée', async () => {
    st.batches = [[{ id: 1, storagePath: 'a', attemptCount: MAX_ATTEMPTS - 1 }]];
    const r = await purgePendingBlobs({ now: NOW, deleteObject: async () => { throw new Error('x'); } });
    expect(r.abandoned).toBe(1);
    expect(st.updates[0].set.attemptCount).toBe(MAX_ATTEMPTS);
  });

  it('enchaîne les lots tant qu’ils sont pleins, dans la limite de maxBatches', async () => {
    const full = (base: number) => [0, 1].map(i => ({ id: base + i, storagePath: `k${base + i}`, attemptCount: 0 }));
    st.batches = [full(1), full(3), [{ id: 5, storagePath: 'k5', attemptCount: 0 }]];
    const r = await purgePendingBlobs({ now: NOW, deleteObject: async () => {}, batchSize: 2 });
    expect(r.processed).toBe(5);
    expect(st.queries).toHaveLength(3);

    st.batches = [full(1), full(3), full(5)];
    st.queries = [];
    await purgePendingBlobs({ now: NOW, deleteObject: async () => {}, batchSize: 2, maxBatches: 2 });
    expect(st.queries).toHaveLength(2);
  });

  it('backoff : 1 h, 2 h, 4 h…', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([3_600_000, 7_200_000, 14_400_000]);
  });
});

describe('deleteStorageObjects', () => {
  it('renvoie séparément les clés supprimées et en échec, sans lever', async () => {
    const r = await deleteStorageObjects(['a', 'b'], async (k) => { if (k === 'b') throw new Error('down'); });
    expect(r).toEqual({ deleted: ['a'], failed: ['b'] });
  });
});

describe('câblage', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('la route cron délègue au service ; la tâche interne est planifiée', () => {
    expect(read('src/app/api/cron/purge-blobs/route.ts')).toContain('purgePendingBlobs()');
    expect(read('src/services/scheduling/daily-maintenance-scheduler.ts')).toContain("lock: 'daily-blob-purge'");
  });

  it('migration 0211 idempotente et colonne dans le schéma', () => {
    const sql = read('src/db/migrations/0211_pending_blob_deletions_attempts.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(read('src/db/schema.ts')).toContain("attemptCount: integer('attempt_count').notNull().default(0)");
  });
});
