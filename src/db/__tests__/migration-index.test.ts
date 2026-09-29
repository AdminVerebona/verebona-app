/**
 * Reprise des index CONCURRENTLY invalides par le runner de migrations
 * (revues lot 12). Client simulé : index, verrous et constructions en cours
 * tenus en mémoire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  concurrentIndexName, runMigrationSql, listInvalidIndexes, repairInvalidMigrationIndexes, indexLockKey, type SqlRunner,
} from '../migration-index';

const FICHIER = `-- Migration 0219 (index 1/3)
-- commentaire ; avec point-virgule
CREATE INDEX CONCURRENTLY IF NOT EXISTS field_evidence_target_idx ON field_evidence (target_type, target_entity_id) WHERE target_entity_id IS NOT NULL;
`;

interface Etat {
  index: Map<string, boolean>;
  verrousAilleurs: Set<string>;
  enConstruction: Set<string>;
  migrations: Set<string>;
  buildLeavesInvalid?: boolean;
}

function fakeClient(etat: Etat, avecReserve = true) {
  const calls: string[] = [];
  const reserved = { n: 0, released: 0 };
  const unsafe = vi.fn(async (q: string, params?: never[]) => {
    const p = (params ?? []) as unknown as string[];
    calls.push(q.trim().split('\n')[0]);
    if (q.includes('pg_try_advisory_lock')) return [{ ok: !etat.verrousAilleurs.has(p[0]) }];
    if (q.includes('pg_advisory_unlock')) return [{ ok: true }];
    if (q.includes('pg_stat_progress_create_index')) return etat.enConstruction.has(p[0]) ? [{ '?column?': 1 }] : [];
    if (q.includes('FROM pg_class c JOIN pg_index')) return etat.index.has(p[0]) ? [{ valid: etat.index.get(p[0]) }] : [];
    if (q.includes('WHERE NOT i.indisvalid')) return [...etat.index].filter(([, v]) => !v).map(([name]) => ({ name }));
    if (q.startsWith('DELETE FROM _migrations')) { etat.migrations.delete(p[0]); return []; }
    const drop = /^DROP INDEX CONCURRENTLY IF EXISTS "(\w+)"/.exec(q);
    if (drop) { etat.index.delete(drop[1]); return []; }
    const name = concurrentIndexName(q);
    if (name && !etat.index.has(name)) etat.index.set(name, !etat.buildLeavesInvalid); // IF NOT EXISTS
    return [];
  });
  const client: SqlRunner = { unsafe };
  if (avecReserve) {
    client.reserve = async () => { reserved.n += 1; return { unsafe, release: () => { reserved.released += 1; } }; };
  }
  return { client, calls, reserved };
}
const etat = (over: Partial<Etat> = {}): Etat => ({
  index: new Map(), verrousAilleurs: new Set(), enConstruction: new Set(), migrations: new Set(), ...over,
});

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('concurrentIndexName', () => {
  it('fichier à une instruction CREATE INDEX CONCURRENTLY IF NOT EXISTS', () => {
    expect(concurrentIndexName(FICHIER)).toBe('field_evidence_target_idx');
    expect(concurrentIndexName('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "u_idx" ON t (a);')).toBe('u_idx');
  });
  it('autre fichier : null (multi-instructions, sans CONCURRENTLY, sans IF NOT EXISTS)', () => {
    expect(concurrentIndexName('SET LOCAL lock_timeout = 1; CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x);')).toBeNull();
    expect(concurrentIndexName('CREATE INDEX IF NOT EXISTS a ON t (x);')).toBeNull();
    expect(concurrentIndexName('CREATE INDEX CONCURRENTLY a ON t (x);')).toBeNull();
    expect(concurrentIndexName('ALTER TABLE t ADD COLUMN x int;')).toBeNull();
  });
});

describe('runMigrationSql', () => {
  it('index invalide : verrou (connexion réservée), DROP CONCURRENTLY, reconstruction valide, verrou rendu', async () => {
    const e = etat({ index: new Map([['field_evidence_target_idx', false]]) });
    const { client, calls, reserved } = fakeClient(e);
    expect(await runMigrationSql(client, FICHIER)).toEqual({ status: 'rebuilt', index: 'field_evidence_target_idx' });
    expect(calls[0]).toMatch(/pg_try_advisory_lock/);
    expect(calls.some((c) => c.startsWith('DROP INDEX CONCURRENTLY IF EXISTS "field_evidence_target_idx"'))).toBe(true);
    expect(calls.at(-1)).toMatch(/pg_advisory_unlock/);
    expect(reserved).toEqual({ n: 1, released: 1 });
    expect(e.index.get('field_evidence_target_idx')).toBe(true);
  });

  it('deux instances : verrou détenu ailleurs → rien n’est fait (pas de DROP de l’index en construction)', async () => {
    const e = etat({ index: new Map([['field_evidence_target_idx', false]]), verrousAilleurs: new Set([indexLockKey('field_evidence_target_idx')]) });
    const { client, calls, reserved } = fakeClient(e);
    expect(await runMigrationSql(client, FICHIER)).toEqual({ status: 'deferred', index: 'field_evidence_target_idx' });
    expect(calls.some((c) => c.startsWith('DROP') || c.startsWith('CREATE') || /unlock/.test(c))).toBe(false);
    expect(reserved.released).toBe(1);
  });

  it('construction en cours (pg_stat_progress_create_index) → rien n’est fait', async () => {
    const e = etat({ index: new Map([['field_evidence_target_idx', false]]), enConstruction: new Set(['field_evidence_target_idx']) });
    const { client, calls } = fakeClient(e);
    expect((await runMigrationSql(client, FICHIER)).status).toBe('deferred');
    expect(calls.some((c) => c.startsWith('DROP') || c.startsWith('CREATE'))).toBe(false);
    expect(calls.at(-1)).toMatch(/pg_advisory_unlock/);
  });

  it('index resté invalide après construction : échec (fichier non marqué appliqué), verrou rendu', async () => {
    const { client, calls } = fakeClient(etat({ buildLeavesInvalid: true }));
    await expect(runMigrationSql(client, FICHIER)).rejects.toThrow(/invalide/);
    expect(calls.at(-1)).toMatch(/pg_advisory_unlock/);
  });

  it('index valide existant : aucune suppression ; autre migration : exécutée telle quelle, sans verrou', async () => {
    const e = etat({ index: new Map([['field_evidence_target_idx', true]]) });
    const { client, calls } = fakeClient(e, false);
    expect((await runMigrationSql(client, FICHIER)).status).toBe('applied');
    expect(calls.some((c) => c.startsWith('DROP'))).toBe(false);
    calls.length = 0;
    expect(await runMigrationSql(client, 'ALTER TABLE t ADD COLUMN IF NOT EXISTS x int;')).toEqual({ status: 'applied', index: null });
    expect(calls).toEqual(['ALTER TABLE t ADD COLUMN IF NOT EXISTS x int;']);
  });
});

describe('repairInvalidMigrationIndexes — contrôle de démarrage', () => {
  const fichiers = [
    { filename: '0217_ai_trace_master_fields_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_event_task_idx ON ai_usage_event (task);' },
    { filename: '0219_x_idx_3.sql', sql: FICHIER },
    { filename: '0100_autre.sql', sql: 'ALTER TABLE t ADD COLUMN x int;' },
  ];

  it('fichier DÉJÀ appliqué (0217) : index reconstruit tout de suite', async () => {
    const e = etat({ index: new Map([['ai_usage_event_task_idx', false], ['b_idx', true]]), migrations: new Set(['0217_ai_trace_master_fields_idx_1.sql']) });
    const { client } = fakeClient(e);
    expect(await repairInvalidMigrationIndexes(client, fichiers)).toEqual({ repaired: ['ai_usage_event_task_idx'], requeued: [], unknown: [] });
    expect(e.index.get('ai_usage_event_task_idx')).toBe(true);
    expect(e.migrations.has('0217_ai_trace_master_fields_idx_1.sql')).toBe(true);
  });

  it('reconstruction différée ou en échec : fichier remis en file (_migrations), index inconnu signalé', async () => {
    const e = etat({
      index: new Map([['ai_usage_event_task_idx', false], ['field_evidence_target_idx', false], ['hors_migration_idx', false]]),
      verrousAilleurs: new Set([indexLockKey('ai_usage_event_task_idx')]),
      migrations: new Set(['0217_ai_trace_master_fields_idx_1.sql', '0219_x_idx_3.sql']),
      buildLeavesInvalid: true,
    });
    const { client } = fakeClient(e);
    const r = await repairInvalidMigrationIndexes(client, fichiers);
    expect(r.repaired).toEqual([]);
    expect(r.requeued.map((q) => q.filename)).toEqual(['0217_ai_trace_master_fields_idx_1.sql', '0219_x_idx_3.sql']);
    expect(r.unknown).toEqual(['hors_migration_idx']);
    expect(e.migrations.size).toBe(0);
  });

  it('listInvalidIndexes', async () => {
    const { client } = fakeClient(etat({ index: new Map([['a_idx', false], ['b_idx', true]]) }));
    expect(await listInvalidIndexes(client)).toEqual(['a_idx']);
  });
});
