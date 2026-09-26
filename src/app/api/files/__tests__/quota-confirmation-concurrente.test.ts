/**
 * Plafond de stockage à la confirmation — verrou par compte et nettoyage
 * des dépôts refusés (CDC BO STO-003, revue indépendante).
 *
 * Base simulée : les conditions Drizzle sont rendues en SQL (PgDialect) pour
 * en extraire les identifiants ; le verrou consultatif est un vrai mutex par
 * clé, libéré à la fin de la transaction comme `pg_advisory_xact_lock`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Row = {
  id: number; userId: number; accountId: number; size: number; uploadStatus: string;
  s3Key: string; deletedAt: Date | null; sha256Hash: string | null;
};
const state = {
  files: new Map<number, Row>(),
  blobs: [] as Array<{ fileId: number; storagePath: string }>,
  locks: new Map<string, Promise<void>>(),
  lockTaken: 0,
};
const LIMIT = 100;
const dialect = new PgDialect();
const tick = () => new Promise((r) => setTimeout(r, 1));
const paramsOf = (cond: SQL) => dialect.sqlToQuery(cond).params;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');

  function makeExecutor(release?: { fns: Array<() => void> }) {
    const select = (fields?: Record<string, unknown>) => {
      let cond: SQL | undefined;
      const run = async () => {
        await tick();
        if (fields && 'used' in fields) {
          const used = [...state.files.values()]
            .filter((f) => f.uploadStatus === 'COMPLETED' && !f.deletedAt)
            .reduce((t, f) => t + f.size, 0);
          return [{ used: String(used) }];
        }
        if (fields && 'maxStorageBytes' in fields) return [{ maxStorageBytes: LIMIT }];
        const ids = cond ? paramsOf(cond) : [];
        return [...state.files.values()].filter((f) => ids.includes(f.id)).map((f) => ({ ...f }));
      };
      const chain = {
        from: () => chain,
        where: (c: SQL) => { cond = c; return chain; },
        limit: () => run(),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
      };
      return chain;
    };
    const update = () => {
      let values: Partial<Row> = {};
      const q = {
        set: (v: Partial<Row>) => { values = v; return q; },
        where: (cond: SQL) => ({
          returning: async () => {
            await tick();
            const ids = paramsOf(cond);
            const touched: Row[] = [];
            for (const f of state.files.values()) {
              if (ids.includes(f.id) && f.uploadStatus === 'PENDING' && !f.deletedAt) {
                Object.assign(f, values);
                touched.push({ ...f });
              }
            }
            return touched;
          },
        }),
      };
      return q;
    };
    const insert = () => ({
      values: async (rows: Array<{ fileId: number; storagePath: string }>) => { state.blobs.push(...rows); },
    });
    const execute = async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      if (!sql.includes('pg_advisory_xact_lock')) return [];
      const key = String(params[0]);
      const previous = state.locks.get(key) ?? Promise.resolve();
      let unlock!: () => void;
      const mine = new Promise<void>((r) => { unlock = r; });
      state.locks.set(key, previous.then(() => mine));
      await previous;
      state.lockTaken += 1;
      release?.fns.push(unlock);
      return [];
    };
    return { select, update, insert, execute };
  }

  const db = {
    ...makeExecutor(),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const release = { fns: [] as Array<() => void> };
      try {
        return await fn(makeExecutor(release));
      } finally {
        release.fns.forEach((f) => f()); // COMMIT / ROLLBACK : verrous libérés
      }
    },
  };
  return { ...actual, db };
});
vi.mock('@/lib/auth-guards', () => ({ getSession: async () => ({ userId: 1, currentAccountId: 7 }) }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: async () => null }));
vi.mock('@/services/commercial-model.service', () => ({
  getCommercialPlanForAccount: async () => 'standard',
  canConsumeAnalysis: async () => ({ allowed: false }),
}));
vi.mock('@/services/funnel-analytics.service', () => ({ trackFunnelEvent: async () => {} }));

const { POST } = await import('../confirm/route');

function pending(id: number, size: number): Row {
  return { id, userId: 1, accountId: 7, size, uploadStatus: 'PENDING', s3Key: `k/${id}`, deletedAt: null, sha256Hash: null };
}
const confirm = (fileId: number) => POST(new NextRequest('http://x/api/files/confirm', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId }),
}));

beforeEach(() => {
  state.files.clear();
  state.blobs.length = 0;
  state.locks.clear();
  state.lockTaken = 0;
});

describe('POST /api/files/confirm — plafond de stockage', () => {
  it('deux confirmations simultanées ne dépassent pas ensemble le plafond', async () => {
    state.files.set(1, pending(1, 60));
    state.files.set(2, pending(2, 60));
    const [a, b] = await Promise.all([confirm(1), confirm(2)]);
    expect([a.status, b.status].sort()).toEqual([200, 413]);
    expect(state.lockTaken).toBe(2);
    const completed = [...state.files.values()].filter((f) => f.uploadStatus === 'COMPLETED');
    expect(completed).toHaveLength(1);
  });

  it('un dépôt refusé (413) ne laisse ni ligne PENDING ni objet S3 orphelins', async () => {
    state.files.set(1, { ...pending(1, 90), uploadStatus: 'COMPLETED' });
    state.files.set(2, pending(2, 20));
    const res = await confirm(2);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(state.files.get(2)!.deletedAt).toBeInstanceOf(Date);
    expect(state.blobs).toEqual([expect.objectContaining({ fileId: 2, storagePath: 'k/2' })]);
    // Le fichier déjà confirmé n'est pas touché.
    expect(state.files.get(1)!.deletedAt).toBeNull();
  });

  it('sous le plafond : confirmé, rien n’est programmé pour suppression', async () => {
    state.files.set(3, pending(3, 40));
    expect((await confirm(3)).status).toBe(200);
    expect(state.files.get(3)!.uploadStatus).toBe('COMPLETED');
    expect(state.blobs).toHaveLength(0);
  });
});
