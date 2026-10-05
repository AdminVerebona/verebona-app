/**
 * Lot 24b — déploiement sans intervention manuelle en base (incident préprod
 * du 05/10) : délais des constructions CONCURRENTLY, aucune construction
 * vouée à l'échec rejouée, classification, coordination démarrage web /
 * postdeploy, maintenance en arrière-plan, diagnostic des sessions
 * bloquantes. Client simulé ; le comportement sur PostgreSQL réel est
 * éprouvé par `src/test/e2e/scenarios/l24b-deploiement-autonome.e2e.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  applyMigrationFiles, blockersStillActive, capDuration, concurrentIndexName, createIndexPass, formatIndexBlockers,
  maskQueryLiterals, migrationCriticality, pgDurationMs, runBootMigrations, runIndexMaintenance, runMigrations,
  MIGRATION_INDEX_LOCK_TIMEOUT_BOOT, MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY, MIGRATION_RUNNER_LOCK_KEY,
  type IndexBlocker, type SqlRunner,
} from '../migration-index';
import { nextMaintenanceDelay, scheduleIndexMaintenance } from '../migration-maintenance';
import { resolveApplicationName } from '../pool-config';

type Construction = 'ok' | '55P03' | 'invalide';

interface Monde {
  migrations: Set<string>;
  /** Index présents : valide ou non. */
  index: Map<string, boolean>;
  /** Comportement d'une construction (défaut `ok`). */
  construction: Map<string, Construction>;
  /** Verrou de l'exécutant détenu ailleurs (jusqu'à `liberer()`). */
  verrouAilleurs: boolean;
  bloqueurs: Array<Record<string, unknown>>;
  bloqueursActifs: boolean;
  /** Échecs des fichiers ordinaires (sous-chaîne → code). */
  echecs: Map<string, string>;
}

const monde = (o: Partial<Monde> = {}): Monde => ({
  migrations: new Set(), index: new Map(), construction: new Map(), verrouAilleurs: false,
  bloqueurs: [], bloqueursActifs: false, echecs: new Map(), ...o,
});

function fakeClient(m: Monde) {
  const journal: Array<{ cnx: string; q: string; p: unknown[] }> = [];
  const executer = (cnx: string) => vi.fn(async (q: string, params?: never[]) => {
    const p = (params ?? []) as unknown as string[];
    journal.push({ cnx, q: q.trim(), p });
    if (q.includes('pg_try_advisory_lock')) return [{ ok: p[0] === MIGRATION_RUNNER_LOCK_KEY ? !m.verrouAilleurs : true }];
    if (q.includes('pg_advisory_unlock')) return [{ ok: true }];
    if (q.includes("current_setting('lock_timeout')")) return [{ v: '10s' }];
    if (q.includes('clock_timestamp()::text')) return [{ t: '2026-10-05 17:28:00+00' }];
    if (q.includes('FROM pg_stat_activity') && q.includes('ANY($1::int[])')) return m.bloqueursActifs ? [{ '?column?': 1 }] : [];
    if (q.includes('FROM pg_stat_activity')) return m.bloqueurs;
    if (q.includes('pg_stat_progress_create_index')) return [];
    if (q.includes('FROM pg_class c JOIN pg_index')) return m.index.has(p[0]) ? [{ valid: m.index.get(p[0]) }] : [];
    if (q.includes('WHERE NOT i.indisvalid')) return [...m.index].filter(([, v]) => !v).map(([name]) => ({ name }));
    if (q.startsWith('SELECT filename FROM _migrations')) return [...m.migrations].map((filename) => ({ filename }));
    if (q.startsWith('INSERT INTO _migrations')) { m.migrations.add(p[0]); return []; }
    if (q.startsWith('DELETE FROM _migrations')) { m.migrations.delete(p[0]); return []; }
    const drop = /^DROP INDEX CONCURRENTLY IF EXISTS "(\w+)"/.exec(q);
    if (drop) {
      if (m.construction.get(drop[1]) === '55P03') throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      m.index.delete(drop[1]);
      return [];
    }
    const nom = concurrentIndexName(q);
    if (nom) {
      const c = m.construction.get(nom) ?? 'ok';
      if (c === '55P03') {
        m.index.set(nom, false); // construction interrompue : index INVALIDE laissé
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      }
      if (!m.index.has(nom)) m.index.set(nom, c === 'ok');
      return [];
    }
    for (const [s, code] of m.echecs) if (q.includes(s)) throw Object.assign(new Error(`échec ${s}`), { code });
    return [];
  });
  const pool = executer('pool');
  let n = 0;
  const client: SqlRunner = {
    unsafe: pool,
    reserve: async () => { n += 1; return { unsafe: executer(`r${n}`), release: () => {} }; },
  };
  const ddl = () => journal.filter((j) => /^(CREATE|DROP|ALTER)/.test(j.q) && !j.q.startsWith('CREATE TABLE IF NOT EXISTS _migrations'));
  const constructions = (index: string) => journal.filter((j) => concurrentIndexName(j.q) === index).length;
  return { client, journal, ddl, constructions };
}

