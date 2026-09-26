/**
 * Suppression d'un bien : TOUT est supprimé, les objets de stockage sont mis
 * en file de purge (pending_blob_deletions) — fonctions pures du service.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {} }));

const { thumbnailStorageKey, exportStorageKeys, selectBlobKeysToPurge } = await import('../asset-deletion.service');

describe('selectBlobKeysToPurge', () => {
  it('dédoublonne, ignore `temp`, les objets encore référencés et ceux déjà en file', () => {
    expect(selectBlobKeysToPurge({
      candidates: ['a', 'a', 'temp', null, undefined, '', 'b', 'c', 'd'],
      stillReferenced: ['c'],
      alreadyPending: ['d'],
    })).toEqual(['a', 'b']);
  });
});

describe('exportStorageKeys', () => {
  it('extrait le PDF et le ZIP générés', () => {
    expect(exportStorageKeys(JSON.stringify({ pdfS3Key: 'exports/1/2/3/a.pdf', zipS3Key: 'exports/1/2/3/a.zip', pdfSize: 3 })))
      .toEqual(['exports/1/2/3/a.pdf', 'exports/1/2/3/a.zip']);
  });
  it('tolère un payload absent ou invalide', () => {
    expect(exportStorageKeys(null)).toEqual([]);
    expect(exportStorageKeys('{oops')).toEqual([]);
  });
});

describe('thumbnailStorageKey', () => {
  it('clé brute', () => {
    expect(thumbnailStorageKey('verebona/u_1/a_2/thumbnail/x.webp', 'bkt')).toBe('verebona/u_1/a_2/thumbnail/x.webp');
  });
  it('URL path-style et virtual-host du bucket', () => {
    expect(thumbnailStorageKey('https://s3.gra.io.cloud.ovh.net/bkt/a/b.webp', 'bkt')).toBe('a/b.webp');
    expect(thumbnailStorageKey('https://bkt.s3.gra.io.cloud.ovh.net/a/b.webp', 'bkt')).toBe('a/b.webp');
  });
  it('URL externe ou vide : rien à purger', () => {
    expect(thumbnailStorageKey('https://images.example.com/x.png', 'bkt')).toBeNull();
    expect(thumbnailStorageKey(null, 'bkt')).toBeNull();
  });
});
