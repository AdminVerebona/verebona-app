/**
 * Cleanup des fichiers supprimés depuis plus de 30 jours : jamais « fichier
 * encore dans S3 mais référence supprimée en base ».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: Array<{ id: number; s3Key: string | null; s3Bucket: string | null }> = [];
const deleted: number[] = [];
const updated: Array<{ values: Record<string, unknown> }> = [];
vi.mock('@/db', () => {
  const selectChain = { from: () => selectChain, where: async () => rows };
  return {
    db: {
      select: () => selectChain,
      delete: () => ({ where: async (cond: { queryChunks?: unknown[] }) => { deleted.push(idOf(cond)); } }),
      update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updated.push({ values }); } }) }),
    },
  };
});
vi.mock('@/services/verebona-assistant/core/conversation.service', () => ({ purgeExpired: async () => 0 }));
// Récupère l'id passé au `sql` de la condition (dernier paramètre numérique).
function idOf(cond: unknown): number {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  const n = [...chunks].reverse().find((c) => typeof c === 'number');
  return Number(n);
}

const { runCleanupJob } = await import('../cleanup-job');

const stockage = new Set<string>();
let s3Panne = false;
const deleteObject = async (_b: string, key: string) => {
  if (s3Panne) throw Object.assign(new Error('503 Slow Down'), { $metadata: { httpStatusCode: 503 } });
  stockage.delete(key);
};

beforeEach(() => {
  rows = [{ id: 1, s3Key: 'acc/1/facture.pdf', s3Bucket: null }];
  stockage.clear(); stockage.add('acc/1/facture.pdf');
  deleted.length = 0; updated.length = 0; s3Panne = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('suppression physique', () => {
  it('échec S3 : fichier et référence conservés, échec tracé, toujours éligible', async () => {
    s3Panne = true;
    const r = await runCleanupJob({ deleteObject });
    expect(stockage.has('acc/1/facture.pdf')).toBe(true);
    expect(deleted).toEqual([]);                      // aucune suppression en base
    expect(r.filesRetained).toBe(1);
    expect(r.success).toBe(false);
    expect(updated[0].values).toHaveProperty('purgeLastError', '503 Slow Down');
    expect(updated[0].values).toHaveProperty('purgeLastAttemptAt');
    expect(updated[0].values).not.toHaveProperty('deletedAt'); // statut de suppression inchangé
  });

  it('S3 rétabli : suppression S3 puis suppression en base', async () => {
    s3Panne = true;
    await runCleanupJob({ deleteObject });
    s3Panne = false;
    const r = await runCleanupJob({ deleteObject });
    expect(stockage.has('acc/1/facture.pdf')).toBe(false);
    expect(deleted).toEqual([1]);
    expect(r).toMatchObject({ filesDeletedFromS3: 1, filesDeletedFromDB: 1, filesRetained: 0 });
  });

  it('objet déjà absent (404) : suppression acquise', async () => {
    const r = await runCleanupJob({ deleteObject: async () => { throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); } });
    expect(deleted).toEqual([1]);
    expect(r.filesRetained).toBe(0);
  });

  it('lien web sans objet S3 : suppression en base directe', async () => {
    rows = [{ id: 2, s3Key: null, s3Bucket: null }];
    const del = vi.fn();
    await runCleanupJob({ deleteObject: del });
    expect(del).not.toHaveBeenCalled();
    expect(deleted).toEqual([2]);
  });
});