const silencieux = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const opts = { sleep: async () => {}, lockPollMs: 10 };

/** Les trois fichiers de l'incident + des fichiers critiques. */
const F = {
  i0235: { filename: '0235_ai_account_cost_cap_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_event_account_created_idx ON ai_usage_event (account_id, created_at);' },
  i0237: { filename: '0237_ai_metrics_export_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS verebona_ai_runs_created_at_idx ON verebona_ai_runs (created_at);' },
  i0242: {
    filename: '0242_upload_operations_idx_1.sql',
    sql: '-- filet seulement\n-- verebona:optional-index\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS asset_files_user_upload_operation_uidx ON asset_files (user_id, upload_operation_id) WHERE upload_operation_id IS NOT NULL;',
  },
  c0242: { filename: '0242_upload_operations.sql', sql: 'ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS upload_operation_id TEXT;' },
  c0243: { filename: '0243_revoked_tokens_tables.sql', sql: 'CREATE TABLE IF NOT EXISTS revoked_tokens (id serial);' },
  c0250: { filename: '0250_unpaid_cycle_no_grace.sql', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS x int;' },
  u0221: { filename: '0221_document_asset_links_idx_1.sql', sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS document_asset_links_active_uniq ON document_asset_links (a);' },
  c0229: { filename: '0229_rooms_to_substructures.sql', sql: 'ALTER TABLE x ADD COLUMN IF NOT EXISTS y int;' },
};
const INCIDENT = [F.i0235, F.i0237, F.c0242, F.i0242, F.c0243, F.c0250];

describe('délais (lot 24b)', () => {
  it('défauts : long au déploiement, court au démarrage ; conversions et plafond par le budget', () => {
    expect(MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY).toBe('10min');
    expect(MIGRATION_INDEX_LOCK_TIMEOUT_BOOT).toBe('10s');
    expect(pgDurationMs('10min')).toBe(600_000);
    expect(pgDurationMs('10s')).toBe(10_000);
    expect(pgDurationMs('250ms')).toBe(250);
    expect(pgDurationMs('500')).toBe(500);
    expect(pgDurationMs('0')).toBe(0);
    expect(() => pgDurationMs('1h')).toThrow();
    expect(capDuration('10min', 120_000)).toBe('120000ms');
    expect(capDuration('10s', 120_000)).toBe('10s');
    expect(capDuration('0', 90_000)).toBe('90000ms'); // « aucune limite » bornée par le budget
  });
});

describe('classification des index de l’incident', () => {
  it('0235 et 0237 (non uniques) optionnels ; 0242 UNIQUE optionnel par marqueur ; autre UNIQUE critique', () => {
    expect(migrationCriticality(F.i0235.sql)).toBe('optional');
    expect(migrationCriticality(F.i0237.sql)).toBe('optional');
    expect(migrationCriticality(F.i0242.sql)).toBe('optional');
    expect(migrationCriticality(F.u0221.sql)).toBe('critical');
    // Le marqueur doit être une ligne de commentaire à part entière.
    expect(migrationCriticality('-- pas verebona:optional-index ici\n' + F.u0221.sql)).toBe('critical');
  });

  it('fichier réel 0242_upload_operations_idx_1.sql : optionnel', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const sql = await readFile(join(process.cwd(), 'src/db/migrations/0242_upload_operations_idx_1.sql'), 'utf-8');
    expect(migrationCriticality(sql)).toBe('optional');
  });
});

describe('postdeploy : incident du 05/10 rejoué (index invalides préexistants, transaction ancienne)', () => {
  it('chaque construction tentée UNE fois (application puis réparation), critiques d’abord, déploiement non bloqué', async () => {
    const m = monde({
      index: new Map([['ai_usage_event_account_created_idx', false], ['verebona_ai_runs_created_at_idx', false]]),
      construction: new Map([
        ['ai_usage_event_account_created_idx', '55P03'], ['verebona_ai_runs_created_at_idx', '55P03'], ['asset_files_user_upload_operation_uidx', '55P03'],
      ]),
    });
    const { client, constructions, journal } = fakeClient(m);
    const log = silencieux();
    const r = await runMigrations(client, INCIDENT, { ...opts, log, repairIndexes: true, indexLockTimeout: '10min' });
    expect(r.outcome).toBe('degraded');
    expect(r.applied).toEqual(['0242_upload_operations.sql', '0243_revoked_tokens_tables.sql', '0250_unpaid_cycle_no_grace.sql']);
    expect(r.pendingCritical).toEqual([]);
    // 0235 / 0237 : DROP de l'index invalide en échec → aucune construction ; 0242 : une seule.
    expect(constructions('asset_files_user_upload_operation_uidx')).toBe(1);
    expect(journal.filter((j) => j.q.startsWith('DROP INDEX CONCURRENTLY')).length).toBe(2);
    expect(r.repair?.skipped.sort()).toEqual(['ai_usage_event_account_created_idx', 'asset_files_user_upload_operation_uidx', 'verebona_ai_runs_created_at_idx']);
    expect(r.repair?.requeued).toEqual([]);
    // Délai long posé sur la connexion dédiée de l'exécutant, puis rétabli.
    expect(journal.some((j) => j.q === "SET lock_timeout = '10min'")).toBe(true);
    expect(journal.filter((j) => j.q.startsWith("SELECT set_config('lock_timeout'")).length).toBeGreaterThan(0);
    expect(new Set(journal.map((j) => j.cnx))).toEqual(new Set(['r1']));
  });

  it('sessions bloquantes encore actives après un 55P03 : index optionnels suivants différés SANS essai', async () => {
    const m = monde({
      construction: new Map([['ai_usage_event_account_created_idx', '55P03']]),
      bloqueurs: [{ pid: 4242, application_name: 'verebona:web-1', state: 'idle in transaction', wait_event_type: 'Client', wait_event: 'ClientRead', xact_age_s: 900, query: "SELECT * FROM users WHERE email = 'a@b.fr'" }],
      bloqueursActifs: true,
    });
    const { client, constructions } = fakeClient(m);
    const log = silencieux();
    const r = await runMigrations(client, [F.i0235, F.i0237], { ...opts, log, repairIndexes: true });
    expect(r.outcome).toBe('degraded');
    expect(constructions('verebona_ai_runs_created_at_idx')).toBe(0);
    expect(r.deferred).toEqual(['0237_ai_metrics_export_idx_1.sql']);
    const lignes = log.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lignes).toMatch(/pid=4242 app=verebona:web-1 state=idle in transaction wait=Client\/ClientRead transaction=900s/);
    expect(lignes).not.toContain('a@b.fr');
    expect(r.failures[0]).toMatchObject({ filename: '0235_ai_account_cost_cap_idx_1.sql', code: '55P03', criticality: 'optional' });
    expect(r.failures[0].blockers?.[0].pid).toBe(4242);
  });

  it('budget épuisé : index optionnel différé sans essai ; délai borné par le temps restant', async () => {
    let t = 0;
    const now = () => t;
    const m = monde();
    const { client, journal } = fakeClient(m);
    // Reste 90 s - 30 s de marge : délai plafonné à 60000ms au lieu de 10min.
    const r = await runMigrations(client, [F.i0235], { ...opts, log: silencieux(), now, deadline: 90_000, indexLockTimeout: '10min' });
    expect(r.outcome).toBe('ready');
    expect(journal.some((j) => j.q === "SET lock_timeout = '60000ms'")).toBe(true);
    t = 0;
    const m2 = monde();
    const c2 = fakeClient(m2);
    const r2 = await runMigrations(c2.client, [F.i0235], { ...opts, log: silencieux(), now, deadline: 20_000 });
    expect(c2.constructions('ai_usage_event_account_created_idx')).toBe(0);
    expect(r2).toMatchObject({ outcome: 'degraded', deferred: ['0235_ai_account_cost_cap_idx_1.sql'] });
  });

  it('attente du verrou de l’exécutant bornée par le budget', async () => {
    let t = 0;
    const m = monde({ verrouAilleurs: true });
    const { client } = fakeClient(m);
    const r = await runMigrations(client, [F.c0243], {
      ...opts, log: silencieux(), lockWaitMs: 600_000, deadline: 60_000, now: () => (t += 1_000),
    });
    expect(r.lockAcquired).toBe(false);
    expect(r.lockWaitMs).toBeLessThanOrEqual(31_000);
  });
});

