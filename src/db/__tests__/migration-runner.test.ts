/**
 * APP-PERF-16 — exécution coordonnée des migrations (`runMigrations`),
 * criticité et état du schéma. Client simulé : verrou de l'exécutant, table
 * `_migrations` et fichiers en échec tenus en mémoire. Le comportement sur
 * PostgreSQL réel (deux processus, index interrompu) est éprouvé par
 * `src/test/e2e/scenarios/app-perf-16-migrations-coordonnees.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  migrationCriticality, migrationCatalog, readSchemaState, runMigrations, isPgDuration,
  MIGRATION_RUNNER_LOCK_KEY, type SqlRunner,
} from '../migration-index';

interface Etat {
  appliquees: Set<string>;
  verrouAilleurs: boolean;
  /** Le verrou se libère après N tentatives. */
  liberationApres?: number;
  echecs: Set<string>;
  tableAbsente?: boolean;
}

function fakeClient(etat: Etat) {
  const sur: { reserved: string[]; pool: string[] } = { reserved: [], pool: [] };
  const libere = { n: 0 };
  let tentatives = 0;
  const executer = (cible: string[]) => vi.fn(async (q: string, params?: never[]) => {
    const p = (params ?? []) as unknown as string[];
    cible.push(q.trim().split('\n')[0]);
    if (q.includes('pg_try_advisory_lock')) {
      tentatives += 1;
      if (p[0] !== MIGRATION_RUNNER_LOCK_KEY) return [{ ok: true }];
      const libre = !etat.verrouAilleurs || (etat.liberationApres != null && tentatives > etat.liberationApres);
      return [{ ok: libre }];
    }
    if (q.includes('pg_advisory_unlock')) return [{ ok: true }];
    if (q.startsWith('SELECT filename FROM _migrations')) {
      if (etat.tableAbsente) throw Object.assign(new Error('relation "_migrations" does not exist'), { code: '42P01' });
      return [...etat.appliquees].map((filename) => ({ filename }));
    }
    if (q.startsWith('INSERT INTO _migrations')) { etat.appliquees.add(p[0]); return []; }
    if (q.includes('pg_class c JOIN pg_index')) return [{ valid: true }];
    if (q.includes('WHERE NOT i.indisvalid')) return [];
    if (q.includes('pg_stat_progress_create_index')) return [];
    for (const e of etat.echecs) {
      if (q.includes(e)) throw Object.assign(new Error(`échec ${e}`), { code: '42703' });
    }
    return [];
  });
  const pool = executer(sur.pool);
  const reservee = executer(sur.reserved);
  const client: SqlRunner = {
    unsafe: pool,
    reserve: async () => ({ unsafe: reservee, release: () => { libere.n += 1; } }),
  };
  return { client, sur, libere };
}

const FICHIERS = [
  { filename: '0001_table.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id int);' },
  { filename: '0001_table_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON t (id);' },
  { filename: '0002_unique.sql', sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_u_idx ON t (id);' },
];
const etat = (o: Partial<Etat> = {}): Etat => ({ appliquees: new Set(), verrouAilleurs: false, echecs: new Set(), ...o });
const silencieux = { info: () => {}, warn: () => {}, error: () => {} };
const opts = { log: silencieux, sleep: async () => {}, lockPollMs: 10 };

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('criticité des fichiers', () => {
  it('index NON unique CONCURRENTLY : optionnel ; unique, table, colonne : critique', () => {
    expect(migrationCatalog(FICHIERS).map((m) => m.criticality)).toEqual(['critical', 'optional', 'critical']);
    expect(migrationCriticality('ALTER TABLE t ADD COLUMN IF NOT EXISTS x int;')).toBe('critical');
    expect(migrationCriticality('-- commentaire\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x);')).toBe('optional');
    // Plusieurs instructions : jamais traité comme un index seul.
    expect(migrationCriticality('CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x); SELECT 1;')).toBe('critical');
  });

  it('durées acceptées dans un SET : aucune interpolation libre', () => {
    for (const v of ['0', '500ms', '10s', '2min']) expect(isPgDuration(v)).toBe(true);
    for (const v of ['10 s', "1s'; DROP TABLE x; --", '', '-1', '1h']) expect(isPgDuration(v)).toBe(false);
  });
});

describe('readSchemaState', () => {
  it('table _migrations absente : tout est en attente, sans lever', async () => {
    const { client } = fakeClient(etat({ tableAbsente: true }));
    const st = await readSchemaState(client, migrationCatalog(FICHIERS));
    expect(st).toEqual({ tracked: false, pendingCritical: ['0001_table.sql', '0002_unique.sql'], pendingOptional: ['0001_table_idx_1.sql'] });
  });

  it('autre erreur (base injoignable) : levée — jamais un faux « prêt »', async () => {
    const client: SqlRunner = { unsafe: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); } };
    await expect(readSchemaState(client, migrationCatalog(FICHIERS))).rejects.toThrow('ECONNREFUSED');
  });
});

