/**
 * APP-PERF-16 — état des migrations partagé par processus (`ensureMigrations`),
 * readiness du schéma, politique de démarrage et réglages.
 *
 * Le moteur (`migration-index`) est simulé : on vérifie ici la coordination
 * DANS le processus — une seule exécution partagée, phases distinctes
 * (commencé ≠ réussi ≠ échoué), état visible de toutes les copies du module
 * (couches Next.js), relecture bornée et unique de la readiness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const moteur = vi.hoisted(() => ({
  runBootMigrations: vi.fn(),
  runIndexMaintenance: vi.fn(),
  readSchemaState: vi.fn(),
  readMigrationFiles: vi.fn(async () => [
    { filename: '0001_a.sql', sql: 'CREATE TABLE a (id int);' },
    { filename: '0001_a_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a (id);' },
  ]),
}));
vi.mock('@/db/migration-index', async (orig) => ({
  ...(await orig<typeof import('@/db/migration-index')>()),
  ...moteur,
}));

const db = await import('@/db');
const { assertMigrationBootPolicy, MigrationBootError } = await import('@/db/migration-boot');
const { resolveMigrationRuntimeConfig } = await import('@/db/migration-config');

const rapport = (o: Record<string, unknown> = {}) => ({
  outcome: 'ready', lockAcquired: true, lockWaitMs: 3, durationMs: 10, applied: ['0001_a.sql'], deferred: [], skipped: [],
  failures: [], firstCriticalFailure: null, repair: null, pendingCritical: [], pendingOptional: [], ...o,
});

const envInitial = { ...process.env };
beforeEach(() => {
  db.resetMigrationStateForTests();
  moteur.runBootMigrations.mockReset();
  moteur.runIndexMaintenance.mockReset();
  moteur.readSchemaState.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...envInitial }; vi.restoreAllMocks(); });

describe('ensureMigrations — passage unique et partagé', () => {
  it('appels concurrents : UNE exécution ; « running » n’est jamais « ready »', async () => {
    let fin!: (v: unknown) => void;
    moteur.runBootMigrations.mockReturnValueOnce(new Promise((r) => { fin = r; }));
    const a = db.ensureMigrations();
    const b = db.ensureMigrations();
    await vi.waitFor(() => expect(moteur.runBootMigrations).toHaveBeenCalledTimes(1));
    expect(db.getMigrationStatus().phase).toBe('running');
    expect((await db.getSchemaReadiness()).ready).toBe(false);
    fin(rapport());
    const [sa, sb] = await Promise.all([a, b]);
    expect(sa.phase).toBe('ready');
    expect(sb.phase).toBe('ready');
    // Appel ultérieur (route, à la requête) : aucune nouvelle exécution.
    await db.ensureMigrations();
    expect(moteur.runBootMigrations).toHaveBeenCalledTimes(1);
  });

  it('état porté par globalThis : visible d’une autre copie du module (couche Next.js)', async () => {
    moteur.runBootMigrations.mockResolvedValueOnce(rapport());
    await db.ensureMigrations();
    vi.resetModules();
    const autreCopie = await import('@/db');
    expect(autreCopie.getMigrationStatus().phase).toBe('ready');
    await autreCopie.ensureMigrations();
    expect(moteur.runBootMigrations).toHaveBeenCalledTimes(1);
  });

  it('échec critique : phase `failed`, première cause, failures exposées', async () => {
    const f = { filename: '0001_a.sql', message: 'colonne x', code: '42703', criticality: 'critical' };
    moteur.runBootMigrations.mockResolvedValueOnce(rapport({ outcome: 'failed', failures: [f], firstCriticalFailure: f, pendingCritical: ['0001_a.sql'] }));
    const s = await db.ensureMigrations();
    expect(s.phase).toBe('failed');
    expect(s.firstFailure).toMatchObject({ filename: '0001_a.sql', code: '42703' });
    expect(db.getMigrationFailures()).toHaveLength(1);
  });

  it('lanceur en erreur (base injoignable) : `unknown`, ne lève pas', async () => {
    moteur.runBootMigrations.mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const s = await db.ensureMigrations();
    expect(s.phase).toBe('unknown');
    expect(s.error).toBe('ECONNREFUSED');
  });

  it('MIGRATIONS_ON_BOOT=check : aucune exécution, lecture seule', async () => {
    process.env.MIGRATIONS_ON_BOOT = 'check';
    moteur.readSchemaState.mockResolvedValueOnce({ tracked: true, pendingCritical: [], pendingOptional: ['0001_a_idx_1.sql'] });
    const s = await db.ensureMigrations();
    expect(moteur.runBootMigrations).not.toHaveBeenCalled();
    expect(s.phase).toBe('degraded');
  });

  it('MIGRATIONS_ON_BOOT=check, critique manquant : `failed`', async () => {
    process.env.MIGRATIONS_ON_BOOT = 'check';
    moteur.readSchemaState.mockResolvedValueOnce({ tracked: true, pendingCritical: ['0001_a.sql'], pendingOptional: [] });
    expect((await db.ensureMigrations()).phase).toBe('failed');
  });

  it('démarrage web (lot 24b) : coordination bornée, aucun index ni réparation ; MIGRATIONS_REPAIR_ON_BOOT obsolète, signalée', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    moteur.runBootMigrations.mockResolvedValue(rapport());
    await db.ensureMigrations();
    expect(moteur.runBootMigrations.mock.calls[0][2]).toEqual({ waitMs: 900_000, lockTimeout: '10s', statementTimeout: '0' });
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/obsolète/));
    db.resetMigrationStateForTests();
    process.env.MIGRATIONS_REPAIR_ON_BOOT = 'true';
    process.env.MIGRATION_BOOT_WAIT_MS = '1000';
    await db.ensureMigrations();
    expect(moteur.runBootMigrations.mock.calls[1][2]).toMatchObject({ waitMs: 1000 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/MIGRATIONS_REPAIR_ON_BOOT est obsolète/));
  });
});

describe('maintenance des index en arrière-plan (lot 24b)', () => {
  const maintenance = (o: Record<string, unknown> = {}) => ({
    kind: 'done', built: ['0001_a_idx_1.sql'], deferred: [], failures: [], repair: null, pendingCritical: [], pendingOptional: [], ...o,
  });

  it('passage réussi : `degraded` → `ready`, délai long par défaut', async () => {
    moteur.runBootMigrations.mockResolvedValueOnce(rapport({ outcome: 'degraded', pendingOptional: ['0001_a_idx_1.sql'] }));
    await db.ensureMigrations();
    moteur.runIndexMaintenance.mockResolvedValueOnce(maintenance());
    expect(await db.runIndexMaintenanceRound()).toBe('done');
    expect(moteur.runIndexMaintenance.mock.calls[0][2]).toMatchObject({ indexLockTimeout: '10min', lockTimeout: '10s' });
    expect(db.getMigrationStatus()).toMatchObject({ phase: 'ready', pendingOptional: [] });
  });

  it('autre exécutant (`busy`) ou index encore en attente : état conservé / mis à jour', async () => {
    moteur.runBootMigrations.mockResolvedValueOnce(rapport({ outcome: 'degraded', pendingOptional: ['0001_a_idx_1.sql'] }));
    await db.ensureMigrations();
    moteur.runIndexMaintenance.mockResolvedValueOnce(maintenance({ kind: 'busy', built: [] }));
    expect(await db.runIndexMaintenanceRound()).toBe('busy');
    expect(db.getMigrationStatus().phase).toBe('degraded');
    moteur.runIndexMaintenance.mockResolvedValueOnce(maintenance({ kind: 'pending', built: [], pendingOptional: ['0001_a_idx_1.sql'] }));
    expect(await db.runIndexMaintenanceRound()).toBe('pending');
    expect(db.getMigrationStatus().phase).toBe('degraded');
  });

  it('index critique construit en arrière-plan : `waiting` → `ready` (poste local, sans postdeploy)', async () => {
    moteur.runBootMigrations.mockResolvedValueOnce(rapport({ outcome: 'waiting', pendingCritical: ['0001_a.sql'], skipped: ['0001_a.sql'] }));
    await db.ensureMigrations();
    moteur.runIndexMaintenance.mockResolvedValueOnce(maintenance());
    await db.runIndexMaintenanceRound();
    expect((await db.getSchemaReadiness()).ready).toBe(true);
  });

  it('MIGRATIONS_ON_BOOT=check ou intervalle 0 : jamais démarrée (aucune DDL depuis le web)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.env.MIGRATIONS_ON_BOOT = 'check';
    db.startIndexMaintenance();
    db.resetMigrationStateForTests();
    process.env.MIGRATIONS_ON_BOOT = 'run';
    process.env.MIGRATION_INDEX_REBUILD_INTERVAL_MIN = '0';
    db.startIndexMaintenance();
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/maintenance des index/));
    db.resetMigrationStateForTests();
    delete process.env.MIGRATION_INDEX_REBUILD_INTERVAL_MIN;
    db.startIndexMaintenance();
    db.startIndexMaintenance();
    expect(info.mock.calls.filter((c) => /maintenance des index/.test(String(c[0])))).toHaveLength(1);
    expect(moteur.runIndexMaintenance).not.toHaveBeenCalled(); // premier passage différé
    db.resetMigrationStateForTests(); // arrête la minuterie
  });
});

describe('getSchemaReadiness — relecture bornée et unique', () => {
  it('`waiting` puis schéma complété ailleurs : relu, devient prêt', async () => {
    moteur.runBootMigrations.mockResolvedValueOnce(rapport({ outcome: 'waiting', lockAcquired: false, pendingCritical: ['0001_a.sql'] }));
    await db.ensureMigrations();
    moteur.readSchemaState.mockResolvedValueOnce({ tracked: true, pendingCritical: [], pendingOptional: [] });
    const r = await db.getSchemaReadiness({ maxAgeMs: 0 });
    expect(r).toMatchObject({ ready: true, phase: 'ready', pendingCritical: 0 });
  });

  it('T-03 (contrôles accumulés) : appels simultanés → UNE lecture ; base bloquée → réponse au délai', async () => {
    moteur.runBootMigrations.mockResolvedValueOnce(rapport({ outcome: 'failed', pendingCritical: ['0001_a.sql'] }));
    await db.ensureMigrations();
    moteur.readSchemaState.mockReturnValue(new Promise(() => {}));
    const debut = Date.now();
    const rs = await Promise.all(Array.from({ length: 20 }, () => db.getSchemaReadiness({ maxAgeMs: 0, timeoutMs: 50 })));
    expect(Date.now() - debut).toBeLessThan(1_000);
    expect(moteur.readSchemaState).toHaveBeenCalledTimes(1);
    expect(rs.every((r) => !r.ready && r.phase === 'failed')).toBe(true);
  });

  it('prêt au démarrage : aucune requête', async () => {
    moteur.runBootMigrations.mockResolvedValueOnce(rapport());
    await db.ensureMigrations();
    expect((await db.getSchemaReadiness({ maxAgeMs: 0 })).ready).toBe(true);
    expect(moteur.readSchemaState).not.toHaveBeenCalled();
  });

  it('aucun message SQL dans la readiness', async () => {
    const f = { filename: '0001_a.sql', message: 'syntax error at or near "SECRET"', code: '42601', criticality: 'critical' };
    moteur.runBootMigrations.mockResolvedValueOnce(rapport({ outcome: 'failed', failures: [f], firstCriticalFailure: f, pendingCritical: ['0001_a.sql'] }));
    await db.ensureMigrations();
    moteur.readSchemaState.mockResolvedValueOnce({ tracked: true, pendingCritical: ['0001_a.sql'], pendingOptional: [] });
    const r = await db.getSchemaReadiness({ maxAgeMs: 0 });
    expect(r.firstFailure).toEqual({ filename: '0001_a.sql', code: '42601' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('politique de démarrage (CA-01)', () => {
  const echec = { phase: 'failed' as const, pendingCritical: ['0001_a.sql'], firstFailure: { filename: '0001_a.sql', code: '42703', message: 'm' } };

  it('critique en échec : démarrage refusé (défaut `block`)', () => {
    expect(() => assertMigrationBootPolicy(echec, {})).toThrow(MigrationBootError);
  });

  it('`degraded` explicite : démarrage maintenu, signalé', () => {
    expect(() => assertMigrationBootPolicy(echec, { MIGRATIONS_BOOT_POLICY: 'degraded' })).not.toThrow();
  });

  it.each(['ready', 'degraded', 'waiting', 'unknown', 'skipped'] as const)('phase %s : jamais bloquante', (phase) => {
    expect(() => assertMigrationBootPolicy({ ...echec, phase }, {})).not.toThrow();
  });
});

describe('réglages MIGRATIONS_* / MIGRATION_*', () => {
  it('défauts (aucune variable obligatoire) ; Scalingo : premier passage de maintenance après le postdeploy', () => {
    expect(resolveMigrationRuntimeConfig({})).toEqual({
      mode: 'run', policy: 'block', bootWaitMs: 900_000, lockTimeout: '10s', statementTimeout: '0',
      indexLockTimeout: '10min',
      indexMaintenance: { firstDelayMs: 15_000, intervalMs: 30 * 60_000, maxIntervalMs: 6 * 3_600_000 },
      obsolete: [],
    });
    expect(resolveMigrationRuntimeConfig({ CONTAINER: 'web-1' }).indexMaintenance.firstDelayMs).toBe(25 * 60_000);
    expect(resolveMigrationRuntimeConfig({ MIGRATION_INDEX_LOCK_TIMEOUT: '3min', MIGRATION_INDEX_REBUILD_INTERVAL_MIN: '0' }))
      .toMatchObject({ indexLockTimeout: '3min', indexMaintenance: { intervalMs: 0 } });
  });
  it('valeurs invalides : erreur explicite', () => {
    expect(() => resolveMigrationRuntimeConfig({ MIGRATIONS_ON_BOOT: 'oui' })).toThrow(/MIGRATIONS_ON_BOOT/);
    expect(() => resolveMigrationRuntimeConfig({ MIGRATION_BOOT_WAIT_MS: '-5' })).toThrow(/MIGRATION_BOOT_WAIT_MS/);
    expect(() => resolveMigrationRuntimeConfig({ MIGRATION_LOCK_TIMEOUT: "1s'" })).toThrow(/MIGRATION_LOCK_TIMEOUT/);
    expect(() => resolveMigrationRuntimeConfig({ MIGRATION_INDEX_LOCK_TIMEOUT: '1h' })).toThrow(/MIGRATION_INDEX_LOCK_TIMEOUT/);
    expect(() => resolveMigrationRuntimeConfig({ MIGRATION_INDEX_REBUILD_INTERVAL_MIN: '1.5' })).toThrow(/MIGRATION_INDEX_REBUILD_INTERVAL_MIN/);
  });
});
