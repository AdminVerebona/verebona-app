/**
 * deleteAssetCompletely : les objets de stockage (fichiers, versions, exports,
 * vignette) sont mis en file de purge DANS la transaction et AVANT la
 * suppression du bien, dont la cascade efface les références.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ops: string[] = [];
let inserted: Array<{ storagePath: string; fileId: null }> = [];
let selectResults: Record<string, unknown[][]> = {};

vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  const chain = (onResolve: () => unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['where', 'limit', 'set']) c[m] = () => c;
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(onResolve).then(res, rej);
    return c;
  };
  const tx = {
    select: () => ({
      from: (t: never) => {
        const name = getTableName(t);
        return chain(() => {
          if (name === 'rooms') return [];
          ops.push(`select:${name}`);
          return (selectResults[name] ?? []).shift() ?? [];
        });
      },
    }),
    insert: (t: never) => ({
      values: (v: typeof inserted) => chain(() => { ops.push(`insert:${getTableName(t)}`); inserted = v; }),
    }),
    update: (t: never) => chain(() => ops.push(`update:${getTableName(t)}`)),
    delete: (t: never) => chain(() => ops.push(`delete:${getTableName(t)}`)),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

const { deleteAssetCompletely } = await import('../asset-deletion.service');

beforeEach(() => {
  ops.length = 0;
  inserted = [];
  selectResults = {};
});

describe('deleteAssetCompletely', () => {
  it('programme la purge de tous les objets puis supprime le bien', async () => {
    selectResults = {
      asset_files: [
        [{ id: 1, s3Key: 'f/1.pdf' }, { id: 2, s3Key: 'temp' }, { id: 3, s3Key: 'f/shared.pdf' }, { id: 4, s3Key: null }],
        // Garde-fou : f/shared.pdf encore référencé par un fichier qui survit.
        [{ s3Key: 'f/shared.pdf' }],
      ],
      document_versions: [[{ s3Key: 'f/1.v1.pdf' }]],
      export_generation: [[{ outputPayload: JSON.stringify({ pdfS3Key: 'exports/1/5/9/x.pdf' }) }]],
      pending_blob_deletions: [[{ storagePath: 'f/1.v1.pdf' }]], // déjà en file
    };

    const result = await deleteAssetCompletely({ id: 5, thumbnailUrl: 'verebona/u_1/a_5/thumbnail/t.webp' });

    expect(inserted.map((r) => r.storagePath).sort()).toEqual(
      ['exports/1/5/9/x.pdf', 'f/1.pdf', 'verebona/u_1/a_5/thumbnail/t.webp'].sort(),
    );
    expect(inserted.every((r) => r.fileId === null)).toBe(true);
    expect(result.blobsScheduled).toBe(3);
    expect(ops.indexOf('insert:pending_blob_deletions')).toBeLessThan(ops.indexOf('delete:assets'));
    expect(ops).toContain('update:asset_transmissions');
    expect(ops[ops.length - 1]).toBe('delete:assets');
  });

  it('bien sans fichier : aucune programmation, le bien est supprimé', async () => {
    const result = await deleteAssetCompletely({ id: 6, thumbnailUrl: null });
    expect(result.blobsScheduled).toBe(0);
    expect(ops).not.toContain('insert:pending_blob_deletions');
    expect(ops).toContain('delete:assets');
  });
});
