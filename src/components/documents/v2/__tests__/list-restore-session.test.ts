import { describe, expect, it } from 'vitest';
import { purgeListSnapshots, snapshotStorageKey } from '../list-restore';

function memoire() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    m,
  };
}

describe('listes restaurées — changement de session', () => {
  it('efface les instantanés de documents, et seulement eux', () => {
    const s = memoire();
    s.setItem(snapshotStorageKey('documents'), '{}');
    s.setItem(snapshotStorageKey('bien:12'), '{}');
    s.setItem('autre', 'x');
    purgeListSnapshots(s);
    expect([...s.m.keys()]).toEqual(['autre']);
  });
});