describe('runMigrations — exécution coordonnée', () => {
  it('verrou obtenu : tout passe par la connexion dédiée, bornée, puis rendue', async () => {
    const e = etat();
    const { client, sur, libere } = fakeClient(e);
    const r = await runMigrations(client, FICHIERS, { ...opts, lockTimeout: '5s', statementTimeout: '0' });
    expect(r.outcome).toBe('ready');
    expect(r.lockAcquired).toBe(true);
    // Lot 24b : index OPTIONNELS en dernier, après tous les fichiers critiques.
    expect(r.applied).toEqual(['0001_table.sql', '0002_unique.sql', '0001_table_idx_1.sql']);
    expect(sur.pool).toEqual([]);
    expect(sur.reserved).toEqual(expect.arrayContaining([
      "SET lock_timeout = '5s'", "SET statement_timeout = '0'", 'RESET lock_timeout', 'RESET statement_timeout',
    ]));
    expect(sur.reserved.filter((q) => q.includes('pg_advisory_unlock')).length).toBeGreaterThan(0);
    // Le verrou est pris AVANT toute DDL.
    expect(sur.reserved.findIndex((q) => q.includes('pg_try_advisory_lock')))
      .toBeLessThan(sur.reserved.findIndex((q) => q.startsWith('CREATE TABLE IF NOT EXISTS _migrations')));
    expect(libere.n).toBe(1);
  });

  it('T-01 : verrou détenu ailleurs jusqu’au délai → aucune DDL, état relu, `waiting`', async () => {
    let t = 0;
    const { client, sur } = fakeClient(etat({ verrouAilleurs: true }));
    const r = await runMigrations(client, FICHIERS, { ...opts, lockWaitMs: 100, now: () => (t += 30) });
    expect(r.lockAcquired).toBe(false);
    expect(r.outcome).toBe('waiting');
    expect(r.pendingCritical).toEqual(['0001_table.sql', '0002_unique.sql']);
    expect(sur.reserved.some((q) => q.startsWith('CREATE') || q.startsWith('SET'))).toBe(false);
    expect(sur.reserved.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('T-01 : verrou libéré pendant l’attente (autre exécutant fini) → rien à refaire, `ready`', async () => {
    const e = etat({ verrouAilleurs: true, liberationApres: 2, appliquees: new Set(FICHIERS.map((f) => f.filename)) });
    const { client } = fakeClient(e);
    const r = await runMigrations(client, FICHIERS, { ...opts, lockWaitMs: 60_000 });
    expect(r.lockAcquired).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.outcome).toBe('ready');
  });

  it('T-02 : migration CRITIQUE en échec → `failed`, première cause rapportée, suite poursuivie', async () => {
    const { client } = fakeClient(etat({ echecs: new Set(['CREATE TABLE IF NOT EXISTS t ']) }));
    const r = await runMigrations(client, FICHIERS, opts);
    expect(r.outcome).toBe('failed');
    expect(r.firstCriticalFailure).toMatchObject({ filename: '0001_table.sql', code: '42703', criticality: 'critical' });
    expect(r.pendingCritical).toEqual(['0001_table.sql']);
    expect(r.applied).toContain('0002_unique.sql');
  });

  it('T-02 : index OPTIONNEL en échec → `degraded`, jamais `ready` ni `failed`', async () => {
    const { client } = fakeClient(etat({ echecs: new Set(['t_id_idx']) }));
    const r = await runMigrations(client, FICHIERS, opts);
    expect(r.outcome).toBe('degraded');
    expect(r.firstCriticalFailure).toBeNull();
    expect(r.failures).toEqual([expect.objectContaining({ filename: '0001_table_idx_1.sql', criticality: 'optional' })]);
    expect(r.pendingOptional).toEqual(['0001_table_idx_1.sql']);
  });

  it('durée invalide : refus avant toute connexion', async () => {
    const { client, sur } = fakeClient(etat());
    await expect(runMigrations(client, FICHIERS, { ...opts, lockTimeout: "1s'; --" })).rejects.toThrow(/lockTimeout invalide/);
    expect(sur.reserved).toEqual([]);
  });

  it('base coupée pendant l’exécution : connexion et verrou rendus, erreur levée', async () => {
    const e = etat();
    const { client, libere, sur } = fakeClient(e);
    const reserve = client.reserve!;
    client.reserve = async () => {
      const c = await reserve();
      const orig = c.unsafe;
      return { ...c, unsafe: async (q: string, p?: never[]) => {
        if (q.startsWith('SELECT filename FROM _migrations')) throw new Error('connexion perdue');
        return orig(q, p);
      } };
    };
    await expect(runMigrations(client, FICHIERS, opts)).rejects.toThrow('connexion perdue');
    expect(libere.n).toBe(1);
    expect(sur.reserved.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
  });
});