describe('applyMigrationFiles — démarrage web (`skip`)', () => {
  it('aucun index CONCURRENTLY ; un index CRITIQUE sauté arrête la chaîne', async () => {
    const m = monde();
    const { client, ddl } = fakeClient(m);
    const r = await applyMigrationFiles(client, [F.c0242, F.i0242, F.u0221, F.c0229, F.c0243], silencieux(), { concurrentIndexes: 'skip' });
    // 0221_idx (critique, premier dans l'ordre) arrête tout ce qui suit : aucune DDL.
    expect(ddl()).toEqual([]);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['0221_document_asset_links_idx_1.sql', '0229_rooms_to_substructures.sql', '0242_upload_operations.sql', '0242_upload_operations_idx_1.sql', '0243_revoked_tokens_tables.sql']);
  });

  it('sans index critique : fichiers ordinaires appliqués, index optionnels laissés', async () => {
    const m = monde();
    const { client, constructions } = fakeClient(m);
    const r = await applyMigrationFiles(client, INCIDENT, silencieux(), { concurrentIndexes: 'skip' });
    expect(r.applied).toEqual(['0242_upload_operations.sql', '0243_revoked_tokens_tables.sql', '0250_unpaid_cycle_no_grace.sql']);
    expect(r.skipped).toEqual(['0235_ai_account_cost_cap_idx_1.sql', '0237_ai_metrics_export_idx_1.sql', '0242_upload_operations_idx_1.sql']);
    for (const i of ['ai_usage_event_account_created_idx', 'verebona_ai_runs_created_at_idx', 'asset_files_user_upload_operation_uidx']) {
      expect(constructions(i)).toBe(0);
    }
  });
});

describe('runBootMigrations — coordination démarrage web / postdeploy', () => {
  it('seul (local) : applique les critiques, laisse les index, `degraded` sans attendre', async () => {
    const m = monde();
    const { client, constructions } = fakeClient(m);
    const sleep = vi.fn(async () => {});
    const r = await runBootMigrations(client, INCIDENT, { log: silencieux(), sleep });
    expect(r.outcome).toBe('degraded');
    expect(r.pendingOptional).toHaveLength(3);
    expect(sleep).not.toHaveBeenCalled();
    expect(constructions('asset_files_user_upload_operation_uidx')).toBe(0);
  });

  it('postdeploy a la main : aucune DDL, relecture jusqu’au schéma critique prêt, sans double application', async () => {
    const m = monde({ verrouAilleurs: true });
    const { client, ddl } = fakeClient(m);
    let tours = 0;
    const sleep = vi.fn(async () => {
      tours += 1;
      if (tours === 3) { for (const f of [F.c0242, F.c0243, F.c0250]) m.migrations.add(f.filename); } // le postdeploy a fini les critiques
    });
    const log = silencieux();
    const r = await runBootMigrations(client, INCIDENT, { log, sleep, pollMs: 5_000 });
    expect(r).toMatchObject({ outcome: 'degraded', lockAcquired: false, applied: [] });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(ddl()).toEqual([]);
    // Une annonce, pas une ligne par relecture.
    expect(log.warn.mock.calls.filter((c) => /relecture toutes les/.test(String(c[0])))).toHaveLength(1);
    expect(log.warn.mock.calls.filter((c) => /verrou détenu par un autre exécutant/.test(String(c[0])))).toHaveLength(1);
  });

  it('attente bornée : au-delà, `waiting` (démarrage maintenu, readiness à 503)', async () => {
    let t = 0;
    const m = monde({ verrouAilleurs: true });
    const { client, ddl } = fakeClient(m);
    const r = await runBootMigrations(client, INCIDENT, {
      log: silencieux(), waitMs: 60_000, pollMs: 5_000, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(r.outcome).toBe('waiting');
    expect(r.lockWaitMs).toBeGreaterThanOrEqual(60_000);
    expect(ddl()).toEqual([]);
  });

  it('55P03 sur un fichier critique (transitoire) : nouvel essai ; autre erreur : `failed` tout de suite', async () => {
    const m = monde({ echecs: new Map([['revoked_tokens', '55P03']]) });
    const { client } = fakeClient(m);
    const sleep = vi.fn(async () => { m.echecs.clear(); });
    const r = await runBootMigrations(client, [F.c0243], { log: silencieux(), sleep });
    expect(r.outcome).toBe('ready');
    expect(sleep).toHaveBeenCalledTimes(1);

    const m2 = monde({ echecs: new Map([['revoked_tokens', '42703']]) });
    const c2 = fakeClient(m2);
    const sleep2 = vi.fn(async () => {});
    expect((await runBootMigrations(c2.client, [F.c0243], { log: silencieux(), sleep: sleep2 })).outcome).toBe('failed');
    expect(sleep2).not.toHaveBeenCalled();
  });

  it('index CRITIQUE en attente (base neuve, local) : `waiting` immédiat, laissé à la maintenance', async () => {
    const m = monde();
    const { client } = fakeClient(m);
    const sleep = vi.fn(async () => {});
    const r = await runBootMigrations(client, [F.u0221, F.c0229], { log: silencieux(), sleep });
    expect(r.outcome).toBe('waiting');
    expect(r.lockAcquired).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('runIndexMaintenance — reconstruction en arrière-plan', () => {
  it('index optionnels en attente : construits avec le délai long, SANS le verrou de l’exécutant', async () => {
    const m = monde({
      migrations: new Set([F.c0242.filename, F.c0243.filename, F.c0250.filename]),
      index: new Map([['ai_usage_event_account_created_idx', false]]),
    });
    const { client, journal } = fakeClient(m);
    const r = await runIndexMaintenance(client, INCIDENT, { log: silencieux() });
    expect(r.kind).toBe('done');
    expect(r.built.sort()).toEqual([F.i0235.filename, F.i0237.filename, F.i0242.filename].sort());
    expect(r.pendingOptional).toEqual([]);
    expect(journal.some((j) => j.q.includes('pg_try_advisory_lock') && j.p[0] === MIGRATION_RUNNER_LOCK_KEY)).toBe(false);
    expect(journal.filter((j) => j.q === "SET lock_timeout = '10min'").length).toBe(3);
    expect(m.index.get('ai_usage_event_account_created_idx')).toBe(true);
  });

  it('index encore bloqué : `pending`, tenté une fois ; index invalide d’un fichier appliqué : réparé', async () => {
    const m = monde({
      migrations: new Set([...INCIDENT.map((f) => f.filename)].filter((f) => f !== F.i0237.filename)),
      index: new Map([['ai_usage_event_account_created_idx', false]]),
      construction: new Map([['verebona_ai_runs_created_at_idx', '55P03']]),
    });
    const { client, constructions } = fakeClient(m);
    const r = await runIndexMaintenance(client, INCIDENT, { log: silencieux() });
    expect(r.kind).toBe('pending');
    expect(constructions('verebona_ai_runs_created_at_idx')).toBe(1);
    expect(r.repair?.repaired).toEqual(['ai_usage_event_account_created_idx']);
    expect(r.repair?.skipped).toEqual(['verebona_ai_runs_created_at_idx']);
  });

  it('schéma critique incomplet : chaîne complète sous verrou, `busy` s’il est pris', async () => {
    const m = monde({ verrouAilleurs: true });
    const { client, ddl } = fakeClient(m);
    const r = await runIndexMaintenance(client, INCIDENT, { log: silencieux() });
    expect(r.kind).toBe('busy');
    expect(ddl()).toEqual([]);
    m.verrouAilleurs = false;
    const r2 = await runIndexMaintenance(client, [F.u0221, F.c0229], { log: silencieux() });
    expect(r2.kind).toBe('done');
    expect(m.migrations.has(F.c0229.filename)).toBe(true);
  });
});

describe('planification de la maintenance', () => {
  const s = { firstDelayMs: 25 * 60_000, intervalMs: 30 * 60_000, maxIntervalMs: 6 * 3_600_000 };
  it('délais : arrêt quand tout est fait, doublement plafonné sur échec, intervalle de base si occupé', () => {
    expect(nextMaintenanceDelay('done', 0, s)).toBeNull();
    expect(nextMaintenanceDelay('busy', 3, s)).toBe(30 * 60_000);
    expect(nextMaintenanceDelay('pending', 1, s)).toBe(30 * 60_000);
    expect(nextMaintenanceDelay('pending', 2, s)).toBe(60 * 60_000);
    expect(nextMaintenanceDelay('pending', 20, s)).toBe(6 * 3_600_000);
  });

  it('enchaînement : premier passage différé, jamais deux à la fois, s’arrête une fois `done`', async () => {
    const minuteries: Array<{ fn: () => void; ms: number }> = [];
    const resultats: Array<'pending' | 'done'> = ['pending', 'done'];
    const run = vi.fn(async () => resultats.shift()!);
    const sch = scheduleIndexMaintenance({ ...s, run, setTimer: (fn, ms) => { minuteries.push({ fn, ms }); return minuteries.length; }, clearTimer: () => {}, log: { warn: () => {}, error: () => {} } });
    expect(minuteries.map((x) => x.ms)).toEqual([25 * 60_000]);
    minuteries[0].fn();
    await vi.waitFor(() => expect(minuteries).toHaveLength(2));
    expect(minuteries[1].ms).toBe(30 * 60_000);
    minuteries[1].fn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(minuteries).toHaveLength(2);
    expect(sch.nextDelayMs()).toBeNull();
  });

  it('erreur du passage : traitée comme « en attente », planificateur toujours vivant', async () => {
    const minuteries: Array<() => void> = [];
    const log = { warn: vi.fn(), error: vi.fn() };
    const sch = scheduleIndexMaintenance({ ...s, run: async () => { throw new Error('base coupée'); }, setTimer: (fn) => { minuteries.push(fn); return 1; }, clearTimer: () => {}, log });
    minuteries[0]();
    await vi.waitFor(() => expect(minuteries).toHaveLength(2));
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/base coupée/));
    sch.stop();
    expect(sch.nextDelayMs()).toBeNull();
  });
});

describe('diagnostic des sessions bloquantes', () => {
  it('littéraux masqués, rien de secret', () => {
    expect(maskQueryLiterals("UPDATE users SET password_hash = 'x''y' WHERE id = 1234567 AND token = E'abc'"))
      .toBe("UPDATE users SET password_hash = '…' WHERE id = … AND token = '…'");
    expect(maskQueryLiterals('SELECT $$secret$$, 42')).toBe('SELECT $$…$$, 42');
  });

  it('format : une ligne par session ; aucune session visible : message explicite', () => {
    const b: IndexBlocker = { pid: 7, applicationName: 'verebona:web-1', state: 'active', waitEventType: null, waitEvent: null, xactAgeS: 12, query: 'SELECT 1' };
    expect(formatIndexBlockers('i', [b])[1]).toBe('[db]   pid=7 app=verebona:web-1 state=active wait=-/- transaction=12s query="SELECT 1"');
    expect(formatIndexBlockers('i', [])[0]).toMatch(/aucune session plus ancienne visible/);
  });

  it('blockersStillActive : tableau d’entiers passé en paramètre, jamais interpolé', async () => {
    const unsafe = vi.fn(async () => [{ x: 1 }]);
    expect(await blockersStillActive({ unsafe }, [12, 34], '2026-10-05 17:28:00+00')).toBe(true);
    expect((unsafe.mock.calls[0] as unknown[])[1]).toEqual(['{12,34}', '2026-10-05 17:28:00+00']);
    expect(await blockersStillActive({ unsafe }, [], 'x')).toBe(false);
  });

  it('createIndexPass : défaut court (démarrage)', () => {
    expect(createIndexPass().indexLockTimeout).toBe('10s');
  });
});

describe('application_name', () => {
  it('rôle du conteneur, filtré, borné', () => {
    expect(resolveApplicationName('web-1')).toBe('verebona:web-1');
    expect(resolveApplicationName('')).toBe('verebona');
    expect(resolveApplicationName("x'; DROP--")).toBe('verebona:xDROP--');
    expect(resolveApplicationName('a'.repeat(100)).length).toBeLessThanOrEqual(63);
  });
});
